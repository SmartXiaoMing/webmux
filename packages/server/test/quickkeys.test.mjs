/**
 * Unit tests for the quick-key store.
 *
 * Real database, no server: the ordering and lookup rules are the whole of the
 * logic here, and running them against SQLite is also what proves migration 4
 * applies cleanly and advances `user_version`.
 */
import { after, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { openDatabase } from '../src/db/index.ts'
import { QuickKeyStore } from '../src/quickkeys/store.ts'

const dir = mkdtempSync(path.join(tmpdir(), 'webmux-quickkeys-'))
const db = openDatabase(dir)

after(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

/** Each case gets its own table contents, so none of them can see another's. */
function freshStore() {
  db.exec('DELETE FROM quick_keys')
  return new QuickKeyStore(db)
}

describe('quick key store', () => {
  it('applies migration 4', () => {
    assert.equal(db.pragma('user_version', { simple: true }), 4)
  })

  it('creates and lists', () => {
    const store = freshStore()
    assert.deepEqual(store.list(), [])

    const created = store.create('git', 'git status', true)
    assert.match(created.id, /^[0-9a-f]{10}$/)
    assert.deepEqual(store.list(), [created])
  })

  it('lists oldest first', () => {
    const store = freshStore()
    // Explicit timestamps, because Date.now() can return the same millisecond
    // for consecutive calls — which is exactly the case the id tiebreak exists
    // for, and is covered separately below.
    store.create('one', 'echo 1', true, 1_000)
    store.create('two', 'echo 2', true, 2_000)
    store.create('three', 'echo 3', true, 3_000)

    assert.deepEqual(
      store.list().map((row) => row.label),
      ['one', 'two', 'three'],
    )
  })

  it('orders deterministically when two keys share a timestamp', () => {
    const store = freshStore()
    for (let i = 0; i < 5; i += 1) store.create(`k${i}`, `echo ${i}`, true, 5_000)

    const first = store.list().map((row) => row.id)
    // Same store, re-read: without the id tiebreak SQLite is free to return
    // these in any order, and the bar would reshuffle between page loads.
    assert.deepEqual(store.list().map((row) => row.id), first)
    assert.deepEqual([...first].sort(), first, 'ids should be ascending')
  })

  it('does not repeat ids', () => {
    const store = freshStore()
    const ids = new Set()
    for (let i = 0; i < 500; i += 1) ids.add(store.create(`k${i}`, `echo ${i}`, false).id)
    assert.equal(ids.size, 500)
  })

  it('round-trips send_enter as 0/1', () => {
    const store = freshStore()
    const withEnter = store.create('run', 'ls', true)
    const withoutEnter = store.create('frag', 'ls', false)

    assert.equal(withEnter.send_enter, 1)
    assert.equal(withoutEnter.send_enter, 0)

    const rows = store.list()
    assert.equal(rows.find((row) => row.id === withEnter.id).send_enter, 1)
    assert.equal(rows.find((row) => row.id === withoutEnter.id).send_enter, 0)
  })

  it('replaces every field on update, and keeps the position', () => {
    const store = freshStore()
    store.create('first', 'echo 1', true, 1_000)
    const middle = store.create('middle', 'echo 2', true, 2_000)
    store.create('last', 'echo 3', true, 3_000)

    const updated = store.update(middle.id, 'changed', 'echo changed', false)
    assert.deepEqual(updated, {
      id: middle.id,
      label: 'changed',
      text: 'echo changed',
      send_enter: 0,
    })

    // Editing must not move a key to the end of the bar.
    assert.deepEqual(
      store.list().map((row) => row.label),
      ['first', 'changed', 'last'],
    )
  })

  it('returns null when updating an unknown id', () => {
    const store = freshStore()
    assert.equal(store.update('deadbeef00', 'x', 'y', true), null)
  })

  it('removes, and reports whether anything was removed', () => {
    const store = freshStore()
    const key = store.create('gone', 'echo bye', false)

    assert.equal(store.remove(key.id), true)
    assert.deepEqual(store.list(), [])
    // Second time: nothing left to delete, which the route turns into a 404
    // rather than a silent success.
    assert.equal(store.remove(key.id), false)
  })

  it('counts what it lists', () => {
    const store = freshStore()
    assert.equal(store.count(), 0)
    for (let i = 0; i < 7; i += 1) store.create(`k${i}`, `echo ${i}`, false)
    assert.equal(store.count(), store.list().length)
    assert.equal(store.count(), 7)
  })

  it('stores text verbatim, including spaces and metacharacters', () => {
    const store = freshStore()
    const text = `cd "/tmp/a b" && ls | grep -v '^d' && echo 'done'`
    const created = store.create('complex', text, true)
    assert.equal(store.list()[0].text, text)
    assert.equal(created.text, text)
  })
})
