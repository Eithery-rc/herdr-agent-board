// New sessions from the web board, and renaming one in Claude and herdr.
//
// A launch runs in the background and is reported in the board payload (`launches`), so the
// page shows a starting card at once and a clear reason when it fails. Two ways to start one:
//   herdr (default)  a tab through herdr (a workspace first when asked), the agent started by
//                    `herdr agent start`, then /rename and the first message typed into it.
//   command          `launch.command` in config.json: an executable and its arguments, with
//                    {placeholders} filled in per argument. No shell, nothing from the request
//                    becomes a command; it should print `pane=<id>` when the session is up.
// The card gets the chosen category as soon as the session has an id; a Claude started by the
// board gets its id up front (--session-id), so even its first brief knows the lane.
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { open, readdir, stat } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { checkBranch, checkName, normDir, sameDir, slugName, uniqueSlug, worktreePath } from '../web/launch-model.js'
import { resolvePath } from './files.mjs'
import { raiseTerminal } from './actions.mjs'
import { herdr, herdrText } from './herdr.mjs'
import { t } from './lang.mjs'
import { CLAUDE_DIR, STATE_DIR } from './paths.mjs'
import { writeCard } from './store.mjs'

export const PLACEHOLDERS = ['name', 'label', 'cwd', 'workspace', 'workspaceLabel', 'category', 'message', 'messageFile', 'sessionId']
const MESSAGE_MAX = 20_000

// ------------------------------------------------------------------ the command from config

const fill = (s, vars) => String(s).replace(/\{(\w+)\}/g, (m, k) => {
  if (!PLACEHOLDERS.includes(k)) throw new Error(t('launch.err.placeholder', { name: m }))
  return String(vars[k] ?? '')
})
const used = s => [...String(s).matchAll(/\{(\w+)\}/g)].map(m => m[1])

/** Whether the template uses {key} anywhere. */
export const usesPlaceholder = (template, key) => (template ?? []).flat().some(s => used(s).includes(key))

/**
 * `launch.command` with the values filled in: { file, args }. Each element is one argument, a
 * value never splits or joins arguments. A nested array is an optional group, left out when
 * any value it uses is empty: ["-BriefFile", "{messageFile}"]. The executable takes no values.
 */
export function commandArgs(template, vars) {
  if (!Array.isArray(template) || typeof template[0] !== 'string' || !template[0].trim()) throw new Error(t('launch.err.command'))
  if (used(template[0]).length) throw new Error(t('launch.err.commandValue'))
  const args = []
  for (const part of template.slice(1)) {
    if (Array.isArray(part)) {
      if (!part.every(s => typeof s === 'string')) throw new Error(t('launch.err.command'))
      if (part.flatMap(used).every(k => String(vars[k] ?? '') !== '')) args.push(...part.map(s => fill(s, vars)))
    } else if (typeof part === 'string') args.push(fill(part, vars))
    else throw new Error(t('launch.err.command'))
  }
  return { file: template[0], args }
}

/** What a launcher printed when it worked: `pane=<id> name=<name> agent=<herdr name>`, each optional. */
export function parseLauncherOutput(stdout) {
  const out = {}
  for (const m of String(stdout ?? '').matchAll(/\b(pane|agent|session)=(\S+)/g)) out[m[1]] = m[2]
  return out
}

const ANSI = /\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07/g

/**
 * Why a launcher failed, from what it printed: PowerShell's error view puts the message on the
 * last "| " line, other tools on their last line. The pane, when the text names one.
 */
