import path from 'node:path'
import { existsSync } from 'node:fs'
import Fastify, { type FastifyError, type FastifyReply, type FastifyRequest } from 'fastify'
import cookie from '@fastify/cookie'
import fastifyStatic from '@fastify/static'
import websocket from '@fastify/websocket'
import { forwardedHeaderWarning, loadConfig, plaintextWarning } from './config'
import { openDatabase } from './db/index'
import { logger } from './logger'
import { getOrCreateSecret } from './auth/tokens'
import { registerAuthRoutes, isInitialized, type AuthContext } from './auth/routes'
import { FailureLimiter } from './auth/ratelimit'
import { registerFileRoutes } from './http/files'
import { registerShareRoutes } from './http/shares'
import { registerPublicShareRoutes } from './http/shares-public'
import { registerPlaceRoutes } from './http/places'
import { registerQuickKeyRoutes } from './http/quickkeys'
import { PlaceStore } from './places/store'
import { QuickKeyStore } from './quickkeys/store'
import { ShareStore } from './shares/store'
import { VerifyGate } from './shares/verify'
import { registerSessionRoutes } from './http/sessions'
import { createJail, loadRoots } from './fs/jail'
import { UploadStore } from './fs/upload'
import { registerTerminalGateway } from './ws/gateway'
import { SessionRegistry } from './terminal/registry'
import { TmuxBackend } from './terminal/tmux'

const log = logger.child('boot')

