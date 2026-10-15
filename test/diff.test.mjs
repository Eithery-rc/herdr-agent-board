import assert from 'node:assert/strict'
import { test } from 'node:test'
import { changedFiles, parseDiff, parseStatus } from '../web/diff.js'

test('git status: codes, renames, untracked and quoted paths', () => {
  const status = [' M src/app.js', 'A  new.txt', ' D gone.md', 'R  old name.txt -> new name.txt', '?? draft/', 'UU both.js', '?? "caf\\303\\251.txt"'].join('\n')
  assert.deepEqual(parseStatus(status), [
    { path: 'src/app.js', from: null, code: 'M' },
    { path: 'new.txt', from: null, code: 'A' },
    { path: 'gone.md', from: null, code: 'D' },
    { path: 'new name.txt', from: 'old name.txt', code: 'R' },
    { path: 'draft/', from: null, code: '??' },
    { path: 'both.js', from: null, code: 'U' },
    { path: 'café.txt', from: null, code: '??' },
  ])
})

test('git diff: files, both line numbers through hunks, counts, binary files', () => {
  const diff = [
    'diff --git a/src/app.js b/src/app.js',
    'index 1111111..2222222 100644',
    '--- a/src/app.js',
    '+++ b/src/app.js',
    '@@ -10,4 +10,5 @@ function x() {',
    ' keep',
    '-old line',
    '+new line',
    '+added',
    ' keep 2',
    '@@ -40 +41 @@',
    '-a',
    '+b',
    '\\ No newline at end of file',
    'diff --git a/logo.png b/logo.png',
    'index 3333333..4444444 100644',
    'Binary files a/logo.png and b/logo.png differ',
  ].join('\n')
  const [app, logo] = parseDiff(diff)
  assert.equal(app.path, 'src/app.js')
  assert.equal(app.added, 3)
  assert.equal(app.removed, 2)
  assert.deepEqual(app.lines.map(l => [l.kind, l.old, l.new]), [
    ['hunk', null, null], ['ctx', 10, 10], ['del', 11, null], ['add', null, 11], ['add', null, 12], ['ctx', 12, 13],
    ['hunk', null, null], ['del', 40, null], ['add', null, 41], ['note', null, null],
  ])
  assert.equal(logo.binary, true)
  assert.equal(logo.lines.length, 0)
})

test('status and diff together: every file once, untracked ones without a diff', () => {
  const files = changedFiles(' M a.js\n?? b.txt\n', 'diff --git a/a.js b/a.js\n--- a/a.js\n+++ b/a.js\n@@ -1 +1 @@\n-x\n+y\n')
  assert.deepEqual(files.map(f => [f.path, f.code, !!f.diff]), [['a.js', 'M', true], ['b.txt', '??', false]])
  assert.equal(changedFiles('', '').length, 0)
})
