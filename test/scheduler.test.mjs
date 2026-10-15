import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import http from 'node:http'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { root, sandbox, until } from './fixtures/sandbox.mjs'

// The scheduler runs in a child process against a fake herdr: entries are files in the sandbox's
// schedule folder, the session's prompt is a logged `herdr agent prompt` call.
const HOUR = 3600e3
const dirOf = box => join(box.env.LOCALAPPDATA, 'herdr/plugins/agent-board/schedule')
const cardsOf = box => join(box.env.LOCALAPPDATA, 'herdr/plugins/agent-board/cards')

function put(box, entry) {
  mkdirSync(dirOf(box), { recursive: true })
  writeFileSync(join(dirOf(box), `${entry.id}.json`), JSON.stringify({ key: 's1', name: 'Test', created: Date.now(), ...entry }))
}
const read = (box, id) => (existsSync(join(dirOf(box), `${id}.json`)) ? JSON.parse(readFileSync(join(dirOf(box), `${id}.json`), 'utf8')) : null)
const runs = box => (existsSync(join(dirOf(box), 'log.jsonl')) ? readFileSync(join(dirOf(box), 'log.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) : [])
const prompts = box => box.calls().filter(a => a[1] === 'prompt').map(a => a[3])

/** Claude's input box as `herdr agent read --ansi` shows it; a suggestion is drawn dim. */
const RULE = '─'.repeat(40)
const screen = (typed = '', dim = '') => ['● done', RULE, `❯ ${typed}${dim ? `\x1b[2m${dim}\x1b[0m` : ''}`, RULE, '  ⏵⏵ bypass permissions on'].join('\n')

/** herdr with one Claude session s1 in pane p1. */
function herdrWith(box, status, extra = {}) {
  const snapshot = { panes: [{ pane_id: 'p1', agent: 'claude', agent_session: { value: 's1' }, agent_status: status, cwd: box.dir }], tabs: [], workspaces: [] }
  box.state({
    'api snapshot': { result: { snapshot } },
    'agent get': { result: { agent: { agent: 'claude', agent_status: status, agent_session: { value: 's1' } } } },
    'agent read': { text: screen('', 'try: run the tests') },
    'agent prompt': { result: {} },
    ...extra,
  })
}

async function scheduler(box, cfg = {}) {
  const proc = box.run('scheduler', { categories: [{ id: 'other', title: 'Other', color: 'gray' }], wakeUrl: null, scheduleTickSec: 0.2, ...cfg })
  await until(() => proc.messages.some(m => m.ready))
  return proc
}

/** The sandbox's board config; port 9 answers nothing, so the CLI never reaches the live board. */
function config(box, extra = {}) {
  const dir = join(box.env.APPDATA, 'herdr/plugins/config/agent-board')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ language: 'en', port: 9, ...extra }))
}

/** The board command in an agent's session (its env), with herdr answered by the fake. */
async function agentCli(box, args, env = {}) {
  const out = await box.run('cli', { args, env }).exited
  return { code: out.code, out: `${out.stdout}${out.stderr}`.trim() }
}

function cli(box, args) {
  if (!existsSync(join(box.env.APPDATA, 'herdr/plugins/config/agent-board/config.json'))) config(box)
  return new Promise(resolve => {
    const proc = spawn(process.execPath, [join(root, 'src/cli.mjs'), ...args], { cwd: root, env: box.env })
    let out = ''
    proc.stdout.on('data', c => (out += c))
    proc.stderr.on('data', c => (out += c))
    proc.on('close', code => resolve({ code, out: out.trim() }))
  })
}

test('board remind / every / schedule / unschedule keep entries for the session', { timeout: 15_000 }, async t => {
  const box = sandbox(t)
  const s = ['--session', '11111111-2222-3333-4444-555555555555']
  const one = await cli(box, ['remind', ...s, 'in', '30m', 'check the CI run'])
  assert.equal(one.code, 0, one.out)
  const id = /reminder ([0-9a-f]{6})/.exec(one.out)[1]
  const entry = read(box, id)
  assert.equal(entry.text, 'check the CI run')
  assert.ok(Math.abs(entry.next - (Date.now() + 30 * 60e3)) < 10_000)
  const every = await cli(box, ['every', ...s, '0 9 * * 1-5', 'check the inbox'])
  assert.equal(every.code, 0, every.out)
  assert.equal(read(box, /every ([0-9a-f]{6})/.exec(every.out)[1]).cron, '0 9 * * 1-5')
  // PowerShell passes the five fields unquoted.
  assert.equal((await cli(box, ['every', ...s, '0', '9', '*', '*', 'mon', 'weekly'])).code, 0)
  assert.match((await cli(box, ['remind', ...s, 'today', '0:00', 'past'])).out, /in the past/)
  assert.match((await cli(box, ['remind', ...s, 'soon', 'text'])).out, /usage/)
  assert.match((await cli(box, ['every', ...s, '0 0 30 2 *', 'never'])).out, /never runs/)
  assert.match((await cli(box, ['every', ...s, '*/2 * * * *', 'too often'])).out, /more often than every 5 minutes/)
  assert.match((await cli(box, ['remind', ...s, 'in', '99999999999d', 'never'])).out, /usage/)
  assert.match((await cli(box, ['remind', ...s, 'in', '3000d', 'far'])).out, /five years/)
  assert.match((await cli(box, ['every', ...s, '* * *', 'bad'])).out, /5 fields/)
  const list = await cli(box, ['schedule', ...s])
  assert.equal(list.out.split('\n').length, 3)
  assert.match(list.out, /every "0 9 \* \* 1-5"/)
  assert.match((await cli(box, ['unschedule', ...s])).out, /usage/)
  assert.match((await cli(box, ['unschedule', id])).out, new RegExp(`removed ${id}`))
  assert.equal(read(box, id), null)
  assert.match((await cli(box, ['unschedule', ...s, 'all'])).out, /removed 2 entries/)
  assert.deepEqual(readdirSync(dirOf(box)).filter(n => n.endsWith('.json')), [])
})

test('a due reminder goes into an idle session, then it is gone and logged', { timeout: 15_000 }, async t => {
  const box = sandbox(t)
  herdrWith(box, 'idle')
  put(box, { id: 'aaaaa1', text: 'check the CI run', at: Date.now() - 1000, next: Date.now() - 1000 })
  await scheduler(box)
  await until(() => prompts(box).length === 1 && runs(box).length === 1)
  assert.deepEqual(prompts(box), ['[board reminder] check the CI run'])
  assert.equal(read(box, 'aaaaa1'), null)
  assert.equal(runs(box)[0].result, 'sent')
})

test('after the board was off: a one-off says how late, a cron entry runs once for all it missed', { timeout: 15_000 }, async t => {
  const box = sandbox(t)
  herdrWith(box, 'idle')
  const top = new Date()
  top.setMinutes(0, 0, 0)
  put(box, { id: 'bbbbb1', text: 'late one', at: Date.now() - 3 * HOUR, next: Date.now() - 3 * HOUR })
  put(box, { id: 'bbbbb2', key: 's2', text: 'hourly', cron: '0 * * * *', next: top.getTime() - 3 * HOUR })
  const snapshot = { panes: ['s1', 's2'].map((s, i) => ({ pane_id: `p${i + 1}`, agent: 'claude', agent_session: { value: s }, agent_status: 'idle' })), tabs: [], workspaces: [] }
  box.state({
    'api snapshot': { result: { snapshot } },
    'agent get p1': { result: { agent: { agent_status: 'idle', agent_session: { value: 's1' } } } },
    'agent get p2': { result: { agent: { agent_status: 'idle', agent_session: { value: 's2' } } } },
    'agent prompt': { result: {} },
  })
  await scheduler(box)
  await until(() => prompts(box).length === 2 && runs(box).length === 2)
  const [late] = prompts(box).filter(p => p.endsWith('late one'))
  assert.match(late, /^\[board reminder; 3 h late, due .+\] late one$/)
  const [hourly] = prompts(box).filter(p => p.endsWith('hourly'))
  assert.match(hourly, /^\[board schedule bbbbb2: 0 \* \* \* \*; 4 runs since .+, sent once\] hourly$/)
  const cron = read(box, 'bbbbb2')
  assert.ok(cron.next > Date.now())
  assert.equal(cron.runs, 1)
  assert.equal(cron.claim, undefined)
})

test('a working session gets it once it is free; one that stays busy has it logged as missed', { timeout: 15_000 }, async t => {
  const box = sandbox(t)
  herdrWith(box, 'working')
  put(box, { id: 'ccccc1', text: 'when free', at: Date.now() - 1000, next: Date.now() - 1000 })
  await scheduler(box, { scheduleWaitMin: 1 })
  await until(() => read(box, 'ccccc1')?.pendingSince)
  await new Promise(resolve => setTimeout(resolve, 600))
  assert.deepEqual(prompts(box), [])
  assert.equal(read(box, 'ccccc1').why, 'busy')
  herdrWith(box, 'idle')
  await until(() => prompts(box).length === 1)
  assert.deepEqual(prompts(box), ['[board reminder] when free'])

  const busy = sandbox(t)
  herdrWith(busy, 'blocked')
  put(busy, { id: 'ccccc2', text: 'never free', at: Date.now() - 1000, next: Date.now() - 1000 })
  put(busy, { id: 'ccccc3', key: 's1', text: 'cron never free', cron: '* * * * *', next: Date.now() - 1000 })
  await scheduler(busy, { scheduleWaitMin: 0.01 })
  await until(() => runs(busy).length >= 2, 8000)
  assert.deepEqual(prompts(busy), [])
  assert.ok(runs(busy).every(r => r.result === 'missed' && r.why === 'busy'))
  assert.equal(read(busy, 'ccccc2'), null)
  const cron = read(busy, 'ccccc3')
  assert.equal(cron.missed, 1)
  assert.ok(cron.next > Date.now() - 1000)
  assert.equal(cron.pendingSince, undefined)
})

test('text the user left in the input box holds the reminder back until it is gone', { timeout: 15_000 }, async t => {
  const box = sandbox(t)
  herdrWith(box, 'idle', { 'agent read': { text: screen('half a thought') } })
  put(box, { id: 'ddddd2', text: 'not over your draft', at: Date.now() - 1000, next: Date.now() - 1000 })
  await scheduler(box)
  await until(() => read(box, 'ddddd2')?.why === 'draft')
  assert.deepEqual(prompts(box), [])
  herdrWith(box, 'idle')
  await until(() => prompts(box).length === 1)
  assert.deepEqual(prompts(box), ['[board reminder] not over your draft'])
})

test('after /clear the reminder goes to the new session in the same pane and folder', { timeout: 15_000 }, async t => {
  const box = sandbox(t)
  herdrWith(box, 'idle')
  // Set by session s0, which /clear replaced with s1 in pane p1.
  put(box, { id: 'ddddd3', key: 's0', pane: 'p1', cwd: box.dir, text: 'still yours', at: Date.now() - 1000, next: Date.now() - 1000 })
  put(box, { id: 'ddddd4', key: 's8', pane: 'p1', cwd: join(box.dir, 'elsewhere'), text: 'another folder', at: Date.now() - 1000, next: Date.now() - 1000 })
  await scheduler(box)
  await until(() => prompts(box).length === 1 && runs(box).length === 1)
  // The receiver hears it was set before /clear, so it can judge whether it still applies.
  assert.deepEqual(prompts(box), ['[board reminder; set by Test before /clear] still yours'])
  assert.equal(runs(box)[0].key, 's1')
  await until(() => read(box, 'ddddd4')?.why === 'gone')
})

test('a reminder set for another session says who set it', { timeout: 15_000 }, async t => {
  const box = sandbox(t)
  herdrWith(box, 'idle')
  const past = Date.now() - 1000
  put(box, { id: 'abab01', text: 'review my PR', at: past, next: past, from: { key: 's7', name: 'Centium-master' } })
  await scheduler(box)
  await until(() => prompts(box).length === 1)
  assert.deepEqual(prompts(box), ['[board reminder from Centium-master] review my PR'])
  // Set by s7 for s0, which /clear turned into s1: both are said.
  put(box, { id: 'abab02', key: 's0', name: 'old', pane: 'p1', cwd: box.dir, text: 'cron', cron: '0 * * * *', next: past, from: { key: 's7', name: 'Centium-master' } })
  await until(() => prompts(box).length === 2)
  assert.equal(prompts(box)[1], '[board schedule abab02 from Centium-master: 0 * * * *; set for old before /clear] cron')
  // Its own reminder has no "from", also after /clear.
  put(box, { id: 'abab03', key: 's0', name: 'old', pane: 'p1', cwd: box.dir, text: 'mine', at: past, next: past, from: { key: 's0', name: 'old' } })
  await until(() => prompts(box).length === 3)
  assert.equal(prompts(box)[2], '[board reminder; set by old before /clear] mine')
})

test('board remind records who set it, the pane and the pane folder, and no control characters', { timeout: 15_000 }, async t => {
  const box = sandbox(t)
  config(box)
  const project = join(box.dir, 'project')
  const snapshot = {
    panes: [
      { pane_id: 'p1', agent: 'claude', agent_session: { value: 's1' }, agent_status: 'working', cwd: project, terminal_title_stripped: 'Setter' },
      { pane_id: 'p2', agent: 'claude', agent_session: { value: 's2' }, agent_status: 'idle', cwd: box.dir, terminal_title_stripped: 'Target' },
    ],
    tabs: [],
    workspaces: [],
  }
  box.state({ 'api snapshot': { result: { snapshot } } })
  // Its own: the folder is the pane's, not the shell's (the runner's cwd is the repo).
  const own = await agentCli(box, ['remind', 'in', '1h', 'own'], { CLAUDE_CODE_SESSION_ID: 's1', HERDR_PANE_ID: 'p1' })
  assert.equal(own.code, 0, own.out)
  const mine = read(box, /reminder ([0-9a-f]{6})/.exec(own.out)[1])
  assert.equal(mine.pane, 'p1')
  assert.equal(mine.cwd, project)
  assert.equal(mine.from, undefined)
  // For another session: who set it, and the text without control characters.
  const other = await agentCli(box, ['remind', '--session', 'Target', 'in', '1h', 'look\x07 at\x1b[31m this\x7f'], { CLAUDE_CODE_SESSION_ID: 's1', HERDR_PANE_ID: 'p1' })
  assert.equal(other.code, 0, other.out)
  const theirs = read(box, /reminder ([0-9a-f]{6})/.exec(other.out)[1])
  assert.equal(theirs.key, 's2')
  assert.equal(theirs.cwd, box.dir)
  assert.deepEqual(theirs.from, { key: 's1', name: 'Setter' })
  assert.equal(theirs.text, 'look at[31m this')
  // No board answers on the sandbox's port: the agent is told it goes out once one runs.
  assert.match(own.out, /no board with the scheduler is running/)
})

test('board remind says nothing about the board when one with the scheduler answers', { timeout: 15_000 }, async t => {
  const box = sandbox(t)
  const board = http.createServer((req, res) => res.end(JSON.stringify({ items: [], schedules: [] })))
  await new Promise(resolve => board.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => board.close(resolve)))
  config(box, { port: board.address().port })
  const out = await agentCli(box, ['remind', '--session', '11111111-2222-3333-4444-555555555555', 'in', '1h', 'x'])
  assert.equal(out.code, 0, out.out)
  assert.doesNotMatch(out.out, /no board/)
})

test('a cron entry whose session stays gone is dropped after three runs in a row', { timeout: 15_000 }, async t => {
  const box = sandbox(t)
  herdrWith(box, 'idle')
  const past = Date.now() - 1000
  put(box, { id: 'acac01', key: 's-gone', text: 'orphan', cron: '0 * * * *', next: past, gone: 2, missed: 2 })
  put(box, { id: 'acac02', key: 's-gone2', text: 'first miss', cron: '0 * * * *', next: past })
  await scheduler(box, { scheduleWaitMin: 0.01 })
  await until(() => runs(box).length === 2, 8000)
  assert.equal(read(box, 'acac01'), null)
  const dropped = runs(box).find(r => r.id === 'acac01')
  assert.equal(dropped.result, 'dropped')
  assert.equal(dropped.n, 3)
  const kept = read(box, 'acac02')
  assert.equal(kept.gone, 1)
  assert.equal(kept.missed, 1)
  assert.equal(runs(box).find(r => r.id === 'acac02').result, 'missed')
  assert.deepEqual(prompts(box), [])
})

test('a sleeping session is woken through herdr-wake before it gets the text', { timeout: 15_000 }, async t => {
  const box = sandbox(t)
  box.state({ 'api snapshot': { result: { snapshot: { panes: [], tabs: [], workspaces: [] } } } })
  let wakes = 0
  const wake = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json')
    if (req.url === '/sleeping') return res.end(JSON.stringify(wakes ? [] : [{ session: 's1', pane: 'p1', name: 'Sleepy', slept_at: new Date().toISOString() }]))
    assert.equal(req.url, '/wake')
    wakes++
    herdrWith(box, 'idle')
    res.end('{"ok":true}')
  })
  await new Promise(resolve => wake.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => wake.close(resolve)))
  put(box, { id: 'ddddd1', text: 'wake up', at: Date.now() - 1000, next: Date.now() - 1000 })
  await scheduler(box, { wakeUrl: `http://127.0.0.1:${wake.address().port}` })
  await until(() => prompts(box).length === 1)
  assert.equal(wakes, 1)
  assert.deepEqual(prompts(box), ['[board reminder] wake up'])
})

