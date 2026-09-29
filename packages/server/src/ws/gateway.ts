import { randomBytes } from 'node:crypto'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { WebSocket } from 'ws'
import {
  PING_INTERVAL_MS,
  PONG_TIMEOUT_MS,
  WS_CLOSE,
  WS_PATH,
  clientMessage,
  type ErrorCode,
  type ServerMessage,
} from '@webmux/shared'
import type { AuthContext } from '../auth/routes'
import { isAuthenticated } from '../auth/routes'
import type { Config } from '../config'
import { logger } from '../logger'
import type { SessionRegistry } from '../terminal/registry'
import type { Session, SessionClient } from '../terminal/session'

const log = logger.child('ws')

/** A socket this far behind is dropped rather than allowed to grow further. */
const HOPELESS_BACKLOG_BYTES = 64 * 1024 * 1024

/** How often heartbeat and backlog checks run. One timer for all connections. */
const MAINTENANCE_INTERVAL_MS = 5_000

interface Connection {
  id: string
  socket: WebSocket
  client: WsSessionClient
  session: Session | null
  /** Any inbound frame counts as proof of life, not just an explicit pong. */
  lastSeenAt: number
  lastPingAt: number
  attached: boolean
  closed: boolean
}

/**
 * Adapts a WebSocket to the transport-agnostic `SessionClient` interface.
 * All protocol state lives in Session; this only moves bytes.
 */
class WsSessionClient implements SessionClient {
  readonly id: string
  private closedFlag = false

  constructor(private readonly socket: WebSocket) {
    this.id = randomBytes(4).toString('hex')
  }

  /**
   * Read by `Session.attachClient` after its `await`, to catch a socket that
   * died while the session was still starting up.
   */
  get closed(): boolean {
    return this.closedFlag
  }

  get bufferedAmount(): number {
    return this.socket.bufferedAmount
  }

  sendControl(msg: ServerMessage): void {
    this.send(JSON.stringify(msg))
  }

  sendData(buf: Buffer): void {
    this.send(buf)
  }

  private send(payload: string | Buffer): void {
    if (this.closedFlag || this.socket.readyState !== this.socket.OPEN) return
    try {
      this.socket.send(payload, { binary: Buffer.isBuffer(payload) })
    } catch (err) {
      // A send can fail if the socket died between the readyState check and
      // here; the close handler will clean up.
      log.debug(`send failed on client ${this.id}: ${(err as Error).message}`)
    }
  }

  close(code: number, reason: string): void {
    if (this.closedFlag) return
    this.closedFlag = true
    try {
      this.socket.close(code, reason)
    } catch {
      // Already closing.
    }
  }

  markClosed(): void {
    this.closedFlag = true
  }
}

export interface GatewayContext {
  registry: SessionRegistry
  auth: AuthContext
  config: Config
}

/**
 * Validates the Origin header on upgrade.
 *
 * This check is not optional. WebSocket upgrades are **not** subject to CORS or
 * the same-origin policy, so a page on any origin can open a socket to this
 * server, and the browser will attach the session cookie to the handshake.
 * Without an Origin check that is a cross-site WebSocket hijacking hole
 * straight into a shell.
 *
 * A missing Origin means the client is not a browser (browsers always send it
 * for WebSocket), so the cookie still has to be valid on its own merits.
 */