async function main(): Promise<void> {
  const config = loadConfig()
  const db = openDatabase(config.dataDir)
  const secret = getOrCreateSecret(db)

  const auth: AuthContext = { db, config, secret }

  const backend = new TmuxBackend({
    socket: config.tmuxSocket,
    prefix: 'webmux-',
    shell: config.shell,
  })

  // Fail loudly and early: without tmux there is no session persistence, and
  // starting anyway would silently produce a much weaker product.
  if (!(await backend.probe())) {
    log.error('tmux is not installed or not on PATH — session persistence requires it')
    log.error('  macOS:  brew install tmux')
    log.error('  Debian: apt install tmux')
    process.exit(1)
  }

  const registry = new SessionRegistry({ backend, config })

  // Canonicalised once, at boot. Every containment check downstream compares
  // against these paths, so resolving per request would be both slower and
  // subtly wrong for a root that is itself reached through a symlink.
  //
  // A root that cannot be resolved is marked unavailable rather than fatal —
  // see loadRoots for why that differs from the tmux check above.
  const jail = await createJail(await loadRoots(config.files.roots, config.dataDir), config.dataDir)
  const uploads = new UploadStore(
    jail,
    config.dataDir,
    config.files.uploadTtlHours * 3_600_000,
    config.files.maxUploadBytes,
  )

  const shares = new ShareStore(db)
  const places = new PlaceStore(db)
  const quickKeys = new QuickKeyStore(db)
  // The gate bounds how many scrypt verifications run at once; without it a
  // flood of unlock attempts occupies the libuv threadpool, which every
  // `fs.promises` call in the process shares. See shares/verify.ts.
  const shareGate = new VerifyGate(
    config.shares.maxConcurrentVerifications,
    config.shares.globalVerifyPerMinute,
  )
  const shareLimiter = new FailureLimiter(
    config.shares.unlockFailures,
    config.shares.unlockWindowMinutes * 60_000,
  )

  const app = Fastify({
    logger: false,
    // Only honoured when explicitly enabled, so a misconfigured proxy cannot
    // let a client spoof its own address past the login rate limiter.
    trustProxy: config.trustProxy,
  })

  await app.register(cookie)

  // Many HTTP clients send a default `Content-Type: application/json` even on
  // requests that carry no body (DELETE, or a POST with nothing to say).
  // Fastify's stock parser rejects that pairing with an opaque 400, which is
  // both surprising to debug and trivially avoidable: treat an empty body as
  // absent and let the route's own schema decide what is required.
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
    const raw = typeof body === 'string' ? body.trim() : ''
    if (raw === '') {
      done(null, undefined)
      return
    }
    try {
      done(null, JSON.parse(raw))
    } catch {
      const err = Object.assign(new Error('request body is not valid JSON'), { statusCode: 400 })
      done(err, undefined)
    }
  })

  // Resumable uploads send raw bytes rather than JSON. Buffered rather than
  // streamed because a chunk is bounded by the route's bodyLimit, and a Buffer
  // is exactly what the positional write wants.
  app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer' }, (_req, body, done) => {
    done(null, body)
  })

  app.setErrorHandler((err: FastifyError, req: FastifyRequest, reply: FastifyReply) => {
    const status = err.statusCode && err.statusCode >= 400 ? err.statusCode : 500
    if (status >= 500) log.error(`unhandled error on ${req.method} ${req.url}`, err)
    void reply.code(status).send({
      error: { code: status >= 500 ? 'internal' : 'invalid_request', message: err.message },
    })
  })

  registerAuthRoutes(app, auth)
  registerSessionRoutes(app, { registry, auth })
  registerFileRoutes(app, { jail, uploads, auth })
  registerShareRoutes(app, { jail, shares, auth, config })
  registerPlaceRoutes(app, { jail, places, auth })
  registerQuickKeyRoutes(app, { quickKeys, auth })
  // Registered before the static handler and the SPA fallback, but more
  // importantly it is a parametric route: `find-my-way` prefers parametric over
  // `@fastify/static`'s `/*`, so `/s/...` reaches this rather than index.html
  // regardless of registration order.
  registerPublicShareRoutes(app, { jail, shares, auth, config, gate: shareGate, limiter: shareLimiter })

  await app.register(websocket)
  registerTerminalGateway(app, { registry, auth, config })

  // In production the built SPA is served from here; in development Vite serves
  // it and proxies /api and /ws to this process.
  const webRoot = path.resolve(import.meta.dirname, '../../web/dist')
  if (existsSync(webRoot)) {
    await app.register(fastifyStatic, { root: webRoot })
    // SPA fallback: any non-API path renders the app shell.
    app.setNotFoundHandler((req, reply) => {
      // Build artefacts must 404 rather than fall through to the shell.
      //
      // This is what turns a stale client into a white screen: a service worker
      // or a bfcached page holding an old index.html asks for an asset hash the
      // current build deleted, and answering with HTML where a module was
      // expected fails to execute. Saying "not found" lets the client recover.
      if (
        req.url.startsWith('/api') ||
        req.url.startsWith('/ws') ||
        req.url.startsWith('/assets/') ||
        req.url.startsWith('/icons/') ||
        req.url === '/sw.js' ||
        req.url === '/manifest.json'
      ) {
        return reply.code(404).send({ error: { code: 'not_found', message: 'no such route' } })
      }
      return reply.sendFile('index.html')
    })
    log.info(`serving client from ${webRoot}`)
  }

  const adopted = await registry.adoptOrphans()
  if (adopted > 0) log.info(`resumed ${adopted} session(s) from a previous run`)

  // Started after adoption so the first tick has sessions to describe, and
  // before listening so the sidebar never shows a stale directory for a
  // session that has been cd'd around since webmux last ran.
  registry.startLiveCwdRefresh()

  // The only sweep that finds staging areas stranded by a crash, a SIGKILL or
  // a container restart. Expiry is by idle time rather than "clear everything",
  // so restarting mid-upload does not discard the progress that makes a
  // resumable upload worth having.
  const reclaimed = await uploads.sweep()
  if (reclaimed > 0) log.info(`reclaimed ${reclaimed} abandoned upload(s)`)

  await app.listen({ host: config.host, port: config.port })

  const url = `http://${config.host === '0.0.0.0' ? 'localhost' : config.host}:${config.port}`
  log.info(`listening on ${url}`)

  // Warned rather than refused: a LAN or a VPN is a legitimate place to run
  // this, and the server cannot tell a trusted network from an open one. What
  // it can do is make sure the operator knows there is no TLS here, because
  // the failure mode is silent.
  for (const warning of [
    plaintextWarning(config.host),
    forwardedHeaderWarning(config.host, config.trustProxy),
  ]) {
    if (warning !== null) log.warn(warning)
  }

  if (!isInitialized(db)) {
    log.info(`no password set yet — open ${url} to complete setup`)
  }

  let shuttingDown = false
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return
    shuttingDown = true
    log.info(`received ${signal}, shutting down`)

    // Close the listener first so no new work arrives, then detach client
    // ptys. Backing tmux sessions are deliberately left running.
    try {
      await app.close()
    } catch (err) {
      log.warn(`error closing server: ${(err as Error).message}`)
    }
    await registry.shutdown()
    db.close()
    log.info('goodbye — sessions remain running in tmux')
    process.exit(0)
  }

  process.on('SIGINT', () => void shutdown('SIGINT'))
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
}

main().catch((err: unknown) => {
  log.error('fatal startup error', err)
  process.exit(1)
})
