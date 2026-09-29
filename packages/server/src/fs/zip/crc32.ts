/**
 * CRC-32 (IEEE), the per-entry checksum ZIP stores.
 *
 * Table-driven rather than `zlib.crc32`, for two reasons: it keeps this module
 * free of an import on every read and write, and it gives the test suite an
 * implementation to check *against* `zlib.crc32` rather than one that only
 * ever agrees with itself.
 */

const TABLE = new Uint32Array(256)
for (let i = 0; i < 256; i += 1) {
  let c = i
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  TABLE[i] = c >>> 0
}

/** The register's initial value. Not the same as the CRC of an empty input. */
export const CRC32_SEED = 0xffffffff

/**
 * Folds one chunk into a running CRC.
 *
 * A rolling register, so chunk boundaries are irrelevant — which is what lets
 * the writer checksum bytes as they stream past instead of buffering an entry.
 */
export function crc32Update(crc: number, chunk: Uint8Array): number {
  let c = crc
  for (let i = 0; i < chunk.length; i += 1) {
    c = TABLE[(c ^ chunk[i]!) & 0xff]! ^ (c >>> 8)
  }
  return c >>> 0
}

/** Turns a running CRC into the value ZIP actually stores. */
export function crc32Final(crc: number): number {
  return (crc ^ 0xffffffff) >>> 0
}

/** One-shot, for tests and small buffers. */
export function crc32(chunk: Uint8Array): number {
  return crc32Final(crc32Update(CRC32_SEED, chunk))
}
