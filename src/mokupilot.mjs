// A call in MokuPilot (github.com/MokuTeam/MokuPilot) with a fork of a session: its work agent
// goes on from the session's conversation as a fork (claude --resume <id> --fork-session), so it
// knows what the session knows while the session itself stays as it was. The board runs
// MokuPilot's launcher with
//   call --claude-session <id> [--cwd <folder>]
// and MokuPilot does the rest: one already running takes the request, else it starts and calls.
//
// The launcher, from config.json `mokupilot`:
//   false               off
//   { command: [...] }  a program and its first arguments, one argument per element, no shell.
//                       With {session} or {cwd} in it, it is the whole command line, filled in;
//                       a nested array is left out when a value it uses is empty, as in
//                       launch.command. Without them the board adds its own arguments.
//   { dir: "..." }      a MokuPilot checkout: its .venv's Python runs run.py on Windows (what
//                       meet.cmd does: Node runs no .cmd without a shell), its `meet` elsewhere
//   unset               found on this computer: MokuPilot.exe where its installer puts it
//                       (Windows), else `meet` on PATH, meet.cmd standing for its checkout
import { spawn } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { posix, win32 } from 'node:path'
import { cwdOf } from './launch.mjs'
import { t } from './lang.mjs'
import { findCommand } from './setup.mjs'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const PLACEHOLDERS = ['session', 'cwd']
const used = s => [...String(s).matchAll(/\{(\w+)\}/g)].map(m => m[1])

/**
 * How to start MokuPilot here: { state: 'ok', configured, file, args, template } (args: what goes
 * before its own; template: a configured command line with placeholders), { state: 'missing',
 * configured, file } (what was looked for), or { state: 'off' }.
 */
export function mokupilotCommand(cfg, { platform = process.platform, env = process.env, exists = existsSync } = {}) {
  const set = cfg?.mokupilot
  if (set === false) return { state: 'off', configured: true }
  const own = set && typeof set === 'object' ? set : {}
  const win = platform === 'win32'
  const path = win ? win32 : posix
  const onPath = name => {
    const f = findCommand(name, { env, platform, exists, read: () => null, size: () => 0 })
    return (f.ps ?? f.sh)?.file ?? null
  }
  // A program by its path, or by its name on PATH.
  const program = file => (/[\\/]/.test(file) ? (exists(file) ? file : null) : onPath(file))
  // A checkout: the Python of its .venv (pythonw: no console window), as meet.cmd falls back to
  // the one on PATH; elsewhere its own `meet`.
  const checkout = dir => {
    if (!win) {
      const meet = path.join(dir, 'meet')
      return exists(meet) ? { file: meet, args: [] } : { missing: meet }
    }
    const run = path.join(dir, 'run.py')
    const scripts = path.join(dir, '.venv', 'Scripts')
    const python = [path.join(scripts, 'pythonw.exe'), path.join(scripts, 'python.exe')].find(f => exists(f)) ?? onPath('pythonw') ?? onPath('python')
    return exists(run) && python ? { file: python, args: [run] } : { missing: exists(run) ? path.join(scripts, 'pythonw.exe') : run }
  }

  if (own.command !== undefined) {
    const cmd = own.command
    if (!Array.isArray(cmd) || typeof cmd[0] !== 'string' || !cmd[0].trim()) return { state: 'missing', configured: true, file: '', error: t('mokupilot.err.command') }
    if (/(^|[\\/])cmd(\.exe)?$|\.(bat|cmd)$/i.test(cmd[0].trim())) return { state: 'missing', configured: true, file: cmd[0], error: t('mokupilot.err.commandShell') }
    const file = program(cmd[0])
    const template = cmd.flat().some(s => used(s).length) ? cmd.slice(1) : null
    return file ? { state: 'ok', configured: true, file, args: template ? [] : cmd.slice(1).flat().map(String), template } : { state: 'missing', configured: true, file: cmd[0] }
  }
  if (own.dir) {
    const c = checkout(String(own.dir))
    return c.file ? { state: 'ok', configured: true, ...c } : { state: 'missing', configured: true, file: c.missing }
  }
  if (win) {
    const local = env.LOCALAPPDATA || (env.USERPROFILE ? path.join(env.USERPROFILE, 'AppData', 'Local') : '')
    const exe = local ? path.join(local, 'Programs', 'MokuPilot', 'MokuPilot.exe') : ''
    if (exe && exists(exe)) return { state: 'ok', configured: false, file: exe, args: [] }
  }
  const meet = onPath('meet')
  if (!meet) return { state: 'missing', configured: false, file: win ? 'MokuPilot.exe, meet.cmd' : 'meet' }
  if (!win) return { state: 'ok', configured: false, file: meet, args: [] }
  const c = checkout(path.dirname(meet))
  return c.file ? { state: 'ok', configured: false, ...c } : { state: 'missing', configured: false, file: c.missing }
}

