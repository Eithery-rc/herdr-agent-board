// What the page says about a session's helpers (src/helpers.mjs) and about the sessions it works
// with (src/links.mjs): titles, times, the order they are listed in, which session a name in the
// thread is. No DOM here, so the tests can read it.

/** A helper's title: what it was asked to do in a few words, else its name or type. */
export const helperTitle = h => h?.description || h?.name || h?.type || h?.id || ''

/** A stopwatch length: "12s", "4:05", "1:04:05". */
export function clock(ms) {
  const s = Math.max(0, Math.floor((ms ?? 0) / 1000))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const pad = n => String(n).padStart(2, '0')
  if (h) return `${h}:${pad(m)}:${pad(s % 60)}`
  return m ? `${m}:${pad(s % 60)}` : `${s}s`
}

/** Tokens short: 950, 23k, 1.2M. */
export function tokens(n) {
  if (n == null) return ''
  if (n < 1000) return String(n)
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`
  return `${(n / 1_000_000).toFixed(n < 10_000_000 ? 1 : 0)}M`
}

/** The mark's color for a status: run | ok | idle | fail | stop. */
export const toneOf = status => ({ running: 'run', done: 'ok', idle: 'idle', failed: 'fail' })[status] ?? 'stop'

/** How long it ran (or runs, up to `now`). */
export function took(h, now = Date.now()) {
  if (!h?.startedAt) return null
  const end = h.status === 'running' ? now : (h.endedAt ?? h.activity ?? h.startedAt)
  return Math.max(0, end - h.startedAt)
}

/**
 * The helpers in the order the list shows them: what runs now, the workflow runs with their
 * agents, the teammates, then everything that finished, newest first. A helper another helper
 * started goes under it.
 */
export function groupHelpers(helpers = [], workflows = []) {
  const byRun = new Map(workflows.map(w => [w.id, []]))
  const own = []
  for (const h of helpers) {
    if (h.workflow && byRun.has(h.workflow)) byRun.get(h.workflow).push(h)
    else own.push(h)
  }
  const recent = (a, b) => (b.startedAt ?? b.activity ?? 0) - (a.startedAt ?? a.activity ?? 0)
  // Children follow their parent, one level in.
  const ids = new Set(own.map(h => h.id))
  const kids = new Map()
  for (const h of own) if (h.parent && ids.has(h.parent)) kids.set(h.parent, [...(kids.get(h.parent) ?? []), h])
  const flat = list => list.sort(recent).flatMap(h => [{ ...h, depth: 0 }, ...(kids.get(h.id) ?? []).sort(recent).map(k => ({ ...k, depth: 1 }))])
  const top = own.filter(h => !(h.parent && ids.has(h.parent)))
  return {
    running: flat(top.filter(h => h.status === 'running' && h.kind !== 'teammate')),
    teammates: flat(top.filter(h => h.kind === 'teammate')),
    runs: workflows.map(w => ({ ...w, agents: byRun.get(w.id).sort(recent) })).sort((a, b) => (b.status === 'running') - (a.status === 'running') || (b.startedAt ?? 0) - (a.startedAt ?? 0)),
    finished: flat(top.filter(h => h.status !== 'running' && h.kind !== 'teammate')),
  }
}

/**
 * The helper a line of the thread is about: by its id, the call that made it, or its name (a
 * teammate's first, else the newest helper of that name).
 */
export function findHelper(helpers = [], ref = {}) {
  if (ref.id) {
    const h = helpers.find(x => x.id === ref.id)
    if (h) return h
  }
  if (ref.tool) {
    const h = helpers.find(x => x.toolUseId === ref.tool)
    if (h) return h
  }
  if (!ref.name) return null
  const named = helpers.filter(x => x.name === ref.name || x.id === ref.name).sort((a, b) => (b.kind === 'teammate') - (a.kind === 'teammate') || (b.startedAt ?? 0) - (a.startedAt ?? 0))
  return named[0] ?? null
}

const norm = s => String(s ?? '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')

/**
 * The session a name in the thread is (SendMessage's `to`, a message's sender, the name
 * spawn-agent gave): the one item that goes by it, else null. Never the session itself.
 */
export function sessionByName(items = [], name, self = null) {
  const n = norm(name)
  if (!n) return null
  const hits = items.filter(it => it.key !== self && !it.launchOnly && [it.name, it.autoName].some(v => v && norm(v) === n))
  return hits.length === 1 ? hits[0] : null
}

/** Every session an item is linked with: who started it, whom it started, whom it wrote with. */
export function relatedKeys(it) {
  const l = it?.links
  if (!l) return new Set()
  return new Set([l.from?.key, ...(l.started ?? []).map(x => x.key), ...(l.talks ?? []).map(x => x.key)].filter(Boolean))
}

/**
 * The card's short count: the helpers at work (a workflow's agents among them), or the workflows
 * that run between two of their agents; 0 when nothing works.
 */
export const liveCount = it => it?.helpers?.running || it?.helpers?.workflows || 0
