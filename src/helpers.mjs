// A session's helpers: the subagents, forks, workflow agents and in-process teammates Claude Code
// ran for it. They live beside the session's transcript, in <session id>/subagents/:
//   agent-<id>.jsonl         the helper's own transcript (every line a sidechain)
//   agent-<id>.meta.json     what it is: agentType, description, toolUseId, isFork, name,
//                            requestShape (background | foreground), taskKind
//                            (in_process_teammate), parentAgentId (started by another helper),
//                            finished, stoppedByUser
//   workflows/<run>/agent-<id>.*, journal.jsonl   a workflow run's agents and its progress
// and <session id>/workflows/<run>.json once a run is over (its name, status and totals), with
// the run's script in workflows/scripts/<name>-<run>.js. Nothing here writes.
//
// The board asks for every session on each refresh, so everything is cached by the file's time
// and size: a folder is listed again only when its time changes, a transcript's head and tail are
// read again only when it grew.
import { closeSync, openSync, readSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { conversation, promptOf, toolDetail, toolLabel } from './claude.mjs'

const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)
// A helper's id as Claude Code names its files: agent-<id>.jsonl, the id letters, digits and dashes.
const AGENT_FILE = /^agent-([A-Za-z0-9-]{1,120})\.jsonl$/
const RUN_DIR = /^wf_[A-Za-z0-9-]{1,80}$/

function parse(line) {
  try {
    return JSON.parse(line)
  } catch {
    return null
  }
}

function readSlice(path, start, length) {
  const buf = Buffer.alloc(length)
  const fd = openSync(path, 'r')
  try {
    readSync(fd, buf, 0, length, start)
  } finally {
    closeSync(fd)
  }
  return buf.toString('utf8')
}

/** The last `bytes` of a file, from the first whole line on. */
function readTail(path, size, bytes) {
  const start = Math.max(0, size - bytes)
  const text = readSlice(path, start, size - start)
  return start ? text.slice(text.indexOf('\n') + 1) : text
}

/** The first `bytes` of a file, up to its last whole line. */
function readHead(path, size, bytes) {
  const text = readSlice(path, 0, Math.min(size, bytes))
  return size > bytes ? text.slice(0, text.lastIndexOf('\n') + 1) : text
}

/** Text of a message's content: a string, or its text blocks. */
function textOf(content) {
  if (typeof content === 'string') return content
  return Array.isArray(content) ? content.filter(b => b?.type === 'text').map(b => b.text).join('\n') : ''
}

/** The start of a helper's transcript: when it started and what it was asked. */
export function headInfo(text) {
  let startedAt = null
  let prompt = ''
  let from = ''
  for (const line of String(text ?? '').split('\n')) {
    if (!line) continue
    const o = parse(line)
    if (!o) continue
    if (startedAt == null && o.timestamp) startedAt = Date.parse(o.timestamp) || null
    if (o.type !== 'user') continue
    const p = promptOf(textOf(o.message?.content))
    if (!p?.prompt) continue
    ;({ prompt, from } = p)
    break
  }
  return { startedAt, prompt: clip(prompt, 600), from }
}

/**
 * Where a helper's transcript ends: what it does now, and how far it got.
 *   last      end (its final answer) | tool (a call runs) | waiting (the model is on it) |
 *             interrupted (stopped by the user) | error (an API error) | none
 *   now       the call that runs: { name, label, detail }, or null
 *   after     the last call before the model's turn now, for "thinking after Read"
 *   tokens    the last request's context and answer, as Claude Code counts a subagent's tokens
 *   result    its last words, clipped
 *   endedAt   the time of its last message
 */
