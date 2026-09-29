import { createHash, randomBytes } from 'node:crypto'
import { SignJWT, jwtVerify } from 'jose'

/**
 * Share tokens, and the cookie a visitor gets after proving a password.
 *
 * ## Why the token is hashed with sha256 and the password with scrypt
 *
 * They live in the same table and are deliberately treated differently.
 *
 * A token is 256 bits straight out of a CSPRNG. An attacker holding the
 * database faces a 2^256 preimage problem, and a slow KDF would not raise that
 * number by one — it would only make *every visitor request* cost 100 ms and
 * 32 MB of scrypt work. A password's entropy comes from a human, so there
 * cost-per-guess is the only lever that exists. Unifying the two "for
 * consistency" breaks both at once.
 *
 * ## Why there is no `timingSafeEqual` here
 *
 * There is no comparison of attacker input against a stored secret on this
 * path: the string SQLite compares is `sha256(token)`, a *function of* the
 * secret rather than the secret itself. Timing the B-tree lookup tells an
 * attacker about `sha256(guess)`, and exploiting that requires already knowing
 * `sha256(guess)` for the right guess — the preimage problem again.
 *
 * Do not "fix" this by adding a constant-time compare. A constant-time compare
 * is needed when you compare a secret against a stored copy of that secret;
 * here the hash is doing that work. `verifyPassword` is the place in this
 * feature where it genuinely matters, and it already does it.
 */

/**
 * 32 random bytes as base64url is always 43 characters.
 *
 * Every route checks this *before* hashing or touching the database. Not for
 * the hash cost — it is microseconds — but so that a malformed token can never
 * reach a query, so the response is provably not a function of the input's
 * shape (malformed and unknown both answer 404), and so the HTML renderer can
 * rely on the token containing nothing escapable.
 */
export const SHARE_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/

export function generateShareToken(): string {
  return randomBytes(32).toString('base64url')
}

export function hashShareToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex')
}

// ---------------------------------------------------------------------------
// Unlock cookie
// ---------------------------------------------------------------------------

export const SHARE_COOKIE = 'webmux_share'

const SHARE_TYP = 'webmux-share'
const ALG = 'HS256'

export interface ShareClaims {
  /** Share row id. */
  sid: string
  /** The token *hash*, binding the cookie to one token value. */
  th: string
}

/**
 * Signed with the same secret the session tokens use, and that is safe because
 * the two claim sets are disjoint by construction: `verifyToken` requires
 * `sub === 'owner'` and a matching `ver`, which a share cookie cannot present,
 * and this verifier requires `sub === 'share'` plus `typ`, which a session
 * token cannot present. A second secret would mean a second DB row, a second
 * rotation story and a second boot-time read, for a verifier that already
 * cannot be crossed with the other one.
 *
 * The safety rests on that disjointness, so it is asserted in both directions
 * in `shares.test.mjs`. If those tests are ever deleted, this becomes merely
 * convenient rather than safe.
 *
 * `sid` alone would survive a hypothetical in-place token rotation; `th` makes
 * regenerate an unconditional invalidation, because the row's hash changes.
 */
export async function issueShareCookie(
  secret: Uint8Array,
  claims: ShareClaims,
  ttlSeconds: number,
): Promise<string> {
  return new SignJWT({ ...claims })
    .setProtectedHeader({ alg: ALG, typ: SHARE_TYP })
    .setSubject('share')
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + ttlSeconds)
    .sign(secret)
}

/**
 * Verifies the cookie against the share it claims to unlock.
 *
 * Returning true only means *we minted this for that share and token*. It says
 * nothing about whether the share is still live — the row is the authority, and
 * every caller re-reads it. Treating this as authorisation is how a share
 * feature ends up with a revocation bypass that looks correct in review.
 */
export async function verifyShareCookie(
  secret: Uint8Array,
  cookie: string,
  expected: ShareClaims,
): Promise<boolean> {
  try {
    const { payload, protectedHeader } = await jwtVerify(cookie, secret, { algorithms: [ALG] })
    if (protectedHeader.typ !== SHARE_TYP) return false
    if (payload.sub !== 'share') return false
    return payload.sid === expected.sid && payload.th === expected.th
  } catch {
    return false
  }
}
