/**
 * Tests for the two warnings about running without encryption.
 *
 * Pure — no server, no database, no fixtures. They exist because both
 * conditions are invisible at runtime: a plaintext listener and a
 * `Secure`-less cookie both look exactly like a correctly configured one from
 * the outside, so the only thing standing between a misconfiguration and a
 * silent leak is that these fire.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  forwardedHeaderWarning,
  isLoopbackAddress,
  isLoopbackHost,
  notifyProxyWarning,
  plaintextWarning,
  unclaimedWarning,
} from '../src/config.ts'
import { insecureCookieWarning } from '../src/auth/routes.ts'

describe('loopback detection', () => {
  it('recognises the ways a machine refers to itself', () => {
    for (const host of ['127.0.0.1', 'localhost', 'LOCALHOST', '::1', '127.1.2.3', '[::1]']) {
      assert.equal(isLoopbackHost(host), true, `${host} should be loopback`)
    }
  })

  it('does not treat a wildcard bind as local', () => {
    // The case worth pinning: 0.0.0.0 is the *most* exposed address there is,
    // and calling it local would silence the warning exactly when it matters.
    for (const host of ['0.0.0.0', '::', '192.168.1.5', '10.0.0.1', 'term.example.com', '']) {
      assert.equal(isLoopbackHost(host), false, `${host} should count as exposed`)
    }
  })
})

describe('peer-loopback detection', () => {
  /*
   * A different question from `isLoopbackHost` above, about a different input:
   * that one classifies a configured listen address and accepts `localhost`;
   * this one classifies what the kernel reported as `socket.remoteAddress`,
   * which is where the local-only notification ingress gets its answer.
   */
  it('recognises a local peer in every form the kernel produces', () => {
    for (const address of [
      '127.0.0.1',
      '127.1.2.3',
      '::1',
      '0:0:0:0:0:0:0:1', // the expanded spelling of ::1
      '::ffff:127.0.0.1', // an IPv4 peer of a dual-stack listener
      '::ffff:7f00:1', // the same address, in hex
    ]) {
      assert.equal(isLoopbackAddress(address), true, `${address} should be loopback`)
    }
  })

  it('refuses everything else, including what cannot be read', () => {
    // Failing closed matters more here than anywhere else in this file: this
    // function is what stands between a public port and an endpoint that files
    // notifications under the operator's own name.
    for (const address of [
      '10.0.0.1',
      '::ffff:10.0.0.1',
      '192.168.1.5',
      'fe80::1',
      'localhost', // a peer is never a name
      '',
      '  ',
      'nonsense',
      undefined,
    ]) {
      assert.equal(isLoopbackAddress(address), false, `${String(address)} should not count as local`)
    }
  })
})

describe('the notify-behind-a-proxy warning', () => {
  it('stays quiet unless a proxy is actually in front', () => {
    assert.equal(notifyProxyWarning('0.0.0.0', false), null)
    assert.equal(notifyProxyWarning('127.0.0.1', true), null)
  })

  it('fires when a proxy could be forwarding, and says what is left standing', () => {
    // Behind a proxy every request arrives with a loopback peer, so the
    // address check stops distinguishing local from remote and only the token
    // remains. An operator has to know that, because it changes what the token
    // is protecting.
    for (const host of ['0.0.0.0', '192.168.1.5']) {
      const warning = notifyProxyWarning(host, true)
      assert.ok(warning, `${host} should warn`)
      assert.match(warning, /\/api\/notify/)
      assert.match(warning, /token/i)
    }
  })
})

describe('the plaintext listener warning', () => {
  it('stays quiet on a loopback bind', () => {
    assert.equal(plaintextWarning('127.0.0.1'), null)
    assert.equal(plaintextWarning('localhost'), null)
    assert.equal(plaintextWarning('::1'), null)
  })

  it('fires for anything reachable from off the machine, and names the address', () => {
    for (const host of ['0.0.0.0', '192.168.1.5', 'term.example.com']) {
      const warning = plaintextWarning(host)
      assert.ok(warning, `${host} should warn`)
      assert.match(warning, new RegExp(host.replace(/\./g, '\\.')))
      // The mitigations have to be in the message, or it is just noise.
      assert.match(warning, /TLS|WireGuard|127\.0\.0\.1/)
    }
  })
})

describe('the unclaimed-instance warning', () => {
  it('stays quiet on loopback, where nobody else can reach setup', () => {
    assert.equal(unclaimedWarning('127.0.0.1'), null)
    assert.equal(unclaimedWarning('::1'), null)
  })

  it('fires for the default bind, because that is now 0.0.0.0', () => {
    // The whole point of the warning: the default changed to an exposed
    // address, so on a fresh install there is a window in which anyone who can
    // reach the port can claim the instance. Verified against a real boot —
    // both this and the plaintext warning appear before setup is complete.
    const warning = unclaimedWarning('0.0.0.0')
    assert.ok(warning)
    assert.match(warning, /claim/)
    assert.match(warning, /127\.0\.0\.1/)
  })
})

describe('the forwarded-header warning', () => {
  it('stays quiet on loopback, which is the recommended deployment', () => {
    // A reverse proxy on the same host connects over 127.0.0.1, so trusting
    // its headers is both necessary and safe.
    assert.equal(forwardedHeaderWarning('127.0.0.1', true), null)
  })

  it('stays quiet when trustProxy is off, where there is nothing to forge', () => {
    assert.equal(forwardedHeaderWarning('0.0.0.0', false), null)
    assert.equal(forwardedHeaderWarning('192.168.1.5', false), null)
  })

  it('fires only for the combination that is actually exploitable', () => {
    // Directly reachable *and* believing X-Forwarded-For: the rate limit is
    // bypassable by rotating a forged address. Confirmed against a live server,
    // where eight spoofed attempts all returned 401 instead of the sixth
    // returning 429.
    for (const host of ['0.0.0.0', '192.168.1.5', 'term.example.com']) {
      const warning = forwardedHeaderWarning(host, true)
      assert.ok(warning, `${host} with trustProxy should warn`)
      assert.match(warning, /X-Forwarded-For/)
      assert.match(warning, /127\.0\.0\.1/)
    }
  })
})

describe('the proxy misconfiguration warning', () => {
  it('stays quiet when trustProxy is on, which is the correct setup', () => {
    assert.equal(insecureCookieWarning('https', true), null)
    assert.equal(insecureCookieWarning(['https'], true), null)
  })

  it('stays quiet for a direct connection, where there is no proxy to trust', () => {
    assert.equal(insecureCookieWarning(undefined, false), null)
  })

  it('fires when a proxy is forwarding but trustProxy is off', () => {
    // This is the one that silently costs the cookie its Secure flag.
    for (const header of ['https', 'http', ['https']]) {
      const warning = insecureCookieWarning(header, false)
      assert.ok(warning, `${JSON.stringify(header)} should warn`)
      assert.match(warning, /trustProxy/)
      assert.match(warning, /Secure/)
    }
  })
})
