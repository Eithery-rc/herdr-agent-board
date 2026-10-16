import assert from 'node:assert/strict'
import test from 'node:test'
import { limitInfo } from '../web/limits-model.js'

test('zero usage is a reading, missing or malformed values remain unknown', () => {
  assert.deepEqual(limitInfo(null).windows, [])
  assert.deepEqual(limitInfo({ windows: 'invalid' }).windows, [])
  const info = limitInfo({ source: 'usagebar', observedAt: 1000, windows: [{ minutes: 300, usedPercentage: 0 }, { minutes: 10080, usedPercentage: '10' }, { minutes: 300, usedPercentage: 101 }] }, { now: 2000 })
  assert.deepEqual(info.windows, [{ minutes: 300, usedPercentage: 0 }])
  assert.equal(info.source, 'usagebar')
  assert.equal(info.stale, false)
})
test('a disconnected or old reading stays stale; unknown source is not an account claim', () => {
  const reading = { observedAt: 1000, windows: [{ minutes: 300, usedPercentage: 92 }] }
  assert.equal(limitInfo(reading, { connected: false, now: 2000 }).stale, true)
  assert.equal(limitInfo(reading, { now: 1_802_000 }).stale, true)
  assert.equal(limitInfo(reading, { now: 2000 }).source, 'unknown')
  assert.equal(limitInfo({ ...reading, observedAt: 90_000 }, { now: 2000 }).observedAt, null)
})
