// The checks in front of the keys: answer.mjs and the server's answer/permit route against the
// fake herdr. Every refusal must come before a key is sent.
import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { parseDialog } from '../src/questions.mjs'
import { sandbox, until } from './fixtures/sandbox.mjs'

const screen = name => readFileSync(new URL(`./fixtures/screens/${name}.txt`, import.meta.url), 'utf8').replace(/\r\n/g, '\n')
const BASH = screen('permission-bash')
const FINGERPRINT = parseDialog(BASH).fingerprint
// Claude's input box and no dialog: what the pane shows once a dialog is answered.
const IDLE = ['● Done.', '', '─'.repeat(60), '❯ ', '─'.repeat(60), '  ⏵⏵ manual mode on'].join('\n')
const COLOR = { questions: [{ question: 'Which color should the test widget use?', header: 'Color', multiSelect: false, options: [
  { label: 'Red', description: 'A warm red, good for alerts' }, { label: 'Green', description: 'Calm green for success states' }, { label: 'Blue', description: 'Neutral blue, the default' }] }] }

const agent = (status = 'blocked', session = 's1') => ({ result: { agent: { agent: 'claude', agent_status: status, agent_session: { value: session } } } })
const item = (box, extra = {}) => ({ key: 's1', session: 's1', pane: 'p1', agent: 'claude', name: 'Probe', transcript: join(box.dir, 's1.jsonl'), ...extra })
const keysSent = box => box.calls().filter(a => a[1] === 'send-keys' || a[1] === 'send-text')

/** A transcript whose last call is this AskUserQuestion, answered or not. */
function transcript(path, id, answered = false) {
  const ask = { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'AskUserQuestion', input: COLOR }] } }
  const result = { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'answered' }] }, toolUseResult: { answers: { [COLOR.questions[0].question]: 'Blue' } } }
  writeFileSync(path, `${JSON.stringify(ask)}\n${answered ? `${JSON.stringify(result)}\n` : ''}`)
}

async function run(box, input) {
  const out = await box.run('answer', input).exited
  assert.equal(out.code, 0, out.stderr)
  return JSON.parse(out.stdout)
}

test('refusals come before any key: not Claude, another session, not waiting, no fresh question', { timeout: 30_000 }, async t => {
  const box = sandbox(t)
  transcript(join(box.dir, 's1.jsonl'), 'toolu_1')
  box.state({ 'agent get': agent(), 'agent read': { text: screen('question-single') } })
  const notClaude = await run(box, { kind: 'permit', item: item(box, { agent: 'codex' }), body: { fingerprint: FINGERPRINT, option: 1 } })
  assert.match(notClaude.error, /not a Claude session/)
  const noSession = await run(box, { kind: 'answer', item: item(box, { session: null }), body: { toolUseId: 'toolu_1', answers: [{ options: ['Blue'] }] } })
  assert.equal(noSession.ok, false)
  assert.equal(box.calls().length, 0) // refused before asking herdr anything

  box.state({ 'agent get': agent('blocked', 'someone-else'), 'agent read': { text: screen('question-single') } })
  assert.match((await run(box, { kind: 'answer', item: item(box), body: { toolUseId: 'toolu_1', answers: [{ options: ['Blue'] }] } })).error, /another session/)
  box.state({ 'agent get': agent('working'), 'agent read': { text: screen('question-single') } })
  const working = await run(box, { kind: 'answer', item: item(box), body: { toolUseId: 'toolu_1', answers: [{ options: ['Blue'] }] } })
  assert.equal(working.gone, true)
  assert.match(working.error, /no longer waits/)

  box.state({ 'agent get': agent(), 'agent read': { text: screen('question-single') } })
  const other = await run(box, { kind: 'answer', item: item(box), body: { toolUseId: 'toolu_older', answers: [{ options: ['Blue'] }] } })
  assert.equal(other.gone, true)
  assert.match(other.error, /no longer open/)
  transcript(join(box.dir, 's1.jsonl'), 'toolu_1', true)
  assert.equal((await run(box, { kind: 'answer', item: item(box), body: { toolUseId: 'toolu_1', answers: [{ options: ['Blue'] }] } })).gone, true)
  transcript(join(box.dir, 's1.jsonl'), 'toolu_1')
  assert.match((await run(box, { kind: 'answer', item: item(box), body: { toolUseId: 'toolu_1', answers: [{ options: ['Teal'] }] } })).error, /every question/)
  // A permission prompt that is not the one the user saw.
  box.state({ 'agent get': agent(), 'agent read': { text: screen('permission-write') } })
  const changed = await run(box, { kind: 'permit', item: item(box), body: { fingerprint: FINGERPRINT, option: 1 } })
  assert.match(changed.error, /another dialog/)
  assert.equal(changed.stopped, false)
  assert.deepEqual(keysSent(box), [])
})