export function tailInfo(text) {
  const info = { last: 'none', now: null, after: '', tokens: null, result: '', endedAt: null }
  const results = new Set() // tool_use ids with a result later in the file
  const names = new Map() // tool_use id -> tool name, for the result the transcript ends on
  let lastResult = null // the tool_use id of a result the transcript ends on
  const lines = String(text ?? '').split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]
    if (!line || !(line.includes('"type":"user"') || line.includes('"type":"assistant"'))) continue
    const o = parse(line)
    if (!o || (o.type !== 'user' && o.type !== 'assistant')) continue
    const content = o.message?.content
    if (info.endedAt == null) info.endedAt = Date.parse(o.timestamp) || null
    if (o.type === 'user') {
      const blocks = Array.isArray(content) ? content : []
      for (const b of blocks) if (b?.type === 'tool_result') results.add(b.tool_use_id)
      if (info.last === 'none') {
        const said = textOf(content)
        if (/\[Request interrupted by user/.test(said)) info.last = 'interrupted'
        else {
          lastResult = blocks.find(b => b?.type === 'tool_result')?.tool_use_id ?? null
          info.last = 'waiting'
        }
      }
      continue
    }
    const synthetic = o.isApiErrorMessage || o.message?.model === '<synthetic>'
    const blocks = Array.isArray(content) ? content : []
    if (info.last === 'none') {
      const reason = o.message?.stop_reason
      info.last = synthetic ? 'error' : blocks.some(b => b?.type === 'tool_use') ? 'tool' : ['end_turn', 'stop_sequence', 'max_tokens'].includes(reason) ? 'end' : 'waiting'
    }
    if (info.tokens == null && !synthetic && o.message?.usage) {
      const u = o.message.usage
      const n = (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.output_tokens ?? 0)
      if (n) info.tokens = n
    }
    for (let j = blocks.length - 1; j >= 0; j--) {
      const b = blocks[j]
      if (b?.type === 'tool_use') {
        names.set(b.id, b.name)
        if (!info.now && !info.after) {
          const call = { name: b.name, label: toolLabel(b.name), detail: toolDetail(b.name, b.input) }
          if (results.has(b.id)) info.after = call.label
          else info.now = call
        }
      } else if (b?.type === 'text' && !info.result && b.text?.trim() && !synthetic) info.result = clip(b.text.trim(), 400)
    }
    if (info.tokens != null && (info.now || info.after) && info.result) break
  }
  // A workflow agent ends by handing its structured output back.
  if (info.last === 'waiting' && lastResult && names.get(lastResult) === 'StructuredOutput') info.last = 'end'
  if (info.last !== 'tool') info.now = null
  return info
}

/**
 * How a helper stands: running | idle (a teammate waiting for a message) | done | failed |
 * stopped. One that never got to its end runs only while its session's process does, and only
 * when that process wrote to it: a helper the previous process left behind (the session slept
 * or restarted) is stopped.
 *   alive    the session's Claude process runs
 *   since    when that process started (ms), or null
 */
export function helperStatus({ meta = {}, tail = {}, kind, alive = false, since = null, mtimeMs = 0 }) {
  if (meta.stoppedByUser) return 'stopped'
  if (tail.last === 'end') return kind === 'teammate' && alive && !(since && mtimeMs < since) ? 'idle' : 'done'
  if (tail.last === 'interrupted') return 'stopped'
  if (tail.last === 'error') return 'failed'
  if (meta.finished) return 'done'
  if (!alive || (since && mtimeMs < since)) return 'stopped'
  return 'running'
}

/** What a helper is, from its meta file: { kind, type, name, description, ... }. */
export function describe(id, meta = {}, workflow = null) {
  const kind = meta.taskKind === 'in_process_teammate' ? 'teammate' : workflow ? 'workflow' : meta.isFork || meta.agentType === 'fork' ? 'fork' : 'agent'
  // A teammate's agentType is its own name; the agent it runs as comes after.
  const type = kind === 'teammate' ? meta.customAgentType || meta.spawnedAgentType || '' : kind === 'agent' ? meta.agentType || '' : ''
  return {
    id,
    kind,
    type: String(type).slice(0, 80),
    name: String(meta.name ?? '').slice(0, 80),
    description: clip(String(meta.description ?? ''), 200),
    color: /^[a-z]{3,12}$/.test(meta.color ?? '') ? meta.color : '',
    model: meta.model && meta.model !== 'inherit' ? String(meta.model).slice(0, 60) : '',
    background: meta.requestShape === 'background',
    parent: typeof meta.parentAgentId === 'string' ? meta.parentAgentId : null,
    toolUseId: typeof meta.toolUseId === 'string' ? meta.toolUseId : null,
    workflow: workflow?.run ?? null,
    phase: String(meta.workflowPhase ?? '').slice(0, 80),
  }
}

// ---------------------------------------------------------------- the files, cached
const dirCache = new Map() // folder -> { mtimeMs, names }
const metaCache = new Map() // meta file -> { mtimeMs, meta }
const fileCache = new Map() // transcript -> { mtimeMs, size, head, tail }
const runCache = new Map() // workflow run file -> { mtimeMs, run }
const countCache = new Map() // transcript -> { size, offset, tools }

