/**
 * Builds ZIP archives byte by byte, for the attack cases.
 *
 * The attack cases cannot go through our own writer — it refuses to emit most
 * of them — and they cannot go through `zip(1)` either, which likewise refuses.
 * Crafting the bytes directly is the only way to construct an archive whose
 * *name* traverses, whose flags claim encryption, or whose two name fields
 * disagree, and doing it here keeps those tests fast and tool-free.
 */
import { crc32 as zlibCrc32 } from 'node:zlib'

export const SIG_LOCAL = 0x04034b50
export const SIG_CENTRAL = 0x02014b50
export const SIG_EOCD = 0x06054b50

/** A DOS timestamp that is not zero: 2026-09-28 16:00. */
const DOS_TIME = (16 << 11) | (0 << 5)
const DOS_DATE = ((2026 - 1980) << 9) | (9 << 5) | 28

/**
 * @param {Array<{
 *   name: string, data?: Buffer, method?: number, flags?: number,
 *   mode?: number, host?: number, crc?: number, centralName?: string,
 *   extra?: Buffer, centralExtra?: Buffer, localOffset?: number,
 * }>} entries
 */
export function buildZip(entries, { comment = Buffer.alloc(0), diskNumber = 0 } = {}) {
  const localParts = []
  const centralParts = []
  let offset = 0

  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8')
    const data = entry.data ?? Buffer.alloc(0)
    const centralName = Buffer.from(entry.centralName ?? entry.name, 'utf8')
    const method = entry.method ?? 0
    const flags = entry.flags ?? 0x0800
    const crc = entry.crc ?? zlibCrc32(data)
    // `claimedUncompressed` lets a test declare a size that disagrees with the
    // bytes present, which is how a compressed bomb presents itself.
    const compressedSize = data.length
    const uncompressedSize = entry.claimedUncompressed ?? data.length
    const extra = entry.extra ?? Buffer.alloc(0)
    const centralExtra = entry.centralExtra ?? Buffer.alloc(0)
    const isDirectory = entry.name.endsWith('/')
    const mode = entry.mode ?? (isDirectory ? 0o40755 : 0o100644)
    const host = entry.host ?? 3

    const localOffset = entry.localOffset ?? offset

    const local = Buffer.alloc(30)
    local.writeUInt32LE(SIG_LOCAL, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(flags, 6)
    local.writeUInt16LE(method, 8)
    local.writeUInt16LE(DOS_TIME, 10)
    local.writeUInt16LE(DOS_DATE, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(compressedSize, 18)
    local.writeUInt32LE(uncompressedSize, 22)
    local.writeUInt16LE(name.length, 26)
    local.writeUInt16LE(extra.length, 28)
    localParts.push(local, name, extra, data)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(SIG_CENTRAL, 0)
    central.writeUInt16LE((host << 8) | 20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(flags, 8)
    central.writeUInt16LE(method, 10)
    central.writeUInt16LE(DOS_TIME, 12)
    central.writeUInt16LE(DOS_DATE, 14)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(compressedSize, 20)
    central.writeUInt32LE(uncompressedSize, 24)
    central.writeUInt16LE(centralName.length, 28)
    central.writeUInt16LE(centralExtra.length, 30)
    central.writeUInt16LE(0, 32)
    central.writeUInt16LE(diskNumber, 34)
    central.writeUInt16LE(0, 36)
    // Unix mode in the high half, DOS directory bit in the low.
    central.writeUInt32LE((((mode & 0xffff) << 16) | (isDirectory ? 0x10 : 0)) >>> 0, 38)
    central.writeUInt32LE(localOffset, 42)
    centralParts.push(central, centralName, centralExtra)

    offset += local.length + name.length + extra.length + data.length
  }

  const localBlock = Buffer.concat(localParts)
  const centralBlock = Buffer.concat(centralParts)
  const count = entries.length

  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(SIG_EOCD, 0)
  eocd.writeUInt16LE(diskNumber, 4)
  eocd.writeUInt16LE(diskNumber, 6)
  eocd.writeUInt16LE(count, 8)
  eocd.writeUInt16LE(count, 10)
  eocd.writeUInt32LE(centralBlock.length, 12)
  eocd.writeUInt32LE(localBlock.length, 16)
  eocd.writeUInt16LE(comment.length, 20)

  return Buffer.concat([localBlock, centralBlock, eocd, comment])
}

/** A Zip64 extra field, header id 0x0001, eight bytes of uncompressed size. */
export function zip64Extra(size) {
  const extra = Buffer.alloc(4 + 8)
  extra.writeUInt16LE(0x0001, 0)
  extra.writeUInt16LE(8, 2)
  extra.writeBigUInt64LE(BigInt(size), 4)
  return extra
}