export function launcherError(stdout, stderr) {
  const lines = `${stderr ?? ''}\n${stdout ?? ''}`.replace(ANSI, '').split(/\r?\n/).map(l => l.trimEnd())
  const err = String(stderr ?? '').replace(ANSI, '').split(/\r?\n/).map(l => l.trim()).filter(Boolean)
  // PowerShell 7: the message follows the ~~~ line under the code, wrapped over "| " lines.
  const marker = err.findLastIndex(l => /^\|\s*~+$/.test(l))
  const barred = marker >= 0 ? err.slice(marker + 1).map(l => /^\|\s?(.*)$/.exec(l)?.[1]?.trim()).filter(Boolean).join(' ') : ''
  // Windows PowerShell: the message first, cut at the console's width, then "At …", "+ …" and
  // CategoryInfo lines.
  const raw = String(stderr ?? '').replace(ANSI, '').split(/\r?\n/).filter(l => l.trim())
  const at = raw.findIndex(l => /^At \S/.test(l))
  const legacy = at > 0 && raw.some(l => /^\s*\+ CategoryInfo/.test(l)) ? raw.slice(0, at).reduce((s, l, i, all) => s + (i && all[i - 1].length < 110 ? ' ' : '') + l, '').trim() : ''
  const plain = err.filter(l => !/^(At |Line \||\+ |\| |CategoryInfo|FullyQualifiedErrorId|~)/.test(l)).at(-1)
  const message = (barred || legacy || plain || lines.filter(Boolean).at(-1) || '').replace(/^\S+\.ps1\s*:\s*/i, '').replace(/^(Exception|Error|Write-Error):\s*/i, '').trim()
  const pane = /\b(w[A-Za-z0-9]+:p[A-Za-z0-9]+)\b/.exec(lines.join('\n'))?.[1] ?? null
  return { message, pane }
}

/** What kind of failure it was, for the hint the page shows next to it. */
export function failureKind(message, code) {
  const m = String(message ?? '')
  if (code === 'ENOENT' || code === 'EINVAL') return 'launcher'
  if (/trust|dialog|agent_not_ready|blocked/i.test(m)) return 'dialog'
  if (/did not get ready|timed? ?out|ETIMEDOUT|timeout/i.test(m)) return 'timeout'
  if (/no such folder|not a folder|cannot find path/i.test(m)) return 'folder'
  if (/worktree|branch/i.test(m)) return 'worktree'
  return 'other'
}

/** A short name for the launcher in the window: its script's name, else the program's. */
export function launcherLabel(command) {
  if (!Array.isArray(command) || !command.length) return ''
  const script = command.flat().find(s => /\.(ps1|sh|cmd|bat|mjs|cjs|js|py)$/i.test(String(s)) && !/\{/.test(s))
  return basename(String(script ?? command[0])).replace(/\.(ps1|sh|cmd|bat|mjs|cjs|js|py|exe)$/i, '')
}

// ------------------------------------------------------------------ folders for the picker

// A path someone typed can be a share that is offline: no file-system call on it may hold the
// board up. Each one gives up after `ms` and says so (SLOW).
const SLOW = Symbol('slow')
const within = (promise, ms) => Promise.race([promise, new Promise(r => setTimeout(r, ms, SLOW).unref?.())])
const statOf = (path, ms = 2000) => within(stat(path).catch(() => null), ms)

let rootsCache = { at: 0, list: [] }
/** Where browsing starts: home, and every drive on Windows. */
async function roots() {
  if (Date.now() - rootsCache.at < 30_000) return rootsCache.list
  const drives = process.platform === 'win32' ? [...'CDEFGHIJKLMNOPQRSTUVWXYZ'] : []
  const found = await Promise.all(drives.map(async l => ((await statOf(`${l}:\\`, 400))?.isDirectory?.() ? { name: `${l}:`, path: `${l}:\\` } : null)))
  const list = [{ name: '~', path: homedir() }, ...(process.platform === 'win32' ? found.filter(Boolean) : [{ name: '/', path: '/' }])]
  rootsCache = { at: Date.now(), list }
  return list
}

const SYSTEM_DIRS = new Set(['$recycle.bin', 'system volume information', '$windows.~bt', '$windows.~ws', 'config.msi', 'recovery'])

/**
 * The subfolders of a folder (only folders), for the picker's columns and completion; '' lists
 * the roots. `git` also tells the checkout the folder is in, for the worktree option. `slow`:
 * the folder did not answer in time (an offline share), which is not the same as missing.
 */
export async function listDirs(raw, { git = false } = {}) {
  if (!String(raw ?? '').trim()) return { path: '', exists: true, dir: true, roots: await roots(), entries: [] }
  const { path } = resolvePath(raw)
  if (!path) return { path: String(raw), exists: false }
  const st = await statOf(path)
  if (st === SLOW) return { path, exists: false, slow: true }
  if (!st) return { path, exists: false }
  if (!st.isDirectory()) return { path, exists: true, dir: false }
  let entries = []
  let error = null
  try {
    const dirents = await within(readdir(path, { withFileTypes: true }), 4000)
    if (dirents === SLOW) throw Object.assign(new Error('slow'), { code: 'SLOW' })
    const linked = await Promise.all(dirents.map(async d => d.isDirectory() || (d.isSymbolicLink() && (await statOf(join(path, d.name), 1000))?.isDirectory?.())))
    entries = dirents
      .filter((d, i) => linked[i] === true)
      .map(d => d.name)
      .filter(n => !SYSTEM_DIRS.has(n.toLowerCase()))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }))
  } catch (err) {
    error = err.code === 'EPERM' || err.code === 'EACCES' ? 'denied' : err.code === 'SLOW' ? 'slow' : err.message
  }
  const up = dirname(path)
  const out = { path, exists: true, dir: true, entries: entries.slice(0, 2000), truncated: entries.length > 2000, parent: up !== path ? up : '', sep, error }
  if (git) out.git = await gitInfo(path)
  return out
}