test('an answer goes in, and counts as done once the transcript has it', { timeout: 30_000 }, async t => {
  const box = sandbox(t)
  const path = join(box.dir, 's1.jsonl')
  transcript(path, 'toolu_1')
  box.state({ 'agent get': agent(), 'agent read': { text: screen('question-single') }, 'agent send-keys': { result: null } })
  const running = box.run('answer', { kind: 'answer', item: item(box), body: { toolUseId: 'toolu_1', answers: [{ options: ['Blue'] }] } })
  await until(() => keysSent(box).length > 0, 10_000)
  // The screen is still the old one (a slow redraw); the transcript already has the answer.
  transcript(path, 'toolu_1', true)
  const out = await running.exited
  assert.equal(out.code, 0, out.stderr)
  assert.deepEqual(JSON.parse(out.stdout), { ok: true, answers: [{ question: COLOR.questions[0].question, answer: 'Blue' }] })
  assert.deepEqual(keysSent(box), [['agent', 'send-keys', 'p1', '3']])
})

test('a permission prompt: one key, done when the input box is back twice; a blank screen proves nothing', { timeout: 30_000 }, async t => {
  const box = sandbox(t)
  box.state({ 'agent get': agent(), 'agent read': { text: BASH }, 'agent send-keys': { result: null } })
  const running = box.run('answer', { kind: 'permit', item: item(box), body: { fingerprint: FINGERPRINT, option: 1 } })
  await until(() => keysSent(box).length > 0, 10_000)
  box.state({ 'agent get': agent(), 'agent read': { text: IDLE }, 'agent send-keys': { result: null } })
  const out = await running.exited
  assert.deepEqual(JSON.parse(out.stdout), { ok: true })
  assert.deepEqual(keysSent(box), [['agent', 'send-keys', 'p1', '1']])

  // Blank after the key: not taken for done.
  const blank = sandbox(t)
  blank.state({ 'agent get': agent(), 'agent read': { text: BASH }, 'agent send-keys': { result: null } })
  const second = blank.run('answer', { kind: 'permit', item: item(blank), body: { fingerprint: FINGERPRINT, option: 4 } })
  await until(() => keysSent(blank).length > 0, 10_000)
  blank.state({ 'agent get': agent(), 'agent read': { text: '\n\n' }, 'agent send-keys': { result: null } })
  const r = JSON.parse((await second.exited).stdout)
  assert.equal(r.ok, false)
  assert.equal(r.stopped, true)
  assert.match(r.error, /never showed the dialog closing/)
})

test('herdr failing: before any key it says so; after keys it says the dialog may be partly filled in', { timeout: 30_000 }, async t => {
  const box = sandbox(t)
  box.state({ 'agent get': agent(), 'agent read': { error: 'pipe closed' } })
  const before = await run(box, { kind: 'permit', item: item(box), body: { fingerprint: FINGERPRINT, option: 1 } })
  assert.match(before.error, /herdr did not answer: .*pipe closed/)
  assert.ok(!before.stopped)
  box.state({ 'agent get': agent(), 'agent read': { text: BASH }, 'agent send-keys': { error: 'pipe closed' } })
  const after = await run(box, { kind: 'permit', item: item(box), body: { fingerprint: FINGERPRINT, option: 1 } })
  assert.equal(after.stopped, true)
  assert.match(after.error, /partly filled in/)
  assert.match(after.screen, /Do you want to proceed\?/)
})