test('a run another board claimed is left alone until its claim runs out', { timeout: 15_000 }, async t => {
  const box = sandbox(t)
  herdrWith(box, 'idle')
  put(box, { id: 'eeeee1', text: 'claimed', at: Date.now() - 1000, next: Date.now() - 1000, claim: { pid: process.pid, at: Date.now() } })
  put(box, { id: 'eeeee2', key: 's9', text: 'stale claim', at: Date.now() - 1000, next: Date.now() - 1000, claim: { pid: process.pid, at: Date.now() - 600_000 } })
  const snapshot = { panes: ['s1', 's9'].map((s, i) => ({ pane_id: `p${i + 1}`, agent: 'claude', agent_session: { value: s }, agent_status: 'idle' })), tabs: [], workspaces: [] }
  box.state({
    'api snapshot': { result: { snapshot } },
    'agent get p1': { result: { agent: { agent_status: 'idle', agent_session: { value: 's1' } } } },
    'agent get p2': { result: { agent: { agent_status: 'idle', agent_session: { value: 's9' } } } },
    'agent prompt': { result: {} },
  })
  await scheduler(box)
  await until(() => prompts(box).length === 1)
  await new Promise(resolve => setTimeout(resolve, 800))
  assert.deepEqual(prompts(box), ['[board reminder] stale claim'])
  assert.ok(read(box, 'eeeee1'))
})

