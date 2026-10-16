import assert from 'node:assert/strict'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { keyTowardYes, sameFolder, trustDialog } from '../src/trust.mjs'
import { trustScreen } from './fixtures/trust-screen.mjs'

const FOLDER = 'C:\\Users\\me\\AppData\\Local\\Temp\\work\\a-new-project-with-a-long-name'

test('the trust dialog: its folder (wrapped lines joined) and which answer the cursor is on', () => {
  const d = trustDialog(trustScreen(FOLDER))
  assert.deepEqual(d, { folder: FOLDER, options: ['no', 'yes'], selected: 'no' })
  assert.equal(trustDialog(trustScreen(FOLDER, { selected: 'yes' })).selected, 'yes')
  assert.equal(trustDialog(trustScreen(FOLDER, { ansi: false })).folder, FOLDER)
  // No ❯ to be seen: the cursor is unknown, never assumed.
  assert.equal(trustDialog(trustScreen(FOLDER, { selected: null })).selected, null)
})

test('only a dialog Claude shows now, with both answers', () => {
  // Answered already: Claude's own screen came after it.
  assert.equal(trustDialog(`${trustScreen(FOLDER)}\r\n\r\n╭─ Claude Code ─╮\r\n ❯ Try "fix lint errors"\r\n`), null)
  assert.equal(trustDialog(trustScreen(FOLDER).replace('Yes, I trust this folder', 'Something else')), null)
  assert.equal(trustDialog('PS C:\\> claude\r\n Welcome to Claude Code\r\n'), null)
  assert.equal(trustDialog(''), null)
  // The last dialog on screen counts: an older one above it does not.
  const twice = `${trustScreen('C:\\old\\one')}\r\n${trustScreen(FOLDER, { selected: 'yes' })}`
  assert.deepEqual([trustDialog(twice).folder, trustDialog(twice).selected], [FOLDER, 'yes'])
})

test('the folder on screen is compared without the breaks Claude puts in it', () => {
  assert.ok(sameFolder(FOLDER, FOLDER.toLowerCase()))
  assert.ok(sameFolder('C:\\Work\\MyFolder', 'C:\\Work\\My Folder')) // broken where it had a space
  assert.ok(sameFolder('C:/Work/x/', 'C:\\Work\\x'))
  assert.ok(sameFolder('~/code/app', join(homedir(), 'code', 'app')))
  assert.ok(!sameFolder('C:\\Work\\x', 'C:\\Work\\y'))
  assert.ok(!sameFolder('', 'C:\\Work\\x'))
})

test('the key toward "Yes" follows the cursor on screen', () => {
  assert.equal(keyTowardYes({ options: ['no', 'yes'], selected: 'no' }), 'down')
  assert.equal(keyTowardYes({ options: ['no', 'yes'], selected: 'yes' }), '')
  assert.equal(keyTowardYes({ options: ['yes', 'no'], selected: 'no' }), 'up')
  assert.equal(keyTowardYes({ options: ['no', 'yes'], selected: null }), null)
  assert.equal(keyTowardYes(null), null)
})
