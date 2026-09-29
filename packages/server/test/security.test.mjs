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
import { forwardedHeaderWarning, isLoopbackHost, plaintextWarning } from '../src/config.ts'
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
