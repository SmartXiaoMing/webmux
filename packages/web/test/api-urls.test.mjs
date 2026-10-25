/**
 * Download URLs: the name has to be in the last path segment.
 *
 * Not cosmetic. A client that discards `Content-Disposition` — Android's
 * download manager, an in-app browser's download bridge — names the saved file
 * after the URL instead, and with only `?path=` in it every download arrives
 * as `download.bin`. These tests pin the shape down, including the cases where
 * a naive concatenation would produce a URL the server's router does not
 * recognise (a trailing slash) or one where the name no longer decodes back to
 * itself.
 *
 * No DOM and no server: these are pure string builders, and the browser suite
 * cannot make a download land under a name only some clients use.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { api } from '../src/lib/api.ts'

/** The last path segment, decoded, or '' when the URL has none. */
function segment(url) {
  const { pathname } = new URL(url, 'http://example.test')
  const last = pathname.slice(pathname.lastIndexOf('/') + 1)
  return last === '' ? '' : decodeURIComponent(last)
}

/** The path the server will actually resolve. */
function queryPath(url) {
  return new URL(url, 'http://example.test').searchParams.get('path')
}

describe('download URLs', () => {
  it('ends in the filename', () => {
    const url = api.downloadUrl('/home/me/hello.txt')
    assert.equal(segment(url), 'hello.txt')
    assert.equal(queryPath(url), '/home/me/hello.txt')
  })

  it('keeps a Chinese name, spaces and query-ish characters intact', () => {
    const target = '/home/me/报告 (2024) #1?.pdf'
    const url = api.downloadUrl(target)
    assert.equal(segment(url), '报告 (2024) #1?.pdf')
    // The full path still travels in the query, where the server resolves it.
    assert.equal(queryPath(url), target)
  })

  it('appends .zip for an archive, matching the name the server sends', () => {
    const url = api.archiveUrl('/home/me/photos')
    assert.equal(segment(url), 'photos.zip')
    assert.equal(queryPath(url), '/home/me/photos')
  })

  it('does not emit a trailing slash for a root', () => {
    // `/api/fs/download/` is a different path to the router and matches
    // nothing; a root also has no basename to name a file with.
    assert.equal(api.downloadUrl('/'), '/api/fs/download?path=%2F')
    assert.equal(api.archiveUrl('/'), '/api/fs/archive?path=%2F')
  })

  it('takes the basename from a path with a trailing slash', () => {
    // The listing never produces one, but the helper is the wrong place to
    // depend on that: a trailing slash would otherwise become the file name.
    assert.equal(segment(api.downloadUrl('/home/me/photos/')), 'photos')
  })
})
