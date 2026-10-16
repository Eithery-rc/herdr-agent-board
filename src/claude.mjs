// What Claude Code itself records, read without spending a token: the registry of running
// sessions (~/.claude/sessions/<pid>.json: name, sessionId, status) and the tail of each
// transcript, where Claude keeps the session's ai-title and the user's last prompt.
import { closeSync, openSync, readSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { onLanguage, t } from './lang.mjs'
import { isNotice, reminderNotice, taskNotice } from './notices.mjs'
import { CLAUDE_DIR } from './paths.mjs'
import { questionsOf } from './questions.mjs'

function alive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return err.code === 'EPERM'
  }
}

/** Running interactive sessions by session id. */
export function liveSessions(dir = join(CLAUDE_DIR, 'sessions')) {
  const byId = new Map()
  let files = []
  try {
    files = readdirSync(dir)
  } catch {
    return byId
  }
  for (const file of files) {
    if (!file.endsWith('.json')) continue
    try {
      const s = JSON.parse(readFileSync(join(dir, file), 'utf8'))
      if (s.sessionId && s.kind === 'interactive' && alive(s.pid)) byId.set(s.sessionId, s)
    } catch {}
  }
  return byId
}

const pathCache = new Map() // session id -> transcript path
const missCache = new Map() // session id -> when a full search found nothing (retried after a minute)

/** The transcript of a session: projects/<cwd with non-alphanumerics as dashes>/<id>.jsonl. */
export function transcriptPath(sessionId, cwd, projects = join(CLAUDE_DIR, 'projects')) {
  const cached = pathCache.get(sessionId)
  if (cached && statSync(cached, { throwIfNoEntry: false })) return cached
  let found = null
  if (cwd) {
    const guess = join(projects, cwd.replace(/[\\/]+$/, '').replace(/[^a-zA-Z0-9]/g, '-'), `${sessionId}.jsonl`)
    if (statSync(guess, { throwIfNoEntry: false })) found = guess
  }
  if (!found && Date.now() - (missCache.get(sessionId) ?? 0) > 60_000) {
    missCache.set(sessionId, Date.now())
    try {
      for (const entry of readdirSync(projects, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue
        const p = join(projects, entry.name, `${sessionId}.jsonl`)
        if (statSync(p, { throwIfNoEntry: false })) {
          found = p
          break
        }
      }
    } catch {}
  }
  if (found) pathCache.set(sessionId, found)
  return found
}

function readTail(path, size, bytes) {
  const start = Math.max(0, size - bytes)
  const buf = Buffer.alloc(size - start)
  const fd = openSync(path, 'r')
  try {
    readSync(fd, buf, 0, buf.length, start)
  } finally {
    closeSync(fd)
  }
  const text = buf.toString('utf8')
  return start ? text.slice(text.indexOf('\n') + 1) : text
}

/** Clean a prompt for one line on a card: no tags, no Telegram envelope, no line breaks. */
export function cleanPrompt(text) {
  return String(text ?? '')
    .replace(/^\[telegram[^\]]*\]\s*/i, '')
    .replace(/^[❯>]\s*/, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}


const firstLine = s => String(s ?? '').split('\n').find(l => l.trim())?.trim() ?? ''
const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

/** "Bash", "slack · read_channel", "Gmail · search_threads" for a tool name. */
export function toolLabel(name) {
  const m = /^mcp__(.+?)__(.+)$/.exec(name ?? '')
  if (!m) return name ?? ''
  const server = m[1].replace(/^plugin_[^_]+_/, '').replace(/^claude_ai_/, '')
  const tool = m[2].toLowerCase().startsWith(`${server.toLowerCase()}_`) ? m[2].slice(server.length + 1) : m[2]
  return `${server} · ${tool}`
}

/** The few words that say what a tool call is about: a Bash description, a file name, a query. */
/** The file a tool call worked on, in full, for the thread to open; '' for other tools. */
export function toolPath(name, input) {
  if (!input || typeof input !== 'object') return ''
  return ['Read', 'Edit', 'Write', 'NotebookEdit'].includes(name) ? String(input.file_path || input.notebook_path || '') : ''
}

export function toolDetail(name, input) {
  if (!input || typeof input !== 'object') return ''
  const base = p => String(p ?? '').split(/[\\/]/).pop()
  switch (name) {
    case 'Bash':
    case 'PowerShell':
      return clip(input.description || firstLine(input.command), 160)
    case 'Read':
    case 'Edit':
    case 'Write':
    case 'NotebookEdit':
      return base(input.file_path || input.notebook_path)
    case 'Grep':
    case 'Glob':
      return clip(String(input.pattern ?? ''), 120)
    case 'WebFetch':
      try {
        return new URL(input.url).host
      } catch {
        return ''
      }
    case 'Agent':
    case 'Task':
      return input.description ?? ''
    case 'AskUserQuestion':
      return input.questions?.[0]?.question ?? ''
    case 'SendMessage':
      return !input.to ? '' : /^uds:|pipe/i.test(input.to) ? t('tool.peer') : `→ ${input.to}`
    case 'Skill':
      return input.skill ?? ''
  }
  for (const k of ['description', 'query', 'question', 'subject', 'text', 'title', 'url', 'name', 'path']) {
    if (typeof input[k] === 'string' && input[k].trim()) return clip(firstLine(input[k]), 160)
  }
  const any = Object.values(input).find(v => typeof v === 'string' && v.trim() && v.length < 300)
  return any ? clip(firstLine(any), 160) : ''
}

/** Text the user typed, without the envelopes Claude Code and the hooks wrap around it. */
function userText(content) {
  const raw = typeof content === 'string' ? content : Array.isArray(content) ? content.filter(b => b.type === 'text').map(b => b.text).join('\n') : ''
  return raw
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
    .replace(/<(local-command-stdout|local-command-stderr|command-message|command-args)>[\s\S]*?<\/\1>/g, '')
    .replace(/<command-name>([\s\S]*?)<\/command-name>/g, '$1')
    .replace(/^\[telegram[^\]]*\]\s*/i, '')
    .trim()
}

