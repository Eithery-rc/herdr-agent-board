import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import http from 'node:http'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { useLanguage } from '../src/lang.mjs'
import { callCommand, mokupilotCommand, startCall } from '../src/mokupilot.mjs'
import { sandbox, until } from './fixtures/sandbox.mjs'

useLanguage('en')
const ID = '0b3f8c2e-5d1a-4c6b-9e7f-1a2b3c4d5e6f'
const has = (...files) => f => files.includes(f)

test('MokuPilot on Windows: the installed MokuPilot.exe first, else the checkout of meet.cmd on PATH, run by its own Python', () => {
  const local = 'C:\\Users\\u\\AppData\\Local'
  const exe = `${local}\\Programs\\MokuPilot\\MokuPilot.exe`
  const win = (exists, over = {}) => mokupilotCommand({}, { platform: 'win32', env: { LOCALAPPDATA: local, PATH: 'C:\\Windows;C:\\src\\MokuPilot', PATHEXT: '.EXE;.CMD', ...over }, exists })
  assert.deepEqual(win(has(exe, 'C:\\src\\MokuPilot\\meet.cmd')), { state: 'ok', configured: false, file: exe, args: [] })
  // meet.cmd stands for its checkout: Node runs no .cmd without a shell, so its .venv's pythonw runs run.py.
  const repo = ['C:\\src\\MokuPilot\\meet.cmd', 'C:\\src\\MokuPilot\\run.py']
  assert.deepEqual(win(has(...repo, 'C:\\src\\MokuPilot\\.venv\\Scripts\\pythonw.exe')), { state: 'ok', configured: false, file: 'C:\\src\\MokuPilot\\.venv\\Scripts\\pythonw.exe', args: ['C:\\src\\MokuPilot\\run.py'] })
  assert.equal(win(has(...repo, 'C:\\src\\MokuPilot\\.venv\\Scripts\\python.exe')).file, 'C:\\src\\MokuPilot\\.venv\\Scripts\\python.exe')
  // No .venv: the Python on PATH, as meet.cmd falls back to it.
  assert.equal(win(has(...repo, 'C:\\Python\\python.exe'), { PATH: 'C:\\Python;C:\\src\\MokuPilot' }).file, 'C:\\Python\\python.exe')
  assert.deepEqual(win(has()), { state: 'missing', configured: false, file: 'MokuPilot.exe, meet.cmd' })
  // A folder in config.json.
  const dir = mokupilotCommand({ mokupilot: { dir: 'D:\\MokuPilot' } }, { platform: 'win32', env: { PATH: '' }, exists: has('D:\\MokuPilot\\run.py', 'D:\\MokuPilot\\.venv\\Scripts\\pythonw.exe') })
  assert.deepEqual(dir, { state: 'ok', configured: true, file: 'D:\\MokuPilot\\.venv\\Scripts\\pythonw.exe', args: ['D:\\MokuPilot\\run.py'] })
  assert.deepEqual(mokupilotCommand({ mokupilot: { dir: 'D:\\Nope' } }, { platform: 'win32', env: { PATH: '' }, exists: has() }), { state: 'missing', configured: true, file: 'D:\\Nope\\run.py' })
})

