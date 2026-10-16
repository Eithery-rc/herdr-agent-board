// Setting the board up on this computer, and checking that it is: what the install action writes
// (the board and spawn-agent commands on PATH, the Claude Code hooks, the status line, desktop
// notifications on Windows) and what `board doctor`, the install action and the web board check
// (those, herdr's key for the board, herdr-wake, how new sessions start).
//
// patchSettings and checkSetup are pure: gatherFacts reads this computer, and tests hand them
// fixtures instead.
import { existsSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, isAbsolute, join, resolve } from 'node:path'
import { translator } from '../web/i18n.js'
import { launcherLabel } from './launch.mjs'
import { ROOT } from './paths.mjs'
import { claudeCommand, shellLine } from './spawn.mjs'

export const WAKE_REPO = 'https://github.com/Eithery-rc/tg-mcp/tree/main/herdr-wake'
const english = translator('en')

/** The files of this copy of the board that other programs run. */
export function boardFiles(root = ROOT) {
  return {
    cli: join(root, 'src', 'cli.mjs'),
    spawn: join(root, 'src', 'spawn.mjs'),
    hook: join(root, 'src', 'hook.mjs'),
    statusline: join(root, 'src', 'statusline.mjs'),
    toast: join(root, 'src', 'toast.ps1'),
  }
}

// ------------------------------------------------------------------ commands on PATH

const MARK = 'agent-board'

/** The command files install puts in ~/.local/bin: a sh script for Git Bash, Linux and macOS, a .cmd for PowerShell. */
export function shimFiles(root = ROOT) {
  const f = boardFiles(root)
  const sh = file => `#!/bin/sh\n# ${MARK}\nexec node "${file.replace(/\\/g, '/')}" "$@"\n`
  const cmd = file => `@rem ${MARK}\r\n@node "${file}" %*\r\n`
  return { board: sh(f.cli), 'board.cmd': cmd(f.cli), 'spawn-agent': sh(f.spawn), 'spawn-agent.cmd': cmd(f.spawn) }
}

/** The script a command file of ours runs, or null for a file that is not ours. */
export function shimTarget(text) {
  if (!String(text ?? '').includes(MARK)) return null
  return /node\s+"([^"]+)"/.exec(text)?.[1] ?? null
}