/**
 * What a block of the session's message says to the user, as its terminal shows it: the text,
 * and the short updates Claude Code keeps in thinking blocks when the entry has thinkingDisplay
 * "updates" (since 2.1.296), printed in the terminal like any message. Other thinking stays hidden.
 */
export function saidIn(entry, block) {
  if (block?.type === 'text') return block.text?.trim() ?? ''
  if (block?.type === 'thinking' && entry?.thinkingDisplay === 'updates') return block.thinking?.trim() ?? ''
  return ''
}

const tailCache = new Map() // path -> { mtimeMs, size, info }
onLanguage(() => tailCache.clear()) // tool details are in the board's language

/**
 * What the end of a transcript says, cached until the file changes:
 *   title     Claude's own title of the session (ai-title)
 *   prompt    the user's last prompt
 *   lastText  the agent's last words to the user
 *   tool      the last tool call: { id, name, label, detail, pending, questions }; pending = no
 *             result yet, questions = an AskUserQuestion call's questions (questions.mjs)
 */
export function transcriptInfo(path) {
  if (!path) return null
  const st = statSync(path, { throwIfNoEntry: false })
  if (!st) return null
  const cached = tailCache.get(path)
  if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) return cached.info
  // question: the agent's last words end in a question; replied: the user wrote after them.
  const info = { title: '', prompt: '', lastText: '', question: '', replied: false, tool: null, activity: st.mtimeMs }
  const done = () => info.title && info.prompt && info.lastText && info.tool
  // Big tool results can push everything far back: widen the window once.
  for (const bytes of [256 << 10, 2 << 20]) {
    const lines = readTail(path, st.size, bytes).split('\n')
    const results = new Set() // tool_use ids that already have a result (seen later in the file)
    for (let i = lines.length - 1; i >= 0 && !done(); i--) {
      const line = lines[i]
      if (!line) continue
      if (line.includes('"type":"ai-title"')) {
        if (!info.title) info.title = parse(line)?.aiTitle ?? ''
        continue
      }
      if (line.includes('"type":"last-prompt"')) {
        if (!info.prompt) info.prompt = cleanPrompt(parse(line)?.lastPrompt)
        continue
      }
      if (!line.includes('"type":"user"') && !line.includes('"type":"assistant"')) continue
      const o = parse(line)
      const content = o?.message?.content
      if (!o || o.isSidechain) continue
      if (o.type === 'user') {
        if (Array.isArray(content)) for (const b of content) if (b.type === 'tool_result') results.add(b.tool_use_id)
        // A reminder the board typed in (scheduler.mjs) or a background task reporting back is not the user answering.
        if (!info.lastText && !o.isMeta && o.origin?.kind !== 'task-notification' && userText(content) && !isNotice(userText(content))) info.replied = true
        continue
      }
      if (o.type !== 'assistant' || !Array.isArray(content)) continue
      // How full the context is: what the last real request carried, cached parts included.
      const u = o.message?.usage
      if (info.context == null && u && o.message.model !== '<synthetic>') {
        const tokens = (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0)
        if (tokens) info.context = tokens
      }
      for (let j = content.length - 1; j >= 0; j--) {
        const b = content[j]
        if (b.type === 'tool_use' && !info.tool) {
          info.tool = { id: b.id, name: b.name, label: toolLabel(b.name), detail: toolDetail(b.name, b.input), pending: !results.has(b.id) }
          // The form only while it waits for an answer: every board refresh carries it to the page.
          if (b.name === 'AskUserQuestion' && info.tool.pending) info.tool.questions = questionsOf(b.input)
        } else if (!info.lastText && saidIn(o, b)) {
          info.lastText = clip(saidIn(o, b), 700)
          info.question = trailingQuestion(saidIn(o, b))
        }
      }
    }
    if (done() || bytes >= st.size) break
  }
  tailCache.set(path, { mtimeMs: st.mtimeMs, size: st.size, info })
  return info
}

