/**
 * Generates the PWA icons.
 *
 * Run with `pnpm run icons`. Plain `node`, no loader: the CRC-32 table is the
 * ten lines below rather than an import of the zip module's, because reaching
 * into a TypeScript package would make a build script depend on a toolchain for
 * something this small. A wrong table would produce a PNG that the check in the
 * test suite rejects immediately, so the duplication cannot hide.
 *
 * Why hand-rolled: the manifest needs real PNGs — `apple-touch-icon` ignores
 * SVG entirely, and SVG is unreliable for `purpose: "maskable"` — and there is
 * no image library and no network access. A PNG for a flat, two-colour mark is
 * a signature, three chunks and a CRC, and this repository already hand-rolls
 * its SHA-256 and its whole ZIP reader and writer, so this is in keeping rather
 * than an indulgence.
 *
 * The mark is `>_`: a prompt chevron and a cursor block. It reads at 48px, it
 * is unmistakably a terminal, and it needs no typography — which matters,
 * because drawing text would mean shipping a font renderer.
 *
 * Output is deterministic, so re-running produces identical bytes.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { deflateSync } from 'node:zlib'

// ---------------------------------------------------------------------------
// CRC-32 (IEEE), which every PNG chunk carries
// ---------------------------------------------------------------------------

const CRC_TABLE = new Uint32Array(256)
for (let i = 0; i < 256; i += 1) {
  let c = i
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  CRC_TABLE[i] = c >>> 0
}

function crc32(bytes) {
  let c = 0xffffffff
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

const INK = [0x0b, 0x0e, 0x14]
const ACCENT = [0x5a, 0xa9, 0xff]

/** Sub-samples per axis. 4 gives 16 samples per pixel, which is plenty here. */
const SUPERSAMPLE = 4

// ---------------------------------------------------------------------------
// PNG
// ---------------------------------------------------------------------------

function chunk(type, data) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length, 0)

  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const checksum = Buffer.alloc(4)
  checksum.writeUInt32BE(crc32(body), 0)

  return Buffer.concat([length, body, checksum])
}

function encodePng(width, height, rgba) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // colour type: truecolour with alpha
  ihdr[10] = 0 // deflate
  ihdr[11] = 0 // adaptive filtering
  ihdr[12] = 0 // no interlace

  // Every scanline is prefixed with its filter byte; 0 means "none", which is
  // the right choice for flat artwork and costs nothing here.
  const stride = width * 4
  const raw = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride)
  }

  return Buffer.concat([
    signature,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

// ---------------------------------------------------------------------------
// The mark
// ---------------------------------------------------------------------------

/** Distance from a point to a line segment. */
function distanceToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax
  const dy = by - ay
  const lengthSquared = dx * dx + dy * dy
  const t = lengthSquared === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lengthSquared))
  const cx = ax + t * dx
  const cy = ay + t * dy
  return Math.hypot(px - cx, py - cy)
}

/**
 * Is this point part of the glyph?
 *
 * Coordinates are normalised to 0..1 across the icon. `scale` shrinks the mark
 * towards the centre, which is what the maskable variant needs.
 */
function inGlyph(x, y, scale) {
  // Centre the mark, then un-scale the sample point into glyph space.
  const gx = (x - 0.5) / scale + 0.5
  const gy = (y - 0.5) / scale + 0.5

  const stroke = 0.058
  const apexX = 0.535
  const top = 0.3
  const bottom = 0.7
  const left = 0.225

  // The `>`: two arms meeting at the apex.
  const upper = distanceToSegment(gx, gy, left, top, apexX, (top + bottom) / 2) <= stroke
  const lower = distanceToSegment(gx, gy, apexX, (top + bottom) / 2, left, bottom) <= stroke
  if (upper || lower) return true

  // The `_`: a solid block, not a stroked line.
  const barLeft = 0.575
  const barRight = 0.79
  const barTop = 0.612
  const barBottom = 0.7
  return gx >= barLeft && gx <= barRight && gy >= barTop && gy <= barBottom
}

/** Inside the rounded-square background? `radius` of 0 gives a plain square. */
function inBackground(x, y, radius) {
  if (radius <= 0) return true
  const r = radius
  const cx = Math.min(Math.max(x, r), 1 - r)
  const cy = Math.min(Math.max(y, r), 1 - r)
  // Inside the inset rect, or within the corner radius of one of its corners.
  return Math.hypot(x - cx, y - cy) <= r
}

/**
 * Renders one icon.
 *
 * Supersampled and box-filtered, which is the whole of the antialiasing: the
 * glyph is pure arithmetic, so there is no canvas and no font involved.
 */
function render(size, { radius, glyphScale, opaque }) {
  const rgba = Buffer.alloc(size * size * 4)

  for (let py = 0; py < size; py += 1) {
    for (let px = 0; px < size; px += 1) {
      let backgroundHits = 0
      let glyphHits = 0

      for (let sy = 0; sy < SUPERSAMPLE; sy += 1) {
        for (let sx = 0; sx < SUPERSAMPLE; sx += 1) {
          const x = (px + (sx + 0.5) / SUPERSAMPLE) / size
          const y = (py + (sy + 0.5) / SUPERSAMPLE) / size
          if (!inBackground(x, y, radius)) continue
          backgroundHits += 1
          if (inGlyph(x, y, glyphScale)) glyphHits += 1
        }
      }

      const total = SUPERSAMPLE * SUPERSAMPLE
      const at = (py * size + px) * 4

      // Alpha is the background coverage; inside it, the colour is a blend of
      // accent over ink by the glyph's coverage.
      const alpha = opaque ? 1 : backgroundHits / total
      const glyphFraction = backgroundHits === 0 ? 0 : glyphHits / backgroundHits

      rgba[at] = Math.round(INK[0] + (ACCENT[0] - INK[0]) * glyphFraction)
      rgba[at + 1] = Math.round(INK[1] + (ACCENT[1] - INK[1]) * glyphFraction)
      rgba[at + 2] = Math.round(INK[2] + (ACCENT[2] - INK[2]) * glyphFraction)
      rgba[at + 3] = Math.round(alpha * 255)
    }
  }

  return encodePng(size, size, rgba)
}

// ---------------------------------------------------------------------------

const outputDir = path.resolve(import.meta.dirname, '../packages/web/public/icons')
mkdirSync(outputDir, { recursive: true })

const files = [
  // `purpose: "any"` — a rounded square, which is what a launcher shows as-is.
  ['icon-192.png', 192, { radius: 0.22, glyphScale: 0.86, opaque: false }],
  ['icon-512.png', 512, { radius: 0.22, glyphScale: 0.86, opaque: false }],
  // `purpose: "maskable"` — the background must bleed to every edge and the
  // mark must survive being cropped to a circle, so it shrinks to sit inside
  // the safe zone rather than being nudged around.
  ['maskable-192.png', 192, { radius: 0, glyphScale: 0.62, opaque: true }],
  ['maskable-512.png', 512, { radius: 0, glyphScale: 0.62, opaque: true }],
  // iOS applies its own mask and composites transparency onto black, so this
  // one is opaque and square.
  ['apple-touch-icon.png', 180, { radius: 0, glyphScale: 0.78, opaque: true }],
]

for (const [name, size, options] of files) {
  writeFileSync(path.join(outputDir, name), render(size, options))
  console.log(`  ${name}  ${size}×${size}`)
}
console.log(`\nwrote ${files.length} icons to ${path.relative(process.cwd(), outputDir)}`)
