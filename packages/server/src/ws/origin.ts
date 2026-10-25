import type { FastifyRequest } from 'fastify'
import type { Config } from '../config'

/**
 * Validates the Origin header on upgrade. Shared by every WebSocket route.
 *
 * This check is not optional, and it applies to the event channel exactly as
 * it does to the terminal one. WebSocket upgrades are **not** subject to CORS
 * or the same-origin policy, so a page on any origin can open a socket to this
 * server, and the browser will attach the session cookie to the handshake.
 * Without an Origin check that is a cross-site WebSocket hijacking hole: on
 * `/ws/terminal` it leads straight into a shell, and on `/ws/events` it hands
 * an attacker the notification stream — which carries session ids, command
 * text and exit codes.
 *
 * A missing Origin means the client is not a browser (browsers always send it
 * for WebSocket), so the cookie still has to be valid on its own merits.
 */
export function originAllowed(req: FastifyRequest, config: Config): boolean {
  const origin = req.headers.origin
  if (!origin) return true
  if (config.allowedOrigins.includes(origin)) return true

  const host = req.headers.host
  if (!host) return false
  try {
    return new URL(origin).host === host
  } catch {
    return false
  }
}
