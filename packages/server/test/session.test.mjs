/**
 * Input that arrives before the pty exists.
 *
 * The gateway hands a connection its session and *then* starts the pty, so
 * there is a real window in which a client can type into a session that has
 * nowhere to put the keystrokes. Dropping them is silent and asymmetric: the
 * characters around a lost Backspace still land, so the shell ends up with
 * text the user believed they had deleted.
 *
 * A unit test rather than an e2e one because the window is exactly as long as
 * `tmux attach` takes to spawn — no HTTP-level test can hold it open on
 * purpose, and the failure it produces is a race.
 *
 * No tmux, no server: a fake backend whose `attach` resolves when the test
 * says so, and a fake pty that records what it was written.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { Session } from '../src/terminal/session.ts'

/** A backend whose `attach` parks until `release()` is called. */
function harness() {
  let release
  const gate = new Promise((resolve) => {
    release = resolve
  })
  const writes = []

  const pty = {
    pid: 4242,
    write: (data) => writes.push(data),
    kill: () => {},
    resize: () => {},
    onData: () => {},
    onExit: () => {},
  }

  const backend = {
    name: 'fake',
    probe: async () => true,
    create: async () => {},
    attach: async () => {
      await gate
      return { pty, cols: 80, rows: 24 }
    },
    list: async () => [],
    has: async () => true,
    resize: async (_id, cols, rows) => ({ cols, rows }),
    kill: async () => {},
    setTitle: async () => {},
    listOrphans: async () => [],
    shutdown: async () => {},
  }

  const session = new Session(
    backend,
    {
      id: 'test-session',
      title: 'test',
      cwd: '/tmp',
      cols: 80,
      rows: 24,
      scrollbackLines: 1000,
      ringBufferBytes: 1024 * 1024,
      parentId: null,
    },
    () => {},
  )

  return { session, writes, release }
}

describe('input before the pty is ready', () => {
  it('flushes what was typed into the window, in order', async () => {
    const { session, writes, release } = harness()

    const started = session.ensureStarted()
    session.write('echo hi')
    session.write('\r')
    assert.deepEqual(writes, [], 'nothing can reach a pty that does not exist yet')

    release()
    await started
    assert.deepEqual(writes, ['echo hi', '\r'])
    session.dispose()
  })

  it('passes input straight through once the pty exists', async () => {
    const { session, writes, release } = harness()

    const started = session.ensureStarted()
    session.write('buffered')
    release()
    await started
    writes.length = 0

    session.write('live')
    assert.deepEqual(writes, ['live'], 'no duplicate delivery of the flushed buffer')
    session.dispose()
  })

  it('drops an overflowed buffer whole, then accepts input again', async () => {
    const { session, writes, release } = harness()

    const chunk = 'x'.repeat(100 * 1024)
    const started = session.ensureStarted()
    session.write(chunk)
    session.write(chunk)
    session.write(chunk) // 300 KiB, past the 256 KiB cap
    session.write('tail')
    release()
    await started

    // The two chunks that fit are gone along with the one that did not: a
    // prefix is not a smaller version of what was typed, so delivering the
    // first half of a command is worse than delivering none of it. What was
    // typed *after* the overflow is delivered normally — the cap bounds
    // memory, it does not mark the session broken.
    assert.deepEqual(writes, ['tail'])
    session.dispose()
  })

  it('drops the buffer when the session is disposed mid-attach', async () => {
    const { session, writes, release } = harness()

    const started = session.ensureStarted()
    session.write('never delivered')
    session.dispose()

    release()
    await assert.rejects(started, /disposed during startup/)
    assert.deepEqual(writes, [])
  })
})