function run(file, args, { timeout = 15_000, env, cwd } = {}) {
  return new Promise(res => {
    execFile(file, args, { encoding: 'utf8', timeout, windowsHide: true, maxBuffer: 4 << 20, env, cwd }, (err, stdout, stderr) =>
      res({ code: err ? (err.code ?? 1) : 0, killed: !!err?.killed, error: err, stdout: stdout ?? '', stderr: stderr ?? '' }),
    )
  })
}

/** The git checkout a folder is in: { root, branch }, or null. */
export async function gitInfo(dir) {
  const r = await run('git', ['-C', dir, 'rev-parse', '--show-toplevel', '--abbrev-ref', 'HEAD'], { timeout: 5000 })
  if (r.code !== 0) return null
  const [root, branch] = r.stdout.trim().split(/\r?\n/)
  return root ? { root: resolve(root), branch: branch ?? '' } : null
}

let recentCache = { at: 0, list: [] }
/**
 * Folders recent Claude sessions on this machine ran in, newest first: the cwd in the newest
 * transcript of each project. Read from the head of the file only, cached for a minute.
 */
export async function recentFolders(projects = join(CLAUDE_DIR, 'projects'), limit = 12) {
  if (Date.now() - recentCache.at < 60_000) return recentCache.list
  const found = []
  try {
    const mtime = async p => (await stat(p).catch(() => null))?.mtimeMs ?? 0
    const all = (await readdir(projects, { withFileTypes: true })).filter(d => d.isDirectory())
    const dirs = (await Promise.all(all.map(async d => ({ dir: join(projects, d.name), m: await mtime(join(projects, d.name)) })))).sort((a, b) => b.m - a.m).slice(0, 40)
    const temp = normDir(tmpdir())
    const cwds = await Promise.all(
      dirs.map(async ({ dir }) => {
        const files = (await readdir(dir).catch(() => [])).filter(f => f.endsWith('.jsonl'))
        const newest = (await Promise.all(files.map(async f => ({ f, m: await mtime(join(dir, f)) })))).sort((a, b) => b.m - a.m)[0]
        return newest ? cwdOf(join(dir, newest.f)) : null
      }),
    )
    for (const cwd of cwds) {
      if (!cwd || normDir(cwd).startsWith(temp) || found.some(f => sameDir(f, cwd))) continue
      if ((await statOf(cwd, 500))?.isDirectory?.()) found.push(cwd)
      if (found.length >= limit) break
    }
  } catch {}
  recentCache = { at: Date.now(), list: found }
  return found
}

