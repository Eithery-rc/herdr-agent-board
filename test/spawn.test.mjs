import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { spawnOf, spawnResult } from '../src/claude.mjs'
import { failureKind } from '../src/launch.mjs'
import { absoluteDir, choosesSession, claudeCommand, parseArgs, shellLine, stillTyped } from '../src/spawn.mjs'
import { sandbox } from './fixtures/sandbox.mjs'

test('spawn-agent options: the board’s --names and the PowerShell -Names alike', () => {
  const ps = parseArgs(['-Name', 'Acme invoices', '-Cwd', 'C:\\Work\\Acme', '-Label', 'Acme 12', '-BriefFile', 'b.txt', '-Workspace', 'w2', '-TimeoutSec', '90'])
  assert.deepEqual(ps, { name: 'Acme invoices', cwd: 'C:\\Work\\Acme', label: 'Acme 12', briefFile: 'b.txt', workspace: 'w2', timeoutSec: 90 })
  const gnu = parseArgs(['--name', 'Acme invoices', '--cwd=C:\\Work\\Acme', '--label', 'Acme 12', '--brief-file', 'b.txt', '--workspace', 'w2', '--timeout-sec', '90'])
  assert.deepEqual(gnu, ps)
  // Case and dashes do not matter; PowerShell's -Name:value works too.
  assert.equal(parseArgs(['-NAME:x', '-cwd', '.']).name, 'x')
  assert.equal(parseArgs(['-name', 'x', '--Cwd', '.', '-brief', '-starts with a dash']).brief, '-starts with a dash')
  assert.equal(parseArgs(['--name', 'x', '--cwd', '.']).timeoutSec, 120)
  assert.equal(parseArgs(['--name', 'x', '--cwd', '.', '--session-id', '0f8fad5b-d9cb-469f-a165-70867728950e']).sessionId, '0f8fad5b-d9cb-469f-a165-70867728950e')
  assert.equal(parseArgs(['--help']).help, true)
  const fails = [
    [['--cwd', '.'], /--name is missing/],
    [['--name', 'x'], /--cwd is missing/],
    [['--name', '', '--cwd', '.'], /--name is empty/],
    [['--name', '/clear', '--cwd', '.'], /must not start/],
    [['--name', 'a\nb', '--cwd', '.'], /control characters/],
    [['--name', 'x', '--cwd', '.', '--bogus', '1'], /unknown option --bogus/],
    [['--name', 'x', '--cwd', '.', 'stray'], /unexpected argument "stray"/],
    [['--name', 'x', '--cwd'], /--cwd needs a value/],
    [['--name', 'x', '--cwd', '.', '--timeout-sec', 'soon'], /--timeout-sec must be a number/],
    [['--name', 'x', '--cwd', '.', '--session-id', 'abc'], /UUID/],
    [['--name', 'x', '--cwd', '.', '--brief', 'a', '--brief-file', 'b'], /not both/],
  ]
  for (const [argv, re] of fails) assert.throws(() => parseArgs(argv), re, argv.join(' '))
})

