#!/usr/bin/env node
// `board`: how agents keep their card current. Prints one line, so a call costs next to nothing.
//   board                    show this session's card
//   board cat <id> [title]   set the category (lane); a new id with a title is added to the config
//   board doing <text>       what the session works on now
//   board wait <text>        what it waits for outside the chat (moves the card to "waiting")
//   board ask <question>     needs the user: "Needs me" until the user's next prompt
//   board done [text]        task finished: clears doing, wait and ask, keeps the result
//   board clear              clears doing, wait, ask and result
//   board list               every session on the board, one line each
//   board cats               the known categories
//   board remind <when> <text>   the board types "[board reminder] <text>" into the session then,
//                            waking it if it sleeps (when: in 30m, at 15:30, tomorrow 9:00, ...)
//   board every <cron> <text>    the same on a cron schedule (5 fields, quoted)
//   board schedule [--all]   this session's entries (every session's)
//   board unschedule <id|all>    removes an entry (all: every entry of this session)
// --session <id|name|pane> targets another session's card (for coordinating sessions).
import { categoryFor, categoryInfo, CONFIG_FILE, editCategories, laneRank, loadConfig } from './config.mjs'
import { liveSessions } from './claude.mjs'
import { snapshot } from './herdr.mjs'
import { t } from './lang.mjs'
import { COLUMNS, collect, noteOf, statusText } from './model.mjs'
import { addEntry, listEntries, removeEntry } from './schedule.mjs'
import { readCard, writeCard } from './store.mjs'
import { nextRun, parseCron, parseWhen, shortestGap } from './when.mjs'
import { shortWhen } from '../web/when.js'

const USAGE = `board [cat <id> ["<Title>"] | doing <text> | wait <text> | ask <question> | done [text] | clear | list | cats | remind <when> "<text>" | every "<cron>" "<text>" | schedule [--all] | unschedule <id|all>] [--session <id|name|pane>]`
// The session an entry is for; its pane and folder find it again after /clear gives it a new id.
const where = s => ({ key: s.key, name: s.name ?? '', ...(s.pane && { pane: s.pane }), ...(s.cwd && { cwd: s.cwd }) })
const MIN_REPEAT_MS = 5 * 60_000
const WHEN_HELP = 'in 30m, in 2h, at 15:30, tomorrow 9:00, fri 17:00, 2026-10-20 14:00 (local time)'

const args = process.argv.slice(2)
let target = null
const si = args.indexOf('--session')
if (si >= 0) {
  target = args[si + 1]
  args.splice(si, 2)
}
const [cmd = 'show', ...rest] = args
const text = rest.join(' ').replace(/\s+/g, ' ').trim()
const cfg = loadConfig()

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** { key, cwd } of the session the command is about. */
async function resolveSession() {
  if (target) {
    if (UUID.test(target)) return { key: target, cwd: '' }
    const t = target.toLowerCase()
    const item = (await collect(cfg)).find(i => [i.name, i.pane, i.session].some(v => v && v.toLowerCase() === t))
    if (!item) throw new Error(`no session "${target}" on the board`)
    return { key: item.key, cwd: item.cwd, name: item.name, pane: item.pane }
  }
  const own = process.env.CLAUDE_CODE_SESSION_ID
  if (own) return { key: own, cwd: process.cwd(), name: liveSessions().get(own)?.name, pane: process.env.HERDR_PANE_ID }
  const pane = process.env.HERDR_PANE_ID
  if (pane) {
    const p = (await snapshot()).panes.find(x => x.pane_id === pane)
    if (p?.agent) return { key: p.agent_session?.value ?? `pane-${pane}`, cwd: p.cwd ?? '', pane }
  }
  throw new Error('cannot tell which session this is: run it from a Claude session, or pass --session')
}

