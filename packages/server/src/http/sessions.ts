import type { FastifyInstance } from 'fastify'
import { createSessionRequest, type SessionSummary } from '@webmux/shared'
import type { AuthContext } from '../auth/routes'
import { requireAuth } from '../auth/routes'
import { audit } from '../audit'
import { logger } from '../logger'
import type { SessionRegistry } from '../terminal/registry'

const log = logger.child('http:sessions')

export interface SessionRoutesContext {
  registry: SessionRegistry
  auth: AuthContext
}

export function registerSessionRoutes(app: FastifyInstance, ctx: SessionRoutesContext): void {
  const auth = requireAuth(ctx.auth)

  app.get('/api/sessions', { preHandler: auth }, async (): Promise<SessionSummary[]> => {
    return ctx.registry.list()
  })

  app.post('/api/sessions', { preHandler: auth }, async (req, reply) => {
    const parsed = createSessionRequest.safeParse(req.body ?? {})
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: { code: 'invalid_request', message: parsed.error.issues[0]?.message ?? 'invalid body' } })
    }

    try {
      const session = await ctx.registry.create(parsed.data)
      audit(ctx.auth.db, 'session.create', session.id, req.ip)
      return reply.code(201).send(session.toSummary())
    } catch (err) {
      const code = (err as { code?: string }).code
      if (code === 'session_limit') {
        return reply.code(429).send({ error: { code, message: (err as Error).message } })
      }
      log.error('failed to create session', err)
      return reply.code(500).send({ error: { code: 'internal', message: 'failed to create session' } })
    }
  })

  app.patch<{ Params: { id: string }; Body: { title?: string } }>(
    '/api/sessions/:id',
    { preHandler: auth },
    async (req, reply) => {
      const session = ctx.registry.get(req.params.id)
      if (!session) {
        return reply.code(404).send({ error: { code: 'session_not_found', message: 'no such session' } })
      }

      const title = req.body?.title?.trim()
      if (!title || title.length > 128) {
        return reply
          .code(400)
          .send({ error: { code: 'invalid_request', message: 'title must be 1-128 characters' } })
      }

      await session.setTitle(title)
      return session.toSummary()
    },
  )

  app.delete<{ Params: { id: string } }>('/api/sessions/:id', { preHandler: auth }, async (req, reply) => {
    const killed = await ctx.registry.kill(req.params.id)
    if (!killed) {
      return reply.code(404).send({ error: { code: 'session_not_found', message: 'no such session' } })
    }
    audit(ctx.auth.db, 'session.kill', req.params.id, req.ip)
    return reply.code(204).send()
  })
}
