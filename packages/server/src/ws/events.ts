import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { WebSocket } from 'ws'
import {
  EVENTS_WS_PATH,
  NOTIFY_BACKLOG_LIMIT,
  PING_INTERVAL_MS,
  PONG_TIMEOUT_MS,
  WS_CLOSE,
  notifyClientMessage,
  type NotifyErrorCode,
  type NotifyServerMessage,
} from '@webmux/shared'
import { isAuthenticated, type AuthContext } from '../auth/routes'
import type { Config } from '../config'
import { logger } from '../logger'
import type { NotificationHub } from '../notify/hub'
import type { NotificationStore } from '../notify/store'
import { originAllowed } from './origin'

const log = logger.child('events')

/** How often liveness and backlog are checked. One timer for all connections. */
const MAINTENANCE_INTERVAL_MS = 5_000

/** A socket this far behind is dropped rather than allowed to grow further. */
const HOPELESS_BACKLOG_BYTES = 4 * 1024 * 1024

/**
 * One browser tab's connection to the notification stream.
 *
 * Kept deliberately thin: this carries JSON control frames and nothing else,
 * in contrast to the terminal channel next door, which multiplexes a binary
 * PTY stream, a replay protocol and a resync snapshot onto one socket. Those
 * concerns belong to a session, and notifications do not have one.
 */
class EventConnection {
  lastSeenAt = Date.now()
  lastPingAt = Date.now()
  helloed = false
  closed = false

  constructor(
    readonly socket: WebSocket,
    readonly id: string,
  ) {}

  send(message: NotifyServerMessage): void {
    if (this.closed || this.socket.readyState !== this.socket.OPEN) return
    try {
      this.socket.send(JSON.stringify(message))
    } catch (err) {
      // A send can fail if the socket died between the check and here; the
      // close handler cleans up.
      log.debug(`send failed on ${this.id}: ${(err as Error).message}`)
    }
  }

  fail(code: NotifyErrorCode, message: string): void {
    this.send({ t: 'error', code, message })
  }
}

export interface EventGatewayContext {
  hub: NotificationHub
  store: NotificationStore
  auth: AuthContext
  config: Config
}

