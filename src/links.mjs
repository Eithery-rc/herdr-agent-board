// Who works with whom among the board's sessions, from what their transcripts recorded:
//   spawn      the session ran spawn-agent, which printed "pane=<id> name=<name>" for the
//              session it started
//   sent       it called SendMessage with another session's name
//   received   another session's message came in (Claude Code records the sender's name and
//              its message pipe with it)
// A transcript only grows, so each one is read once, in the background, and from then on only
// from where the last read stopped. Only the lines with one of a few markers are parsed. Nothing
// here writes.
import { open, stat } from 'node:fs/promises'
import { spawnOf, spawnResult } from './claude.mjs'

const MARKERS = ['spawn-agent', '"SendMessage"', '"kind":"peer"', 'pane='].map(m => Buffer.from(m))
const CHUNK = 4 << 20
const MAX_LINE = 64 << 20 // a line longer than this (a pasted screenshot) is skipped, not held
const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)
const firstLine = s => String(s ?? '').split('\n').find(l => l.trim())?.trim() ?? ''

function parse(line) {
  try {
    return JSON.parse(line)
  } catch {
    return null
  }
}

/**
 * The events in one transcript line: [{ kind: 'spawn', name, pane, at } | { kind: 'sent', to,
 * summary, at } | { kind: 'received', name, pipe, id, text, at }]. `state` carries what a later
 * line completes (a spawn-agent call waits for its output) and what was seen already (a call is
 * recorded twice when a request is logged with it).
 */
export function lineEvents(line, state) {
  const o = parse(line)
  if (!o || o.isSidechain || !['user', 'assistant', 'attachment'].includes(o.type)) return []
  const at = Date.parse(o.timestamp) || 0
  const out = []
  if (o.type === 'attachment') {
    const a = o.attachment
    if (a?.type === 'queued_command' && a.origin?.kind === 'peer') out.push(received(a.origin, Date.parse(a.timestamp) || at, state))
    return out.filter(Boolean)
  }
  if (o.type === 'user' && o.origin?.kind === 'peer') return [received(o.origin, at, state)].filter(Boolean)
  const content = Array.isArray(o.message?.content) ? o.message.content : []
  for (const b of content) {
    if (o.type === 'assistant' && b?.type === 'tool_use') {
      if (state.seen.has(b.id)) continue
      state.seen.add(b.id)
      if (b.name === 'SendMessage' && typeof b.input?.to === 'string' && typeof b.input?.message === 'string') {
        const to = b.input.to.replace(/\s*\[[^\]]*\]\s*$/, '').trim().slice(0, 300)
        // A reply to the pipe a message came from: the sender's name, for when that pipe is gone.
        out.push({ kind: 'sent', to, name: state.pipes.get(to) ?? '', summary: clip(String(b.input.summary ?? firstLine(b.input.message)), 200), at })
        continue
      }
      const spawn = spawnOf(b.name, b.input)
      if (spawn) state.pending.set(b.id, { ...spawn, at })
    } else if (o.type === 'user' && b?.type === 'tool_result' && state.pending.has(b.tool_use_id)) {
      const call = state.pending.get(b.tool_use_id)
      state.pending.delete(b.tool_use_id)
      const text = typeof b.content === 'string' ? b.content : Array.isArray(b.content) ? b.content.map(c => c?.text ?? '').join('\n') : ''
      const r = !b.is_error && spawnResult(text)
      if (r) out.push({ kind: 'spawn', name: r.name || call.name, pane: r.pane, at: call.at })
    }
  }
  return out
}

function received(origin, at, state) {
  const id = String(origin.msg_id ?? '')
  if (id && state.seen.has(id)) return null
  if (id) state.seen.add(id)
  const name = String(origin.name ?? '').slice(0, 120)
  const pipe = String(origin.from ?? '').slice(0, 300)
  if (!name && !pipe) return null
  if (pipe && name) state.pipes.set(pipe, name)
  return { kind: 'received', name, pipe, id, text: clip(firstLine(origin.body), 200), at }
}

/** Where the lines that hold a marker start, up to `last`, in order. */
function markedLines(buf, last) {
  const starts = new Set()
  for (const m of MARKERS) {
    for (let i = buf.indexOf(m); i >= 0 && i < last; i = buf.indexOf(m, i)) {
      starts.add(buf.lastIndexOf(10, i) + 1)
      i = buf.indexOf(10, i) + 1 // on from the next line: one hit is enough for a line
      if (!i) break
    }
  }
  return [...starts].sort((a, b) => a - b)
}

/**
 * The transcripts' events, kept up to date: `update(paths)` reads what each one gained since,
 * one file at a time in the background, and calls onChange() when new events came in.
 */
