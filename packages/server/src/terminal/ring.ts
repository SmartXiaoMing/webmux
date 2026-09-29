/**
 * Bounded byte buffer retaining the tail of a session's output stream.
 *
 * Offsets are *absolute*: `startOffset` is the stream position of the first
 * retained byte and `endOffset` one past the last. A reconnecting client
 * reports how many bytes it has already rendered, and `since()` either returns
 * exactly the missing tail or `null` to signal that the gap has been evicted
 * and the client needs a full resynchronisation.
 *
 * This is what makes a brief network blip invisible: the client splices a few
 * kilobytes back into its buffer instead of repainting from a snapshot.
 */
export class ByteRing {
  /** Retained chunks, oldest first. Individual chunks are never larger than `capacity`. */
  private chunks: Buffer[] = []
  private bytes = 0
  private start = 0
  private end = 0

  constructor(private readonly capacity: number) {
    if (capacity <= 0) throw new Error('ByteRing capacity must be positive')
  }

  get startOffset(): number {
    return this.start
  }

  get endOffset(): number {
    return this.end
  }

  get size(): number {
    return this.bytes
  }

  push(buf: Buffer): void {
    if (buf.length === 0) return

    // A single oversized read (a big `cat`, say) would otherwise be trimmed
    // chunk-by-chunk; keep only its tail and account for the skipped prefix.
    if (buf.length >= this.capacity) {
      const kept = buf.subarray(buf.length - this.capacity)
      this.start = this.end + buf.length - this.capacity
      this.end += buf.length
      this.chunks = [kept]
      this.bytes = kept.length
      return
    }

    this.chunks.push(buf)
    this.bytes += buf.length
    this.end += buf.length

    while (this.bytes > this.capacity) {
      const head = this.chunks[0]
      if (!head) break
      const overflow = this.bytes - this.capacity
      if (head.length <= overflow) {
        this.chunks.shift()
        this.bytes -= head.length
        this.start += head.length
      } else {
        this.chunks[0] = head.subarray(overflow)
        this.bytes -= overflow
        this.start += overflow
      }
    }
  }

  /**
   * Bytes from absolute offset `from` up to the current end.
   *
   * @returns the missing bytes (possibly empty), or `null` if `from` has been
   *   evicted or is ahead of the stream — both cases require a resync.
   */
  since(from: number): Buffer | null {
    if (from < this.start || from > this.end) return null
    if (from === this.end) return Buffer.alloc(0)

    let skip = from - this.start
    const parts: Buffer[] = []
    for (const chunk of this.chunks) {
      if (skip >= chunk.length) {
        skip -= chunk.length
        continue
      }
      parts.push(skip > 0 ? chunk.subarray(skip) : chunk)
      skip = 0
    }

    if (parts.length === 0) return Buffer.alloc(0)
    return parts.length === 1 ? (parts[0] as Buffer) : Buffer.concat(parts)
  }
}
