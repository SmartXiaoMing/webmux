import type { FastifyInstance } from 'fastify'
import { quickKeyRequest, type QuickKey, type QuickKeysResponse } from '@webmux/shared'
import { requireAuth, type AuthContext } from '../auth/routes'
import { MAX_QUICK_KEYS, type QuickKeyRow, type QuickKeyStore } from '../quickkeys/store'

export interface QuickKeyRoutesContext {
  quickKeys: QuickKeyStore
  auth: AuthContext
}

function firstIssue(error: { issues: Array<{ message?: string }> }): string {
  return error.issues[0]?.message ?? 'invalid request'
}

function toKey(row: QuickKeyRow): QuickKey {
  return { id: row.id, label: row.label, text: row.text, sendEnter: row.send_enter === 1 }
}

/**
 * Every mutating route answers with the whole list, mirroring `places`: the
 * editor replaces its copy from the response rather than refetching, so it
 * cannot drift from the server's order, and removing one key costs no second
 * request.
 */
function response(store: QuickKeyStore): QuickKeysResponse {
  return {
    keys: store.list().map(toKey),
    limits: { maxKeys: MAX_QUICK_KEYS },
  }
}

/**
 * Macros for the accessory key bar.
 *
 * Deliberately not audited, unlike the session and file routes: this is a UI
 * preference, and nothing here reaches outside the database. Calling `audit`
 * would bury the events that do matter under a log line per edit.
 */
export function registerQuickKeyRoutes(app: FastifyInstance, ctx: QuickKeyRoutesContext): void {
  const auth = requireAuth(ctx.auth)

  app.get('/api/quickkeys', { preHandler: auth }, async (): Promise<QuickKeysResponse> => {
    return response(ctx.quickKeys)
  })

  app.post('/api/quickkeys', { preHandler: auth }, async (req, reply) => {
    const parsed = quickKeyRequest.safeParse(req.body ?? {})
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: { code: 'invalid_request', message: firstIssue(parsed.error) } })
    }

    // Refused rather than trimmed: dropping the key the user just created would
    // look like the save silently failed.
    if (ctx.quickKeys.count() >= MAX_QUICK_KEYS) {
      return reply.code(409).send({
        error: { code: 'quick_key_limit', message: `最多只能有 ${MAX_QUICK_KEYS} 个快捷键` },
      })
    }

    const { label, text, sendEnter } = parsed.data
    ctx.quickKeys.create(label, text, sendEnter)
    return reply.code(201).send(response(ctx.quickKeys))
  })

  app.put<{ Params: { id: string } }>(
    '/api/quickkeys/:id',
    { preHandler: auth },
    async (req, reply) => {
      const parsed = quickKeyRequest.safeParse(req.body ?? {})
      if (!parsed.success) {
        return reply
          .code(400)
          .send({ error: { code: 'invalid_request', message: firstIssue(parsed.error) } })
      }

      const { label, text, sendEnter } = parsed.data
      const updated = ctx.quickKeys.update(req.params.id, label, text, sendEnter)
      if (!updated) {
        return reply
          .code(404)
          .send({ error: { code: 'quick_key_not_found', message: 'no such quick key' } })
      }

      return response(ctx.quickKeys)
    },
  )

  app.delete<{ Params: { id: string } }>(
    '/api/quickkeys/:id',
    { preHandler: auth },
    async (req, reply) => {
      if (!ctx.quickKeys.remove(req.params.id)) {
        return reply
          .code(404)
          .send({ error: { code: 'quick_key_not_found', message: 'no such quick key' } })
      }

      return response(ctx.quickKeys)
    },
  )
}
