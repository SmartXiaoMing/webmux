import { useSyncExternalStore } from 'react'
import { FS_UPLOAD_CHUNK_SIZE } from '@webmux/shared'
import { ApiError, api } from './api'

/**
 * Resumable upload client.
 *
 * The transport is XHR rather than `fetch`, for one reason: `fetch` exposes no
 * upload progress, and `xhr.upload.onprogress` is the only universally
 * available way to drive a progress bar. It hands back `abort()` for free too.
 */

/** Chunks in flight at once. Beyond this, a flaky mobile link gets worse, not better. */
const CONCURRENCY = 3

/** How often progress notifications reach React. `onprogress` fires per packet. */
const NOTIFY_INTERVAL_MS = 200

const RETRY_DELAYS_MS = [500, 2000, 8000]

const STORAGE_KEY = 'webmux.uploads.v1'

export type UploadState = 'queued' | 'uploading' | 'done' | 'failed' | 'cancelled'

export interface UploadTask {
  /** Local identity, stable across a reload so progress survives one. */
  readonly key: string
  readonly name: string
  readonly size: number
  /** Destination path on the server. */
  readonly target: string
  state: UploadState
  /** Bytes the server has acknowledged, plus what is in flight. */
  bytesSent: number
  uploadId: string | null
  error: string | null
}

// ---------------------------------------------------------------------------
// Hashing
// ---------------------------------------------------------------------------

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
])

const rotr = (x: number, n: number): number => ((x >>> n) | (x << (32 - n))) >>> 0

/**
 * SHA-256, in JavaScript.
 *
 * `crypto.subtle` only exists in a *secure context*, and a self-hosted webmux
 * is very plausibly reached at `http://192.168.x.x:8080` — plain HTTP on a
 * LAN, where `crypto.subtle` is simply `undefined`. Falling back to this keeps
 * the per-chunk checksum unconditional rather than quietly dropping the
 * integrity guarantee in exactly the deployment where links are least
 * reliable. `upload.test.mjs` cross-checks it against node's implementation.
 */
function sha256Fallback(bytes: Uint8Array): Uint8Array {
  const bitLength = bytes.length * 8
  const padded = new Uint8Array(Math.ceil((bytes.length + 9) / 64) * 64)
  padded.set(bytes)
  padded[bytes.length] = 0x80

  const view = new DataView(padded.buffer)
  view.setUint32(padded.length - 8, Math.floor(bitLength / 0x100000000))
  view.setUint32(padded.length - 4, bitLength >>> 0)

  const h = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ])
  const w = new Uint32Array(64)

  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let i = 0; i < 16; i += 1) w[i] = view.getUint32(offset + i * 4)

    for (let i = 16; i < 64; i += 1) {
      const s0 = rotr(w[i - 15]!, 7) ^ rotr(w[i - 15]!, 18) ^ (w[i - 15]! >>> 3)
      const s1 = rotr(w[i - 2]!, 17) ^ rotr(w[i - 2]!, 19) ^ (w[i - 2]! >>> 10)
      w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) >>> 0
    }

    let [a, b, c, d, e, f, g, hh] = h as unknown as number[]

    for (let i = 0; i < 64; i += 1) {
      const S1 = rotr(e!, 6) ^ rotr(e!, 11) ^ rotr(e!, 25)
      const ch = (e! & f!) ^ (~e! & g!)
      const t1 = (hh! + S1 + ch + K[i]! + w[i]!) >>> 0
      const S0 = rotr(a!, 2) ^ rotr(a!, 13) ^ rotr(a!, 22)
      const maj = (a! & b!) ^ (a! & c!) ^ (b! & c!)
      const t2 = (S0 + maj) >>> 0

      hh = g
      g = f
      f = e
      e = (d! + t1) >>> 0
      d = c
      c = b
      b = a
      a = (t1 + t2) >>> 0
    }

    h[0] = (h[0]! + a!) >>> 0
    h[1] = (h[1]! + b!) >>> 0
    h[2] = (h[2]! + c!) >>> 0
    h[3] = (h[3]! + d!) >>> 0
    h[4] = (h[4]! + e!) >>> 0
    h[5] = (h[5]! + f!) >>> 0
    h[6] = (h[6]! + g!) >>> 0
    h[7] = (h[7]! + hh!) >>> 0
  }

  const digest = new Uint8Array(32)
  const digestView = new DataView(digest.buffer)
  for (let i = 0; i < 8; i += 1) digestView.setUint32(i * 4, h[i]!)
  return digest
}

export async function sha256Base64(data: Blob | Uint8Array): Promise<string> {
  const bytes = data instanceof Blob ? new Uint8Array(await data.arrayBuffer()) : data
  const subtle = globalThis.crypto?.subtle
  if (subtle) {
    // Cast through `unknown`: a typed array is a perfectly good BufferSource at
    // runtime, but the array types are generic over their backing buffer now,
    // and `ArrayBufferLike` includes SharedArrayBuffer which digest() rejects.
    const digest = await subtle.digest('SHA-256', bytes as unknown as BufferSource)
    return toBase64(new Uint8Array(digest))
  }
  return toBase64(sha256Fallback(bytes))
}