/**
 * The question a message ends with, or '' when it does not end with one: its last sentence or
 * two, without markdown. Code blocks and trailing markup ( **, `, quotes, brackets) are ignored.
 */
export function trailingQuestion(text) {
  const t = String(text ?? '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/[\s*_`)\]»"'”]+$/u, '')
  if (!t.endsWith('?')) return ''
  const para = t.split(/\n\s*\n/).pop()
  const sentences = para
    .replace(/[*_`#>]+/g, '')
    .split(/(?<=[.!?…:])\s+/)
    .map(s => s.replace(/^\s*(?:[-•]|\d+\.)\s+/, '').trim())
    .filter(Boolean)
  let q = sentences.pop() ?? ''
  const before = sentences.pop()
  if (before && before.length + q.length < 200) q = `${before} ${q}`
  return clip(q.replace(/\s+/g, ' ').trim(), 300)
}

function parse(line) {
  try {
    return JSON.parse(line)
  } catch {
    return null
  }
}

/**
 * The last `limit` turns of a session for the detail view: the user's prompts, the agent's
 * texts and its tool calls in a line each (done = the call has a result). A question form
 * (AskUserQuestion) carries its questions and, once done, the answers: { ask, answers }, answers
 * null when it was closed without one. Background tasks reporting back and board reminders come
 * as { role: 'notice', ...taskNotice() or reminderNotice() } (notices.mjs). A call that works
 * with others carries what it is about, for a line of its own: `helper` (Agent: a subagent or a
 * fork, `id` once it started), `workflow`, `send` (SendMessage), `spawn` (spawn-agent started a
 * session). Another session's or a teammate's message is { role: 'peer', from, text }.
 * `sidechain` reads a helper's own transcript (helpers.mjs), whose lines are all sidechain lines.
 */
export function conversation(path, limit = 40, { sidechain = false } = {}) {
  const st = path && statSync(path, { throwIfNoEntry: false })
  if (!st) return []
  // Screenshots and big tool results can fill megabytes: read further back when the window held few turns.
  let items = []
  for (const bytes of [2 << 20, 8 << 20]) {
    items = turns(readTail(path, st.size, bytes), { sidechain })
    if (items.filter(i => i.role !== 'tool').length >= limit / 3 || bytes >= st.size) break
  }
  return items.slice(-limit)
}

const attr = (attrs, name) => new RegExp(`\\b${name}="([^"]*)"`).exec(attrs)?.[1] ?? ''

/**
 * What a helper was asked to do, from a user line of its transcript, without the frames Claude
 * Code puts around it: a fork's boilerplate (its directive follows), a workflow harness header,
 * a teammate message's tag. { prompt, from } (from: the teammate who asked), or null for the
 * harness's relay of the user's own request, which the helper only reads.
 */
export function promptOf(text) {
  const t = String(text ?? '')
  const fork = /<\/fork-boilerplate>\s*([\s\S]*)$/.exec(t)
  if (fork) return { prompt: fork[1].replace(/^Your directive:\s*/, '').trim(), from: '' }
  const mate = /<teammate-message\b([^>]*)>\s*([\s\S]*?)\s*(?:<\/teammate-message>|$)/.exec(t)
  if (mate) return { prompt: mate[2], from: attr(mate[1], 'teammate_id') }
  if (/^\[Workflow harness — user request\]/.test(t)) return null
  const wf = /^\[Workflow harness[^\]]*\][^\n]*\n([\s\S]*)$/.exec(t)
  if (wf) return { prompt: wf[1].replace(/^ {2}/gm, '').trim(), from: '' }
  return { prompt: t.trim(), from: '' }
}

/** Messages from teammates in a user line: [{ from, summary, text }]. */
export function teammateMessages(text) {
  return [...String(text ?? '').matchAll(/<teammate-message\b([^>]*)>\s*([\s\S]*?)\s*<\/teammate-message>/g)].map(m => ({
    from: attr(m[1], 'teammate_id'),
    summary: clip(attr(m[1], 'summary'), 200),
    text: clip(m[2], 4000),
    team: true,
  }))
}