export function registerEventGateway(app: FastifyInstance, ctx: EventGatewayContext): void {
  const connections = new Set<EventConnection>()

  /**
   * Brings a client up to date, oldest first.
   *
   * The ordering of the two messages is what makes this correct: everything
   * retained since `since` arrives as one `notify` batch, and the `ready`
   * frame that precedes it carries the authoritative counts. A client can
   * therefore render a consistent view even when the batch was capped, which
   * is the ordinary case after a long absence.
   */
  const catchUp = (connection: EventConnection, since: number | undefined): void => {
    const latestId = ctx.store.latestId()
    const oldest = ctx.store.oldestId()

    // A cursor above the newest id did not come from this database — it was
    // restored from a backup, or the client is pointed at a different data
    // directory. Treat it as a first visit; honouring it would leave the
    // client ignoring every notification until it caught up with a number it
    // invented.
    const usable = since !== undefined && since <= latestId ? since : undefined

    // "Something between what you have and what we kept was deleted."
    const pruned = usable !== undefined && oldest !== null && usable + 1 < oldest

    // One row more than will be sent, so "we hit the cap" can be told apart
    // from "that is the lot". Without it the client moves its cursor to the
    // last id it received and asks for everything after that on the next
    // connect — leaving whatever fell between the cap and the cursor
    // permanently invisible on this channel.
    const fetched = ctx.store.list(NOTIFY_BACKLOG_LIMIT + 1, usable !== undefined ? { since: usable } : {})
    const capped = fetched.length > NOTIFY_BACKLOG_LIMIT
    const items = capped ? fetched.slice(0, NOTIFY_BACKLOG_LIMIT) : fetched
    const truncated = pruned || capped
    const unread = ctx.store.unreadCount()
    connection.send({ t: 'ready', latestId, unread, truncated })

    if (items.length > 0) {
      // Oldest first, and marked as history: a client must not announce a
      // backlog it is only now being told about.
      connection.send({ t: 'notify', items: items.reverse(), unread, catchUp: true })
    }
  }

  app.get(
    EVENTS_WS_PATH,
    {
      websocket: true,
      preValidation: async (req, reply) => {
        if (!originAllowed(req, ctx.config)) {
          log.warn(`rejected event socket from disallowed origin: ${req.headers.origin}`)
          await reply.code(403).send({ error: { code: 'forbidden_origin', message: 'origin not allowed' } })
          return
        }
        if (!(await isAuthenticated(req, ctx.auth))) {
          await reply.code(401).send({ error: { code: 'unauthorized', message: 'authentication required' } })
        }
      },
    },
    (socket: WebSocket, req: FastifyRequest) => {
      const connection = new EventConnection(socket, req.id)
      connections.add(connection)

      // Subscribed before the snapshot is read, and that order is load-bearing:
      // the other way round, a notification published between the read and the
      // subscription would be in neither the snapshot nor the live stream.
      // A duplicate is harmless — the client dedupes by id — a gap is not.
      const unsubscribe = ctx.hub.addSubscriber((message) => connection.send(message))

      socket.on('message', (raw, isBinary) => {
        connection.lastSeenAt = Date.now()

        if (isBinary) {
          connection.fail('bad_message', 'binary frames are not accepted on this channel')
          return
        }

        let decoded: unknown
        try {
          decoded = JSON.parse(raw.toString())
        } catch {
          connection.fail('bad_message', 'malformed JSON')
          return
        }

        const parsed = notifyClientMessage.safeParse(decoded)
        if (!parsed.success) {
          connection.fail('bad_message', parsed.error.issues[0]?.message ?? 'unrecognised message')
          return
        }

        const msg = parsed.data
        switch (msg.t) {
          case 'hello':
            if (connection.helloed) {
              connection.fail('bad_message', 'already greeted on this socket')
              return
            }
            connection.helloed = true
            catchUp(connection, msg.since)
            return

          case 'ping':
            connection.send({ t: 'pong' })
            return

          case 'pong':
            return
        }
      })

      socket.on('close', () => {
        connection.closed = true
        connections.delete(connection)
        unsubscribe()
      })

      socket.on('error', (err) => {
        log.debug(`socket error on ${connection.id}: ${err.message}`)
      })
    },
  )

  /**
   * One timer for every connection.
   *
   * Note the ping is unconditional. The terminal gateway next door only pings
   * sockets that have attached to a session, because an unattached one is
   * about to go away — here there is no attach, so copying that condition
   * would leave every connection silent and reaped after PONG_TIMEOUT_MS.
   */
  const maintenance = setInterval(() => {
    const now = Date.now()
    for (const connection of connections) {
      if (connection.closed) continue

      if (now - connection.lastSeenAt > PONG_TIMEOUT_MS) {
        log.debug(`event client ${connection.id} timed out`)
        connection.closed = true
        connection.socket.close(WS_CLOSE.SHUTTING_DOWN, 'ping timeout')
        continue
      }

      if (connection.socket.bufferedAmount > HOPELESS_BACKLOG_BYTES) {
        log.warn(`event client ${connection.id} backlog, dropping`)
        connection.closed = true
        connection.socket.close(WS_CLOSE.TOO_SLOW, 'client too slow')
        continue
      }

      // Only greeted clients are pinged: before the handshake frame there is
      // nothing to keep alive, and the client is expected to send it at once.
      if (connection.helloed && now - connection.lastPingAt >= PING_INTERVAL_MS) {
        connection.lastPingAt = now
        connection.send({ t: 'ping' })
      }
    }
  }, MAINTENANCE_INTERVAL_MS)
  maintenance.unref?.()

  app.addHook('onClose', async () => {
    clearInterval(maintenance)
    for (const connection of connections) {
      connection.closed = true
      try {
        connection.socket.close(WS_CLOSE.SHUTTING_DOWN, 'server shutting down')
      } catch {
        // Already closing.
      }
    }
    connections.clear()
  })
}
