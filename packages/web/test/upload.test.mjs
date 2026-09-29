/**
 * Unit tests for the upload client's pure logic.
 *
 * The SHA-256 fallback is hand-written, and hand-written SHA-256 is exactly the
 * kind of thing that works on every input you try by hand and then breaks on
 * one length. It is cross-checked against node's implementation across the
 * padding boundaries, which is where those implementations actually fail.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { missingChunks, sha256Base64 } from '../src/lib/upload.ts'

const expected = (bytes) => createHash('sha256').update(bytes).digest('base64')

describe('sha256Base64', () => {
  it('agrees with node when crypto.subtle is available', async () => {
    const bytes = randomBytes(1000)
    assert.equal(await sha256Base64(bytes), expected(bytes))
  })

  it('agrees with node through the fallback path', async () => {
    const real = globalThis.crypto
    // Plain HTTP on a LAN has no `crypto.subtle`; this is that environment.
    Object.defineProperty(globalThis, 'crypto', { value: {}, configurable: true })
    try {
      // 55/56/57 and 63/64/65 straddle the two padding boundaries — a single
      // off-by-one in the length encoding or the 0x80 terminator shows up here
      // and almost nowhere else.
      const sizes = [0, 1, 55, 56, 57, 63, 64, 65, 119, 120, 127, 128, 1000, 4096]
      for (const size of sizes) {
        const bytes = randomBytes(size)
        assert.equal(await sha256Base64(bytes), expected(bytes), `failed at size ${size}`)
      }
    } finally {
      Object.defineProperty(globalThis, 'crypto', { value: real, configurable: true })
    }
  })

  it('hashes the empty input correctly', async () => {
    assert.equal(
      await sha256Base64(new Uint8Array(0)),
      '47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=',
    )
  })
})

describe('missingChunks', () => {
  const CHUNK = 100

  it('asks for everything when the server holds nothing', () => {
    assert.deepEqual(missingChunks([], 250, CHUNK), [0, 100, 200])
  })

  it('skips the ranges the server already has', () => {
    // The middle chunk is missing; only that one should be requested.
    assert.deepEqual(missingChunks([[0, 100], [200, 250]], 250, CHUNK), [100])
  })

  it('asks for nothing when the upload is complete', () => {
    assert.deepEqual(missingChunks([[0, 250]], 250, CHUNK), [])
  })

  it('handles a gap at the end', () => {
    assert.deepEqual(missingChunks([[0, 100]], 250, CHUNK), [100, 200])
  })

  it('handles a gap at the start', () => {
    assert.deepEqual(missingChunks([[100, 250]], 250, CHUNK), [0])
  })

  it('returns nothing for a zero-length file', () => {
    assert.deepEqual(missingChunks([], 0, CHUNK), [])
  })

  it('never requests an offset past the declared size', () => {
    for (const received of [[], [[0, 100]], [[0, 150]]]) {
      for (const offset of missingChunks(received, 137, CHUNK)) {
        assert.ok(offset < 137, `offset ${offset} is past the end`)
      }
    }
  })
})
