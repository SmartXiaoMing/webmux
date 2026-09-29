/**
 * Keystrokes typed while the socket cannot carry them.
 *
 * Output is protected by a sequence number, a ring buffer and a replay
 * protocol. Input had no such protection: anything typed while the socket was
 * down was dropped on the floor. The failure that produces is nasty because it
 * is partial — a lost Backspace with the characters after it still delivered
 * leaves the shell holding text the user believes they deleted.
 *
 * The socket is a browser API, so this suite installs a fake `WebSocket` and a
 * fake `location`, and drives the frames by hand. The clock is injected, which
 * is the only way to test the staleness window without sleeping through it.
 */
import { after, before, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { TerminalSocket } from '../src/lib/terminal-socket.ts'

class FakeWebSocket {
  static OPEN = 1
  static CONNECTING = 0
  static CLOSED = 3
  static instances = []

  constructor(url) {
    this.url = url
    this.readyState = FakeWebSocket.CONNECTING
    this.sent = []
    FakeWebSocket.instances.push(this)
  }

  send(payload) {
    this.sent.push(JSON.parse(payload))
  }

  close() {
    this.readyState = FakeWebSocket.CLOSED
    this.onclose?.({ code: 1000 })
  }

  /** Control frames only, in the order the transport was asked to send them. */
  get inputFrames() {
    return this.sent.filter((msg) => msg.t === 'input').map((msg) => msg.data)
  }

  fireOpen() {
    this.readyState = FakeWebSocket.OPEN
    this.onopen?.({})
  }

  fireControl(msg) {
    this.onmessage?.({ data: JSON.stringify(msg) })
  }
}

function makeSocket({ now = Date.now } = {}) {
  return new TerminalSocket(
    'sess-1',
    {
      onData: () => {},
      onReset: () => {},
      onStatus: () => {},
      onExit: () => {},
      onTitle: () => {},
      onFatal: () => {},
    },
    now,
  )
}

const globals = { location: globalThis.location, WebSocket: globalThis.WebSocket }

before(() => {
  Object.defineProperty(globalThis, 'location', {
    value: { protocol: 'http:', host: 'webmux.test' },
    configurable: true,
  })
  Object.defineProperty(globalThis, 'WebSocket', { value: FakeWebSocket, configurable: true })
})

after(() => {
  for (const [name, value] of Object.entries(globals)) {
    Object.defineProperty(globalThis, name, { value, configurable: true })
  }
})

beforeEach(() => {
  FakeWebSocket.instances = []
})

describe('input queued across a connection gap', () => {
  it('holds keystrokes typed before the socket is open', () => {
    const socket = makeSocket()
    socket.connect()
    const ws = FakeWebSocket.instances[0]

    socket.write('a')
    assert.deepEqual(ws.sent, [], 'nothing can be sent before the socket opens')
    socket.dispose()
  })

  it('waits for the attach acknowledgement, not just the open', () => {
    const socket = makeSocket()
    socket.connect()
    const ws = FakeWebSocket.instances[0]

    socket.write('typed-while-connecting')
    ws.fireOpen()
    assert.equal(ws.sent[0].t, 'attach')
    assert.deepEqual(ws.inputFrames, [], 'the pty may not exist yet')

    ws.fireControl({ t: 'attached' })
    assert.deepEqual(ws.inputFrames, ['typed-while-connecting'])
    socket.dispose()
  })

  it('does not let a fresh key overtake the queue', () => {
    const socket = makeSocket()
    socket.write('first')
    socket.connect()
    const ws = FakeWebSocket.instances[0]

    ws.fireOpen()
    socket.write('second')
    ws.fireControl({ t: 'attached' })

    assert.deepEqual(ws.inputFrames, ['first', 'second'])
    socket.dispose()
  })

  it('delivers live keystrokes immediately once attached', () => {
    const socket = makeSocket()
    socket.connect()
    const ws = FakeWebSocket.instances[0]
    ws.fireOpen()
    ws.fireControl({ t: 'attached' })

    socket.write('live')
    assert.deepEqual(ws.inputFrames, ['live'])
    socket.dispose()
  })

  it('discards a queue older than the staleness window', () => {
    let now = 1_000
    const socket = makeSocket({ now: () => now })
    socket.connect()
    const ws = FakeWebSocket.instances[0]

    socket.write('stale')
    now += 5_001
    ws.fireOpen()
    ws.fireControl({ t: 'attached' })

    assert.deepEqual(ws.inputFrames, [], 'an outage that long means the user has moved on')
    socket.write('fresh')
    assert.deepEqual(ws.inputFrames, ['fresh'], 'and the socket is not left refusing input')
    socket.dispose()
  })

  it('drops held keystrokes when the view is disposed', () => {
    const socket = makeSocket()
    socket.connect()
    const ws = FakeWebSocket.instances[0]

    socket.write('never delivered')
    socket.dispose()
    ws.fireControl({ t: 'attached' })

    assert.deepEqual(ws.inputFrames, [])
  })
})