const norm = p => String(p ?? '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
const samePath = (a, b) => !!a && !!b && norm(a) === norm(b)

// ------------------------------------------------------------------ ~/.claude/settings.json

const BOARD_EVENTS = ['SessionStart', 'UserPromptSubmit']
const TOAST_EVENTS = [
  ['Stop', null],
  ['Notification', 'permission_prompt|elicitation_dialog'],
  ['PreToolUse', 'AskUserQuestion'],
]

// Entries are ours by the file they run: in a folder named like the board, or this copy's own.
const runs = (file, re) => command => re.test(command ?? '') || (!!file && norm(command).includes(norm(file)))
export const toastCommand = file => `powershell -NoProfile -ExecutionPolicy Bypass -File "${file}"`

function matchers(root) {
  const f = boardFiles(root)
  return {
    hook: runs(f.hook, /agent-board.*hook\.mjs/),
    line: runs(f.statusline, /agent-board.*statusline\.mjs/),
    toast: runs(f.toast, /agent-board.*toast\.ps1/),
  }
}

const hookList = settings => (settings?.hooks && typeof settings.hooks === 'object' && !Array.isArray(settings.hooks) ? settings.hooks : {})
/** Every hook command of an event, with its entry's matcher. */
const commandsOf = (settings, event) => (Array.isArray(hookList(settings)[event]) ? hookList(settings)[event] : []).flatMap(e => (Array.isArray(e?.hooks) ? e.hooks : []).map(h => ({ command: String(h?.command ?? ''), matcher: e.matcher ?? null })))

/**
 * settings.json with the board's entries: the SessionStart and UserPromptSubmit hooks, the
 * status line when there is none (a status line someone else set stays), and the notification
 * hooks when `toast` is true (removed when false; left as they are, pointed at this copy, when
 * undefined). Earlier entries of the board are replaced, everything else stays as it was.
 * Returns { settings, statusLine: 'set' | 'kept', toast: boolean }.
 */
export function patchSettings(settings, { root = ROOT, toast } = {}) {
  const s = structuredClone(settings && typeof settings === 'object' ? settings : {})
  if (!s.hooks || typeof s.hooks !== 'object' || Array.isArray(s.hooks)) s.hooks = {}
  const f = boardFiles(root)
  const ours = matchers(root)
  const put = (event, matcher, hook, isOurs) => {
    const list = Array.isArray(s.hooks[event]) ? s.hooks[event] : []
    for (const entry of list) if (entry && Array.isArray(entry.hooks)) entry.hooks = entry.hooks.filter(h => !isOurs(h?.command))
    s.hooks[event] = list.filter(entry => !entry || !Array.isArray(entry.hooks) || entry.hooks.length)
    if (hook) s.hooks[event].push({ ...(matcher && { matcher }), hooks: [hook] })
    if (!s.hooks[event].length) delete s.hooks[event]
  }
  for (const event of BOARD_EVENTS) put(event, null, { type: 'command', command: `node "${f.hook}"`, timeout: 10 }, ours.hook)
  const had = TOAST_EVENTS.some(([event]) => commandsOf(settings, event).some(c => ours.toast(c.command)))
  const withToast = toast ?? had
  for (const [event, matcher] of TOAST_EVENTS) put(event, matcher, withToast ? { type: 'command', command: toastCommand(f.toast), timeout: 30, async: true } : null, ours.toast)
  let statusLine = 'kept'
  if (!s.statusLine || ours.line(s.statusLine.command)) {
    s.statusLine = { type: 'command', command: `node "${f.statusline.replace(/\\/g, '/')}"` }
    statusLine = 'set'
  }
  return { settings: s, statusLine, toast: withToast }
}

// ------------------------------------------------------------------ herdr's config.toml

/** herdr's config.toml: under %APPDATA% on Windows, ~/.config elsewhere (as the plugin config). */
export const herdrConfigFile = (env = process.env, home = homedir()) => join(env.APPDATA || join(home, '.config'), 'herdr', 'config.toml')

/** The value of `key` in a [section] of a TOML text, as written (strings unquoted), or undefined. */
export function tomlValue(text, section, key) {
  let inside = false
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const line = raw.replace(/\s+#.*$/, '').trim()
    if (/^\[\[?[^\]]+\]\]?$/.test(line)) {
      inside = line === `[${section}]`
      continue
    }
    const m = inside && new RegExp(`^${key.replace(/\./g, '\\.')}\\s*=\\s*(.+)$`).exec(line)
    if (m) return m[1].trim().replace(/^"(.*)"$|^'(.*)'$/, (_, a, b) => a ?? b)
  }
  return undefined
}