function toBase64(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

// ---------------------------------------------------------------------------
// Transfer
// ---------------------------------------------------------------------------

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** `fetch` cannot report upload progress; this can, and can be aborted. */
function putChunk(
  uploadId: string,
  offset: number,
  slice: Blob,
  checksum: string,
  onProgress: (loaded: number) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('PUT', `/api/fs/upload/${encodeURIComponent(uploadId)}/chunk?offset=${offset}`)
    xhr.setRequestHeader('content-type', 'application/octet-stream')
    xhr.setRequestHeader('x-chunk-sha256', checksum)
    xhr.withCredentials = true

    xhr.upload.onprogress = (event) => onProgress(event.loaded)

    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        onProgress(slice.size)
        resolve()
        return
      }
      let code = 'unknown'
      let message = `上传失败 (${xhr.status})`
      try {
        const parsed = JSON.parse(xhr.responseText) as { error?: { code?: string; message?: string } }
        code = parsed.error?.code ?? code
        message = parsed.error?.message ?? message
      } catch {
        // Non-JSON body; the status alone will have to do.
      }
      reject(new ApiError(xhr.status, code, message))
    }

    xhr.onerror = () => reject(new ApiError(0, 'network', '网络错误，上传中断'))
    xhr.onabort = () => reject(new ApiError(0, 'aborted', '上传已取消'))
    xhr.send(slice)
  })
}

/** Runs `worker` over `items` with bounded parallelism, stopping at the first failure. */
async function runPool<T>(items: T[], limit: number, worker: (item: T) => Promise<void>): Promise<void> {
  let index = 0
  let failure: unknown = null

  const runners = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (failure === null) {
      const i = index
      index += 1
      if (i >= items.length) return
      try {
        await worker(items[i]!)
      } catch (err) {
        failure ??= err
        return
      }
    }
  })

  await Promise.all(runners)
  if (failure !== null) throw failure
}

async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  let lastError: unknown
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt += 1) {
    try {
      return await fn()
    } catch (err) {
      lastError = err
      // A 4xx means the request itself is wrong; repeating it changes nothing.
      // 429 is the exception — that one is explicitly worth waiting out.
      if (err instanceof ApiError && err.status >= 400 && err.status < 500 && err.status !== 429) throw err
      const backoff = RETRY_DELAYS_MS[attempt]
      if (backoff === undefined) break
      await delay(backoff)
    }
  }
  throw lastError
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

/** Identifies a file across a reload, where no `File` object survives. */
function fingerprint(file: File): string {
  return `${file.name} ${file.size} ${file.lastModified}`
}

interface RememberedUpload {
  uploadId: string
  target: string
}

function readRemembered(): Record<string, RememberedUpload> {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') as Record<string, RememberedUpload>
  } catch {
    return {}
  }
}

function writeRemembered(all: Record<string, RememberedUpload>): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(all))
  } catch {
    // Private mode, or the quota is full. Resuming is a convenience, not a
    // correctness requirement, so losing it is not worth an error.
  }
}

class UploadStore {
  private readonly tasks = new Map<string, UploadTask>()
  private readonly listeners = new Set<() => void>()
  private snapshot: UploadTask[] = []
  private timer: number | null = null
  private readonly controllers = new Map<string, AbortController>()

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  getSnapshot = (): UploadTask[] => this.snapshot

  /**
   * Coalesces notifications into a frame-ish window.
   *
   * `upload.onprogress` fires per network packet; pushing each one through
   * `setState` would re-render the whole tray dozens of times a second for no
   * visible benefit.
   */
  private emit(immediate = false): void {
    if (immediate) {
      if (this.timer !== null) {
        window.clearTimeout(this.timer)
        this.timer = null
      }
      this.snapshot = [...this.tasks.values()]
      for (const listener of this.listeners) listener()
      return
    }
    if (this.timer !== null) return
    this.timer = window.setTimeout(() => {
      this.timer = null
      this.snapshot = [...this.tasks.values()]
      for (const listener of this.listeners) listener()
    }, NOTIFY_INTERVAL_MS)
  }

  /** Drops finished uploads from the tray. */
  clearFinished(): void {
    for (const [key, task] of this.tasks) {
      if (task.state === 'done' || task.state === 'failed' || task.state === 'cancelled') {
        this.tasks.delete(key)
      }
    }
    this.emit(true)
  }

  cancel(key: string): void {
    const task = this.tasks.get(key)
    if (!task) return
    this.controllers.get(key)?.abort()
    this.controllers.delete(key)
    task.state = 'cancelled'
    this.emit(true)

    // Free the staging area on the server too — otherwise it lingers until the
    // sweeper's TTL, holding disk for an upload nobody wants.
    if (task.uploadId !== null) {
      void api.uploadAbort(task.uploadId).catch(() => {})
      const remembered = readRemembered()
      delete remembered[key]
      writeRemembered(remembered)
    }
  }

