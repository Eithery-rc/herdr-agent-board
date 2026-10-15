import { test } from 'node:test'
import assert from 'node:assert/strict'
import { unseenResult, recordView, nextAttention, attentionTime } from '../web/attention.js'
const done = { key: 'a', session: 'a', column: 'done', status: 'done', pin: 'done', activity: 100, lastText: 'Result' }
test('view receipts survive reload, differ between sessions and reset for a new result', () => {
  const seen = JSON.parse(JSON.stringify(recordView({}, done)))
  assert.equal(unseenResult(done, seen), false)
  assert.equal(unseenResult({ ...done, key: 'b' }, seen), true)
  assert.equal(unseenResult({ ...done, activity: 101 }, seen), true)
  assert.equal(unseenResult({ ...done, lastText: 'Correction' }, seen), true)
  assert.equal(unseenResult({ ...done, column: 'work' }, {}), false)
  assert.equal(unseenResult({ ...done, lastText: '' }, {}), false)
  assert.equal(done.pin, 'done')
  assert.equal(done.status, 'done')
})
test('next attention wraps, respects caller filtering and keeps unanswered questions after viewing', () => {
  const waiting = { key: 'b', column: 'me', askSince: 5, activity: 10 }
  const items = [done, waiting, { key: 'c', column: 'idle' }]
  assert.equal(nextAttention(items, null, {}), 'a')
  assert.equal(nextAttention(items, 'a', {}), 'b')
  assert.equal(nextAttention(items, 'b', {}), 'a')
  assert.equal(nextAttention(items, 'b', recordView({}, done)), 'b')
  assert.equal(nextAttention([], null, {}), null)
  assert.equal(attentionTime(waiting), 5)
  assert.equal(attentionTime({ ...waiting, askSince: null }), 10)
  assert.equal(attentionTime({ ...waiting, activity: 0, askSince: null }), null)
})
test('view receipts stay bounded', () => {
  let seen = {}
  for (let i = 0; i < 510; i++) seen = recordView(seen, { ...done, key: `s${i}` })
  assert.equal(Object.keys(seen).length, 500)
})
