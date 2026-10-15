// The board's data: every agent pane in herdr plus the sessions herdr-wake put to sleep, each
// merged with its card and with what Claude recorded about it, and sorted into a column.
import { categoryFor } from './config.mjs'
import { liveSessions, transcriptInfo, transcriptPath } from './claude.mjs'
import { snapshot } from './herdr.mjs'
import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { t } from './lang.mjs'
import { CONTEXT_DIR } from './paths.mjs'
import { allCards, writeCard } from './store.mjs'

// Titles read in the board's language at the moment they are used.
const column = (id, icon, color) => ({ id, icon, color, get title() { return t(`col.${id}`) } })
export const COLUMNS = [
  column('work', '▶', 'green'),
  column('me', '!', 'red'),
  column('ext', '◷', 'yellow'),
  column('done', '✓', 'cyan'),
  column('idle', '·', 'gray'),
]

/** herdr's agent status in words: "working", "asleep". */
export function statusText(status) {
  const key = `status.${status}`
  const text = t(key)
  return text === key ? status : text
}

let sleepCache = { at: 0, list: [] }

/** Sessions herdr-wake put to sleep; empty when the router is not running. Cached for 5 s. */
async function sleepers(url) {
  if (!url) return []
  if (Date.now() - sleepCache.at < 5000) return sleepCache.list
  let list = []
  try {
    const res = await fetch(`${url}/sleeping`, { signal: AbortSignal.timeout(2000) })
    if (res.ok) list = await res.json()
  } catch {}
  sleepCache = { at: Date.now(), list: Array.isArray(list) ? list : [] }
  return sleepCache.list
}

/** After the board put a session to sleep or woke it: read herdr-wake again on the next refresh. */
export function forgetSleepers() {
  sleepCache.at = 0
}

/** Columns the user can drag a card to. "Working" is herdr's to say. */
export const PINS = new Set(['me', 'ext', 'done', 'idle'])
/** A turn is on: the session works, or a dialog in it waits in the middle of the work. */
export const busy = status => status === 'working' || status === 'blocked'

/**
 * Why a session needs the user, or '':
 *   decision  a dialog in the terminal holds it (permission, a question form): herdr says blocked
 *   ask       the agent said so with `board ask` (cleared when the user replies)
 *   question  it ended its turn with a question nobody answered yet (unless the user waved that
 *             exact question off on the board: card.dismissed)
 *   later     the user dragged it to "Needs me" to look at it later (card.pin)
 * A card the user dragged elsewhere (card.pin) shows no question until the pin goes.
 */
export function attentionOf(status, card, info) {
  if (status === 'working') return ''
  if (status === 'blocked') return 'decision'
  const own = card?.ask ? 'ask' : !card?.wait && info?.question && !info.replied && card?.dismissed !== info.question ? 'question' : ''
  if (PINS.has(card?.pin)) return card.pin === 'me' ? own || 'later' : ''
  return own
}

export function columnOf(status, card, info) {
  if (status === 'working') return 'work'
  if (attentionOf(status, card, info)) return 'me'
  if (PINS.has(card?.pin)) return card.pin
  if (card?.wait) return 'ext'
  if (status === 'done') return 'done'
  return 'idle'
}

/**
 * The column the user dragged the card to, or ''. It holds until the session works again (the
 * user or another session wrote to it); a card dragged during a turn (card.pinBusy) lands there
 * once that turn is over. Spent pins are taken off the card file here; a write that fails (its
 * card is locked) is tried again on the next refresh instead of failing this one.
 */
function pinOf(key, status, card) {
  if (!PINS.has(card.pin)) return ''
  const save = patch => {
    try {
      writeCard(key, patch)
    } catch {}
  }
  if (card.pinBusy) {
    if (!busy(status)) save({ pinBusy: '' })
  } else if (busy(status)) {
    save({ pin: '', pinAt: '', pinBusy: '' })
    return ''
  }
  return card.pin
}

/** What the user is asked, for the card. */
function askedText(attention, card, info, tool) {
  if (attention === 'ask') return card.ask
  if (attention === 'question') return info.question
  if (attention !== 'decision' || !tool?.pending) return ''
  return tool.name === 'AskUserQuestion' ? tool.detail : t('note.permission', { what: `${tool.label}${tool.detail ? ` · ${tool.detail}` : ''}` })
}

const contextCache = new Map() // session -> { mtimeMs, data }

/**
 * How full a session's context is. The status line (statusline.mjs) says it best, percentage and
 * window size included; without it, the tokens of the last request from the transcript.
 */