function originAllowed(req: FastifyRequest, config: Config): boolean {
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

export function registerTerminalGateway(app: FastifyInstance, ctx: GatewayContext): void {
  const connections = new Set<Connection>()

  app.get(
    WS_PATH,
    {
      websocket: true,
      preValidation: async (req, reply) => {
        if (!originAllowed(req, ctx.config)) {
          log.warn(`rejected websocket from disallowed origin: ${req.headers.origin}`)
          await reply.code(403).send({ error: { code: 'forbidden_origin', message: 'origin not allowed' } })
          return
        }
        if (!(await isAuthenticated(req, ctx.auth))) {
          await reply.code(401).send({ error: { code: 'unauthorized', message: 'authentication required' } })
        }
      },
    },
    (socket: WebSocket, req: FastifyRequest) => {
      const client = new WsSessionClient(socket)
      const now = Date.now()
      const connection: Connection = {
        id: client.id,
        socket,
        client,
        session: null,
        lastSeenAt: now,
        lastPingAt: now,
        attached: false,
        closed: false,
      }
      connections.add(connection)

      const fail = (code: ErrorCode, message: string): void => {
        client.sendControl({ t: 'error', code, message })
      }

      socket.on('message', (raw, isBinary) => {
        connection.lastSeenAt = Date.now()

        // The client never sends binary frames; terminal input is keystrokes.
        if (isBinary) {
          fail('bad_message', 'binary frames are not accepted from clients')
          return
        }

        let decoded: unknown
        try {
          decoded = JSON.parse(raw.toString())
        } catch {
          fail('bad_message', 'malformed JSON')
          return
        }

        const parsed = clientMessage.safeParse(decoded)
        if (!parsed.success) {
          fail('bad_message', parsed.error.issues[0]?.message ?? 'unrecognised message')
          return
        }

        const msg = parsed.data
        switch (msg.t) {
          case 'ping':
            client.sendControl({ t: 'pong' })
            return

          case 'pong':
            // lastSeenAt already refreshed above; nothing further to do.
            return

          case 'attach': {
            if (connection.attached) {
              fail('bad_message', 'already attached on this socket')
              return
            }
            const session = ctx.registry.get(msg.sessionId)
            if (!session) {
              fail('session_not_found', `no such session: ${msg.sessionId}`)
              return
            }
            connection.attached = true
            connection.session = session

            // The client's own dimensions win: it is the one with a real
            // viewport. Resizing before the snapshot is built means the
            // snapshot is already the right shape when it arrives.
            void session
              .resize(msg.cols, msg.rows)
              // A failed resize is not a failed attach, and handling them with
              // one `catch` made it one: a transient hiccup on `resize-window`
              // would close a connection that was about to work, and send the
              // client into backoff over a session that is perfectly healthy.
              // The cost of carrying on is the previous dimensions, which the
              // next resize corrects.
              .catch((err: unknown) => {
                log.warn(`resize before attach failed for ${msg.sessionId}: ${(err as Error).message}`)
              })
              .then(() => session.attachClient(client, msg.lastSeq))
              .catch((err: unknown) => {
                log.error(`attach failed for session ${msg.sessionId}`, err)
                fail('internal', 'failed to attach to session')
                client.close(1011, 'attach failed')
              })
            return
          }

          case 'input': {
            connection.session?.write(msg.data)
            return
          }

          case 'resize': {
            void connection.session?.resize(msg.cols, msg.rows).catch((err: unknown) => {
              log.debug(`resize failed: ${(err as Error).message}`)
            })
            return
          }
        }
      })

      socket.on('close', () => {
        connection.closed = true
        connections.delete(connection)
        client.markClosed()
        connection.session?.detachClient(client)
      })

      socket.on('error', (err) => {
        log.debug(`socket error on client ${client.id}: ${err.message}`)
      })
    },
  )

  /**
   * One timer drives liveness and backlog enforcement for every connection.
   * Application-level pings are used rather than protocol-level ones because
   * browser JavaScript cannot observe protocol pongs.
   */
  const maintenance = setInterval(() => {
    const now = Date.now()
    for (const connection of connections) {
      if (connection.closed) continue

      if (now - connection.lastSeenAt > PONG_TIMEOUT_MS) {
        log.debug(`client ${connection.id} timed out`)
        connection.client.close(WS_CLOSE.SHUTTING_DOWN, 'ping timeout')
        continue
      }

      if (connection.client.bufferedAmount > HOPELESS_BACKLOG_BYTES) {
        log.warn(`client ${connection.id} backlog ${connection.client.bufferedAmount} bytes, dropping`)
        connection.client.close(WS_CLOSE.TOO_SLOW, 'client too slow')
        continue
      }

      if (connection.attached && now - connection.lastPingAt >= PING_INTERVAL_MS) {
        connection.lastPingAt = now
        connection.client.sendControl({ t: 'ping' })
      }

      connection.session?.reevaluateBackpressure()
    }
  }, MAINTENANCE_INTERVAL_MS)
  maintenance.unref?.()

  app.addHook('onClose', async () => {
    clearInterval(maintenance)
    for (const connection of connections) {
      connection.client.close(WS_CLOSE.SHUTTING_DOWN, 'server shutting down')
    }
    connections.clear()
  })
}