test('an entry cancelled while its run is on the way stays cancelled', { timeout: 15_000 }, async t => {
  const box = sandbox(t)
  const gate = join(box.dir, 'prompt-gate')
  herdrWith(box, 'idle', { 'agent prompt': { result: {}, waitFor: gate } })
  put(box, { id: 'fffff1', text: 'every minute', cron: '* * * * *', next: Date.now() - 1000 })
  await scheduler(box)
  await until(() => prompts(box).length === 1)
  assert.match((await cli(box, ['unschedule', 'fffff1'])).out, /removed fffff1/)
  writeFileSync(gate, '')
  await until(() => runs(box).length === 1)
  await new Promise(resolve => setTimeout(resolve, 300))
  assert.equal(read(box, 'fffff1'), null)
})

test('a board reminder does not count as the user answering the session', { timeout: 15_000 }, async t => {
  const box = sandbox(t)
  mkdirSync(cardsOf(box), { recursive: true })
  const card = () => JSON.parse(readFileSync(join(cardsOf(box), 's1.json'), 'utf8'))
  writeFileSync(join(cardsOf(box), 's1.json'), JSON.stringify({ key: 's1', ask: 'Send it?', askSince: 1, pin: 'me', pinAt: 1, briefV: 99 }))
  const hook = prompt =>
    new Promise(resolve => {
      const proc = spawn(process.execPath, [join(root, 'src/hook.mjs')], { cwd: root, env: { ...box.env, HERDR_PANE_ID: 'p1' } })
      proc.on('close', resolve)
      proc.stdin.end(JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: 's1', cwd: box.dir, prompt }))
    })
  await hook('[board reminder from Centium-master] check the CI run')
  assert.equal(card().ask, 'Send it?')
  // The session works again: a column dragged to by hand goes, as with any work.
  assert.equal(card().pin, undefined)
  await hook('yes, send it')
  assert.equal(card().ask, undefined)
})

