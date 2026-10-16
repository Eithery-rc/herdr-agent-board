import assert from 'node:assert/strict'
import test from 'node:test'
import { launchContext, launchDraftBook } from '../web/launch-drafts.js'

test('launch forms stay with their project and restore all choices together', () => {
  const book = launchDraftBook()
  const a = launchContext({ item: { cwd: '/work/payments', category: 'payments' } })
  const b = launchContext({ item: { cwd: '/work/platform', category: 'platform' } })
  const form = { name: 'Payments', cwd: '/work/payments', category: 'payments', message: 'Fix charges', workspace: 'Payments', newWorkspace: false, worktree: { branch: 'fix-charges' } }
  book.write(a, form)
  assert.equal(book.read(b), null)
  assert.deepEqual(book.read(a), form)
  form.worktree.branch = 'changed-outside'
  assert.equal(book.read(a).worktree.branch, 'fix-charges')
  assert.notEqual(launchContext({ category: 'payments' }), launchContext({ category: 'platform' }))
  assert.notEqual(a, launchContext({ item: { cwd: '/work/payments', category: 'payments' }, newWorkspace: true }))
  assert.notEqual(launchContext({ cwd: '/work/A' }), launchContext({ cwd: '/work/a' }))
  assert.equal(launchContext({ cwd: 'C:\\Work\\A\\' }), launchContext({ cwd: 'c:/work/a' }))
})

test('success clears its submitted form without erasing a newer edit or another project', () => {
  const book = launchDraftBook()
  const sent = book.write('a', { message: 'first' })
  assert.equal(book.write('a', { message: 'first' }), sent)
  book.write('a', { message: 'later edit' })
  book.write('b', { message: 'other project' })
  book.clear('a', sent)
  assert.equal(book.read('a').message, 'later edit')
  assert.equal(book.read('b').message, 'other project')
  const cleared = book.write('a', { message: '' })
  book.clear('a', cleared)
  assert.equal(book.read('a'), null)
})

test('abandoned forms expire and the page keeps a bounded number', () => {
  let clock = 0
  const book = launchDraftBook({ now: () => clock, lifetime: 100, limit: 2 })
  book.write('a', {})
  book.write('b', {})
  book.write('c', {})
  assert.equal(book.read('a'), null)
  clock = 100
  assert.equal(book.read('c'), null)
})
