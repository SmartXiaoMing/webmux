/**
 * Unit tests for the share machinery: tokens, the unlock cookie, the page
 * escaping, the verification gate and the pacer.
 *
 * Pure — no server, no database, no fixtures.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { issueToken, verifyToken } from '../src/auth/tokens.ts'
import { paced } from '../src/http/throttle.ts'
import { escapeHtml, formatBytes } from '../src/shares/page.ts'
import {
  SHARE_TOKEN_PATTERN,
  generateShareToken,
  hashShareToken,
  issueShareCookie,
  verifyShareCookie,
} from '../src/shares/tokens.ts'
import { VerifyGate } from '../src/shares/verify.ts'

const SECRET = new Uint8Array(32).fill(7)
const OTHER_SECRET = new Uint8Array(32).fill(9)

// ---------------------------------------------------------------------------

describe('share tokens', () => {
  it('generates 43 base64url characters', () => {
    for (let i = 0; i < 100; i += 1) {
      const token = generateShareToken()
      assert.equal(token.length, 43)
      assert.ok(SHARE_TOKEN_PATTERN.test(token), token)
    }
  })

  it('does not repeat', () => {
    const seen = new Set(Array.from({ length: 1000 }, generateShareToken))
    assert.equal(seen.size, 1000)
  })

  it('hashes to a stable hex digest', () => {
    const token = generateShareToken()
    assert.equal(hashShareToken(token), hashShareToken(token))
    assert.match(hashShareToken(token), /^[0-9a-f]{64}$/)
    // The hash is what the DB compares, so it must not be reversible by
    // inspection.
    assert.equal(hashShareToken(token).includes(token), false)
  })
})

describe('unlock cookie', () => {
  const claims = { sid: 'share-1', th: 'a'.repeat(64) }

  it('round-trips for the share it was minted for', async () => {
    const cookie = await issueShareCookie(SECRET, claims, 3600)
    assert.equal(await verifyShareCookie(SECRET, cookie, claims), true)
  })

  it('refuses a cookie minted for a different share', async () => {
    const cookie = await issueShareCookie(SECRET, claims, 3600)
    assert.equal(await verifyShareCookie(SECRET, cookie, { ...claims, sid: 'share-2' }), false)
  })

  it('refuses a cookie minted for a different token value', async () => {
    // `th` binds the cookie to one token, so regenerate is an unconditional
    // invalidation rather than something `sid` alone would survive.
    const cookie = await issueShareCookie(SECRET, claims, 3600)
    assert.equal(await verifyShareCookie(SECRET, cookie, { ...claims, th: 'b'.repeat(64) }), false)
  })

  it('refuses a cookie signed with another secret', async () => {
    const cookie = await issueShareCookie(OTHER_SECRET, claims, 3600)
    assert.equal(await verifyShareCookie(SECRET, cookie, claims), false)
  })

  it('refuses an expired cookie', async () => {
    const cookie = await issueShareCookie(SECRET, claims, -1)
    assert.equal(await verifyShareCookie(SECRET, cookie, claims), false)
  })

  it('refuses garbage', async () => {
    for (const value of ['', 'nope', 'a.b.c', 'eyJhbGciOiJub25lIn0.e30.']) {
      assert.equal(await verifyShareCookie(SECRET, value, claims), false, value)
    }
  })

  /**
   * The load-bearing pair.
   *
   * Reusing the session signing secret for share cookies is only safe because
   * the two claim sets are disjoint. If these two assertions are ever deleted,
   * the reuse stops being safe and becomes merely convenient — a share cookie
   * that satisfied `verifyToken` would be a session, and a session token that
   * satisfied `verifyShareCookie` would unlock shares.
   */
  it('cannot be crossed with a session token, in either direction', async () => {
    const session = await issueToken(SECRET, 0, 1)
    assert.equal(await verifyToken(SECRET, session, 0), true, 'sanity: the session token is valid')
    assert.equal(
      await verifyShareCookie(SECRET, session, claims),
      false,
      'a session token must never unlock a share',
    )

    const share = await issueShareCookie(SECRET, claims, 3600)
    assert.equal(await verifyShareCookie(SECRET, share, claims), true, 'sanity: the share cookie is valid')
    assert.equal(
      await verifyToken(SECRET, share, 0),
      false,
      'a share cookie must never be a session',
    )
  })
})

