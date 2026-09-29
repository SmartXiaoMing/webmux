import path from 'node:path'
import type { FastifyInstance, FastifyReply } from 'fastify'
import {
  placeFavoriteRequest,
  placeOpenedRequest,
  type Place,
  type PlacesResponse,
} from '@webmux/shared'
import { requireAuth, type AuthContext } from '../auth/routes'
import { toFsError, type Jail, type ResolvedPath } from '../fs/jail'
import { logger } from '../logger'
import { MAX_FAVORITES, MAX_RECENT, type PlaceRow, type PlaceStore } from '../places/store'

const log = logger.child('http:places')

export interface PlaceRoutesContext {
  jail: Jail
  places: PlaceStore
  auth: AuthContext
}

function firstIssue(error: { issues: Array<{ message?: string }> }): string {
  return error.issues[0]?.message ?? 'invalid request'
}

function toPlace(row: PlaceRow): Place {
  return {
    path: row.path,
    name: row.name,
    favorite: row.favorite_at !== null,
    lastOpenedAt: row.opened_at,
  }
}

export function registerPlaceRoutes(app: FastifyInstance, ctx: PlaceRoutesContext): void {
  const auth = requireAuth(ctx.auth)

  /**
   * Resolves a directory the caller wants remembered.
   *
   * Through the jail, and on the *write* path only. These paths are handed back
   * to the file browser and navigated to later, so an out-of-jail or
   * non-existent one should be refused while the caller can still be told why.
   *
   * Reads deliberately do not probe: that would be one `stat` per row on every
   * sidebar load, and a favourite whose directory has since vanished costs
   * nothing worse than a clear error from the browser when it is clicked.
   */
  async function resolveDirectory(target: string): Promise<ResolvedPath> {
    return ctx.jail.resolveDir(target)
  }

  function displayName(resolved: ResolvedPath): string {
    return path.basename(resolved.abs) || resolved.root.name
  }

  function sendFsError(reply: FastifyReply, err: unknown, context: string): FastifyReply {
    const fsError = toFsError(err)
    if (fsError.status >= 500) log.error(`${context}: ${fsError.message}`, err)
    return reply.code(fsError.status).send({ error: { code: fsError.code, message: fsError.message } })
  }

  app.get('/api/places', { preHandler: auth }, async (): Promise<PlacesResponse> => {
    return {
      favorites: ctx.places.listFavorites().map(toPlace),
      recent: ctx.places.listRecent().map(toPlace),
      limits: { maxFavorites: MAX_FAVORITES, maxRecent: MAX_RECENT },
    }
  })

  app.put('/api/places/favorite', { preHandler: auth }, async (req, reply) => {
    const parsed = placeFavoriteRequest.safeParse(req.body ?? {})
    if (!parsed.success) return reply.code(400).send({ error: { code: 'invalid_request', message: firstIssue(parsed.error) } })

    try {
      const resolved = await resolveDirectory(parsed.data.path)
      ctx.places.setFavorite(resolved.abs, displayName(resolved), parsed.data.favorite)
      // Returns the whole list so the client does not have to refetch, and
      // cannot drift from the server's ordering.
      return {
        favorites: ctx.places.listFavorites().map(toPlace),
        recent: ctx.places.listRecent().map(toPlace),
        limits: { maxFavorites: MAX_FAVORITES, maxRecent: MAX_RECENT },
      } satisfies PlacesResponse
    } catch (err) {
      return sendFsError(reply, err, 'favorite')
    }
  })

  app.put('/api/places/opened', { preHandler: auth }, async (req, reply) => {
    const parsed = placeOpenedRequest.safeParse(req.body ?? {})
    if (!parsed.success) return reply.code(400).send({ error: { code: 'invalid_request', message: firstIssue(parsed.error) } })

    try {
      const resolved = await resolveDirectory(parsed.data.path)
      ctx.places.recordOpened(resolved.abs, displayName(resolved))
      return reply.code(204).send()
    } catch (err) {
      return sendFsError(reply, err, 'opened')
    }
  })
}