async function cwdOf(file) {
  let fh
  try {
    fh = await open(file, 'r')
    const buf = Buffer.alloc(32 << 10)
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0)
    const m = /"cwd":("(?:[^"\\]|\\.)*")/.exec(buf.subarray(0, bytesRead).toString('utf8'))
    return m ? JSON.parse(m[1]) : null
  } catch {
    return null
  } finally {
    await fh?.close()
  }
}

// ------------------------------------------------------------------ typing into a live agent

const stalled = err => /agent_prompt_stalled/.test(`${err?.code} ${err?.message}`)

/**
 * Type a line into an agent's prompt. Right after a slash command Claude can drop typed text,
 * and a short turn can end before herdr sees it working: both read as agent_prompt_stalled.
 * Text still on screen gets an Enter; text that vanished is typed again (as spawn-agent does).
 */
async function typeLine(pane, text, tries = 3) {
  const line = /^-/.test(text) ? ` ${text}` : text // a leading dash reads as an option to herdr
  for (let i = 1; i <= tries; i++) {
    try {
      await herdr(['agent', 'prompt', pane, line])
      return true
    } catch (err) {
      if (!stalled(err)) throw err
      const screen = await herdrText(['pane', 'read', pane, '--source', 'visible'], 5000).catch(() => '')
      // Its first line (the screen breaks the rest) still in the prompt: it only needs its Enter.
      if (screen.includes(text.split('\n')[0].slice(0, 30)) || /Pasted text/.test(screen)) {
        await herdr(['pane', 'send-keys', pane, 'enter']).catch(() => {})
        return true
      }
      await new Promise(r => setTimeout(r, 800))
    }
  }
  return false
}

/** Claude's /rename runs without a turn: herdr calls the prompt stalled; the screen says whether it took. */
async function claudeRename(pane, name) {
  try {
    await herdr(['agent', 'prompt', pane, `/rename ${name}`])
  } catch (err) {
    if (!stalled(err)) throw err
  }
  for (let i = 0; i < 10; i++) {
    await new Promise(r => setTimeout(r, 500))
    if (/Session renamed/i.test(await herdrText(['pane', 'read', pane, '--source', 'visible'], 5000).catch(() => ''))) return true
  }
  return false
}

async function agentNames() {
  try {
    return new Set(((await herdr(['agent', 'list']))?.agents ?? []).map(a => a.name).filter(Boolean))
  } catch {
    return new Set()
  }
}

/**
 * Rename a session in Claude (/rename, what SendMessage, ListAgents and herdr-wake see) and its
 * herdr name. Typed into the session, so only into an idle one that is still the same session.
 */
export async function renameSession(item, name) {
  if (item.sleeping) return { ok: false, error: t('rename.err.asleep', { name: item.name }) }
  if (!item.session || !item.pane || item.agent !== 'claude') return { ok: false, error: t('rename.err.notClaude', { name: item.name }) }
  try {
    const agent = (await herdr(['agent', 'get', item.pane]))?.agent
    if (!agent || (agent.agent_session?.value ?? null) !== item.session) return { ok: false, error: t('err.sessionChanged', { name: item.name }) }
    if (agent.agent_status === 'working' || agent.agent_status === 'blocked') return { ok: false, error: t('rename.err.busy', { name: item.name }) }
    const confirmed = await claudeRename(item.pane, name)
    const taken = await agentNames()
    taken.delete(agent.name)
    const slug = uniqueSlug(slugName(name), taken)
    if (slug !== agent.name) await herdr(['agent', 'rename', item.pane, slug]).catch(() => {})
    return { ok: true, confirmed }
  } catch (err) {
    return { ok: false, error: t('rename.err.claude', { why: err.message }) }
  }
}

