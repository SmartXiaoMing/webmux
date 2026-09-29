/**
 * Fixed-window failure counter, keyed by client IP.
 *
 * Only *failures* are recorded, so a legitimate user is never locked out by
 * their own successful logins. In-memory is the right scope: the process is
 * the only thing that can authenticate anyone, and a restart clearing the
 * counters is an acceptable trade for not adding a store.
 */
export class FailureLimiter {
  private readonly hits = new Map<string, { count: number; resetAt: number }>()

  constructor(
    private readonly maxFailures: number,
    private readonly windowMs: number,
  ) {}

  /** @returns seconds the caller must wait, or 0 if the attempt may proceed. */
  retryAfter(key: string): number {
    const entry = this.hits.get(key)
    if (!entry) return 0
    const now = Date.now()
    if (now >= entry.resetAt) {
      this.hits.delete(key)
      return 0
    }
    if (entry.count < this.maxFailures) return 0
    return Math.ceil((entry.resetAt - now) / 1000)
  }

  recordFailure(key: string): void {
    const now = Date.now()
    const entry = this.hits.get(key)
    if (!entry || now >= entry.resetAt) {
      this.hits.set(key, { count: 1, resetAt: now + this.windowMs })
      return
    }
    entry.count += 1
  }

  reset(key: string): void {
    this.hits.delete(key)
  }

  /** Drops expired entries; called periodically so the map cannot grow without bound. */
  sweep(): void {
    const now = Date.now()
    for (const [key, entry] of this.hits) {
      if (now >= entry.resetAt) this.hits.delete(key)
    }
  }
}