  /**
   * Uploads `file` to `target`.
   *
   * Resumes automatically when this exact file was uploaded before and the
   * server still holds the session — the client asks what is missing rather
   * than assuming it must start over.
   */
  async upload(file: File, target: string): Promise<void> {
    const key = fingerprint(file)
    const existing = this.tasks.get(key)
    if (existing && (existing.state === 'uploading' || existing.state === 'queued')) return

    const task: UploadTask = {
      key,
      name: file.name,
      size: file.size,
      target,
      state: 'uploading',
      bytesSent: 0,
      uploadId: null,
      error: null,
    }
    this.tasks.set(key, task)
    this.emit(true)

    const controller = new AbortController()
    this.controllers.set(key, controller)

    try {
      let status = await this.openSession(file, target, key)

      // Whatever the server already holds is the starting point. This is what
      // makes a reload mid-upload cost nothing but the missing chunks.
      task.bytesSent = status.bytesReceived
      this.emit()

      const sentInFlight = new Map<number, number>()
      const report = (): void => {
        let inFlight = 0
        for (const loaded of sentInFlight.values()) inFlight += loaded
        task.bytesSent = status.bytesReceived + inFlight
        this.emit()
      }

      const missing = missingChunks(status.received, status.size, status.chunkSize)
      await runPool(missing, CONCURRENCY, async (offset) => {
        if (controller.signal.aborted) throw new ApiError(0, 'aborted', '上传已取消')

        const slice = file.slice(offset, Math.min(offset + status.chunkSize, status.size))
        const checksum = await sha256Base64(slice)
        sentInFlight.set(offset, 0)

        await withRetry(() =>
          putChunk(status.uploadId, offset, slice, checksum, (loaded) => {
            sentInFlight.set(offset, loaded)
            report()
          }),
        )

        sentInFlight.delete(offset)
        // Counted optimistically here; the authoritative figure comes back with
        // the next status or the completion response.
        status = { ...status, bytesReceived: status.bytesReceived + slice.size }
        report()
      })

      // Only now is the file actually installed on the server.
      await api.uploadComplete(status.uploadId, true)
      task.state = 'done'
      task.bytesSent = file.size
      this.forget(key)
      this.emit(true)
    } catch (err) {
      task.state = controller.signal.aborted ? 'cancelled' : 'failed'
      task.error = err instanceof ApiError ? err.message : '上传失败'
      this.emit(true)
      throw err
    } finally {
      this.controllers.delete(key)
    }
  }

  /**
   * Opens an upload session, reusing a remembered one when it still exists.
   *
   * A stale id (swept, or from a different server) is simply dropped — the
   * client must never assume the bytes it remembers are still there.
   */
  private async openSession(file: File, target: string, key: string): Promise<UploadStatusLike> {
    const remembered = readRemembered()[key]
    if (remembered && remembered.target === target) {
      const resumed = await api.uploadStatus(remembered.uploadId).catch(() => null)
      if (resumed !== null && resumed.size === file.size) return resumed
      this.forget(key)
    }

    const created = await api.uploadInit(target, file.size)
    const all = readRemembered()
    all[key] = { uploadId: created.uploadId, target }
    writeRemembered(all)
    return created
  }

  private forget(key: string): void {
    const all = readRemembered()
    delete all[key]
    writeRemembered(all)
  }
}

type UploadStatusLike = {
  uploadId: string
  size: number
  chunkSize: number
  received: Array<[number, number]>
  bytesReceived: number
}

/**
 * Turns the server's received ranges into the list of chunk offsets still owed.
 *
 * Chunk-aligned by construction: the server only accepts aligned offsets, so
 * every gap it reports begins on a boundary.
 */
export function missingChunks(
  received: Array<[number, number]>,
  size: number,
  chunkSize: number,
): number[] {
  const offsets: number[] = []
  let cursor = 0

  for (const [start, end] of received) {
    while (cursor < start) {
      offsets.push(cursor)
      cursor += chunkSize
    }
    cursor = Math.max(cursor, end)
  }
  while (cursor < size) {
    offsets.push(cursor)
    cursor += chunkSize
  }

  return offsets
}

export const uploads = new UploadStore()

/** Subscribes a component to the upload tray. */
export function useUploadTasks(): UploadTask[] {
  return useSyncExternalStore(uploads.subscribe, uploads.getSnapshot, uploads.getSnapshot)
}

/**
 * A filename that is safe to use as a single path component.
 *
 * Browsers never put a separator in `File.name`, but the server cannot tell a
 * browser-supplied path from a hand-rolled one, and a name like `..` would
 * silently retarget the upload at the parent directory.
 */
export function safeName(name: string): string {
  return name.replace(/[/\\]/g, '_').replace(/^\.+$/, '_') || 'unnamed'
}

export { FS_UPLOAD_CHUNK_SIZE }