// ------------------------------------------------------------------ launches

class LaunchError extends Error {
  constructor(message, kind) {
    super(message)
    this.kind = kind
  }
}

const WORKSPACE_ID = /^[A-Za-z0-9][\w:-]{0,39}$/
/** A workspace name herdr takes as a value: no control characters, no leading dash. */
const workspaceName = (s, max) => !!s && s.length <= max && !/[\u0000-\u001f\u007f]/.test(s) && !s.startsWith('-')

/** Check a launch request. { ok, launch } or { ok: false, error, field }. */
export async function checkRequest(body) {
  const fail = (field, key, vars) => ({ ok: false, field, error: t(key, vars) })
  const name = String(body?.name ?? '').trim()
  const bad = checkName(name)
  if (bad) return fail('name', bad, { max: 60 })
  const { path: cwd } = resolvePath(body?.cwd)
  if (!cwd) return fail('cwd', 'launch.err.cwdEmpty')
  const st = await statOf(cwd, 3000)
  if (st === SLOW) return fail('cwd', 'launch.err.cwdSlow', { path: cwd })
  if (!st) return fail('cwd', 'launch.err.cwdMissing', { path: cwd })
  if (!st.isDirectory()) return fail('cwd', 'launch.err.cwdFile', { path: cwd })
  const category = /^[a-z0-9_-]{1,32}$/.test(String(body?.category ?? '')) ? body.category : 'other'
  const ws = body?.workspace ?? {}
  let workspaceId = ''
  let workspaceLabel = ''
  if (ws.id) {
    if (!WORKSPACE_ID.test(String(ws.id))) return fail('workspace', 'launch.err.workspace')
    workspaceId = String(ws.id)
    workspaceLabel = String(ws.label ?? '').trim()
    if (workspaceLabel && !workspaceName(workspaceLabel, 60)) workspaceLabel = ''
  } else {
    workspaceLabel = String(ws.create ?? '').trim()
    if (!workspaceName(workspaceLabel, 40)) return fail('workspace', 'launch.err.workspaceName')
  }
  const message = String(body?.message ?? '').trim()
  if (message.length > MESSAGE_MAX) return fail('message', 'launch.err.message', { n: MESSAGE_MAX })
  let worktree = null
  if (body?.worktree) {
    const branch = String(body.worktree.branch ?? '').trim()
    const why = checkBranch(branch)
    if (why) return fail('worktree', why)
    worktree = { branch }
  }
  return { ok: true, launch: { name, label: name, cwd, category, workspaceId, workspaceLabel, newWorkspace: !workspaceId, message, worktree } }
}

/**
 * The launches of this board process. `onChange` publishes the board again; `observe(items)`
 * after each refresh links launches to the sessions they started and gives those their lane.
 */
