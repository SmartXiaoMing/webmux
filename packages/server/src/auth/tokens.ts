import { randomBytes } from 'node:crypto'
import { SignJWT, jwtVerify } from 'jose'
import type { DB } from '../db/index'
import { getSetting, setSetting } from '../db/index'

const ALG = 'HS256'
export const SESSION_COOKIE = 'webmux_session'

const SECRET_KEY = 'auth.jwt_secret'
const VERSION_KEY = 'auth.token_version'

/**
 * The signing secret is generated on first run and kept in the database. It is
 * never derived from the password, so a password change does not silently
 * invalidate it — that is what `token_version` is for.
 */
export function getOrCreateSecret(db: DB): Uint8Array {
  let secret = getSetting(db, SECRET_KEY)
  if (!secret) {
    secret = randomBytes(32).toString('base64')
    setSetting(db, SECRET_KEY, secret)
  }
  return new Uint8Array(Buffer.from(secret, 'base64'))
}

export function getTokenVersion(db: DB): number {
  return Number(getSetting(db, VERSION_KEY) ?? '0') || 0
}

/**
 * Invalidates every issued token at once — used on password change and on an
 * explicit "sign out everywhere".
 */
export function bumpTokenVersion(db: DB): void {
  setSetting(db, VERSION_KEY, String(getTokenVersion(db) + 1))
}

export interface TokenClaims {
  ver: number
}

export async function issueToken(secret: Uint8Array, version: number, ttlHours: number): Promise<string> {
  return new SignJWT({ ver: version })
    .setProtectedHeader({ alg: ALG })
    .setSubject('owner')
    .setIssuedAt()
    .setExpirationTime(`${ttlHours}h`)
    .sign(secret)
}

export async function verifyToken(secret: Uint8Array, token: string, currentVersion: number): Promise<boolean> {
  try {
    const { payload } = await jwtVerify(token, secret, { algorithms: [ALG] })
    return payload.sub === 'owner' && payload.ver === currentVersion
  } catch {
    return false
  }
}

export interface CookieOptions {
  httpOnly: true
  sameSite: 'lax'
  secure: boolean
  path: string
  maxAge: number
}

/**
 * `SameSite=Lax` is sufficient here: the SPA is same-origin, and Lax still
 * blocks the cookie on cross-site POSTs. WebSocket upgrades are exempt from
 * SameSite entirely, which is exactly why the upgrade handler independently
 * validates the Origin header — see ws/gateway.ts.
 */
export function sessionCookieOptions(secure: boolean, ttlHours: number): CookieOptions {
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure,
    path: '/',
    maxAge: ttlHours * 3600,
  }
}
