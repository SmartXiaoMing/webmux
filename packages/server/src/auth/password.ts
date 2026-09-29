import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from 'node:crypto'

/**
 * Hand-rolled rather than `promisify(scrypt)`: the promisified type resolves to
 * the three-argument overload, which drops the `options` parameter that
 * carries the cost parameters.
 */
function scryptAsync(
  password: string,
  salt: Buffer,
  keylen: number,
  options: ScryptOptions,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, keylen, options, (err, derivedKey) => {
      if (err) reject(err)
      else resolve(derivedKey)
    })
  })
}

/**
 * Password hashing with scrypt from Node's standard library.
 *
 * argon2id would be the marginally stronger choice, but it costs a native
 * dependency that has to compile on every target. scrypt is memory-hard, in
 * core, and more than adequate for a single-credential self-hosted service.
 *
 * Parameters follow RFC 7914 / OWASP guidance for interactive logins
 * (~32 MB working set, roughly 100 ms per verification).
 */
const PARAMS = { N: 1 << 15, r: 8, p: 1 } as const
const KEY_LEN = 32
const SALT_LEN = 16

/**
 * scrypt needs 128 * N * r bytes ≈ 33.5 MB here, which sits just above Node's
 * 32 MB default and would throw without an explicit bump.
 */
const MAX_MEM = 64 * 1024 * 1024

/** Unicode normalization so visually identical passwords hash identically. */
function normalize(password: string): string {
  return password.normalize('NFKC')
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_LEN)
  const key = (await scryptAsync(normalize(password), salt, KEY_LEN, {
    ...PARAMS,
    maxmem: MAX_MEM,
  })) as Buffer

  return ['scrypt', PARAMS.N, PARAMS.r, PARAMS.p, salt.toString('base64'), key.toString('base64')].join('$')
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$')
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false

  const N = Number(parts[1])
  const r = Number(parts[2])
  const p = Number(parts[3])
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) return false

  let salt: Buffer
  let expected: Buffer
  try {
    salt = Buffer.from(parts[4] ?? '', 'base64')
    expected = Buffer.from(parts[5] ?? '', 'base64')
  } catch {
    return false
  }
  if (salt.length === 0 || expected.length === 0) return false

  let actual: Buffer
  try {
    actual = (await scryptAsync(normalize(password), salt, expected.length, {
      N,
      r,
      p,
      maxmem: MAX_MEM,
    })) as Buffer
  } catch {
    return false
  }

  // timingSafeEqual throws on length mismatch, so guard first.
  if (actual.length !== expected.length) return false
  return timingSafeEqual(actual, expected)
}
