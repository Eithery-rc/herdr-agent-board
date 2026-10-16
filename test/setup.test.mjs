import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { boardFiles, boardKey, checkSetup, findCommand, patchSettings, report, shimFiles, shimTarget, todo, toastCommand, tomlValue } from '../src/setup.mjs'
import { root, sandbox } from './fixtures/sandbox.mjs'

const ROOT_A = 'C:\\plugins\\agent-board'
const ROOT_B = 'C:\\plugins\\mokuteam.herdr-agent-board-1a2b'
const files = boardFiles(ROOT_A)
const commands = (settings, event) => (settings.hooks[event] ?? []).flatMap(e => e.hooks.map(h => h.command))

test('install writes its hooks once, keeps everyone else’s, and moves its own to this copy', () => {
  const theirs = {
    model: 'opus',
    hooks: {
      SessionStart: [{ hooks: [{ type: 'command', command: 'python recall.py' }] }, { hooks: [{ type: 'command', command: `node "${boardFiles(ROOT_B).hook}"`, timeout: 10 }] }],
      Stop: [{ hooks: [{ type: 'command', command: 'python ingest.py' }] }],
    },
    statusLine: { type: 'command', command: 'my-status' },
  }
  const once = patchSettings(theirs, { root: ROOT_A })
  assert.equal(once.statusLine, 'kept')
  assert.equal(once.toast, false)
  assert.equal(once.settings.model, 'opus')
  assert.deepEqual(once.settings.statusLine, theirs.statusLine)
  assert.deepEqual(commands(once.settings, 'SessionStart'), ['python recall.py', `node "${files.hook}"`])
  assert.deepEqual(commands(once.settings, 'UserPromptSubmit'), [`node "${files.hook}"`])
  assert.deepEqual(commands(once.settings, 'Stop'), ['python ingest.py'])
  assert.deepEqual(patchSettings(once.settings, { root: ROOT_A }).settings, once.settings) // idempotent
  assert.deepEqual(theirs.hooks.SessionStart.length, 2) // the input is left alone

  // Notifications: on, kept on (pointed at the copy that installs), off.
  const on = patchSettings(once.settings, { root: ROOT_B, toast: true }).settings
  assert.deepEqual(on.hooks.Stop.at(-1), { hooks: [{ type: 'command', command: toastCommand(boardFiles(ROOT_B).toast), timeout: 30, async: true }] })
  assert.equal(on.hooks.Notification[0].matcher, 'permission_prompt|elicitation_dialog')
  assert.equal(on.hooks.PreToolUse[0].matcher, 'AskUserQuestion')
  const kept = patchSettings(on, { root: ROOT_A })
  assert.equal(kept.toast, true)
  assert.deepEqual(commands(kept.settings, 'PreToolUse'), [toastCommand(files.toast)])
  assert.deepEqual(commands(kept.settings, 'Stop'), ['python ingest.py', toastCommand(files.toast)])
  const off = patchSettings(kept.settings, { root: ROOT_A, toast: false }).settings
  assert.deepEqual(commands(off, 'Stop'), ['python ingest.py'])
  assert.equal(off.hooks.Notification, undefined)

  // No status line yet, or the board's own from another copy: the board's, with forward slashes.
  assert.deepEqual(patchSettings({}, { root: ROOT_A }).settings.statusLine, { type: 'command', command: `node "${files.statusline.replace(/\\/g, '/')}"` })
  assert.equal(patchSettings({ statusLine: { command: `node "${boardFiles(ROOT_B).statusline}"` } }, { root: ROOT_A }).statusLine, 'set')
  // Not an object where hooks should be: replaced rather than crashed on.
  assert.deepEqual(Object.keys(patchSettings({ hooks: [] }, { root: ROOT_A }).settings.hooks), ['SessionStart', 'UserPromptSubmit'])
})