test('MokuPilot on macOS and Linux: `meet` on PATH or in the configured checkout; off, and a command of its own', () => {
  assert.deepEqual(mokupilotCommand({}, { platform: 'darwin', env: { PATH: '/usr/bin:/usr/local/bin' }, exists: has('/usr/local/bin/meet') }), { state: 'ok', configured: false, file: '/usr/local/bin/meet', args: [] })
  assert.deepEqual(mokupilotCommand({}, { platform: 'linux', env: { PATH: '/usr/bin' }, exists: has() }), { state: 'missing', configured: false, file: 'meet' })
  assert.deepEqual(mokupilotCommand({ mokupilot: { dir: '/home/u/mokupilot' } }, { platform: 'linux', env: { PATH: '' }, exists: has('/home/u/mokupilot/meet') }), { state: 'ok', configured: true, file: '/home/u/mokupilot/meet', args: [] })
  assert.deepEqual(mokupilotCommand({ mokupilot: false }, { platform: 'linux', env: { PATH: '/usr/local/bin' }, exists: () => true }), { state: 'off', configured: true })

  const own = mokupilotCommand({ mokupilot: { command: ['/opt/mp/MokuPilot', '--profile', 'work'] } }, { platform: 'linux', env: { PATH: '' }, exists: has('/opt/mp/MokuPilot') })
  assert.deepEqual(own, { state: 'ok', configured: true, file: '/opt/mp/MokuPilot', args: ['--profile', 'work'], template: null })
  assert.deepEqual(callCommand(own, { session: ID, cwd: '/w/acme' }), { file: '/opt/mp/MokuPilot', args: ['--profile', 'work', 'call', '--claude-session', ID, '--cwd', '/w/acme'] })
  assert.deepEqual(callCommand(own, { session: ID }).args.slice(2), ['call', '--claude-session', ID])
  // With values in it, the command is the whole line; a group without its value is left out.
  const line = mokupilotCommand({ mokupilot: { command: ['mp', 'start', '--fork={session}', ['--in', '{cwd}']] } }, { platform: 'linux', env: { PATH: '/opt/bin' }, exists: has('/opt/bin/mp') })
  assert.deepEqual(callCommand(line, { session: ID, cwd: '/w/acme' }), { file: '/opt/bin/mp', args: ['start', `--fork=${ID}`, '--in', '/w/acme'] })
  assert.deepEqual(callCommand(line, { session: ID, cwd: '' }).args, ['start', `--fork=${ID}`])
  const unknown = mokupilotCommand({ mokupilot: { command: ['mp', '{name}'] } }, { platform: 'linux', env: { PATH: '/opt/bin' }, exists: has('/opt/bin/mp') })
  assert.throws(() => callCommand(unknown, { session: ID }), /\{name\}/)
  // Never a shell: cmd and .cmd files are refused, as for launch.command.
  assert.match(mokupilotCommand({ mokupilot: { command: ['C:\\src\\MokuPilot\\meet.cmd'] } }, { platform: 'win32', env: { PATH: '' }, exists: () => true }).error, /not cmd/)
  assert.match(mokupilotCommand({ mokupilot: { command: 'meet' } }, { platform: 'linux', env: { PATH: '' }, exists: () => true }).error, /a list/)
})