/** The command line for a call with a fork of `session`, in `cwd` when known: { file, args }. */
export function callCommand(launcher, { session, cwd = '' }) {
  if (!launcher.template) return { file: launcher.file, args: [...launcher.args, 'call', '--claude-session', session, ...(cwd ? ['--cwd', cwd] : [])] }
  const vars = { session, cwd }
  const fill = s => String(s).replace(/\{(\w+)\}/g, (m, k) => {
    if (!PLACEHOLDERS.includes(k)) throw new Error(t('mokupilot.err.placeholder', { name: m }))
    return String(vars[k] ?? '')
  })
  const args = []
  for (const part of launcher.template) {
    // An optional group: ["--cwd", "{cwd}"] is left out without a folder.
    if (Array.isArray(part)) {
      if (part.flatMap(used).every(k => String(vars[k] ?? '') !== '')) args.push(...part.map(fill))
    } else args.push(fill(part))
  }
  return { file: launcher.file, args }
}

const isDir = dir => {
  try {
    return statSync(dir).isDirectory()
  } catch {
    return false
  }
}

/**
 * Start a MokuPilot call with a fork of the session `item` (a board item with its transcript):
 * { ok } once MokuPilot's launcher started, { ok: false, error } when it could not. It runs on
 * its own, past the board's lifetime; the folder is the one the session started in.
 */
export async function startCall(cfg, item, { platform = process.platform, env = process.env, run = spawn } = {}) {
  if (item?.agent !== 'claude' || !UUID.test(String(item?.session ?? ''))) return { ok: false, error: t('mokupilot.err.notClaude') }
  const launcher = mokupilotCommand(cfg, { platform, env })
  if (launcher.state === 'off') return { ok: false, error: t('mokupilot.err.off') }
  if (launcher.state !== 'ok') return { ok: false, error: launcher.error ?? t('mokupilot.err.missing', { file: launcher.file }) }
  // --resume finds a session only from its own folder: the transcript says which that is.
  const recorded = (item.transcript && (await cwdOf(item.transcript))) || item.cwd || ''
  const cwd = recorded && isDir(recorded) ? recorded : ''
  let cmd
  try {
    cmd = callCommand(launcher, { session: item.session, cwd })
  } catch (err) {
    return { ok: false, error: err.message }
  }
  // Not one of the board's own panes: herdr's variables stay with the board.
  const childEnv = { ...env }
  delete childEnv.HERDR_PANE_ID
  delete childEnv.HERDR_TAB_ID
  return new Promise(res => {
    let child
    try {
      child = run(cmd.file, cmd.args, { cwd: cwd || undefined, env: childEnv, detached: true, stdio: 'ignore', windowsHide: false })
    } catch (err) {
      return res({ ok: false, error: t('mokupilot.err.start', { why: err.code || err.message }) })
    }
    child.once('error', err => res({ ok: false, error: t('mokupilot.err.start', { why: err.code === 'ENOENT' ? t('mokupilot.err.notFound', { file: cmd.file }) : err.code || err.message }) }))
    child.once('spawn', () => {
      child.unref()
      res({ ok: true, file: cmd.file })
    })
  })
}