export function createLinks({ onChange = () => {} } = {}) {
  const files = new Map() // path -> { offset, events, state }
  const queue = []
  let running = false

  async function read(path) {
    const f = files.get(path) ?? { offset: 0, events: [], state: { pending: new Map(), seen: new Set(), pipes: new Map() } }
    files.set(path, f)
    const st = await stat(path).catch(() => null)
    if (!st) return false
    // Rewritten from the start (it never is, but a smaller file cannot be read on from the old place).
    if (st.size < f.offset) Object.assign(f, { offset: 0, events: [], state: { pending: new Map(), seen: new Set(), pipes: new Map() } })
    if (st.size === f.offset) return false
    const before = f.events.length
    const fh = await open(path, 'r')
    try {
      let carry = Buffer.alloc(0)
      let pos = f.offset
      while (pos < st.size) {
        const want = Math.min(CHUNK, st.size - pos)
        const chunk = Buffer.alloc(want)
        const { bytesRead } = await fh.read(chunk, 0, want, pos)
        if (!bytesRead) break
        pos += bytesRead
        const buf = carry.length ? Buffer.concat([carry, chunk.subarray(0, bytesRead)]) : chunk.subarray(0, bytesRead)
        const last = buf.lastIndexOf(10) // '\n'
        if (last < 0) {
          carry = buf.length > MAX_LINE ? Buffer.alloc(0) : buf
          continue
        }
        for (const start of markedLines(buf, last)) f.events.push(...lineEvents(buf.toString('utf8', start, buf.indexOf(10, start)), f.state))
        carry = Buffer.from(buf.subarray(last + 1))
      }
      // A line still being written is read again next time, whole.
      f.offset = pos - carry.length
    } finally {
      await fh.close()
    }
    return f.events.length > before
  }

  async function drain() {
    if (running) return
    running = true
    let changed = false
    try {
      while (queue.length) {
        const path = queue.shift()
        try {
          if (await read(path)) changed = true
        } catch {}
      }
    } finally {
      running = false
    }
    if (changed) onChange()
  }

  return {
    /** Read on in these transcripts (the most active first, as the board lists them). */
    update(paths) {
      for (const p of paths) if (p && !queue.includes(p)) queue.push(p)
      drain()
    },
    /** The events read so far from a transcript. */
    events: path => files.get(path)?.events ?? [],
    /** Whether every transcript asked for was read to its end. */
    idle: () => !running && !queue.length,
  }
}

const norm = s => String(s ?? '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')

/**
 * The links between the board's items, from each one's events (`eventsOf(item)`): by key,
 * { from: { key, name, at } | null, started: [{ key, name, at }], talks: [{ key, name, in, out,
 * at }] }. A started session is matched by its pane and the name spawn-agent gave it (a pane id
 * is used again once its tab is gone); a message's other end by its pipe while that session
 * runs, else by its name when exactly one session on the board has it.
 */
export function relate(items, eventsOf) {
  const names = it => new Set([it.name, it.autoName].filter(Boolean).map(norm))
  const byName = new Map()
  for (const it of items) for (const n of names(it)) byName.set(n, [...(byName.get(n) ?? []), it])
  const byPipe = new Map(items.filter(it => it.pipe).map(it => [it.pipe.replace(/^uds:/, ''), it]))
  const one = (name, self) => {
    const list = (byName.get(norm(name)) ?? []).filter(it => it.key !== self.key)
    return list.length === 1 ? list[0] : null
  }
  const out = new Map(items.map(it => [it.key, { from: null, started: [], talks: [] }]))
  const talk = (a, b, dir, at) => {
    const links = out.get(a.key)
    let t = links.talks.find(x => x.key === b.key)
    if (!t) links.talks.push((t = { key: b.key, name: b.name, in: 0, out: 0, at: 0 }))
    t[dir]++
    t.at = Math.max(t.at, at)
  }
  for (const a of items) {
    for (const ev of eventsOf(a) ?? []) {
      if (ev.kind === 'spawn') {
        const b = items.find(it => it.key !== a.key && it.pane && it.pane === ev.pane && names(it).has(norm(ev.name)))
        if (!b) continue
        const mine = out.get(a.key).started
        const prev = mine.find(x => x.key === b.key)
        if (prev) prev.at = Math.max(prev.at, ev.at)
        else mine.push({ key: b.key, name: b.name, at: ev.at })
        const theirs = out.get(b.key)
        // Started again in the same pane under the same name: the latest start counts.
        if (!theirs.from || theirs.from.at <= ev.at) theirs.from = { key: a.key, name: a.name, at: ev.at }
      } else if (ev.kind === 'sent') {
        // A reply goes to the pipe the message came from.
        const b = ev.to.startsWith('uds:') ? (byPipe.get(ev.to.slice(4)) ?? one(ev.name, a)) : one(ev.to, a)
        if (b && b.key !== a.key) talk(a, b, 'out', ev.at)
      } else if (ev.kind === 'received') {
        const b = byPipe.get(ev.pipe.replace(/^uds:/, '')) ?? one(ev.name, a)
        if (b && b.key !== a.key) talk(a, b, 'in', ev.at)
      }
    }
  }
  for (const links of out.values()) {
    links.started.sort((x, y) => y.at - x.at)
    links.talks.sort((x, y) => y.at - x.at)
    links.talks = links.talks.slice(0, 8)
  }
  return out
}