// Times for agents: unambiguous, in local time.
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const pad = n => String(n).padStart(2, '0')
function stamp(ms) {
  const d = new Date(ms)
  return `${WEEKDAYS[d.getDay()]} ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}
function fromNow(ms, now) {
  const min = Math.round(Math.abs(ms - now) / 60_000)
  const d = Math.floor(min / 1440)
  const h = Math.floor((min % 1440) / 60)
  const parts = d ? [`${d} d`, h && `${h} h`] : h ? [`${h} h`, min % 60 && `${min % 60} min`] : [`${min} min`]
  const span = parts.filter(Boolean).join(' ')
  return ms >= now ? `in ${span}` : `${span} ago`
}
const clip = (s, n = 60) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

function entryLine(e, now, withSession) {
  const parts = [e.id, `${stamp(e.next)} (${fromNow(e.next, now)})`, e.cron ? `every "${e.cron}"` : 'once']
  if (withSession) parts.push(e.name || e.key)
  if (e.pendingSince) parts.push(`due, waits for the session since ${stamp(e.pendingSince)}`)
  parts.push(clip(e.text, 80))
  return parts.join(' · ')
}

function line(key, cwd) {
  const card = readCard(key) ?? {}
  const cat = card.category || categoryFor(cfg, cwd)
  const parts = [cat ? `${cat}${card.category ? '' : ' (guessed)'}` : 'category: not set']
  if (card.doing) parts.push(`doing: ${card.doing}`)
  if (card.wait) parts.push(`waiting: ${card.wait}`)
  if (card.ask) parts.push(`asks the user: ${card.ask}`)
  if (card.result) parts.push(`done: ${card.result}`)
  return parts.join(' · ')
}

async function main() {
  if (cmd === 'help' || cmd === '--help' || cmd === '-h') return console.log(USAGE)

  if (cmd === 'cats') {
    const known = cfg.categories.map(c => `${c.id} (${categoryInfo(cfg, c.id).title})`).join(', ')
    return console.log(`${known}. A new id makes a new lane. Config: ${CONFIG_FILE}`)
  }

  if (cmd === 'list') {
    const items = await collect(cfg)
    const order = new Map(COLUMNS.map((c, i) => [c.id, i]))
    items.sort((a, b) => laneRank(cfg, a.category) - laneRank(cfg, b.category) || a.category.localeCompare(b.category) || order.get(a.column) - order.get(b.column))
    const soonest = new Map()
    for (const e of listEntries()) if (!soonest.has(e.key)) soonest.set(e.key, e.next)
    for (const i of items) {
      const col = COLUMNS.find(c => c.id === i.column).title
      const note = noteOf(i)
      const alarm = soonest.has(i.key) ? ` ⏰ ${shortWhen(soonest.get(i.key), t)}` : ''
      console.log(`${i.name} [${i.category}] ${col}${i.sleeping ? ` (${statusText('sleeping')})` : ''}${alarm}${note ? `: ${note.slice(0, 80)}` : ''}`)
    }
    return
  }

  // Neither needs to know which session asks.
  if (cmd === 'schedule' && rest.includes('--all')) {
    const list = listEntries()
    if (!list.length) return console.log('nothing scheduled')
    for (const e of list) console.log(entryLine(e, Date.now(), true))
    return
  }
  if (cmd === 'unschedule' && rest[0] && rest[0].toLowerCase() !== 'all') {
    const e = removeEntry(rest[0].toLowerCase())
    if (!e) throw new Error(`no entry "${rest[0]}"; see board schedule`)
    return console.log(`ok · removed ${e.id} (${e.cron ? `every "${e.cron}"` : stamp(e.next)}${e.name ? `, ${e.name}` : ''}): ${clip(e.text)}`)
  }

  const s = await resolveSession()
  const now = Date.now()
  switch (cmd) {
    case 'show':
      break
    case 'cat': {
      const id = (rest[0] ?? '').toLowerCase().replace(/[^a-z0-9_-]/g, '')
      if (!id) throw new Error(`usage: board cat <id> ["<Title>"]; known: ${cfg.categories.map(c => c.id).join(', ')}`)
      // A new id with a title becomes a real category (config.json), not just a lane named by its id.
      const title = rest.slice(1).join(' ').trim()
      if (title && !cfg.categories.some(c => c.id === id)) {
        const r = editCategories({ op: 'create', id, title })
        if (!r.ok) throw new Error(r.error)
        cfg.categories.push({ id, title })
      }
      writeCard(s.key, { category: id })
      break
    }
    case 'doing':
      if (!text) throw new Error('usage: board doing <text>')
      // Back at work: whatever it waited for has arrived, whatever it asked is settled.
      writeCard(s.key, { doing: text, wait: '', waitSince: '', ask: '', askSince: '', result: '', by: 'agent' })
      break
    case 'wait':
      if (!text) throw new Error('usage: board wait <text>')
      writeCard(s.key, { wait: text, waitSince: now, by: 'agent' })
      break
    case 'ask':
      // Needs the user: the card goes to "Needs me" until the user's next prompt (hook.mjs clears it).
      if (!text) throw new Error('usage: board ask <question>')
      writeCard(s.key, { ask: text, askSince: now, by: 'agent' })
      break
    case 'done':
      writeCard(s.key, { doing: '', wait: '', waitSince: '', ask: '', askSince: '', result: text, by: 'agent' })
      break
    case 'clear':
      writeCard(s.key, { doing: '', wait: '', waitSince: '', ask: '', askSince: '', result: '' })
      break
    case 'remind': {
      // The time is the first one to five words that read as one; the rest is the text.
      let at = null
      let words = 0
      for (let k = Math.min(5, rest.length - 1); k >= 1 && at === null; k--) {
        at = parseWhen(rest.slice(0, k).join(' '), now)
        words = k
      }
      const msg = rest.slice(words).join(' ').replace(/\s+/g, ' ').trim()
      if (at === null || !msg) throw new Error(`usage: board remind <when> "<text>"; when: ${WHEN_HELP}`)
      if (at <= now) throw new Error(`${stamp(at)} is in the past`)
      if (at > now + 5 * 366 * 86_400_000) throw new Error(`${stamp(at)} is more than five years ahead`)
      const e = addEntry({ ...where(s), text: msg, at, next: at, by: 'agent' })
      return console.log(`ok · reminder ${e.id} ${stamp(at)} (${fromNow(at, now)}): ${clip(msg)} · cancel: board unschedule ${e.id}`)
    }
    case 'every': {
      // The cron in one quoted word, or its five fields as they are (PowerShell leaves * alone).
      let expr = rest[0] ?? ''
      let words = 1
      if (!/\s/.test(expr) && !expr.startsWith('@') && rest.length > 5) {
        expr = rest.slice(0, 5).join(' ')
        words = 5
      }
      let cron
      try {
        cron = parseCron(expr)
      } catch (err) {
        throw new Error(`${err.message}. usage: board every "<minute hour day month weekday>" "<text>", e.g. board every "0 9 * * 1-5" "check the inbox"; quote the schedule`)
      }
      const msg = rest.slice(words).join(' ').replace(/\s+/g, ' ').trim()
      if (!msg) throw new Error('usage: board every "<cron>" "<text>"')
      const next = nextRun(cron, now)
      if (next === null) throw new Error(`"${cron.expr}" never runs`)
      // Every run is a turn of the session, waking it if need be.
      if (shortestGap(cron, now) < MIN_REPEAT_MS) throw new Error(`"${cron.expr}" runs more often than every ${MIN_REPEAT_MS / 60_000} minutes; for a one-off wait use board remind`)
      const e = addEntry({ ...where(s), text: msg, cron: cron.expr, next, by: 'agent' })
      return console.log(`ok · every ${e.id} "${cron.expr}", next ${stamp(next)} (${fromNow(next, now)}): ${clip(msg)} · cancel: board unschedule ${e.id}`)
    }
    case 'schedule': {
      const list = listEntries().filter(e => e.key === s.key)
      if (!list.length) return console.log('nothing scheduled for this session')
      for (const e of list) console.log(entryLine(e, now, false))
      return
    }
    case 'unschedule': {
      // An id is removed above, whoever set it; here only "all" of this session's.
      if (rest[0]?.toLowerCase() !== 'all') throw new Error('usage: board unschedule <id|all>')
      const mine = listEntries().filter(e => e.key === s.key)
      for (const e of mine) removeEntry(e.id)
      return console.log(`ok · removed ${mine.length} ${mine.length === 1 ? 'entry' : 'entries'}`)
    }
    default:
      throw new Error(`unknown command "${cmd}". ${USAGE}`)
  }
  const cat = readCard(s.key)?.category
  const extra = cat && !cfg.categories.some(c => c.id === cat) ? ` (new lane "${categoryInfo(cfg, cat).title}")` : ''
  console.log(`ok · ${line(s.key, s.cwd)}${extra}`)
}

main().catch(err => {
  console.error(`board: ${err.message}`)
  process.exit(1)
})