/** Another session's message, from the origin Claude Code records with it. */
function peerOf(origin, text) {
  const tag = /<cross-session-message\b([^>]*)>\s*([\s\S]*?)\s*(?:<\/cross-session-message>|$)/.exec(String(text ?? ''))
  const body = typeof origin?.body === 'string' ? origin.body : (tag?.[2] ?? '')
  const from = String(origin?.name || attr(tag?.[1] ?? '', 'from-name') || '')
  if (!body.trim() && !from) return null
  return { from: from.slice(0, 120), pipe: String(origin?.from ?? ''), text: clip(body.trim(), 4000), id: String(origin?.msg_id ?? '') }
}

/**
 * A Bash or PowerShell call that starts a session with spawn-agent: { name } as it gave -Name
 * ('' when that is a variable). Null for anything else, a spawn-agent without -Name included.
 */
export function spawnOf(tool, input) {
  if (tool !== 'Bash' && tool !== 'PowerShell') return null
  const cmd = String(input?.command ?? '')
  if (!/(?:^|[\s;&|(=])spawn-agent(?:\.ps1)?\s/.test(cmd)) return null
  const m = /\s-Name\s+(?:"([^"]+)"|'([^']+)'|([^\s"';|&)]+))/.exec(cmd)
  if (!m) return null
  const name = (m[1] ?? m[2] ?? m[3]).trim()
  return { name: name.startsWith('$') ? '' : name.slice(0, 120) }
}

/** What spawn-agent printed for the session it started: "pane=<id> name=<name> agent=<id>". */
export function spawnResult(text) {
  const m = /\bpane=([\w:.-]+)\s+name=(.+?)\s+agent=\S+/.exec(String(text ?? ''))
  return m ? { pane: m[1], name: m[2].trim().slice(0, 120) } : null
}