test('the web board lists the schedule without the bookkeeping and cancels an entry', { timeout: 15_000 }, async t => {
  const box = sandbox(t)
  herdrWith(box, 'idle')
  put(box, { id: 'abcdef', text: 'later', at: Date.now() + HOUR, next: Date.now() + HOUR, claim: { pid: 1, at: 1 }, tried: 1 })
  const probe = http.createServer()
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve))
  const port = probe.address().port
  await new Promise(resolve => probe.close(resolve))
  const proc = box.run('server', { port, categories: [{ id: 'other', title: 'Other', color: 'gray' }], wakeUrl: null, refreshSec: 3600 })
  await until(() => proc.messages.some(m => m.ready))
  const url = `http://127.0.0.1:${port}`
  const board = await (await fetch(`${url}/api/board`)).json()
  assert.equal(board.schedules.length, 1)
  assert.equal(board.schedules[0].text, 'later')
  assert.equal('claim' in board.schedules[0] || 'tried' in board.schedules[0], false)
  assert.deepEqual(board.scheduleLog, [])
  const cancel = headers => fetch(`${url}/api/schedule`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ op: 'cancel', id: 'abcdef' }) })
  assert.equal((await cancel({})).status, 403)
  assert.equal((await cancel({ 'x-board': '1' })).status, 200)
  assert.equal(read(box, 'abcdef'), null)
  assert.equal((await cancel({ 'x-board': '1' })).status, 404)
})