test('spawn-agent: what it types into the tab’s shell', () => {
  assert.deepEqual(claudeCommand(undefined), ['claude'])
  assert.deepEqual(claudeCommand('claude-tg'), ['claude-tg'])
  assert.deepEqual(claudeCommand(['claude', '--model', 'opus']), ['claude', '--model', 'opus'])
  // launch.args, from before the board had its own launcher, still reach claude; launch.claude wins.
  assert.deepEqual(claudeCommand(undefined, ['--model', 'opus']), ['claude', '--model', 'opus'])
  assert.deepEqual(claudeCommand(['claude-tg'], ['--model', 'opus']), ['claude-tg'])
  for (const bad of [[], [''], [3], 'x y'.split(' ').concat(5), {}]) assert.throws(() => claudeCommand(bad), /launch\.claude/, JSON.stringify(bad))
  assert.equal(shellLine(['claude', '--dangerously-skip-permissions', '--session-id', '0f8fad5b-d9cb-469f-a165-70867728950e']), 'claude --dangerously-skip-permissions --session-id 0f8fad5b-d9cb-469f-a165-70867728950e')
  // Anything but a plain word goes in single quotes, which PowerShell, bash, zsh and fish all take literally.
  assert.equal(shellLine(['claude', '--append-system-prompt', 'Be brief; no $HOME & no `x`', '--allowedTools', 'Read,Write', '']), "claude --append-system-prompt 'Be brief; no $HOME & no `x`' --allowedTools 'Read,Write' ''")
  assert.equal(shellLine(['C:\\tools\\start-claude.ps1'], true), 'C:\\tools\\start-claude.ps1')
  assert.throws(() => shellLine(['C:\\tools\\start-claude.ps1'], false), /program must be a name on PATH/) // a backslash means something to sh
  assert.throws(() => shellLine(['C:\\Program Files\\claude.exe'], true), /program must be a name on PATH/)
  assert.throws(() => shellLine(['-x']), /starts with a dash/)
  assert.throws(() => shellLine(['claude', "it's"]), /a quote/)
  assert.throws(() => shellLine(['claude', 'Don’t stop'], true), /a quote/) // PowerShell ends a string at it too
  assert.throws(() => shellLine(['claude', 'a b']), /control character/)
  // A backslash means something to sh: quoted in an argument, on Windows too (a Git Bash tab).
  assert.equal(shellLine(['claude', '--mcp-config', 'C:\\a\\b.json'], true), "claude --mcp-config 'C:\\a\\b.json'")
  // Option names are checked as names: nothing from Object's prototype passes for one.
  assert.throws(() => parseArgs(['--name', 'x', '--cwd', '.', '--constructor', '1']), /unknown option --constructor/)
  assert.throws(() => parseArgs(['--name', 'x', '--cwd', '.', '--toString', '1']), /unknown option --toString/)
  // Typed text still on screen, wrapped by a narrow pane, or as a pasted-text chip.
  assert.equal(stillTyped('❯ Check the invo\nices in the ledger and rep', 'Check the invoices in the ledger and report'), true)
  assert.equal(stillTyped('[Pasted text #1 +12 lines]', 'whatever'), true)
  assert.equal(stillTyped('❯ ', 'Check the invoices'), false)
  assert.throws(() => shellLine(['claude', 'a\nb']), /control character/)
  assert.equal(choosesSession(['claude', '--resume', 'x']), true)
  assert.equal(choosesSession(['claude-tg', '-c']), true)
  assert.equal(choosesSession(['claude', '--session-id=x']), true)
  assert.equal(choosesSession(['claude', '--model', 'opus']), false)
  assert.equal(absoluteDir('~'), absoluteDir(process.env.USERPROFILE || process.env.HOME))
})

test('the board links a session to the one that started it with spawn-agent, either spelling', () => {
  assert.deepEqual(spawnOf('Bash', { command: 'spawn-agent --name "Case 7" --cwd C:/w --brief-file b.txt' }), { name: 'Case 7' })
  assert.deepEqual(spawnOf('Bash', { command: "spawn-agent --name='Case 8' --cwd ." }), { name: 'Case 8' })
  assert.deepEqual(spawnOf('PowerShell', { command: 'spawn-agent.cmd -Name x -Cwd .' }), { name: 'x' })
  assert.deepEqual(spawnOf('PowerShell', { command: 'Spawn-Agent -name Mixed -cwd .' }), { name: 'Mixed' })
  assert.equal(spawnOf('Bash', { command: 'spawn-agent --named x' }), null)
  assert.deepEqual(spawnResult('pane=wP:p3 name=Case 7 agent=case-7'), { pane: 'wP:p3', name: 'Case 7' })
})

