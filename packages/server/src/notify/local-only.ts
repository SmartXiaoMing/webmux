import { timingSafeEqual } from 'node:crypto'
import type net from 'node:net'
import type { FastifyRequest } from 'fastify'
import { addressAllowed } from '../config'

/**
 * Why a request to the local-only ingress was refused. Returned rather than
 * thrown so the route can pick the status code, and so the reason can reach
 * the audit log — an operator debugging a script that suddenly gets 403s wants
 * to know which of the four checks said no.
 */
export type LocalOnlyRejection = 'origin' | 'peer' | 'forwarded' | 'token'

/**
 * The header a local caller presents, and the fallbacks that make `curl` work
 * without reading the docs twice.
 */
function presentedToken(req: FastifyRequest): string | null {
  const header = req.headers['x-webmux-token']
  if (typeof header === 'string' && header !== '') return header

  const authorization = req.headers.authorization
  if (typeof authorization === 'string' && authorization.toLowerCase().startsWith('bearer ')) {
    return authorization.slice(7).trim()
  }
  return null
}

/**
 * Constant-time comparison, with the length check done first.
 *
 * `timingSafeEqual` throws when the two buffers differ in length, so the check
 * is not optional. Returning early on a length mismatch does leak the length
 * of the secret, which is fixed and public anyway — the token is generated
 * here, and every reply either matches or does not.
 */
export function tokenMatches(presented: string | null, expected: string): boolean {
  if (presented === null) return false

  const a = Buffer.from(presented, 'utf8')
  const b = Buffer.from(expected, 'utf8')
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

/**
 * Strips the port from one `X-Forwarded-For` entry, or null when the entry is
 * not an address.
 *
 * The header's grammar, as it is actually sent, is `ip`, `ip:port`,
 * `[v6]:port`, or occasionally a literal like `unknown`. Anything unparseable
 * returns null, and null is treated as a failure by the caller: a hop that
 * cannot be read is a hop that cannot be shown to be local, and guessing in
 * the permissive direction here would defeat the whole check.
 */
function forwardedHop(entry: string): string | null {
  const text = entry.trim()
  if (text === '') return null

  if (text.startsWith('[')) {
    const end = text.indexOf(']')
    return end === -1 ? null : text.slice(1, end)
  }

  const colons = (text.match(/:/g) ?? []).length
  // More than one colon and no brackets: a bare IPv6 address, no port.
  if (colons > 1) return text
  if (colons === 1) {
    const [host, port] = text.split(':')
    return host !== undefined && port !== undefined && /^\d+$/.test(port) ? host : null
  }
  return text
}

/**
 * Whether every hop a proxy recorded is a local address.
 *
 * Checked in full rather than only at the ends. The common nginx directive is
 * `$proxy_add_x_forwarded_for`, which *appends* the peer address to whatever
 * the client sent — so a request can arrive claiming `127.0.0.1, 203.0.113.9`,
 * with the loopback first precisely because the client put it there. Only
 * looking at the last entry passes that; only looking at the first fails every
 * legitimate proxy. Requiring all of them is the check that means what it says.
 */
function forwardedChainIsLocal(header: string, allow: net.BlockList): boolean {
  const hops = header.split(',')
  if (hops.length === 0) return false
  return hops.every((hop) => {
    const address = forwardedHop(hop)
    return address !== null && addressAllowed(allow, address)
  })
}

/**
 * The four checks, in the order that makes a failure cheapest to explain.
 *
 * 1. **No `Origin` header.** Browsers attach one to every POST they make —
 *    cross-origin, same-origin, form, `fetch`, `sendBeacon` — and no local
 *    script does. Note that `Origin: null` (a `file://` page, a sandboxed
 *    iframe) is a *present* header and is refused like any other; testing for
 *    "an origin that is not null" would be the bug here, not the fix.
 * 2. **Peer address**, from `req.socket.remoteAddress` and never from
 *    `req.ip`. With `trustProxy` on, `req.ip` is read from
 *    `X-Forwarded-For`, which is the client's own text — the same forgery
 *    `forwardedHeaderWarning` in config.ts exists to warn about. Do not
 *    "simplify" this to `req.ip`.
 * 3. **The forwarded chain**, because a reverse proxy on this host makes the
 *    peer address loopback for traffic from anywhere. See
 *    `forwardedChainIsLocal`.
 * 4. **The token**, which is what remains once a caller is provably local —
 *    and, behind a proxy that sends no forwarding header at all, the only
 *    check that still holds.
 */
export function localOnlyRejection(
  req: FastifyRequest,
  allow: net.BlockList,
  token: string,
): LocalOnlyRejection | null {
  if (req.headers.origin !== undefined) return 'origin'
  if (!addressAllowed(allow, req.socket.remoteAddress)) return 'peer'

  const forwarded = req.headers['x-forwarded-for']
  if (typeof forwarded === 'string' && !forwardedChainIsLocal(forwarded, allow)) return 'forwarded'

  if (!tokenMatches(presentedToken(req), token)) return 'token'
  return null
}
