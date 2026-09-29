import { verifyPassword } from '../auth/password'

/**
 * Admission control for share-password verification.
 *
 * ## Why this exists at all
 *
 * `verifyPassword` is scrypt at N=2^15, r=8: ~32 MiB and ~50-100 ms of work.
 * That is the right cost for a password — but this endpoint is
 * *unauthenticated*, and the cost lands somewhere specific and unpleasant.
 *
 * `crypto.scrypt`'s async form runs on the **libuv threadpool**, which has four
 * threads by default — and every `fs.promises` call in the process uses those
 * same four threads. So a flood of unlock attempts does not merely burn CPU; it
 * occupies the pool, and every `open`/`stat`/`readdir` in the process queues
 * behind 100 ms tasks. The symptom is not "shares are slow", it is "the whole
 * box is dead".
 *
 * ## Why it refuses instead of queueing
 *
 * Queueing converts a CPU denial of service into an unbounded-memory one — each
 * waiting request pins its body and its socket — and adds latency to the
 * legitimate visitor. Rejecting immediately caps the damage at
 * `maxConcurrent × 32 MiB` and at most that many of the four threads, and a real
 * visitor's worst case is waiting behind one other verification.
 *
 * This gate protects the *machine*. It does not protect the password — that is
 * the failure limiter's job, and the two are not substitutes.
 */
export class VerifyGate {
  private active = 0
  private windowStart = 0
  private windowCount = 0

  constructor(
    private readonly maxConcurrent: number,
    /** 0 disables the circuit breaker. */
    private readonly perMinute: number,
    private readonly clock: () => number = Date.now,
  ) {}

  /**
   * @returns null when the caller may proceed (and must then call `release()`),
   *   or a number of seconds to wait when it may not.
   */
  tryAcquire(): number | null {
    const now = this.clock()

    if (this.perMinute > 0) {
      if (now - this.windowStart >= 60_000) {
        this.windowStart = now
        this.windowCount = 0
      }
      if (this.windowCount >= this.perMinute) {
        return Math.max(1, Math.ceil((this.windowStart + 60_000 - now) / 1000))
      }
      // Counted even if the concurrency check then refuses: an attempt was made,
      // and the point of the breaker is to bound attempts, not successes.
      this.windowCount += 1
    }

    if (this.active >= this.maxConcurrent) return 2

    this.active += 1
    return null
  }

  release(): void {
    this.active = Math.max(0, this.active - 1)
  }

  /** For tests and for logging the effective setting at boot. */
  get inFlight(): number {
    return this.active
  }
}

/**
 * Verifies a share password under the gate.
 *
 * @returns `'ok'`, `'wrong'`, or the number of seconds to wait.
 */
export async function verifySharePassword(
  gate: VerifyGate,
  password: string,
  storedHash: string,
): Promise<'ok' | 'wrong' | number> {
  const wait = gate.tryAcquire()
  if (wait !== null) return wait
  try {
    return (await verifyPassword(password, storedHash)) ? 'ok' : 'wrong'
  } finally {
    gate.release()
  }
}