/** A folder's entries, read again only when the folder's time changes. */
function list(dir) {
  const st = statSync(dir, { throwIfNoEntry: false })
  if (!st?.isDirectory()) {
    dirCache.delete(dir)
    return []
  }
  const hit = dirCache.get(dir)
  if (hit && hit.mtimeMs === st.mtimeMs) return hit.names
  let names = []
  try {
    names = readdirSync(dir)
  } catch {}
  dirCache.set(dir, { mtimeMs: st.mtimeMs, names })
  return names
}

function readMeta(path) {
  const st = statSync(path, { throwIfNoEntry: false })
  if (!st) return {}
  const hit = metaCache.get(path)
  if (hit && hit.mtimeMs === st.mtimeMs) return hit.meta
  let meta = {}
  try {
    meta = JSON.parse(readFileSync(path, 'utf8')) ?? {}
  } catch {}
  metaCache.set(path, { mtimeMs: st.mtimeMs, meta })
  return meta
}

/** Head and tail of a helper's transcript, read again only when the file changed. */
function readTranscript(path) {
  const st = statSync(path, { throwIfNoEntry: false })
  if (!st) return null
  const hit = fileCache.get(path)
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit
  // The head does not change once the prompt is in it.
  let head = hit?.head?.prompt ? hit.head : null
  if (!head) {
    for (const bytes of [64 << 10, 1 << 20]) {
      head = headInfo(readHead(path, st.size, bytes))
      if (head.prompt || bytes >= st.size) break
    }
  }
  // Big tool results and request records can fill the end: widen the window until a message shows.
  let tail = null
  for (const bytes of [64 << 10, 1 << 20, 4 << 20]) {
    tail = tailInfo(readTail(path, st.size, bytes))
    if ((tail.last !== 'none' && tail.tokens != null) || bytes >= st.size) break
  }
  const entry = { mtimeMs: st.mtimeMs, size: st.size, head, tail }
  fileCache.set(path, entry)
  return entry
}

/** How many tool calls a transcript holds, counted on from where the last count stopped. */
export function countTools(path) {
  const st = statSync(path, { throwIfNoEntry: false })
  if (!st) return 0
  let c = countCache.get(path)
  if (!c || st.size < c.offset) c = { offset: 0, tools: 0, seen: new Set() }
  if (st.size > c.offset) {
    const text = readSlice(path, c.offset, st.size - c.offset)
    const end = text.lastIndexOf('\n') + 1
    for (const line of text.slice(0, end).split('\n')) {
      if (!line.includes('"tool_use"') || !line.includes('"type":"assistant"')) continue
      const o = parse(line)
      if (o?.type !== 'assistant' || !Array.isArray(o.message?.content)) continue
      for (const b of o.message.content) if (b?.type === 'tool_use' && !c.seen.has(b.id)) c.seen.add(b.id) && c.tools++
    }
    c.offset += Buffer.byteLength(text.slice(0, end))
  }
  countCache.set(path, c)
  return c.tools
}

/** A workflow run: its name and how it went, from the run file once it is over, else its script. */
function readRun(sessionDir, run) {
  const file = join(sessionDir, 'workflows', `${run}.json`)
  const st = statSync(file, { throwIfNoEntry: false })
  if (st) {
    const hit = runCache.get(file)
    if (hit && hit.mtimeMs === st.mtimeMs) return hit.run
    let d = {}
    try {
      d = JSON.parse(readFileSync(file, 'utf8')) ?? {}
    } catch {}
    const r = {
      over: true,
      name: String(d.workflowName ?? '').slice(0, 120),
      status: String(d.status ?? ''),
      summary: clip(String(d.summary ?? ''), 300),
      startedAt: Number(d.startTime) || null,
      durationMs: Number(d.durationMs) || null,
      tokens: Number(d.totalTokens) || null,
      tools: Number(d.totalToolCalls) || null,
      agents: Number(d.agentCount) || null,
      taskId: String(d.taskId ?? ''),
    }
    runCache.set(file, { mtimeMs: st.mtimeMs, run: r })
    return r
  }
  // Still running: the script's file is named <workflow name>-<run>.js.
  const script = list(join(sessionDir, 'workflows', 'scripts')).find(n => n.endsWith(`-${run}.js`))
  return { over: false, name: script ? script.slice(0, -(run.length + 4)) : '' }
}

/**
 * Every helper of the session whose transcript is `transcript`, newest first, and its workflow
 * runs: { helpers: [...], workflows: [...] }. `alive` and `since` say whether the session's
 * Claude process runs and since when (helperStatus).
 */