/** The key bound to the board in herdr ("prefix+a"), '' when one is bound without a readable key, or null. */
export function boardKey(text) {
  for (const block of String(text ?? '').split(/^\s*\[\[keys\.command\]\]\s*$/m).slice(1)) {
    const body = block.split(/^\s*\[/m)[0]
    if (/^\s*command\s*=\s*["']agent-board\.open["']/m.test(body)) return /^\s*key\s*=\s*["']([^"']+)["']/m.exec(body)?.[1] ?? ''
  }
  return null
}

export const KEY_SNIPPET = '[[keys.command]]\nkey = "prefix+a"\ntype = "plugin_action"\ncommand = "agent-board.open"\ndescription = "agent board"'

// ------------------------------------------------------------------ what this computer has

/** A text file as a string (a BOM taken off, as Windows PowerShell writes one), or null. */
export function readText(file) {
  try {
    return readFileSync(file, 'utf8').replace(/^\uFEFF/, '')
  } catch {
    return null
  }
}

// Our command files are a few hundred bytes; claude.exe or node.exe on PATH is not read.
const SHIM_MAX = 4096
const sizeOf = file => {
  try {
    return statSync(file).size
  } catch {
    return 0
  }
}

/**
 * Where each shell finds a command: { ps, sh } with the file and, for one of ours, the script it
 * runs. PowerShell takes a .ps1 before a .cmd in the same folder, Git Bash and Unix shells the
 * file of that very name.
 */
export function findCommand(name, { env = process.env, platform = process.platform, exists = existsSync, read = readText, size = sizeOf } = {}) {
  const dirs = String(env.PATH ?? env.Path ?? '').split(platform === 'win32' ? ';' : delimiter).filter(Boolean)
  const exts = ['.ps1', ...String(env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean).map(e => e.toLowerCase())]
  const hit = list => {
    for (const dir of dirs) {
      for (const n of list) {
        const file = join(dir, n)
        if (!exists(file) || isFolder(file)) continue
        const target = size(file) <= SHIM_MAX ? shimTarget(read(file)) : null
        return { file, target, ...(target && !exists(target) && { gone: true }) }
      }
    }
    return null
  }
  return platform === 'win32' ? { ps: hit(exts.map(e => name + e)), sh: hit([name, `${name}.exe`]) } : { sh: hit([name]) }
}

const isFolder = file => {
  try {
    return statSync(file).isDirectory()
  } catch {
    return false
  }
}

async function probe(url, timeoutMs = 1500) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
    return { ok: res.ok, status: res.status }
  } catch (err) {
    return { ok: false, error: err.cause?.code || err.name || err.message }
  }
}

/** The program a launcher runs, found the way the board would: a path as it is, else on PATH. */
function program(name, env, platform) {
  if (!name) return null
  if (isAbsolute(name) || /[\\/]/.test(name)) return { file: resolve(name), found: existsSync(resolve(name)) }
  const f = findCommand(name, { env, platform })
  const found = f.ps ?? f.sh
  return { file: found?.file ?? name, found: !!found }
}

/** Everything the checks look at, read from this computer. */
export async function gatherFacts(cfg, { root = ROOT, env = process.env, platform = process.platform, home = homedir() } = {}) {
  const settingsFile = join(home, '.claude', 'settings.json')
  const settingsText = readText(settingsFile)
  let settings = null
  let settingsError = ''
  if (settingsText !== null) {
    try {
      settings = JSON.parse(settingsText)
    } catch (err) {
      // Only where it broke: V8's message quotes the file around it, and this goes to the page.
      settingsError = `not valid JSON${/position \d+/.exec(err.message) ? ` (${/position \d+/.exec(err.message)[0]})` : ''}`
    }
  }
  const configFile = herdrConfigFile(env, home)
  const launch = cfg?.launch ?? {}
  let launcher = null
  if (launch.command) {
    const cmd = Array.isArray(launch.command) ? launch.command : []
    const script = cmd.flat().find(s => /\.(ps1|sh|mjs|cjs|js|py)$/i.test(String(s)) && !/\{/.test(s))
    launcher = { kind: 'command', name: launcherLabel(cmd), program: program(String(cmd[0] ?? ''), env, platform), script: script ? { file: script, found: existsSync(script) } : null }
  } else if (launch.agent) {
    launcher = { kind: 'herdr', agent: String(launch.agent) }
  } else {
    let claude = null
    let error = ''
    try {
      claude = claudeCommand(launch.claude, launch.args)
      shellLine(claude)
    } catch (err) {
      error = err.message
    }
    launcher = { kind: 'builtin', claude, error, program: claude ? program(claude[0], env, platform) : null }
  }
  return {
    platform,
    root,
    node: process.versions.node,
    binDir: join(home, '.local', 'bin'),
    path: String(env.PATH ?? env.Path ?? ''),
    files: boardFiles(root),
    commands: { board: findCommand('board', { env, platform }), 'spawn-agent': findCommand('spawn-agent', { env, platform }) },
    settingsFile,
    settings,
    settingsError,
    herdrConfigFile: configFile,
    herdrConfig: readText(configFile),
    wakeUrl: cfg?.wakeUrl ?? null,
    wake: cfg?.wakeUrl ? await probe(`${String(cfg.wakeUrl).replace(/\/+$/, '')}/status`) : null,
    launcher,
  }
}

// ------------------------------------------------------------------ the checks

const INSTALL = 'herdr plugin action invoke agent-board.install'
const NOTIFICATIONS = 'herdr plugin action invoke agent-board.notifications'

/**
 * What is set up and what is not, from gatherFacts: a list of { id, level, title, detail, fix,
 * code }, in the language of `t`; `code` is a command or a snippet to copy. level: ok; error (the
 * board misses something it needs); warn (a part of it does not work); off (optional and not set
 * up: what it would give); na (not on this platform).
 */
export function checkSetup(facts, t = english) {
  const out = []
  const add = (id, level, title, detail = '', fix = '', code = '') => out.push({ id, level, title, detail, fix, code })
  const f = facts.files
  const win = facts.platform === 'win32'
  const both = (...parts) => parts.filter(Boolean).join(' ')

  const major = Number(String(facts.node ?? '').split('.')[0])
  if (major && major < 20) add('node', 'error', t('setup.node', { version: facts.node }), t('setup.node.detail'))

  // A command: where each shell finds it, and whether that is this copy's.
  const command = (name, file, level, without) => {
    const shells = Object.entries(facts.commands?.[name] ?? {})
    const shell = sh => t(sh === 'ps' ? 'setup.shell.ps' : win ? 'setup.shell.gitBash' : 'setup.shell.sh')
    const missing = shells.filter(([, hit]) => !hit).map(([sh]) => sh)
    const foreign = shells.filter(([, hit]) => hit && !hit.target).map(([sh, hit]) => `${hit.file} (${shell(sh)})`)
    const stale = shells.find(([, hit]) => hit?.target && !samePath(hit.target, file))?.[1]
    if (!missing.length && !foreign.length && !stale) return add(name, 'ok', t('setup.cmd.ok', { name }), shells.map(([, hit]) => hit.file).join(', '))
    if (foreign.length) return add(name, level, t('setup.cmd.foreign', { name }), both(t('setup.cmd.foreignDetail', { files: foreign.join(', ') }), without), t('setup.cmd.foreignFix'), INSTALL)
    if (stale?.gone) return add(name, level, t('setup.cmd.gone', { name }), both(t('setup.cmd.goneDetail', { file: stale.target }), without), t('setup.runInstall'), INSTALL)
    if (stale) return add(name, 'warn', t('setup.cmd.stale', { name }), t('setup.cmd.staleDetail', { file: stale.target }), t('setup.runInstall'), INSTALL)
    const onPath = facts.path.split(win ? ';' : ':').some(d => samePath(d, facts.binDir))
    if (!onPath) return add(name, level, t('setup.cmd.path', { name }), both(t('setup.cmd.pathDetail', { dir: facts.binDir }), without), t(win ? 'setup.cmd.pathFixWin' : 'setup.cmd.pathFix', { dir: facts.binDir }))
    const title = missing.length < shells.length ? t('setup.cmd.missingFor', { name, shells: missing.map(shell).join(', ') }) : t('setup.cmd.missing', { name })
    return add(name, level, title, without, t('setup.runInstall'), INSTALL)
  }
  command('board', f.cli, 'error', t('setup.board.without'))

  // Claude Code hooks: how sessions learn about the board.
  if (facts.settingsError) {
    add('hooks', 'error', t('setup.hooks.unreadable'), `${facts.settingsFile}: ${facts.settingsError}`, t('setup.hooks.unreadableFix'))
  } else {
    const ours = matchers(facts.root)
    const per = BOARD_EVENTS.map(event => {
      const hooks = commandsOf(facts.settings, event).filter(c => ours.hook(c.command))
      return { event, here: hooks.some(c => norm(c.command).includes(norm(f.hook))), other: hooks.find(c => !norm(c.command).includes(norm(f.hook)))?.command }
    })
    const missing = per.filter(p => !p.here)
    if (!missing.length) add('hooks', 'ok', t('setup.hooks.ok'), t('setup.hooks.okDetail', { events: BOARD_EVENTS.join(', '), file: facts.settingsFile }))
    else if (missing.every(p => p.other)) add('hooks', 'warn', t('setup.hooks.stale'), missing[0].other, t('setup.runInstall'), INSTALL)
    else add('hooks', 'error', t('setup.hooks.missing', { events: missing.map(p => p.event).join(', ') }), t('setup.hooks.without'), t('setup.runInstall'), INSTALL)

    const line = facts.settings?.statusLine?.command
    if (line && ours.line(line)) {
      if (norm(line).includes(norm(f.statusline))) add('statusline', 'ok', t('setup.line.ok'), t('setup.line.okDetail'))
      else add('statusline', 'warn', t('setup.line.stale'), line, t('setup.runInstall'), INSTALL)
    } else if (line) add('statusline', 'ok', t('setup.line.own'), t('setup.line.ownDetail'))
    else add('statusline', 'warn', t('setup.line.none'), t('setup.line.noneDetail'), t('setup.runInstall'), INSTALL)
  }

  command('spawn-agent', f.spawn, 'warn', t('setup.spawn.without'))

  // herdr's key for the board.
  const key = boardKey(facts.herdrConfig)
  if (key !== null) add('key', 'ok', t('setup.key.ok'), t('setup.key.okDetail', { key: key || '?', file: facts.herdrConfigFile }))
  else add('key', 'warn', t('setup.key.none'), t('setup.key.noneDetail'), t('setup.key.noneFix', { file: facts.herdrConfigFile }), KEY_SNIPPET)

  // herdr-wake: putting sessions to sleep and waking them. Optional: no mark on the board for it.
  if (!facts.wakeUrl) add('wake', 'off', t('setup.wake.off'), both(t('setup.wake.offDetail'), t('setup.wake.without')), t('setup.wake.fix'), WAKE_REPO)
  else if (facts.wake?.ok) add('wake', 'ok', t('setup.wake.ok'), t('setup.wake.okDetail', { url: facts.wakeUrl }))
  else add('wake', 'off', t('setup.wake.down', { url: facts.wakeUrl }), t('setup.wake.without'), t('setup.wake.fix'), WAKE_REPO)

  // How new sessions start.
  const l = facts.launcher
  if (l?.kind === 'command') {
    const bad = [l.program && !l.program.found && l.program.file, l.script && !l.script.found && l.script.file].filter(Boolean)
    if (bad.length) add('launch', 'warn', t('setup.launch.commandBad', { name: l.name }), t('setup.launch.commandBadDetail', { what: bad.join(', ') }), t('setup.launch.commandBadFix'))
    else add('launch', 'ok', t('setup.launch.command', { name: l.name }))
  } else if (l?.kind === 'herdr') {
    add('launch', 'ok', t('setup.launch.herdr', { agent: l.agent }), t('setup.launch.herdrDetail'))
  } else if (l?.kind === 'builtin') {
    const program = l.claude?.[0] ?? ''
    if (l.error) add('launch', 'warn', t('setup.launch.claudeBad'), l.error, t('setup.launch.claudeBadFix'))
    else if (!l.program?.found) add('launch', 'warn', t('setup.launch.notFound', { program }), t('setup.launch.notFoundDetail', { program }), t('setup.launch.notFoundFix'))
    else add('launch', 'ok', t('setup.launch.builtin', { claude: program }), l.claude.length === 1 && program === 'claude' ? t('setup.launch.builtinDetail') : '')
  }

  // Desktop notifications with the agent's words. Optional too, until they are on.
  if (!win) {
    add('toast', 'na', t('setup.toast.na'), t('setup.toast.naDetail'))
  } else {
    const ours = matchers(facts.root)
    const per = TOAST_EVENTS.map(([event]) => commandsOf(facts.settings, event).filter(c => ours.toast(c.command)))
    const here = per.every(list => list.some(c => norm(c.command).includes(norm(f.toast))))
    const delivery = tomlValue(facts.herdrConfig, 'ui.toast', 'delivery') ?? 'off'
    const theirs = TOAST_EVENTS.flatMap(([event]) => commandsOf(facts.settings, event)).find(c => /toast/i.test(c.command) && !ours.toast(c.command))?.command
    if (per.every(list => !list.length)) {
      if (theirs) add('toast', 'ok', t('setup.toast.own'), theirs)
      else add('toast', 'off', t('setup.toast.off'), t('setup.toast.offDetail'), t('setup.toast.offFix'), NOTIFICATIONS)
    } else if (theirs) add('toast', 'warn', t('setup.toast.twice'), t('setup.toast.theirs', { command: theirs }), t('setup.toast.theirsFix', { file: facts.settingsFile }))
    else if (!here) add('toast', 'warn', t('setup.toast.stale'), per.flat()[0]?.command ?? '', t('setup.run'), NOTIFICATIONS)
    else if (delivery !== 'off') add('toast', 'warn', t('setup.toast.twice'), t('setup.toast.twiceDetail', { delivery, file: facts.herdrConfigFile }), t('setup.toast.twiceFix'))
    else add('toast', 'ok', t('setup.toast.ok'), t('setup.toast.okDetail'))
  }
  return out
}

/** Problems worth a mark on the web board: what does not work, not what is merely off. */
export const todo = checks => checks.filter(c => c.level === 'error' || c.level === 'warn')

const MARKS = { ok: 'ok', error: '!!', warn: '! ', off: '- ', na: '- ' }

/** The checks as text for a terminal. */
export function report(checks, t = english) {
  const lines = []
  for (const c of checks) {
    lines.push(`${MARKS[c.level]} ${c.title}${c.level === 'ok' && c.detail ? ` · ${c.detail}` : ''}`)
    if (c.level === 'ok') continue
    for (const part of [c.detail, c.fix, c.code]) if (part) lines.push(...part.split('\n').map(l => `     ${l}`))
  }
  const n = todo(checks).length
  lines.push(n ? t('setup.todo', { n }) : t('setup.allSet'))
  return lines.join('\n')
}