// ---------------------------------------------------------------- against the fake herdr
const fake = new URL('./fixtures/fake-herdr.mjs', import.meta.url).href
const SPAWN = fileURLToPath(new URL('../src/spawn.mjs', import.meta.url))
const READY = { result: { pane: { pane_id: 'wA:p9', tab_id: 'wA:t9', agent: 'claude', agent_status: 'idle' } } }
const STATE = {
  'tab create': { result: { tab: { tab_id: 'wA:t9' }, root_pane: { pane_id: 'wA:p9' } } },
  'tab rename': { result: null },
  'pane run': { result: null },
  'pane get': { seq: [{ result: { pane: { pane_id: 'wA:p9', agent: null } } }, READY] },
  'agent list': { result: { agents: [{ name: 'acme-invoices', pane_id: 'wB:p1' }, { pane_id: 'wA:p9' }] } },
  'agent rename': { result: null },
  'agent prompt': { result: null },
  'pane read': { text: 'Session renamed to: Acme invoices' },
  'pane send-keys': { result: null },
}

function runSpawn(box, args, extra = {}) {
  return new Promise(resolve => {
    const proc = spawn(process.execPath, [SPAWN, ...args], { env: { ...box.env, HERDR_BIN_PATH: process.execPath, NODE_OPTIONS: `--import=${fake}`, ...extra }, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    proc.stdout.on('data', d => (stdout += d))
    proc.stderr.on('data', d => (stderr += d))
    proc.on('close', code => resolve({ code, stdout, stderr }))
  })
}

function boardConfig(box, cfg) {
  const dir = join(box.env.APPDATA, 'herdr', 'plugins', 'config', 'agent-board')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'config.json'), JSON.stringify(cfg))
}

test('spawn-agent starts Claude in a new tab, names it in herdr and Claude, sends the brief, and says where', { timeout: 30_000 }, async t => {
  const box = sandbox(t)
  box.state(STATE)
  boardConfig(box, { launch: { claude: ['claude-tg', '--model', 'opus 4'] } })
  const dir = join(box.dir, 'Acme project')
  mkdirSync(dir)
  const brief = join(box.dir, 'brief.txt')
  writeFileSync(brief, '\uFEFF-Check the invoices.\nThen report.\n')
  const r = await runSpawn(box, ['-Name', 'Acme invoices', '-Cwd', dir, '-Workspace', 'wA', '-BriefFile', brief, '--session-id', '0f8fad5b-d9cb-469f-a165-70867728950e'])
  assert.equal(r.code, 0, r.stderr)
  // The pane and the name the board links sessions by; another agent had the name already.
  assert.equal(r.stdout.trim(), 'pane=wA:p9 name=Acme invoices agent=acme-invoices-2')
  const calls = box.calls().map(a => a.slice(0, 2).join(' ') === 'pane get' ? 'pane get' : a.join(' '))
  assert.deepEqual(calls.filter((c, i) => c !== 'pane get' || calls[i - 1] !== 'pane get'), [
    `tab create --workspace wA --cwd ${dir} --label Acme invoices --no-focus`,
    "pane run wA:p9 claude-tg --model 'opus 4' --session-id 0f8fad5b-d9cb-469f-a165-70867728950e",
    'pane get',
    'agent list',
    'agent rename wA:p9 acme-invoices-2',
    'agent prompt wA:p9 /rename Acme invoices',
    'pane read wA:p9 --source visible',
    // A leading dash would read as an option to herdr: a space goes before it.
    'agent prompt wA:p9  -Check the invoices.\nThen report.',
  ])
})