function contextOf(session, info) {
  const own = { context: info.context ?? null, contextPct: null, contextSize: null }
  if (!session) return own
  const file = join(CONTEXT_DIR, `${String(session).replace(/[^A-Za-z0-9_-]/g, '_')}.json`)
  const st = statSync(file, { throwIfNoEntry: false })
  if (!st) return own
  let hit = contextCache.get(session)
  if (!hit || hit.mtimeMs !== st.mtimeMs) {
    try {
      hit = { mtimeMs: st.mtimeMs, data: JSON.parse(readFileSync(file, 'utf8')) }
      contextCache.set(session, hit)
    } catch {
      return own
    }
  }
  const d = hit.data
  // The transcript can be newer (a reply the status line has not run for yet): its tokens win then.
  const fresh = !info.activity || d.at >= info.activity - 5000
  return { context: (fresh && d.tokens) || own.context, contextPct: fresh ? (d.usedPercentage ?? null) : null, contextSize: d.size ?? null }
}

/** All board items, newest activity first. */
export async function collect(cfg) {
  const [snap, asleep] = await Promise.all([snapshot(), sleepers(cfg.wakeUrl)])
  const live = liveSessions()
  const cards = allCards()
  const labels = new Map(snap.workspaces.map(w => [w.workspace_id, w.label]))
  const items = []
  const seen = new Set()

  const add = base => {
    const saved = cards.get(base.key) ?? {}
    const pin = pinOf(base.key, base.status, saved)
    const card = { ...saved, pin }
    const path = base.session ? transcriptPath(base.session, base.cwd) : null
    const info = transcriptInfo(path) ?? {}
    const guess = categoryFor(cfg, base.cwd)
    const tool = info.tool ?? null
    const attention = attentionOf(base.status, card, info)
    items.push({
      ...base,
      // A name given on the board beats the one herdr and Claude know it by; autoName is theirs.
      name: card.name || base.name,
      autoName: base.name,
      category: card.category || guess || 'other',
      categorySet: !!card.category,
      doing: card.doing ?? '',
      wait: card.wait ?? '',
      waitSince: card.waitSince ?? null,
      result: card.result ?? '',
      title: info.title ?? '',
      prompt: info.prompt ?? '',
      lastText: info.lastText ?? '',
      ...contextOf(base.session, info), // context: tokens of its last request; contextPct, contextSize when the status line said
      tool,
      attention,
      question: askedText(attention, card, info, tool),
      askSince: attention === 'ask' ? (card.askSince ?? null) : null,
      activity: info.activity ?? base.activity ?? 0,
      column: columnOf(base.status, card, info),
      pin, // the column the user dragged it to, or ''
      auto: columnOf(base.status, { ...card, pin: '' }, info), // where it would be without the pin
      transcript: path,
    })
  }

  for (const p of snap.panes) {
    if (!p.agent) continue
    const session = p.agent_session?.value ?? null
    const key = session ?? `pane-${p.pane_id}`
    if (seen.has(key)) continue
    seen.add(key)
    const reg = session ? live.get(session) : null
    add({
      key,
      session,
      pane: p.pane_id,
      workspace: labels.get(p.workspace_id) ?? '',
      agent: p.agent,
      name: reg?.name || p.terminal_title_stripped || p.label || p.pane_id,
      cwd: p.cwd ?? reg?.cwd ?? '',
      status: p.agent_status ?? 'unknown',
      sleeping: false,
      focused: p.pane_id === snap.focused_pane_id,
      activity: reg?.statusUpdatedAt ?? 0,
    })
  }

  const panes = new Map(snap.panes.map(p => [p.pane_id, p]))
  for (const s of asleep) {
    if (!s.session || seen.has(s.session)) continue
    seen.add(s.session)
    add({
      key: s.session,
      session: s.session,
      pane: s.pane,
      workspace: s.workspace ?? '',
      agent: 'claude',
      name: s.name || s.session.slice(0, 8),
      cwd: panes.get(s.pane)?.cwd ?? '',
      status: 'sleeping',
      sleeping: true,
      focused: false,
      activity: Date.parse(s.slept_at) || 0,
    })
  }

  items.sort((a, b) => b.activity - a.activity)
  return items
}

/** The one line a card shows under the name. */
export function noteOf(item) {
  if (item.column === 'ext') return item.wait || t('note.parked')
  // Claude's own title of the session beats the last prompt, which is often just "ok" or "go on".
  const title = item.title && item.title !== item.name ? item.title : ''
  const auto = title || item.prompt
  if (item.attention === 'later') return t('note.parkedWith', { what: item.doing || auto || t('note.look') })
  if (item.column === 'me') return item.question || item.doing || auto || t('note.decision')
  if (item.column === 'done' || item.column === 'idle') return item.result || item.doing || auto
  return item.doing || auto
}