/** A Workflow call's name: its script's meta name, or the saved workflow it ran. */
function workflowName(input) {
  const m = /\bname\s*:\s*(['"`])([^'"`\n]{1,120})\1/.exec(String(input?.script ?? ''))
  return m ? m[2] : String(input?.name ?? '').slice(0, 120)
}

/** What a call that works with others is about, for a line of its own in the thread. */
function linkOf(b) {
  const input = b.input ?? {}
  if (b.name === 'Agent' || b.name === 'Task') {
    const type = String(input.subagent_type ?? '')
    return { helper: { kind: type === 'fork' ? 'fork' : 'agent', type: type === 'fork' ? '' : type.slice(0, 80), name: String(input.name ?? '').slice(0, 80), background: !!input.run_in_background, id: '' } }
  }
  if (b.name === 'Workflow') return { workflow: { name: workflowName(input), run: '' } }
  if (b.name === 'SendMessage' && typeof input.to === 'string') {
    // The [ref] a listing adds to a name is not part of it.
    const to = input.to.replace(/\s*\[[^\]]*\]\s*$/, '').trim().slice(0, 300)
    return { send: { to, summary: clip(String(input.summary ?? ''), 200), text: typeof input.message === 'string' ? clip(input.message, 4000) : '' } }
  }
  const spawn = spawnOf(b.name, input)
  return spawn ? { spawn: { ...spawn, pane: '' } } : null
}

/** A result fills in what the call could not know: the helper's id, the run, the new session. */
function linkResult(tool, block, result) {
  const text = typeof block.content === 'string' ? block.content : Array.isArray(block.content) ? block.content.map(c => c?.text ?? '').join('\n') : ''
  if (tool.helper) tool.helper.id = String(result?.agentId ?? /\bagentId:\s*([A-Za-z0-9-]+)/.exec(text)?.[1] ?? '')
  if (tool.workflow) tool.workflow.run = String(result?.runId ?? /[\\/](wf_[A-Za-z0-9-]+)/.exec(text)?.[1] ?? '')
  if (tool.spawn) {
    const r = !block.is_error && spawnResult(typeof result?.stdout === 'string' ? result.stdout : text)
    if (r) Object.assign(tool.spawn, r)
    else tool.spawn.failed = true
  }
}

/** The answers Claude Code recorded for a question form, in the order of its questions. */
function askAnswers(ask, result) {
  const answers = result?.answers
  if (!answers || typeof answers !== 'object') return null
  // Keyed by the full question text, which questionsOf keeps whole.
  return ask.map(q => (typeof answers[q.question] === 'string' ? clip(answers[q.question], 2000) : ''))
}

function turns(text, { sidechain = false } = {}) {
  const items = []
  const tools = new Map() // tool_use id -> item
  // Another session's message can be queued into a turn and come again as a line of its own.
  const peers = new Set()
  const peer = (p, at) => {
    const key = p.id || JSON.stringify([p.from, p.text])
    if (peers.has(key)) return
    peers.add(key)
    items.push({ role: 'peer', ...p, at })
  }
  // A background task reporting back or a board reminder: a line of its own (notices.mjs). One
  // can be queued into a running turn and then sent again as a turn of its own: shown once. A
  // task id alone is not enough, a monitor or a resumed agent reports again under the same one.
  const shown = new Set()
  const keys = new WeakMap() // notice item -> its key
  const notice = (n, at) => {
    const key = JSON.stringify([n.kind, n.id, n.status, n.name, n.summary, n.detail, n.from, n.note])
    // With an id the copy can come later in the turn; a reminder (no id) only right after itself,
    // since the same reminder text can come every hour.
    if (n.id ? shown.has(key) : keys.get(items.at(-1)) === key) return
    shown.add(key)
    const item = { role: 'notice', ...n, at }
    keys.set(item, key)
    items.push(item)
  }
  for (const line of text.split('\n')) {
    if (!line || !(line.includes('"type":"user"') || line.includes('"type":"assistant"') || line.includes('"type":"queued_command"'))) continue
    const o = parse(line)
    if (!o || (o.isSidechain && !sidechain) || o.isMeta || o.isCompactSummary) continue
    const content = o.message?.content
    const at = Date.parse(o.timestamp) || 0
    // A prompt sent while the session worked goes into the running turn, and the transcript
    // keeps it as a queued command, not a user line. Other sessions' messages and task
    // notifications arrive the same way.
    if (o.type === 'attachment') {
      const a = o.attachment
      if (a?.type !== 'queued_command') continue
      const when = Date.parse(a.timestamp) || at
      if (a.origin?.kind === 'peer') {
        const p = peerOf(a.origin, a.prompt)
        if (p) peer(p, when)
        continue
      }
      const task = a.commandMode === 'task-notification' ? taskNotice(a.prompt) : null
      if (task) notice(task, when)
      const text = a.commandMode === 'prompt' && a.origin?.kind !== 'peer' ? userText(a.prompt) : ''
      const reminder = reminderNotice(text)
      if (reminder) notice(reminder, when)
      else if (text && !(items.at(-1)?.role === 'user' && items.at(-1).text === clip(text, 3000))) items.push({ role: 'user', text: clip(text, 3000), at: when })
      continue
    }
    if (o.type === 'user') {
      if (Array.isArray(content)) {
        for (const b of content) {
          if (b.type !== 'tool_result' || !tools.has(b.tool_use_id)) continue
          const tool = tools.get(b.tool_use_id)
          tool.done = true
          if (tool.ask) tool.answers = askAnswers(tool.ask, o.toolUseResult)
          linkResult(tool, b, o.toolUseResult)
        }
        if (content.every(b => b.type === 'tool_result')) continue
      }
      if (o.origin?.kind === 'peer') {
        const p = peerOf(o.origin, userText(content))
        if (p) peer(p, at)
        continue
      }
      let text = userText(content)
      const mates = teammateMessages(text)
      if (mates.length) {
        for (const m of mates) peer(m, at)
        continue
      }
      if (sidechain) {
        // A fork's transcript starts with its parent's call that made it: its own work begins
        // with its directive.
        if (text.includes('<fork-boilerplate>')) items.length = 0
        const p = promptOf(text)
        if (!p) continue
        text = p.prompt
      }
      const n = taskNotice(text) ?? reminderNotice(text)
      if (n) notice(n, at)
      else if (text) items.push({ role: 'user', text: clip(text, 3000), at })
    } else if (Array.isArray(content)) {
      for (const b of content) {
        const said = saidIn(o, b)
        if (said) items.push({ role: 'assistant', text: clip(said, 4000), at })
        else if (b.type === 'tool_use') {
          const t = { role: 'tool', label: toolLabel(b.name), detail: toolDetail(b.name, b.input), path: toolPath(b.name, b.input), done: false, at }
          const ask = b.name === 'AskUserQuestion' ? questionsOf(b.input) : null
          if (ask) Object.assign(t, { id: b.id, ask: ask.map(({ question, header, multiSelect }) => ({ question, header, multiSelect })), answers: null })
          const link = linkOf(b)
          if (link) Object.assign(t, { id: b.id }, link)
          tools.set(b.id, t)
          items.push(t)
        }
      }
    }
  }
  return items
}