test('an own answer that starts with a dash gets a space before it', { timeout: 10_000 }, async t => {
  const box = sandbox(t)
  box.state({ 'pane send-text': { result: null } })
  await run(box, { kind: 'text', item: { pane: 'p1' }, text: '-1 day' })
  await run(box, { kind: 'text', item: { pane: 'p1' }, text: 'plain' })
  assert.deepEqual(keysSent(box), [['pane', 'send-text', 'p1', ' -1 day'], ['pane', 'send-text', 'p1', 'plain']])
})

// ---------------------------------------------------------------- the route

async function unusedPort() {
  const server = http.createServer()
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  await new Promise(resolve => server.close(resolve))
  return port
}

const SNAPSHOT = { result: { snapshot: { panes: [{ pane_id: 'p1', agent: 'claude', agent_session: { value: 's1' }, agent_status: 'blocked', cwd: '' }], tabs: [], workspaces: [] } } }

async function board(t, state) {
  const box = sandbox(t)
  mkdirSync(join(box.env.HOME, '.claude', 'projects', 'p'), { recursive: true })
  box.state(state)
  const port = await unusedPort()
  const proc = box.run('server', { port, categories: [{ id: 'other', title: 'Other', color: 'gray' }], wakeUrl: null, refreshSec: 3600, language: 'en' })
  await until(() => proc.messages.some(m => m.ready))
  const post = (action, body, headers = {}) =>
    fetch(`http://127.0.0.1:${port}/api/session/s1/${action}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-board': '1', ...headers }, body: JSON.stringify(body) }).then(async r => ({ status: r.status, body: await r.json() }))
  return { box, proc, port, post }
}

test('the route: stale data, another page, another session, one answer at a time', { timeout: 40_000 }, async t => {
  const gate = sandbox(t).dir
  const { box, proc, port, post } = await board(t, { 'api snapshot': SNAPSHOT, 'agent get': { ...agent(), waitFor: join(gate, 'go') }, 'agent read': { text: BASH }, 'agent send-keys': { result: null } })
  await until(() => box.calls().some(a => a[1] === 'snapshot'))
  proc.send('refresh')
  await until(() => proc.messages.some(m => m.refreshed))

  const page = await post('permit', { session: 's1', fingerprint: FINGERPRINT, option: 1 }, { origin: 'http://evil.example' })
  assert.equal(page.status, 403)
  const other = await post('permit', { session: 's2', fingerprint: FINGERPRINT, option: 1 })
  assert.equal(other.status, 409)
  assert.match(other.body.error, /another session/)

  // The first holds in herdr; a second one at the same time is turned away.
  const first = post('permit', { session: 's1', fingerprint: FINGERPRINT, option: 1 })
  await until(() => box.calls().some(a => a[1] === 'get'))
  const second = await post('permit', { session: 's1', fingerprint: FINGERPRINT, option: 2 })
  assert.equal(second.status, 409, JSON.stringify(second.body) + JSON.stringify(proc.messages))
  assert.match(second.body.error, /already being typed/)
  box.state({ 'api snapshot': SNAPSHOT, 'agent get': agent(), 'agent read': { text: BASH }, 'agent send-keys': { result: null } })
  writeFileSync(join(gate, 'go'), '')
  await until(() => keysSent(box).length > 0, 10_000)
  box.state({ 'api snapshot': SNAPSHOT, 'agent get': agent(), 'agent read': { text: IDLE }, 'agent send-keys': { result: null } })
  const done = await first
  assert.equal(done.status, 200, JSON.stringify(done.body))
  assert.deepEqual(keysSent(box), [['agent', 'send-keys', 'p1', '1']])

  // herdr gone: the board's data goes stale and answers wait for it.
  box.state({ 'api snapshot': { error: 'offline' } })
  for (let i = 0; i < 50 && !(await fetch(`http://127.0.0.1:${port}/api/board`).then(r => r.json())).stale; i++) {
    proc.send('refresh')
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  const stale = await post('answer', { session: 's1', toolUseId: 'toolu_1', answers: [] })
  assert.equal(stale.status, 409, JSON.stringify(stale.body))
  assert.match(stale.body.error, /No fresh data/)
  assert.equal(keysSent(box).length, 1)
})
