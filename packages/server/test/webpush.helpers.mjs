/**
 * Helpers for standing in for a browser and a push service in tests.
 *
 * Shared by the unit tests and the end-to-end suite, in the same spirit as
 * zip.helpers.mjs: the interesting thing is not the helper, it is that both
 * sides of the protocol can be exercised without a real browser.
 */
import {
  createDecipheriv,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
} from 'node:crypto'
import assert from 'node:assert/strict'
import { publicKeyFromPoint } from '../src/notify/webpush.ts'

/** What a browser subscription amounts to: a P-256 pair and a shared secret. */
export function subscriptionKeys() {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  const der = publicKey.export({ format: 'der', type: 'spki' })
  return { privateKey, publicKey: der.subarray(der.length - 65) }
}

/**
 * Decrypts a push body the way a user agent does, following RFC 8188's decode
 * procedure rather than undoing the server's encoder.
 *
 * That distinction is the point. A decryptor that mirrors the encoder passes
 * even when both share the same mistake — get the framing wrong in both
 * directions and the round trip is still clean. The rule below is the
 * specification's: strip trailing zero octets, then the last remaining octet
 * must be the padding delimiter (0x02 for a final record). Nothing here
 * assumes the padding is absent, or that the delimiter is the last byte.
 */
export function decryptPushBody(body, { privateKey, publicKey, authSecret }) {
  const salt = body.subarray(0, 16)
  const idlen = body[20]
  const asPublic = body.subarray(21, 21 + idlen)
  const header = body.subarray(0, 21 + idlen)

  const ecdh = diffieHellman({ privateKey, publicKey: publicKeyFromPoint(Buffer.from(asPublic)) })
  const ikm = Buffer.from(
    hkdfSync(
      'sha256',
      ecdh,
      authSecret,
      Buffer.concat([Buffer.from('WebPush: info\0', 'utf8'), publicKey, asPublic]),
      32,
    ),
  )
  const cek = Buffer.from(
    hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0', 'utf8'), 16),
  )
  const nonce = Buffer.from(
    hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0', 'utf8'), 12),
  )

  const ciphertext = body.subarray(header.length)
  const decipher = createDecipheriv('aes-128-gcm', cek, nonce)
  decipher.setAAD(header)
  decipher.setAuthTag(ciphertext.subarray(ciphertext.length - 16))
  const padded = Buffer.concat([
    decipher.update(ciphertext.subarray(0, ciphertext.length - 16)),
    decipher.final(),
  ])

  let end = padded.length
  while (end > 0 && padded[end - 1] === 0) end -= 1
  assert.equal(padded[end - 1], 0x02, 'the last non-zero octet must be the padding delimiter')
  return padded.subarray(0, end - 1)
}
