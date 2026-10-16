import assert from 'node:assert/strict'
import test from 'node:test'
import { detailResource } from '../web/detail-resource.js'

test('error ends loading; explicit retry is deduplicated and restores identical data', async () => {
  let calls = 0, resolve
  const changes = []
  const resource = detailResource({ read: () => ++calls === 1 ? Promise.reject(new Error('offline')) : new Promise(r => resolve = r), changed: v => changes.push(v), now: () => 42 })
  resource.reset('a')
  await resource.load('a')
  assert.equal(resource.snapshot().status, 'error')
  assert.equal(resource.snapshot().error, 'offline')
  const retry = resource.load('a')
  assert.equal(resource.load('a'), retry)
  await Promise.resolve()
  resolve({ conversation: [] })
  await retry
  assert.equal(calls, 2)
  assert.equal(resource.snapshot().status, 'ready')
  assert.equal(resource.snapshot().at, 42)
})

test('refresh errors retain the last read and a missing session rejects late replies', async () => {
  let mode = 'ok', resolve
  const resource = detailResource({ read: () => mode === 'ok' ? Promise.resolve({ conversation: ['cached'] }) : mode === 'error' ? Promise.reject(new Error('failed')) : new Promise(r => resolve = r), changed() {} })
  await resource.load('a')
  mode = 'error'; await resource.load('a')
  assert.deepEqual(resource.snapshot().data.conversation, ['cached'])
  assert.equal(resource.snapshot().status, 'error')
  mode = 'late'; const late = resource.load('a'); await Promise.resolve()
  resource.missing(); resolve({ conversation: ['obsolete'] }); await late
  assert.equal(resource.snapshot().status, 'missing')
  assert.deepEqual(resource.snapshot().data.conversation, ['cached'])
})

test('a reply from the previous selection cannot replace the new one', async () => {
  const replies = {}
  const resource = detailResource({ read: key => new Promise(r => replies[key] = r), changed() {} })
  const a = resource.load('a'); await Promise.resolve()
  const b = resource.load('b'); await Promise.resolve()
  replies.b({ name: 'b' }); await b
  replies.a({ name: 'a' }); await a
  assert.equal(resource.snapshot().key, 'b')
  assert.equal(resource.snapshot().data.name, 'b')
})

test('a stalled read reaches an actionable error rather than loading forever', async () => {
  const resource = detailResource({ read: () => new Promise(() => {}), changed() {}, timeoutMs: 10 })
  await resource.load('a')
  assert.equal(resource.snapshot().status, 'error')
  assert.match(resource.snapshot().error, /timed out/)
})

test('a missing response can be read again when the selected session returns', async () => {
  let present = false
  const resource = detailResource({ read: async () => {
    if (!present) throw Object.assign(new Error('gone'), { missing: true })
    return { conversation: ['returned'] }
  }, changed() {} })
  await resource.load('a')
  assert.equal(resource.snapshot().status, 'missing')
  present = true
  await resource.load('a')
  assert.equal(resource.snapshot().status, 'ready')
})