test('a call starts MokuPilot on its own, in the folder the session started in, for Claude sessions only', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'board-mokupilot-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const project = join(dir, 'Acme project')
  mkdirSync(project)
  const transcript = join(dir, `${ID}.jsonl`)
  writeFileSync(transcript, `${JSON.stringify({ type: 'user', cwd: project, sessionId: ID })}\n`)
  const runs = []
  const run = (file, args, opts) => {
    const child = new EventEmitter()
    child.unref = () => (child.unrefed = true)
    runs.push({ file, args, opts, child })
    queueMicrotask(() => child.emit('spawn'))
    return child
  }
  const cfg = { mokupilot: { command: ['/opt/mp/MokuPilot'] } }
  const env = { PATH: '', HERDR_PANE_ID: 'w1:p1', HERDR_TAB_ID: 'w1:t1', HERDR_WORKSPACE_ID: 'w1', HOME: '/home/u' }
  const item = { key: ID, session: ID, agent: 'claude', cwd: join(dir, 'elsewhere'), transcript }
  // A program by its path: there is none at /opt/mp here, so the check goes through `exists`.
  const opts = { platform: 'linux', env, run }
  const missing = await startCall(cfg, item, opts)
  assert.equal(missing.ok, false)
  assert.match(missing.error, /MokuPilot not found \(\/opt\/mp\/MokuPilot\)/)

  const real = { mokupilot: { command: [process.execPath] } }
  assert.deepEqual(await startCall(real, item, opts), { ok: true, file: process.execPath })
  const r = runs.at(-1)
  assert.deepEqual(r.args, ['call', '--claude-session', ID, '--cwd', project])
  assert.equal(r.opts.cwd, project)
  assert.equal(r.opts.detached, true)
  assert.equal(r.opts.stdio, 'ignore')
  assert.equal(r.child.unrefed, true)
  // herdr's pane and tab stay with the board; the rest of the environment goes along.
  assert.equal(r.opts.env.HERDR_PANE_ID, undefined)
  assert.equal(r.opts.env.HERDR_TAB_ID, undefined)
  assert.equal(r.opts.env.HOME, '/home/u')

  // No transcript to read and no folder on disk: no --cwd, MokuPilot finds it from the session.
  await startCall(real, { ...item, transcript: null, cwd: join(dir, 'gone') }, opts)
  assert.deepEqual(runs.at(-1).args, ['call', '--claude-session', ID])
  assert.equal(runs.at(-1).opts.cwd, undefined)

  const count = runs.length
  for (const bad of [{ ...item, agent: 'codex' }, { ...item, session: null }, { ...item, session: 'pane-p1' }]) {
    const out = await startCall(real, bad, opts)
    assert.equal(out.ok, false)
    assert.match(out.error, /Claude Code session/)
  }
  assert.match((await startCall({ mokupilot: false }, item, opts)).error, /turned off/)
  assert.equal(runs.length, count)

  // A program that cannot start says so.
  const failing = (file, args, o) => {
    const child = new EventEmitter()
    queueMicrotask(() => child.emit('error', Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' })))
    return child
  }
  assert.match((await startCall(real, item, { ...opts, run: failing })).error, /did not start: .* not found/)
})

// ---------------------------------------------------------------- through the server
async function unusedPort() {
  const server = http.createServer()
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  await new Promise(resolve => server.close(resolve))
  return port
}

async function boardServer(t, cfg, panes, before = () => {}) {
  const box = sandbox(t)
  before(box)
  box.state({ 'api snapshot': { result: { snapshot: { panes, tabs: [], workspaces: [{ workspace_id: 'wA', label: 'Alpha' }] } } } })
  const port = await unusedPort()
  // The board itself runs in a herdr pane: that pane is not the call's.
  const proc = box.run('server', { port, categories: [{ id: 'other', title: 'Other', color: 'gray' }], wakeUrl: null, refreshSec: 3600, ...cfg }, { HERDR_PANE_ID: 'wB:p1' })
  await until(() => proc.messages.some(m => m.ready))
  const url = `http://127.0.0.1:${port}`
  const board = async () => (await fetch(`${url}/api/board`)).json()
  const deadline = Date.now() + 5000
  while ((await board()).stale) {
    if (Date.now() > deadline) throw new Error('not fresh')
    await new Promise(r => setTimeout(r, 10))
  }
  const post = (path, headers = {}) => fetch(url + path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-board': '1', ...headers }, body: '{}' })
  return { box, board, post }
}

test('the board starts a MokuPilot call with a fork of a Claude session, only from its own page', { timeout: 30_000 }, async t => {
  const launcher = fileURLToPath(new URL('./fixtures/fake-launcher.mjs', import.meta.url))
  const box0 = sandbox(t)
  const record = join(box0.dir, 'call.json')
  const project = join(box0.dir, 'Acme')
  const other = join(box0.dir, 'Other')
  mkdirSync(project)
  mkdirSync(other)
  const panes = [
    { pane_id: 'p1', agent: 'claude', agent_session: { value: ID }, agent_status: 'idle', cwd: other, workspace_id: 'wA' },
    { pane_id: 'p2', agent: 'codex', agent_session: { value: '1c9d0f3a-2b4e-4d6f-8a1b-2c3d4e5f6a7b' }, agent_status: 'idle', cwd: project, workspace_id: 'wA' },
    { pane_id: 'p3', agent: 'claude', agent_status: 'idle', cwd: project, workspace_id: 'wA' },
  ]
  // The session's transcript says where it started; the pane may have moved on since.
  const transcript = box => {
    const folder = join(box.env.HOME, '.claude', 'projects', project.replace(/[^a-zA-Z0-9]/g, '-'))
    mkdirSync(folder, { recursive: true })
    writeFileSync(join(folder, `${ID}.jsonl`), `${JSON.stringify({ type: 'user', cwd: project, sessionId: ID, message: { role: 'user', content: 'hi' } })}\n`)
  }
  const { board, post } = await boardServer(t, { mokupilot: { command: [process.execPath, launcher, record] } }, panes, transcript)
  assert.equal((await board()).mokupilot, true)

  assert.equal((await post(`/api/session/${ID}/mokupilot`, { 'x-board': '' })).status, 403)
  assert.equal((await post(`/api/session/${ID}/mokupilot`, { origin: 'http://evil.example' })).status, 403)
  assert.equal(existsSync(record), false)

  const res = await post(`/api/session/${ID}/mokupilot`)
  assert.equal(res.status, 200, JSON.stringify(await res.clone().json()))
  await until(() => existsSync(record) && readFileSync(record, 'utf8').length > 0, 10_000)
  const seen = JSON.parse(readFileSync(record, 'utf8'))
  assert.deepEqual(seen.args, ['call', '--claude-session', ID, '--cwd', project])
  assert.equal(seen.cwd, project)
  assert.equal(seen.pane, null)

  for (const key of ['1c9d0f3a-2b4e-4d6f-8a1b-2c3d4e5f6a7b', 'pane-p3']) {
    const r = await post(`/api/session/${key}/mokupilot`)
    assert.equal(r.status, 409, key)
    assert.match((await r.json()).error, /Claude Code session/)
  }
})

test('without MokuPilot the page offers no call, and asking for one says what is missing', { timeout: 30_000 }, async t => {
  const box0 = sandbox(t)
  const nope = join(box0.dir, 'MokuPilot', 'MokuPilot')
  const panes = [{ pane_id: 'p1', agent: 'claude', agent_session: { value: ID }, agent_status: 'idle', cwd: box0.dir, workspace_id: 'wA' }]
  const { board, post } = await boardServer(t, { mokupilot: { command: [nope] } }, panes)
  assert.equal((await board()).mokupilot, false)
  const r = await post(`/api/session/${ID}/mokupilot`)
  assert.equal(r.status, 409)
  assert.match((await r.json()).error, /MokuPilot not found/)
})
