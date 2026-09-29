/**
 * Bandwidth pacing for share downloads.
 *
 * An async generator rather than a Transform, because that is how the rest of
 * the streaming stack already works: the zip route sends
 * `Readable.from(archiveStream(walk))` and the consumer pulls. Pacing composes
 * with that in a few lines, and it sidesteps the trap `zip/write.ts` documents
 * — `pipe()` does not forward errors, so a stalled source plus an unhandled
 * error is a hung response rather than a failed one.
 *
 * Cancellation needs nothing here: `Readable.from` calls `return()` on the
 * generator when the client disconnects, which ends the `for await` and
 * propagates to the source.
 */

export interface ThrottleClock {
  now(): number
  sleep(ms: number): Promise<void>
}

const realClock: ThrottleClock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}

/** Lower bound on the coalescing window: writing in smaller pieces is wasteful. */
const MIN_TARGET_BYTES = 8 * 1024
/** Upper bound, so a very fast limit cannot buffer without limit. */
const MAX_TARGET_BYTES = 1024 * 1024

/**
 * Paces `source` to roughly `bytesPerSecond`.
 *
 * ## Coalescing
 *
 * Chunks are buffered up to a target before being emitted, so the number of
 * timed waits is bounded by the *rate* rather than by the source's chunk size.
 * Without this, a source delivering 1 KB chunks at 1 MB/s schedules a thousand
 * `setTimeout`s a second and the timer churn — not the network — becomes the
 * bottleneck. With `target ≈ bytesPerSecond / 10`, that is about ten waits per
 * second whatever the source does.
 *
 * ## Scheduling
 *
 * Each emit is scheduled against an absolute deadline measured from the first
 * emit, rather than sleeping for "this chunk's duration" each time. Two
 * properties fall out:
 *
 *   - Lateness does not accumulate. A wake-up that fires 5 ms late is absorbed
 *     by the next deadline being an absolute time, instead of being added to
 *     every subsequent wait.
 *   - A stalled source does not accumulate credit. If the source pauses for ten
 *     seconds, the deadline is already in the past on the next chunk, so there
 *     is no wait — and no ten-second burst at full speed either.
 */
export async function* paced(
  source: AsyncIterable<Buffer>,
  bytesPerSecond: number,
  clock: ThrottleClock = realClock,
): AsyncGenerator<Buffer> {
  // A non-positive or nonsensical rate means "no limit" rather than "stall
  // forever", so a `0` in a config file cannot produce a download that never
  // finishes.
  if (!Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) {
    yield* source
    return
  }

  const target = Math.min(MAX_TARGET_BYTES, Math.max(MIN_TARGET_BYTES, Math.floor(bytesPerSecond / 10)))

  let startedAt: number | null = null
  let emitted = 0
  let parts: Buffer[] = []
  let buffered = 0

  const take = async (): Promise<Buffer> => {
    const buffer = Buffer.concat(parts, buffered)
    parts = []
    buffered = 0

    const now = clock.now()
    startedAt ??= now
    emitted += buffer.length

    const dueAt = startedAt + (emitted / bytesPerSecond) * 1000
    const wait = dueAt - now
    if (wait > 0) await clock.sleep(wait)

    return buffer
  }

  for await (const chunk of source) {
    parts.push(chunk)
    buffered += chunk.length
    if (buffered >= target) yield await take()
  }

  if (buffered > 0) yield await take()
}