export function helpersOf(transcript, { alive = false, since = null } = {}) {
  if (!transcript?.endsWith('.jsonl')) return { helpers: [], workflows: [] }
  const sessionDir = transcript.slice(0, -'.jsonl'.length)
  const subagents = join(sessionDir, 'subagents')
  const helpers = []
  const add = (dir, name, workflow) => {
    const m = AGENT_FILE.exec(name)
    if (!m) return
    const path = join(dir, name)
    const file = readTranscript(path)
    if (!file) return
    const meta = readMeta(join(dir, `agent-${m[1]}.meta.json`))
    const h = describe(m[1], meta, workflow)
    const status = helperStatus({ meta, tail: file.tail, kind: h.kind, alive, since, mtimeMs: file.mtimeMs })
    helpers.push({
      ...h,
      status,
      startedAt: file.head.startedAt,
      endedAt: file.tail.endedAt ?? file.mtimeMs,
      activity: file.mtimeMs,
      prompt: file.head.prompt,
      from: file.head.from,
      now: status === 'running' ? file.tail.now : null,
      after: status === 'running' && !file.tail.now ? file.tail.after : '',
      tokens: file.tail.tokens,
      result: ['done', 'idle', 'failed'].includes(status) ? file.tail.result : '',
      path,
    })
  }
  const names = list(subagents)
  for (const name of names) add(subagents, name, null)
  const workflows = []
  if (names.includes('workflows')) {
    for (const run of list(join(subagents, 'workflows'))) {
      if (!RUN_DIR.test(run)) continue
      const dir = join(subagents, 'workflows', run)
      const before = helpers.length
      for (const name of list(dir)) add(dir, name, { run })
      const own = helpers.slice(before)
      const info = readRun(sessionDir, run)
      const journal = statSync(join(dir, 'journal.jsonl'), { throwIfNoEntry: false })
      const touched = Math.max(journal?.mtimeMs ?? 0, ...own.map(h => h.activity))
      const status = info.over
        ? info.status === 'completed' ? 'done' : info.status === 'failed' ? 'failed' : 'stopped'
        : alive && !(since && touched < since) ? 'running' : 'stopped'
      // An agent the run left running when it ended did not get further.
      if (status !== 'running') for (const h of own) if (h.status === 'running') h.status = 'stopped'
      workflows.push({
        id: run,
        name: info.name,
        status,
        summary: info.summary ?? '',
        startedAt: info.startedAt ?? Math.min(...own.map(h => h.startedAt ?? Infinity).filter(Number.isFinite), touched),
        endedAt: info.over && info.startedAt && info.durationMs ? info.startedAt + info.durationMs : touched,
        activity: touched,
        tokens: info.tokens ?? null,
        tools: info.tools ?? null,
        agents: info.agents ?? own.length,
        taskId: info.taskId ?? '',
      })
    }
  }
  helpers.sort((a, b) => (b.startedAt ?? b.activity) - (a.startedAt ?? a.activity))
  workflows.sort((a, b) => b.startedAt - a.startedAt)
  return { helpers, workflows }
}

/** What a card needs: how many run now, how many there are, the newest few that run. */
export function summarize({ helpers = [], workflows = [] } = {}) {
  const live = helpers.filter(h => h.status === 'running')
  const runs = workflows.filter(w => w.status === 'running')
  if (!helpers.length && !workflows.length) return null
  return {
    running: live.length,
    total: helpers.length,
    workflows: runs.length,
    live: live.slice(0, 4).map(h => ({ id: h.id, kind: h.kind, label: h.description || h.name || h.type, color: h.color })),
    // Moves whenever a running helper writes: the open sheet reads its helpers again then.
    at: Math.max(0, ...live.map(h => h.activity), ...runs.map(w => w.activity)),
  }
}

/** Helpers as the page gets them: no file paths. */
export const publicHelper = ({ path, ...h }) => h

/**
 * One helper of the session for its window: what it is and how it stands, how many tool calls it
 * made, and its conversation (the same turns as a session's, sidechain lines included). Null
 * when the session has no helper with that id: the id only picks one of the session's own files.
 */
export function helperDetail(transcript, id, opts) {
  const { helpers, workflows } = helpersOf(transcript, opts)
  const h = helpers.find(x => x.id === id)
  if (!h) return null
  return {
    helper: { ...publicHelper(h), tools: countTools(h.path), prompt: h.prompt },
    workflow: h.workflow ? (workflows.find(w => w.id === h.workflow) ?? null) : null,
    conversation: conversation(h.path, 80, { sidechain: true }),
  }
}

/** For tests: forget what was read. */
export function clearHelperCache() {
  for (const c of [dirCache, metaCache, fileCache, runCache, countCache]) c.clear()
}
