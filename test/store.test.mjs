import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, readdirSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { sandbox, until } from './fixtures/sandbox.mjs'

const message = (proc, key) => proc.messages.find(m => m[key])
async function done(proc) {
  const out = await proc.exited
  assert.equal(out.code, 0, out.stderr)
  assert.ok(message(proc, 'done'), JSON.stringify(proc.messages))
}

test('separate processes merge the same card under contention; another card is independent', { timeout: 15_000 }, async t => {
  const box = sandbox(t)
  const release = join(box.dir, 'release-writer')
  const first = box.run('write', { key: 'shared', patch: { doing: 'first' }, release })
  await until(() => message(first, 'held'))
  const independent = box.run('write', { key: 'other', patch: { wait: 'independent' } })
  await done(independent)
  assert.equal(message(first, 'done'), undefined)
  const second = box.run('write', { key: 'shared', patch: { category: 'second' } })
  await until(() => message(second, 'attempting'))
  // Without serialization the second writer finishes while the first holds an old read.
  // Release on that completion (old code), or after a short wait (correctly locked code).
  await Promise.race([second.exited, new Promise(resolve => setTimeout(resolve, 300))])
  writeFileSync(release, '')
  await Promise.all([done(first), done(second)])
  const card = JSON.parse(readFileSync(join(box.cards, 'shared.json'), 'utf8'))
  assert.equal(card.doing, 'first')
  assert.equal(card.category, 'second')
  assert.ok(readdirSync(box.cards).every(name => name.endsWith('.json')))
})

test('an occupied card lock times out without deleting another writer lock or changing data', { timeout: 10_000 }, async t => {
  const box = sandbox(t)
  mkdirSync(join(box.cards, 'shared.json.lock'), { recursive: true })
  writeFileSync(join(box.cards, 'shared.json'), '{"key":"shared","doing":"original"}')
  const proc = box.run('write', { key: 'shared', patch: { doing: 'changed' } })
  const out = await proc.exited
  assert.equal(out.code, 0, out.stderr)
  assert.match(message(proc, 'error')?.error ?? '', /Timed out waiting for card lock/)
  assert.equal(JSON.parse(readFileSync(join(box.cards, 'shared.json'), 'utf8')).doing, 'original')
  assert.ok(existsSync(join(box.cards, 'shared.json.lock')))
})

test('a lock left by a writer that died long ago is taken over', { timeout: 10_000 }, async t => {
  const box = sandbox(t)
  const lock = join(box.cards, 'shared.json.lock')
  mkdirSync(lock, { recursive: true })
  const old = new Date(Date.now() - 60_000)
  utimesSync(lock, old, old)
  writeFileSync(join(box.cards, 'shared.json'), '{"key":"shared","doing":"original"}')
  await done(box.run('write', { key: 'shared', patch: { doing: 'changed' } }))
  assert.equal(JSON.parse(readFileSync(join(box.cards, 'shared.json'), 'utf8')).doing, 'changed')
  assert.equal(existsSync(lock), false)
})

for (const failure of ['patch', 'rename']) {
  test(`write releases its lock and temporary file after ${failure} failure`, { timeout: 10_000 }, async t => {
    const box = sandbox(t)
    if (failure === 'rename') mkdirSync(join(box.cards, 'broken.json'), { recursive: true })
    const proc = box.run('write', { key: 'broken', patch: {}, failPatch: failure === 'patch' })
    const out = await proc.exited
    assert.equal(out.code, 0, out.stderr)
    assert.ok(message(proc, 'error'))
    assert.equal(existsSync(join(box.cards, 'broken.json.lock')), false)
    assert.ok(readdirSync(box.cards).every(name => !name.endsWith('.tmp')))
    if (failure === 'patch') await done(box.run('write', { key: 'broken', patch: { doing: 'recovered' } }))
  })
}

test('successive processes preserve merge and field clearing semantics', async t => {
  const box = sandbox(t)
  await done(box.run('write', { key: 's', patch: { doing: 'x', wait: 'y', category: 'work' } }))
  await done(box.run('write', { key: 's', patch: { doing: '', wait: null, result: 'done' } }))
  const card = JSON.parse(readFileSync(join(box.cards, 's.json'), 'utf8'))
  assert.equal(card.category, 'work')
  assert.equal(card.result, 'done')
  assert.equal(card.key, 's')
  assert.equal(typeof card.updatedAt, 'number')
  assert.equal('doing' in card, false)
  assert.equal('wait' in card, false)
})