describe('page escaping', () => {
  it('escapes all five characters in one pass', () => {
    assert.equal(escapeHtml('&'), '&amp;')
    assert.equal(escapeHtml('<'), '&lt;')
    assert.equal(escapeHtml('>'), '&gt;')
    assert.equal(escapeHtml('"'), '&quot;')
    assert.equal(escapeHtml("'"), '&#39;')
    assert.equal(escapeHtml('a & b < c > d " e \' f'), 'a &amp; b &lt; c &gt; d &quot; e &#39; f')
  })

  it('does not double-decode', () => {
    // The single-pass property: an already-escaped entity in a filename must
    // come out escaped again, not reinterpreted.
    assert.equal(escapeHtml('&amp;'), '&amp;amp;')
    assert.equal(escapeHtml('&lt;script&gt;'), '&amp;lt;script&amp;gt;')
  })

  it('neutralises a hostile filename', () => {
    const hostile = '<img src=x onerror=alert(1)>.txt'
    const escaped = escapeHtml(hostile)
    assert.equal(escaped.includes('<'), false)
    assert.equal(escaped.includes('>'), false)
    assert.ok(escaped.includes('&lt;img'))
  })

  it('formats sizes', () => {
    assert.equal(formatBytes(0), '0 B')
    assert.equal(formatBytes(999), '999 B')
    assert.equal(formatBytes(1024), '1.0 KB')
    assert.equal(formatBytes(1024 * 1024 * 3), '3.0 MB')
  })
})

describe('verification gate', () => {
  it('admits up to the concurrency cap and then refuses rather than queueing', () => {
    const gate = new VerifyGate(2, 0)
    assert.equal(gate.tryAcquire(), null)
    assert.equal(gate.tryAcquire(), null)
    // Refused, not queued: queueing turns a CPU denial of service into an
    // unbounded-memory one and adds latency for real visitors.
    assert.equal(typeof gate.tryAcquire(), 'number')

    gate.release()
    assert.equal(gate.tryAcquire(), null)
  })

  it('enforces the per-minute budget and reports a sensible wait', () => {
    let now = 0
    const gate = new VerifyGate(4, 2, () => now)
    assert.equal(gate.tryAcquire(), null)
    gate.release()
    assert.equal(gate.tryAcquire(), null)
    gate.release()

    const refused = gate.tryAcquire()
    assert.equal(typeof refused, 'number')
    assert.ok(refused >= 1 && refused <= 60, `unexpected wait ${refused}`)

    // A new window reopens it.
    now += 60_001
    assert.equal(gate.tryAcquire(), null)
  })

  it('does not leak slots when a verification throws', () => {
    const gate = new VerifyGate(1, 0)
    assert.equal(gate.tryAcquire(), null)
    gate.release()
    gate.release() // extra release must not push the counter negative
    assert.equal(gate.inFlight, 0)
    assert.equal(gate.tryAcquire(), null)
  })
})

describe('pacer', () => {
  function fakeClock() {
    let now = 0
    const sleeps = []
    return {
      clock: {
        now: () => now,
        sleep: async (ms) => {
          sleeps.push(ms)
          now += ms
        },
      },
      sleeps,
      elapsed: () => now,
    }
  }

  async function* from(chunks) {
    for (const chunk of chunks) yield chunk
  }

  it('passes everything through unchanged', async () => {
    const { clock } = fakeClock()
    const chunks = [Buffer.from('aa'), Buffer.from('bb'), Buffer.from('cc')]
    const out = []
    for await (const chunk of paced(from(chunks), 0, clock)) out.push(chunk)
    assert.equal(Buffer.concat(out).toString(), 'aabbcc')
  })

  it('paces a whole transfer to roughly the requested duration', async () => {
    const { clock, elapsed, sleeps } = fakeClock()
    // 80 KiB at 80 KiB/s is one second.
    const chunks = Array.from({ length: 10 }, () => Buffer.alloc(8 * 1024, 1))
    for await (const _ of paced(from(chunks), 80 * 1024, clock)) void _

    assert.ok(Math.abs(elapsed() - 1000) <= 10, `expected ~1000ms, got ${elapsed()}ms`)
    // Equal chunks ⇒ equal waits ⇒ no drift accumulating across the transfer.
    assert.ok(sleeps.length > 0)
    assert.ok(Math.abs(sleeps[0] - sleeps[sleeps.length - 1]) <= 2, `drifted: ${sleeps.join(',')}`)
  })

  it('coalesces small chunks so the wait count is bounded by the rate', async () => {
    const { clock, sleeps } = fakeClock()
    // 1000 × 1 KiB chunks at 1 MB/s. Without coalescing this schedules 1000
    // timers for what is a 1-second transfer, and the timer churn — not the
    // bandwidth — becomes the bottleneck.
    const chunks = Array.from({ length: 1000 }, () => Buffer.alloc(1024, 1))
    for await (const _ of paced(from(chunks), 1024 * 1024, clock)) void _

    assert.ok(sleeps.length <= 20, `expected coalescing, got ${sleeps.length} waits`)
    assert.ok(sleeps.length >= 1)
  })

  it('never sleeps negatively', async () => {
    const { clock, sleeps } = fakeClock()
    const chunks = Array.from({ length: 50 }, () => Buffer.alloc(64 * 1024, 1))
    for await (const _ of paced(from(chunks), 10 * 1024 * 1024, clock)) void _
    for (const wait of sleeps) assert.ok(wait >= 0, `negative wait ${wait}`)
  })
})