export function createLaunches({ cfg, log = () => {}, onChange = () => {} }) {
  const launches = new Map()
  const changed = () => onChange()
  const spec = () => cfg.launch ?? {}

  async function start(body, items = []) {
    const r = await checkRequest(body)
    if (!r.ok) return r
    const l = { ...r.launch, id: randomUUID().slice(0, 8), state: 'starting', step: 'prepare', startedAt: Date.now(), knownPanes: new Set(items.map(i => i.pane)), pane: null, key: null, error: '', kind: '' }
    launches.set(l.id, l)
    runLaunch(l)
      .then(() => {
        l.state = 'done'
        l.doneAt = Date.now()
      })
      .catch(err => {
        if (l.dismissed) return void launches.delete(l.id) // waved off while it ran: nothing to show
        l.state = 'failed'
        l.error = err.message || String(err)
        l.kind = err.kind || failureKind(l.error, err.code)
        log(`launch ${l.name}: ${l.error}`)
      })
      .finally(changed)
    changed()
    return { ok: true, id: l.id }
  }

  const step = (l, name) => {
    l.step = name
    changed()
  }

  async function runLaunch(l) {
    if (l.worktree) {
      step(l, 'worktree')
      const git = await gitInfo(l.cwd)
      if (!git) throw new LaunchError(t('launch.err.notGit', { path: l.cwd }), 'worktree')
      const path = worktreePath(git.root, l.worktree.branch)
      if (await statOf(path)) throw new LaunchError(t('launch.err.worktreeExists', { path }), 'worktree')
      const r = await run('git', ['-C', git.root, 'worktree', 'add', '-b', l.worktree.branch, path], { timeout: 60_000 })
      if (r.code !== 0) throw new LaunchError(t('launch.err.worktreeGit', { why: launcherError(r.stdout, r.stderr).message || r.error?.message }), 'worktree')
      // The session works in the same place below the checkout as the folder that was picked.
      const below = relative(git.root, l.cwd)
      const inside = below && !below.startsWith('..') ? join(path, below) : path
      l.cwd = (await statOf(inside))?.isDirectory?.() ? inside : path
    }
    if (l.newWorkspace) {
      step(l, 'workspace')
      const r = await herdr(['workspace', 'create', '--cwd', l.cwd, '--label', l.workspaceLabel, '--no-focus'])
      l.workspaceId = r.workspace.workspace_id
      l.rootPane = r.root_pane?.pane_id ?? null
      l.rootTab = r.tab?.tab_id ?? null
    }
    if (spec().command) await viaCommand(l)
    else await viaHerdr(l)
  }

  /** A Claude the board starts gets its session id now, so its card (and lane) exist before it does. */
  function ownSessionId(l) {
    l.sessionId = randomUUID()
    writeCard(l.sessionId, { category: l.category })
    l.carded = l.sessionId
  }

  async function viaHerdr(l) {
    step(l, 'tab')
    let pane
    if (l.rootPane) {
      pane = l.rootPane
      if (l.rootTab) await herdr(['tab', 'rename', l.rootTab, l.label]).catch(() => {})
    } else {
      pane = (await herdr(['tab', 'create', '--workspace', l.workspaceId, '--cwd', l.cwd, '--label', l.label, '--no-focus'])).root_pane.pane_id
    }
    l.pane = pane
    const kind = String(spec().agent ?? 'claude')
    const args = (Array.isArray(spec().args) ? spec().args : []).map(String)
    if (kind === 'claude' && !args.some(a => /^(--session-id|-r|--resume|-c|--continue)$/.test(a))) {
      ownSessionId(l)
      args.push('--session-id', l.sessionId)
    }
    l.agent = uniqueSlug(slugName(l.name), await agentNames())
    step(l, 'agent')
    const ms = Math.max(10, Number(spec().timeoutSec) || 120) * 1000
    try {
      await herdr(['agent', 'start', l.agent, '--kind', kind, '--pane', pane, '--timeout', String(Math.min(ms, 300_000)), ...(args.length ? ['--', ...args] : [])], ms + 15_000)
    } catch (err) {
      if (err.code !== 'agent_not_ready' && !/agent_not_ready/.test(err.message)) {
        const agent = kind === 'claude' ? 'Claude' : kind
        throw new LaunchError(/timeout|timed out/i.test(err.message) ? t('launch.err.notReady', { s: ms / 1000, agent }) : err.message, failureKind(err.message))
      }
      // A dialog holds it (trusting the folder, usually): the user answers it, the board waits and goes on.
      l.state = 'waiting'
      step(l, 'dialog')
      await untilReady(l, 15 * 60_000)
      l.state = 'starting'
    }
    if (kind === 'claude') {
      step(l, 'rename')
      await claudeRename(pane, l.name)
    }
    if (l.message) {
      step(l, 'message')
      if (!(await typeLine(pane, l.message))) throw new LaunchError(t('launch.err.message.lost'), 'message')
    }
  }

  async function untilReady(l, limit) {
    const deadline = Date.now() + limit
    while (Date.now() < deadline && !l.dismissed) {
      await new Promise(r => setTimeout(r, 1500))
      let agent = null
      try {
        agent = (await herdr(['agent', 'get', l.pane], 5000))?.agent
      } catch (err) {
        if (/not.?found|no such/i.test(err.message)) throw new LaunchError(t('launch.err.paneGone'), 'other')
      }
      if (agent && (agent.agent_status === 'idle' || agent.agent_status === 'done')) return
    }
    throw new LaunchError(t(l.dismissed ? 'launch.err.dismissed' : 'launch.err.dialogTimeout'), 'dialog')
  }

  async function viaCommand(l) {
    const template = spec().command
    const vars = { name: l.name, label: l.label, cwd: l.cwd, workspace: l.workspaceId, workspaceLabel: l.workspaceLabel, category: l.category, message: l.message, messageFile: '', sessionId: '' }
    if (usesPlaceholder(template, 'sessionId')) {
      ownSessionId(l)
      vars.sessionId = l.sessionId
    }
    let file = null
    if (l.message && usesPlaceholder(template, 'messageFile')) {
      const dir = join(STATE_DIR, 'launch')
      mkdirSync(dir, { recursive: true })
      file = join(dir, `${l.id}.txt`)
      writeFileSync(file, l.message)
      vars.messageFile = file
    }
    try {
      const { file: exe, args } = commandArgs(template, vars)
      step(l, 'command')
      // The board runs in a pane of its own workspace: the launcher must not take that for "here".
      const env = { ...process.env, HERDR_WORKSPACE_ID: l.workspaceId }
      delete env.HERDR_PANE_ID
      delete env.HERDR_TAB_ID
      const timeout = Math.max(10, Number(spec().timeoutSec) || 180) * 1000
      const r = await run(exe, args, { timeout, env, cwd: l.cwd })
      const out = parseLauncherOutput(r.stdout)
      if (out.pane) l.pane = out.pane
      if (r.code !== 0) {
        if (r.error?.code === 'ENOENT') throw new LaunchError(t('launch.err.launcherMissing', { file: exe }), 'launcher')
        if (r.killed) throw new LaunchError(t('launch.err.launcherTimeout', { s: timeout / 1000 }), 'timeout')
        const e = launcherError(r.stdout, r.stderr)
        if (!l.pane && e.pane) l.pane = e.pane
        throw new LaunchError(e.message || r.error?.message || t('err.status', { code: r.code }), failureKind(e.message, r.error?.code))
      }
      // A new workspace starts with a tab of shells; the launcher opened its own tab beside it.
      if (l.rootTab && l.pane && l.pane !== l.rootPane) await tidy(l.workspaceId, l.rootTab, l.pane)
    } finally {
      if (file) try { unlinkSync(file) } catch {}
    }
  }

  /** Close the tab a new workspace came with, if no agent runs in it (the session is elsewhere). */
  async function tidy(workspace, tab, pane) {
    try {
      const panes = ((await herdr(['pane', 'list', '--workspace', workspace]))?.panes ?? []).filter(p => p.tab_id === tab)
      if (panes.length && !panes.some(p => p.agent || p.pane_id === pane)) await herdr(['tab', 'close', tab])
    } catch {}
  }

  /** After a refresh: which item each launch started, and its category on its card. */
  function observe(items) {
    const claimed = new Set()
    for (const l of launches.values()) {
      let it = (l.sessionId && items.find(i => i.session === l.sessionId)) || (l.pane && items.find(i => i.pane === l.pane)) || null
      // A launcher that says its pane only at the end: while it runs, a new agent pane in that
      // folder and workspace is taken for it, and the pane it prints settles it. herdr's own path
      // and launchers given {sessionId} need no guess: they are matched by the session id.
      const guess = !it && !l.pane && !l.sessionId && l.step === 'command' && l.state === 'starting' && l.workspaceLabel
      if (guess) it = items.find(i => !l.knownPanes.has(i.pane) && i.workspace === l.workspaceLabel && sameDir(i.cwd, l.cwd) && !claimed.has(i.key) && ![...launches.values()].some(o => o !== l && o.key === i.key))
      if (!it) continue
      claimed.add(it.key)
      l.key = it.key
      l.pane ??= it.pane
      // Its card gets the lane under the key it has now. A Claude pane is keyed by its session id
      // in a moment, so only other agents get a card by their pane.
      if (l.carded !== it.key && (it.session || it.agent !== 'claude')) {
        try {
          writeCard(it.key, { category: l.category })
          l.carded = it.key
        } catch {}
      }
    }
    // Started ones go once their card is on the board; failed ones stay until dismissed (or 30 min).
    const now = Date.now()
    let gone = false
    for (const [id, l] of launches) {
      const done = l.state === 'done' && ((l.key && l.carded && now - l.doneAt > 8000) || now - l.doneAt > 120_000 || l.dismissed)
      if (done || (l.state === 'failed' && now - l.startedAt > 30 * 60_000)) {
        launches.delete(id)
        gone = true
      }
    }
    if (gone) changed()
  }

  /** An item a launch started: in the chosen lane until its card says so too, and how the launch goes. */
  function decorate(item) {
    const l = [...launches.values()].find(x => x.key === item.key)
    if (!l) return item
    return { ...item, category: item.categorySet ? item.category : l.category, launch: l.state === 'done' || l.dismissed ? null : view(l) }
  }

  const view = l => ({ id: l.id, name: l.name, cwd: l.cwd, category: l.category, workspace: l.workspaceLabel, state: l.state, step: l.step, error: l.error, kind: l.kind, pane: l.pane, key: l.key, startedAt: l.startedAt, doneAt: l.doneAt ?? null, message: l.message, worktree: l.worktree, newWorkspace: l.newWorkspace })

  /**
   * Take a launch off the board. A failed one goes; one still running only stops showing: it
   * goes on, and its session still gets its lane (a dialog it waits on is given up on).
   */
  function dismiss(id) {
    const l = launches.get(id)
    if (!l) return { ok: false, error: t('launch.err.gone') }
    l.dismissed = true
    if (l.state === 'failed' || l.state === 'done') launches.delete(id)
    changed()
    return { ok: true }
  }

  /** Go to a launch's tab in herdr (it may be no agent yet: a shell, or one waiting for a dialog). */
  async function focusLaunch(id) {
    const l = launches.get(id)
    if (!l?.pane) return { ok: false, error: t('launch.err.gone') }
    try {
      const tab = (await herdr(['pane', 'get', l.pane]))?.pane?.tab_id
      if (!tab) throw new Error(t('launch.err.paneGone'))
      await herdr(['tab', 'focus', tab])
    } catch (err) {
      return { ok: false, error: t('err.focus', { name: l.name, why: err.message }) }
    }
    if (cfg.raiseTerminal !== false) raiseTerminal(cfg)
    return { ok: true }
  }

  /** What the window needs: the launcher, herdr's workspaces, recent folders. */
  async function options() {
    let workspaces = []
    let focused = ''
    let error = ''
    try {
      const list = (await herdr(['workspace', 'list'], 8000))?.workspaces ?? []
      workspaces = list.map(w => ({ id: w.workspace_id, label: w.label }))
      focused = list.find(w => w.focused)?.workspace_id ?? ''
    } catch (err) {
      error = err.message
    }
    const command = spec().command
    return {
      launcher: command ? { kind: 'command', name: launcherLabel(command) } : { kind: 'herdr', agent: String(spec().agent ?? 'claude') },
      workspaces,
      focused,
      board: (cfg.placement ?? 'workspace') === 'workspace' ? (cfg.workspace ?? 'Board') : '',
      recent: await recentFolders(),
      error,
    }
  }

  return { start, observe, decorate, dismiss, focus: focusLaunch, options, list: () => [...launches.values()].filter(l => !l.dismissed).map(view) }
}