test('command files: what they run, and which ones are the board’s', () => {
  const shims = shimFiles(ROOT_A)
  assert.deepEqual(Object.keys(shims), ['board', 'board.cmd', 'spawn-agent', 'spawn-agent.cmd'])
  assert.equal(shimTarget(shims['spawn-agent.cmd']), files.spawn)
  assert.equal(shimTarget(shims['spawn-agent']), files.spawn.replace(/\\/g, '/'))
  assert.match(shims.board, /^#!\/bin\/sh\n/)
  assert.equal(shimTarget('#!/bin/sh\nexec pwsh -File spawn-agent.ps1 "$@"'), null)

  // PowerShell takes a .ps1 before a .cmd in the same folder; Git Bash the file of that name.
  const disk = { 'C:\\bin\\spawn-agent.ps1': 'param()', 'C:\\bin\\spawn-agent.cmd': shims['spawn-agent.cmd'], 'C:\\bin\\spawn-agent': shims['spawn-agent'] }
  const found = findCommand('spawn-agent', { env: { PATH: 'C:\\nope;C:\\bin', PATHEXT: '.EXE;.CMD' }, platform: 'win32', exists: f => f in disk, read: f => disk[f] })
  assert.deepEqual(found.ps, { file: 'C:\\bin\\spawn-agent.ps1', target: null })
  assert.equal(found.sh.target, files.spawn.replace(/\\/g, '/'))
})

test('herdr’s config: the board’s key, and a value in a section', () => {
  const toml = `onboarding = false\n\n[ui.toast]\ndelivery = "system" # loud\n\n[[keys.command]]\nkey = "prefix+g"\ntype = "shell"\ncommand = "lazygit"\n\n[[keys.command]]\nkey = "prefix+a"\ntype = "plugin_action"\ncommand = "agent-board.open"\n`
  assert.equal(boardKey(toml), 'prefix+a')
  assert.equal(boardKey('[[keys.command]]\nkey = "x"\ncommand = "other.open"\n'), null)
  assert.equal(boardKey(null), null)
  assert.equal(tomlValue(toml, 'ui.toast', 'delivery'), 'system')
  assert.equal(tomlValue(toml, 'ui', 'delivery'), undefined)
  assert.equal(tomlValue('[ui.toast]\n# delivery = "herdr"\n', 'ui.toast', 'delivery'), undefined)
})

// What gatherFacts would find on a computer set up all the way, to spoil one thing at a time.
function facts(over = {}) {
  const ours = name => ({ file: `C:\\Users\\u\\.local\\bin\\${name}.cmd`, target: name === 'board' ? files.cli : files.spawn })
  const settings = patchSettings({}, { root: ROOT_A, toast: true }).settings
  return {
    platform: 'win32',
    root: ROOT_A,
    node: '22.5.0',
    binDir: 'C:\\Users\\u\\.local\\bin',
    path: 'C:\\Windows;C:\\Users\\u\\.local\\bin',
    files,
    commands: { board: { ps: ours('board'), sh: { ...ours('board'), file: 'C:\\Users\\u\\.local\\bin\\board' } }, 'spawn-agent': { ps: ours('spawn-agent'), sh: ours('spawn-agent') } },
    settingsFile: 'C:\\Users\\u\\.claude\\settings.json',
    settings,
    settingsError: '',
    herdrConfigFile: 'C:\\Users\\u\\AppData\\Roaming\\herdr\\config.toml',
    herdrConfig: '[ui.toast]\ndelivery = "off"\n\n[[keys.command]]\nkey = "prefix+a"\ntype = "plugin_action"\ncommand = "agent-board.open"\n',
    wakeUrl: 'http://127.0.0.1:12421',
    wake: { ok: true, status: 200 },
    launcher: { kind: 'builtin', claude: ['claude'], error: '', program: { file: 'C:\\bin\\claude.exe', found: true }, ownSession: true },
    ...over,
  }
}
const level = (checks, id) => checks.find(c => c.id === id)?.level

test('doctor: a computer set up all the way', () => {
  const checks = checkSetup(facts())
  assert.deepEqual(checks.map(c => [c.id, c.level]), [['board', 'ok'], ['hooks', 'ok'], ['statusline', 'ok'], ['spawn-agent', 'ok'], ['key', 'ok'], ['wake', 'ok'], ['launch', 'ok'], ['toast', 'ok']])
  assert.deepEqual(todo(checks), [])
  assert.match(report(checks), /Everything the board needs is set up\.$/)
})

test('doctor: each missing piece, what it costs and how to fix it', () => {
  const noHooks = checkSetup(facts({ settings: {} }))
  assert.equal(level(noHooks, 'hooks'), 'error')
  assert.equal(level(noHooks, 'statusline'), 'warn')
  assert.equal(level(noHooks, 'toast'), 'off') // optional: no mark on the board for it
  assert.equal(noHooks.find(c => c.id === 'hooks').code, 'herdr plugin action invoke agent-board.install')

  // The plugin moved (a new copy): hooks and commands still run the old one.
  const moved = facts({ root: ROOT_B, files: boardFiles(ROOT_B) })
  const m = checkSetup(moved)
  for (const id of ['board', 'hooks', 'statusline', 'spawn-agent', 'toast']) assert.notEqual(level(m, id), 'ok', id)
  assert.match(m.find(c => c.id === 'hooks').title, /another copy/)

  // Someone's own spawn-agent.ps1 wins in PowerShell.
  const own = checkSetup(facts({ commands: { ...facts().commands, 'spawn-agent': { ps: { file: 'C:\\Users\\u\\.local\\bin\\spawn-agent.ps1', target: null }, sh: { file: 'C:\\Users\\u\\.local\\bin\\spawn-agent', target: null } } } }))
  assert.equal(level(own, 'spawn-agent'), 'warn')
  assert.match(own.find(c => c.id === 'spawn-agent').detail, /instead of the board.s: \S+spawn-agent\.ps1 \(PowerShell\), \S+spawn-agent \(Git Bash\)/)

  const noPath = checkSetup(facts({ path: 'C:\\Windows', commands: { board: { ps: null, sh: null }, 'spawn-agent': { ps: null, sh: null } } }))
  assert.equal(level(noPath, 'board'), 'error')
  assert.match(noPath.find(c => c.id === 'board').title, /not on PATH/)

  const rest = checkSetup(facts({ herdrConfig: '[ui.toast]\ndelivery = "system"\n', wake: { ok: false, error: 'ECONNREFUSED' }, launcher: { kind: 'builtin', claude: ['claude-tg'], error: '', program: { file: 'claude-tg', found: false }, ownSession: true } }))
  assert.equal(level(rest, 'key'), 'warn')
  assert.match(rest.find(c => c.id === 'key').code, /command = "agent-board\.open"/)
  assert.equal(level(rest, 'wake'), 'off')
  assert.match(rest.find(c => c.id === 'wake').detail, /Put to sleep/)
  assert.equal(level(rest, 'launch'), 'warn')
  assert.equal(level(rest, 'toast'), 'warn') // herdr's own notifications on top of the board's
  assert.deepEqual(todo(rest).map(c => c.id), ['key', 'launch', 'toast'])

  const linux = checkSetup(facts({ platform: 'linux', commands: { board: { sh: facts().commands.board.sh }, 'spawn-agent': { sh: facts().commands['spawn-agent'].sh } } }))
  assert.equal(level(linux, 'toast'), 'na')
  assert.equal(level(linux, 'board'), 'ok')
  assert.equal(level(checkSetup(facts({ launcher: { kind: 'command', name: 'spawn-agent', program: { file: 'pwsh', found: true }, script: { file: 'C:\\gone.ps1', found: false } } })), 'launch'), 'warn')
  assert.equal(level(checkSetup(facts({ settings: null, settingsError: 'Unexpected token' })), 'hooks'), 'error')
  assert.equal(level(checkSetup(facts({ node: '18.19.0' })), 'node'), 'error')
})

test('install in a sandbox: the commands, the hooks once, a backup, and notifications only when asked', { timeout: 30_000 }, async t => {
  const box = sandbox(t)
  const settingsFile = join(box.env.HOME, '.claude', 'settings.json')
  const install = (...args) =>
    new Promise(resolve => {
      const proc = spawn(process.execPath, [join(root, 'src', 'install.mjs'), ...args], { env: { ...box.env, PATH: box.env.PATH }, stdio: ['ignore', 'pipe', 'pipe'] })
      let out = ''
      proc.stdout.on('data', d => (out += d))
      proc.stderr.on('data', d => (out += d))
      proc.on('close', code => resolve({ code, out }))
    })
  const { mkdirSync } = await import('node:fs')
  mkdirSync(join(box.env.HOME, '.claude'), { recursive: true })
  mkdirSync(join(box.env.APPDATA, 'herdr', 'plugins', 'config', 'agent-board'), { recursive: true })
  writeFileSync(join(box.env.APPDATA, 'herdr', 'plugins', 'config', 'agent-board', 'config.json'), JSON.stringify({ language: 'en', wakeUrl: '' }))
  writeFileSync(settingsFile, JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'theirs' }] }] } }))
  const first = await install()
  assert.equal(first.code, 0, first.out)
  for (const name of ['board', 'board.cmd', 'spawn-agent', 'spawn-agent.cmd']) assert.ok(existsSync(join(box.env.HOME, '.local', 'bin', name)), name)
  assert.ok(existsSync(`${settingsFile}.bak-agent-board`))
  const after = JSON.parse(readFileSync(settingsFile, 'utf8'))
  assert.equal(after.hooks.SessionStart.length, 1)
  assert.deepEqual(after.hooks.Stop, [{ hooks: [{ type: 'command', command: 'theirs' }] }])
  assert.match(first.out, /commands: board, spawn-agent/)
  assert.match(first.out, /herdr-wake is off/) // and what that costs, from the check
  assert.match(first.out, /things? need/)
  const second = await install(process.platform === 'win32' ? '--toast' : '--no-toast')
  assert.equal(second.code, 0, second.out)
  const again = JSON.parse(readFileSync(settingsFile, 'utf8'))
  assert.equal(again.hooks.SessionStart.length, 1)
  assert.equal(again.hooks.Stop.length, process.platform === 'win32' ? 2 : 1)
  // Someone else's command of that name is left alone.
  writeFileSync(join(box.env.HOME, '.local', 'bin', 'spawn-agent'), '#!/bin/sh\necho mine\n')
  assert.match((await install()).out, /skipped .*spawn-agent: exists and is not ours/)
  assert.equal(readFileSync(join(box.env.HOME, '.local', 'bin', 'spawn-agent'), 'utf8'), '#!/bin/sh\necho mine\n')
})
