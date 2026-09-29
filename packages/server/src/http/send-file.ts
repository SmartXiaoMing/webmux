import { constants as FS } from 'node:fs'
import { open } from 'node:fs/promises'
import path from 'node:path'
import { Readable } from 'node:stream'
import type { FastifyReply, FastifyRequest } from 'fastify'
import { toFsError, type Jail } from '../fs/jail'
import {
  contentDisposition,
  inlineDisposition,
  parseRange,
  type RangeResult,
} from '../fs/stream'
import { paced } from './throttle'

/**
 * The one place a file is turned into a response.
 *
 * Shared by the internal download and preview routes and by the public share
 * route, so the parts that are easy to get wrong exist exactly once:
 * `O_NOFOLLOW` on an already-canonical path, metadata read from the descriptor
 * rather than from a second path-based stat, the Range grammar, and the header
 * ordering that keeps a JSON error body from going out under the file's own
 * content type. That last one was a real bug — a 416 whose body was serialised
 * as the file's `text/plain` became a 500.
 */

export interface SendPolicy {
  contentType: string
  /** `inline` only for types an allowlist has already cleared. */
  disposition: 'attachment' | 'inline'
  /** Send at most this many bytes, ignoring Range. Used for text previews. */
  byteLimit?: number
  headers?: Record<string, string>
}

export interface StreamOptions {
  /** Pace the response to this rate. Zero or undefined means unlimited. */
  bytesPerSecond?: number
}

export interface JailErrorReply {
  code: string
  message: string
  status: number
  details?: Record<string, unknown>
}

/** Lets a caller with its own error shape (the public share page) take over. */
export type ErrorHandler = (reply: FastifyReply, error: JailErrorReply) => FastifyReply

function defaultErrorHandler(reply: FastifyReply, error: JailErrorReply): FastifyReply {
  return reply
    .code(error.status)
    .send({ error: { code: error.code, message: error.message, ...(error.details ?? {}) } })
}

export async function sendFile(
  req: FastifyRequest,
  reply: FastifyReply,
  abs: string,
  decide: (name: string, size: number) => SendPolicy,
  options: StreamOptions & { onError?: ErrorHandler } = {},
): Promise<FastifyReply> {
  const onError = options.onError ?? defaultErrorHandler

  const fail = (err: unknown): FastifyReply => {
    const fsError = toFsError(err)
    return onError(reply, {
      code: fsError.code,
      message: fsError.message,
      status: fsError.status,
      ...(fsError.details !== undefined ? { details: fsError.details } : {}),
    })
  }

  let handle
  try {
    // The path is canonical, so O_NOFOLLOW cannot reject a legitimate request.
    // It fires only if the final component was swapped for a link after the
    // jail checked it.
    handle = await open(abs, FS.O_RDONLY | FS.O_NOFOLLOW)
  } catch (err) {
    return fail(err)
  }

  try {
    // From the descriptor, never a second path-based stat, so the advertised
    // length cannot disagree with the bytes sent.
    const info = await handle.stat()

    if (info.isDirectory()) {
      await handle.close()
      return reply.code(400).send({ error: { code: 'is_a_directory', message: 'that is a directory' } })
    }
    if (!info.isFile()) {
      // A FIFO would otherwise hang the request until a writer appeared, and a
      // device file has no meaningful length.
      await handle.close()
      return reply.code(400).send({ error: { code: 'not_a_file', message: 'not a regular file' } })
    }

    const name = path.basename(abs)
    const policy = decide(name, info.size)

    // A byte limit makes the response a prefix of the entity rather than the
    // entity, so a Range against it would be answering a different question.
    const capped = policy.byteLimit !== undefined && policy.byteLimit < info.size
    const total = capped ? (policy.byteLimit as number) : info.size
    const range: RangeResult = capped ? { kind: 'full' } : parseRange(req.headers.range, total)

    reply.header('accept-ranges', capped ? 'none' : 'bytes').header('x-content-type-options', 'nosniff')

    for (const [key, value] of Object.entries(policy.headers ?? {})) reply.header(key, value)

    if (range.kind === 'unsatisfiable') {
      await handle.close()
      return reply
        .code(416)
        .header('content-range', `bytes */${total}`)
        .send({ error: { code: 'offset_out_of_range', message: 'requested range is not satisfiable' } })
    }

    // Set only once the response is definitely the file itself.
    reply
      .header(
        'content-disposition',
        policy.disposition === 'inline' ? inlineDisposition(name) : contentDisposition(name),
      )
      .header('content-type', policy.contentType)
      .header('last-modified', new Date(info.mtimeMs).toUTCString())

    if (total === 0) {
      await handle.close()
      return reply.header('content-length', '0').code(200).send('')
    }

    const start = range.kind === 'partial' ? range.start : 0
    const end = range.kind === 'partial' ? range.end : total - 1

    if (range.kind === 'partial') reply.header('content-range', `bytes ${start}-${end}/${total}`)
    reply.header('content-length', String(end - start + 1))
    reply.code(range.kind === 'partial' ? 206 : 200)

    // createReadStream ties the descriptor's lifetime to the stream, so the
    // handle cannot be closed while the stream is still reading. Pacing wraps
    // that stream rather than replacing it, so the same guarantee holds.
    const stream = handle.createReadStream({ start, end, autoClose: true })
    const rate = options.bytesPerSecond ?? 0
    return reply.send(rate > 0 ? Readable.from(paced(stream, rate)) : stream)
  } catch (err) {
    await handle.close().catch(() => {})
    return fail(err)
  }
}

/** Convenience for the internal routes, which always want the JSON error shape. */
export function sendFileFromJail(
  req: FastifyRequest,
  reply: FastifyReply,
  jail: Jail,
  target: string,
  decide: (name: string, size: number) => SendPolicy,
  options: StreamOptions = {},
): Promise<FastifyReply> {
  return jail.resolve(target).then(
    (resolved) => sendFile(req, reply, resolved.abs, decide, options),
    (err: unknown) => {
      const fsError = toFsError(err)
      return reply
        .code(fsError.status)
        .send({ error: { code: fsError.code, message: fsError.message } })
    },
  )
}