test('spawn-agent: a dialog before Claude is ready, a brief herdr calls stalled, and a folder that is not there', { timeout: 30_000 }, async t => {
  const box = sandbox(t)
  box.state({ ...STATE, 'pane get': { result: { pane: { pane_id: 'wA:p9', agent: 'claude', agent_status: 'blocked' } } } })
  const blocked = await runSpawn(box, ['--name', 'Fresh', '--cwd', box.dir, '--workspace', 'wA', '--brief', 'Hi'])
  assert.equal(blocked.code, 1)
  assert.match(blocked.stderr, /^spawn-agent: Claude in wA:p9 waits for a dialog \(folder trust\?\)/)
  assert.equal(box.calls().some(a => a[0] === 'agent' && a[1] === 'prompt'), false)

  // Text still on screen after "stalled" only needs its Enter; the session runs, so it is no failure.
  const box2 = sandbox(t)
  box2.state({ ...STATE, 'agent prompt': { code: 'agent_prompt_stalled', error: 'agent_prompt_stalled: no turn' }, 'pane read': { text: 'Session renamed\n❯ Hello there, a long brief' } })
  const stalled = await runSpawn(box2, ['--name', 'Calm', '--cwd', box2.dir, '--brief', 'Hello there, a long brief'], { HERDR_WORKSPACE_ID: 'wA' })
  assert.equal(stalled.code, 0, stalled.stderr)
  assert.ok(box2.calls().some(a => a.join(' ') === 'pane send-keys wA:p9 enter'))

  const missing = await runSpawn(box2, ['--name', 'Nowhere', '--cwd', join(box2.dir, 'nope'), '--workspace', 'wA'])
  assert.equal(missing.code, 1)
  assert.match(missing.stderr, /No such folder/)
  const noWorkspace = await runSpawn(box2, ['--name', 'Nowhere', '--cwd', box2.dir])
  assert.match(noWorkspace.stderr, /No herdr workspace/)
})

test('spawn-agent --pane starts Claude in a pane that is there, its tab named after the session', { timeout: 30_000 }, async t => {
  const box = sandbox(t)
  box.state({ ...STATE, 'pane get': { seq: [{ result: { pane: { pane_id: 'wA:p9', tab_id: 'wA:t9', agent: null } } }, READY] } })
  const r = await runSpawn(box, ['--name', 'Here', '--cwd', box.dir, '--pane', 'wA:p9'])
  assert.equal(r.code, 0, r.stderr)
  const calls = box.calls().map(a => a.join(' '))
  assert.equal(calls.some(c => c.startsWith('tab create')), false)
  assert.ok(calls.includes('tab rename wA:t9 Here'))
  assert.ok(calls.includes('pane run wA:p9 claude'))
})

test('spawn-agent: a /rename herdr refuses is a warning; a brief it refuses fails as "did not reach", which the board does not retry', { timeout: 30_000 }, async t => {
  const box = sandbox(t)
  box.state({ ...STATE, 'pane get': { seq: [{ result: { pane: { pane_id: 'wA:p9', agent: null } } }, READY] }, 'agent prompt': { code: 'agent_busy', error: 'agent_busy: the agent is busy' } })
  const r = await runSpawn(box, ['--name', 'Busy', '--cwd', box.dir, '--workspace', 'wA', '--brief', 'Go.'])
  assert.equal(r.code, 1)
  assert.match(r.stderr, /spawn-agent: \/rename in wA:p9: .*agent_busy/)
  const last = r.stderr.trim().split('\n').at(-1)
  assert.match(last, /^spawn-agent: The brief did not reach Claude in wA:p9: /)
  assert.equal(failureKind(last), 'message')
})

test('spawn-agent --pane refuses a pane that runs an agent: the command would be typed into it', { timeout: 30_000 }, async t => {
  const box = sandbox(t)
  box.state({ ...STATE, 'pane get': READY })
  const r = await runSpawn(box, ['--name', 'Here', '--cwd', box.dir, '--pane', 'wA:p9'])
  assert.equal(r.code, 1)
  assert.match(r.stderr, /wA:p9 already runs claude/)
  assert.equal(box.calls().some(a => a[0] === 'pane' && a[1] === 'run'), false)
})

test('spawn-agent with launch.args and no launch.claude: claude with those arguments', { timeout: 30_000 }, async t => {
  const box = sandbox(t)
  box.state(STATE)
  boardConfig(box, { launch: { args: ['--model', 'opus'] } })
  const r = await runSpawn(box, ['--name', 'Args', '--cwd', box.dir, '--workspace', 'wA'])
  assert.equal(r.code, 0, r.stderr)
  assert.ok(box.calls().some(a => a.join(' ') === 'pane run wA:p9 claude --model opus'))
})
