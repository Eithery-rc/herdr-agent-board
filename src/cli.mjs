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
// --session <id|name|pane> targets another session's card (for coordinating sessions).
import { categoryFor, categoryInfo, CONFIG_FILE, editCategories, laneRank, loadConfig } from './config.mjs'
import { liveSessions } from './claude.mjs'
import { snapshot } from './herdr.mjs'
import { COLUMNS, collect, noteOf, statusText } from './model.mjs'
import { readCard, writeCard } from './store.mjs'

const USAGE = `board [cat <id> ["<Title>"] | doing <text> | wait <text> | ask <question> | done [text] | clear | list | cats] [--session <id|name|pane>]`

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
    const item = (await collect(cfg)).find(i => [i.name, i.autoName, i.pane, i.session].some(v => v && v.toLowerCase() === t))
    if (!item) throw new Error(`no session "${target}" on the board`)
    return { key: item.key, cwd: item.cwd, name: item.name }
  }
  const own = process.env.CLAUDE_CODE_SESSION_ID
  if (own) return { key: own, cwd: process.cwd(), name: liveSessions().get(own)?.name }
  const pane = process.env.HERDR_PANE_ID
  if (pane) {
    const p = (await snapshot()).panes.find(x => x.pane_id === pane)
    if (p?.agent) return { key: p.agent_session?.value ?? `pane-${pane}`, cwd: p.cwd ?? '' }
  }
  throw new Error('cannot tell which session this is: run it from a Claude session, or pass --session')
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
    for (const i of items) {
      const col = COLUMNS.find(c => c.id === i.column).title
      const note = noteOf(i)
      console.log(`${i.name} [${i.category}] ${col}${i.sleeping ? ` (${statusText('sleeping')})` : ''}${note ? `: ${note.slice(0, 80)}` : ''}`)
    }
    return
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
