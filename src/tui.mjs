// The board: a full-screen terminal UI in a herdr plugin pane. No model in the loop: it polls
// herdr, the Claude registry, transcript tails and the card files, and redraws.
//   lanes = categories, columns = Работает / Ждёт меня / Ждёт внешнего / Готово / Простой
//   Enter or double click: go to the session (waking it if it sleeps); m: send it a message;
//   w: set what it waits for; x: clear its card; c: change its category; 1-9 / 0: filter lanes;
//   q / Esc: back to where you were (an overlay board closes instead); Ctrl+C: close the board.
import { mkdirSync, readFileSync, unlinkSync, watch, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { categoryInfo, laneRank, liveConfig } from './config.mjs'
import * as actions from './actions.mjs'
import { COLUMNS, collect, forgetSleepers, noteOf, STATUS_TEXT } from './model.mjs'
import { goBack } from './nav.mjs'
import { startServer } from './server.mjs'
import { openWeb } from './web-open.mjs'
import { BOARD_FILE, CARDS_DIR, STATE_DIR } from './paths.mjs'
import { writeCard } from './store.mjs'

// Updated in place when config.json changes (by hand or from the web board).
const cfg = liveConfig(() => {
  refresh()
  web?.refresh()
})
let web = null // the web board's server, once it listens
const out = process.stdout
const PANE = process.env.HERDR_PANE_ID ?? null
// An overlay closes once you leave it; the workspace and tab boards stay open.
const OVERLAY = !!PANE && process.env.AGENT_BOARD_PLACEMENT === 'overlay'

// ---------------------------------------------------------------- text
const CSI = '\x1b['
const CODES = { bold: 1, dim: 2, inverse: 7, red: 31, green: 32, yellow: 33, blue: 34, magenta: 35, cyan: 36, white: 37, gray: 90 }
const paint = (text, ...styles) => {
  const codes = styles.filter(Boolean).map(s => CODES[s]).filter(Boolean)
  return codes.length ? `${CSI}${codes.join(';')}m${text}${CSI}0m` : text
}

// East Asian wide and emoji code points take two cells.
const WIDE = [
  [0x1100, 0x115f], [0x231a, 0x231b], [0x2329, 0x232a], [0x23e9, 0x23ec], [0x23f0, 0x23f0], [0x23f3, 0x23f3],
  [0x25fd, 0x25fe], [0x2614, 0x2615], [0x2648, 0x2653], [0x267f, 0x267f], [0x2693, 0x2693], [0x26a1, 0x26a1],
  [0x26aa, 0x26ab], [0x26bd, 0x26be], [0x26c4, 0x26c5], [0x26ce, 0x26ce], [0x26d4, 0x26d4], [0x26ea, 0x26ea],
  [0x26f2, 0x26f3], [0x26f5, 0x26f5], [0x26fa, 0x26fa], [0x26fd, 0x26fd], [0x2705, 0x2705], [0x270a, 0x270b],
  [0x2728, 0x2728], [0x274c, 0x274c], [0x274e, 0x274e], [0x2753, 0x2755], [0x2757, 0x2757], [0x2795, 0x2797],
  [0x27b0, 0x27b0], [0x27bf, 0x27bf], [0x2b1b, 0x2b1c], [0x2b50, 0x2b50], [0x2b55, 0x2b55], [0x2e80, 0xa4cf],
  [0xac00, 0xd7a3], [0xf900, 0xfaff], [0xfe30, 0xfe4f], [0xff00, 0xff60], [0xffe0, 0xffe6], [0x1f000, 0x1faff],
  [0x20000, 0x3fffd],
]
function charWidth(cp) {
  if (cp < 32 || (cp >= 0x7f && cp < 0xa0)) return 0
  if ((cp >= 0x300 && cp <= 0x36f) || (cp >= 0x200b && cp <= 0x200f) || (cp >= 0xfe00 && cp <= 0xfe0f)) return 0
  for (const [a, b] of WIDE) {
    if (cp < a) break
    if (cp <= b) return 2
  }
  return 1
}
const width = s => {
  let w = 0
  for (const ch of s) w += charWidth(ch.codePointAt(0))
  return w
}
/** Exactly `w` cells: cut with an ellipsis or padded with spaces. */
function fit(s, w) {
  s = String(s ?? '').replace(/[\x00-\x1f\x7f]+/g, ' ')
  if (w <= 0) return ''
  const total = width(s)
  if (total <= w) return s + ' '.repeat(w - total)
  let cut = ''
  let used = 0
  for (const ch of s) {
    const cw = charWidth(ch.codePointAt(0))
    if (used + cw > w - 1) break
    cut += ch
    used += cw
  }
  return `${cut}…${' '.repeat(w - 1 - used)}`
}
function age(ms) {
  if (!ms) return ''
  const m = Math.floor((Date.now() - ms) / 60_000)
  if (m < 1) return '<1м'
  if (m < 60) return `${m}м`
  const h = Math.floor(m / 60)
  return h < 24 ? `${h}ч` : `${Math.floor(h / 24)}д`
}

// ---------------------------------------------------------------- state
let items = []
let lanes = [] // [{ cat, info, num, cols: [[item]] }], after the filter
let allCats = [] // every category on the board, in lane order (the 1-9 filter keys)
let sel = null // key of the selected item
let filter = null
let mode = 'board' // board | input | category
let input = null // { label, text, submit }
let flash = null // { text, error, until }
let scroll = 0
let follow = true // scroll the selection into view on the next render
let hits = [] // body line -> [{ x0, x1, key }] for mouse clicks
let lastClick = { key: null, at: 0 }
let loading = true
let loadError = null
let pasting = false
const busy = new Map() // key -> short state shown on the card while an action runs

const colOf = id => COLUMNS.find(c => c.id === id)
const byKey = key => items.find(i => i.key === key)
const selected = () => byKey(sel)

function say(text, error = false) {
  flash = { text, error, until: Date.now() + (error ? 8000 : 4000) }
  render()
}

function build() {
  allCats = [...new Set(items.map(i => i.category))].sort((a, b) => laneRank(cfg, a) - laneRank(cfg, b) || a.localeCompare(b))
  if (filter && !allCats.includes(filter)) filter = null
  lanes = allCats
    .map((cat, n) => ({
      cat,
      num: n + 1,
      info: categoryInfo(cfg, cat),
      cols: COLUMNS.map(col => items.filter(i => i.category === cat && i.column === col.id)),
    }))
    .filter(l => !filter || l.cat === filter)
  const visible = flat()
  if (!visible.some(i => i.key === sel)) {
    sel = visible[0]?.key ?? null
    follow = true
  }
}

/** Visible items in reading order: lane by lane, column by column. */
const flat = () => lanes.flatMap(l => l.cols.flat())

// ---------------------------------------------------------------- data
let refreshing = false
let again = false
async function refresh() {
  if (refreshing) {
    again = true
    return
  }
  refreshing = true
  try {
    items = await collect(cfg)
    loadError = null
  } catch (err) {
    loadError = err.message
  } finally {
    loading = false
    refreshing = false
  }
  build()
  render()
  if (again) {
    again = false
    refresh()
  }
}

// ---------------------------------------------------------------- actions
function setBusy(key, text) {
  if (text) busy.set(key, text)
  else busy.delete(key)
  render()
}

async function jump(it) {
  if (!it?.pane) return
  setBusy(it.key, it.sleeping ? 'бужу…' : 'перехожу…')
  const r = await actions.focus(cfg, it)
  setBusy(it.key, null)
  if (!r.ok) return say(r.error, true)
  if (OVERLAY) quit()
  refresh()
}

async function send(it, text) {
  setBusy(it.key, it.sleeping ? 'бужу…' : 'отправляю…')
  const r = await actions.send(cfg, it, text)
  setBusy(it.key, null)
  say(r.ok ? `Отправлено в ${it.name}` : r.error, !r.ok)
  refresh()
}

function ask(label, initial, submit) {
  mode = 'input'
  input = { label, text: initial ?? '', submit }
  render()
}

function onAction(name) {
  const it = selected()
  switch (name) {
    case 'quit':
      return OVERLAY || !PANE ? quit() : goBack()
    case 'exit':
      return quit()
    case 'refresh':
      return refresh()
    case 'web':
      say('Открываю веб-доску…')
      return openWeb(cfg).then(r => !r.ok && say(r.error, true))
    case 'enter':
      return jump(it)
    case 'message':
      if (it) ask(`Сообщение для ${it.name}`, '', text => text && send(it, text))
      return
    case 'wait':
      if (it)
        ask(`${it.name} ждёт`, it.wait, text => {
          writeCard(it.key, text ? { wait: text, waitSince: Date.now(), by: 'user' } : { wait: '', waitSince: '' })
          refresh()
        })
      return
    case 'clear':
      if (!it) return
      writeCard(it.key, { doing: '', wait: '', waitSince: '', ask: '', askSince: '', result: '', pin: '', pinAt: '', pinBusy: '', dismissed: it.attention === 'question' ? it.question : '' })
      say(`Карточка ${it.name} очищена`)
      return refresh()
    case 'sleep':
      if (!it || it.sleeping) return
      setBusy(it.key, 'усыпляю…')
      return actions.sleepSession(cfg, it).then(r => {
        setBusy(it.key, null)
        say(r.ok ? `${it.name} спит` : r.error, !r.ok)
        forgetSleepers()
        refresh()
      })
    case 'category':
      if (it) {
        mode = 'category'
        render()
      }
      return
    default:
      if (name.startsWith('filter:')) {
        const n = Number(name.slice(7))
        filter = n === 0 ? null : (allCats[n - 1] ?? filter)
        scroll = 0
        follow = true
        build()
        render()
      } else if (['up', 'down', 'left', 'right', 'home'].includes(name)) {
        move(name)
      }
  }
}

function move(dir) {
  const wide = isWide()
  if (!wide || dir === 'home') {
    const list = narrowOrder()
    const i = list.findIndex(x => x.key === sel)
    if (dir === 'home') sel = list[0]?.key ?? sel
    else if (dir === 'up' || dir === 'left') sel = list[Math.max(0, i - 1)]?.key ?? sel
    else sel = list[Math.min(list.length - 1, i + 1)]?.key ?? sel
    follow = true
    return render()
  }
  let pos = null
  lanes.forEach((l, li) => l.cols.forEach((col, ci) => col.forEach((x, ii) => x.key === sel && (pos = { li, ci, ii }))))
  if (!pos) return
  const { li, ci, ii } = pos
  const col = lanes[li].cols[ci]
  let next = null
  if (dir === 'up') {
    if (ii > 0) next = col[ii - 1]
    else for (let l = li - 1; l >= 0 && !next; l--) next = lanes[l].cols[ci].at(-1) ?? null
  } else if (dir === 'down') {
    if (ii < col.length - 1) next = col[ii + 1]
    else for (let l = li + 1; l < lanes.length && !next; l++) next = lanes[l].cols[ci][0] ?? null
  } else {
    const step = dir === 'right' ? 1 : -1
    for (let c = ci + step; c >= 0 && c < COLUMNS.length && !next; c += step) {
      const other = lanes[li].cols[c]
      if (other.length) next = other[Math.min(ii, other.length - 1)]
    }
  }
  if (next) {
    sel = next.key
    follow = true
    render()
  }
}

// ---------------------------------------------------------------- input
const KEYMAP = {
  up: ['\x1b[A', '\x1bOA', 'k', 'л'],
  down: ['\x1b[B', '\x1bOB', 'j', 'о'],
  right: ['\x1b[C', '\x1bOC', 'l', 'д', '\t'],
  left: ['\x1b[D', '\x1bOD', 'h', 'р', '\x1b[Z'],
  home: ['\x1b[H', '\x1b[1~', 'g', 'п'],
  enter: ['\r', '\n'],
  quit: ['q', 'й', '\x1b'],
  exit: ['\x03'],
  message: ['m', 'ь'],
  wait: ['w', 'ц'],
  clear: ['x', 'ч'],
  sleep: ['z', 'я'],
  category: ['c', 'с'],
  refresh: ['r', 'к'],
  web: ['o', 'щ'],
}
const ACTION = new Map(Object.entries(KEYMAP).flatMap(([name, keys]) => keys.map(k => [k, name])))
const TOKEN = /\x1b\[<\d+;\d+;\d+[Mm]|\x1b\[[0-9;?]*[ -/]*[@-~]|\x1bO[@-~]|\x1b|[\s\S]/gu

function onData(data) {
  for (const [tok] of data.matchAll(TOKEN)) {
    if (tok === '\x1b[200~') pasting = true
    else if (tok === '\x1b[201~') pasting = false
    else if (tok.startsWith('\x1b[<')) onMouse(tok)
    else if (tok === '\x1b[I') refresh() // focus in
    else if (mode === 'input') onInputKey(tok)
    else if (mode === 'category') onCategoryKey(tok)
    else if (/^[0-9]$/.test(tok)) onAction(`filter:${tok}`)
    else if (ACTION.has(tok)) onAction(ACTION.get(tok))
  }
}

function onInputKey(tok) {
  if (pasting && (tok === '\r' || tok === '\n')) tok = ' '
  if (tok === '\r' || tok === '\n') {
    const { submit, text } = input
    mode = 'board'
    input = null
    submit(text.trim())
    return render()
  }
  if (tok === '\x1b' || tok === '\x03') {
    mode = 'board'
    input = null
  } else if (tok === '\x7f' || tok === '\b') input.text = [...input.text].slice(0, -1).join('')
  else if (tok === '\x15') input.text = ''
  else if (tok === '\x17') input.text = input.text.replace(/\S*\s*$/, '')
  else if (!tok.startsWith('\x1b') && charWidth(tok.codePointAt(0)) > 0) input.text += tok
  render()
}

function onCategoryKey(tok) {
  const it = selected()
  mode = 'board'
  if (!it || tok === '\x1b' || tok === '\x03') return render()
  if (tok === 'n' || tok === 'т') {
    return ask(`Новая категория для ${it.name} (id латиницей)`, '', text => {
      const id = text.toLowerCase().replace(/[^a-z0-9_-]/g, '')
      if (id) {
        writeCard(it.key, { category: id })
        refresh()
      }
    })
  }
  const c = cfg.categories[Number(tok) - 1]
  if (/^[1-9]$/.test(tok) && c) {
    writeCard(it.key, { category: c.id })
    say(`${it.name} → ${c.title}`)
    refresh()
  }
  render()
}

function onMouse(tok) {
  const [, b, x, y, kind] = tok.match(/^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/).map((v, i) => (i && i < 4 ? Number(v) : v))
  if (mode !== 'board' || kind !== 'M') return
  if (b === 64 || b === 65) {
    scroll = Math.max(0, scroll + (b === 64 ? -3 : 3))
    return render()
  }
  if (b !== 0) return
  const line = scroll + (y - 1 - HEADER_ROWS)
  const hit = (hits[line] ?? []).find(h => x >= h.x0 && x <= h.x1)
  if (!hit) return
  const now = Date.now()
  if (lastClick.key === hit.key && now - lastClick.at < 450) {
    lastClick = { key: null, at: 0 }
    return jump(byKey(hit.key))
  }
  lastClick = { key: hit.key, at: now }
  sel = hit.key
  render()
}

// ---------------------------------------------------------------- render
const HEADER_ROWS = 2
const FOOTER_ROWS = 2
const isWide = () => (out.columns || 80) >= 100

function narrowOrder() {
  const order = new Map(COLUMNS.map((c, i) => [c.id, i]))
  return lanes.flatMap(l => l.cols.flat().sort((a, b) => order.get(a.column) - order.get(b.column)))
}

function cardLines(it, w, isSel) {
  const col = colOf(it.column)
  const icon = it.sleeping && it.column === 'idle' ? 'z' : col.icon
  const right = busy.get(it.key) ?? (it.column === 'ext' ? age(it.waitSince || it.activity) : age(it.activity))
  const nameW = Math.max(1, w - 3 - width(right))
  const note = noteOf(it)
  // A sleeping session with nothing pending takes one line: it is there to be found, not read.
  const compact = it.sleeping && it.column === 'idle'
  if (isSel) {
    const first = paint(`${icon} ${fit(it.name, nameW)} ${right}`, 'inverse', 'bold')
    return compact ? [first] : [first, paint(`  ${fit(note, w - 2)}`, 'inverse')]
  }
  const dim = it.sleeping ? 'dim' : null
  const first = `${paint(icon, col.color, dim)} ${paint(fit(it.name, nameW), compact ? null : 'bold', dim)} ${paint(right, busy.has(it.key) ? 'yellow' : 'gray')}`
  return compact ? [first] : [first, paint(`  ${fit(note, w - 2)}`, 'gray')]
}

function laneHeader(l, w) {
  const count = l.cols.reduce((n, c) => n + c.length, 0)
  const label = ` ${l.num} ${l.info.title} `
  const rest = Math.max(0, w - width(label) - width(String(count)) - 3)
  return `${paint(label, l.info.color, 'bold', 'inverse')} ${paint(String(count), l.info.color)} ${paint('─'.repeat(rest), 'gray')}`
}

function bodyWide(W) {
  const colW = Math.floor((W - 2) / COLUMNS.length)
  const lines = []
  const tops = new Map()
  const heights = new Map()
  hits = []
  for (const l of lanes) {
    lines.push(laneHeader(l, W - 1))
    hits.push([])
    // Each column stacks its own cards, so one- and two-line cards mix freely.
    const stacks = l.cols.map(col =>
      col.flatMap(it => {
        const card = cardLines(it, colW - 1, it.key === sel)
        heights.set(it.key, card.length)
        return card.map((text, k) => ({ text, key: it.key, first: k === 0 }))
      }),
    )
    const height = Math.max(...stacks.map(st => st.length))
    for (let r = 0; r < height; r++) {
      let row = ' '
      const rowHits = []
      stacks.forEach((st, ci) => {
        const cell = st[r]
        row += `${cell ? cell.text : ' '.repeat(colW - 1)} `
        if (!cell) return
        rowHits.push({ x0: 2 + ci * colW, x1: 1 + (ci + 1) * colW, key: cell.key })
        if (cell.first) tops.set(cell.key, lines.length)
      })
      lines.push(row)
      hits.push(rowHits)
    }
    lines.push('')
    hits.push([])
  }
  return { lines, tops, heights, colW }
}

function bodyNarrow(W) {
  const lines = []
  const tops = new Map()
  hits = []
  const order = new Map(COLUMNS.map((c, i) => [c.id, i]))
  for (const l of lanes) {
    lines.push(laneHeader(l, W - 1))
    hits.push([])
    for (const it of l.cols.flat().sort((a, b) => order.get(a.column) - order.get(b.column))) {
      const col = colOf(it.column)
      const right = busy.get(it.key) ?? age(it.column === 'ext' ? it.waitSince || it.activity : it.activity)
      const nameW = Math.min(24, Math.floor(W / 3))
      const stateW = 14
      const noteW = Math.max(0, W - 2 - 2 - nameW - 1 - stateW - 1 - width(right) - 1)
      const state = it.column === 'ext' ? 'ждёт внешнего' : STATUS_TEXT[it.status] ?? it.status
      const text = `${col.icon} ${fit(it.name, nameW)} ${fit(state, stateW)} ${fit(noteOf(it), noteW)} ${right}`
      tops.set(it.key, lines.length)
      lines.push(it.key === sel ? ` ${paint(text, 'inverse')}` : ` ${paint(col.icon, col.color, it.sleeping && 'dim')}${text.slice(col.icon.length)}`)
      hits.push([{ x0: 1, x1: W - 1, key: it.key }])
    }
    lines.push('')
    hits.push([])
  }
  return { lines, tops, heights: new Map(), colW: 0 }
}

function header(W, colW) {
  const asleep = items.filter(i => i.sleeping).length
  const counts = colW
    ? paint(`${items.length} сессий${asleep ? `, ${asleep} спят` : ''}`, 'gray')
    : COLUMNS.map(c => `${paint(c.icon, c.color)} ${items.filter(i => i.column === c.id).length}`).join('  ')
  const time = new Date().toTimeString().slice(0, 5)
  const filt = filter ? paint(`  фильтр: ${categoryInfo(cfg, filter).title} (0 все)`, 'yellow') : ''
  const left = `${paint(' Agent board ', 'bold')} ${counts}${filt}`
  const top = `${left}${' '.repeat(Math.max(1, W - width(left.replace(/\x1b\[[0-9;]*m/g, '')) - 6))}${paint(time, 'gray')}`
  if (!colW) return [top, paint('─'.repeat(W - 1), 'gray')]
  const titles = COLUMNS.map(c => {
    const n = lanes.reduce((s, l) => s + l.cols[COLUMNS.indexOf(c)].length, 0)
    return paint(fit(`${c.icon} ${c.title} ${n}`, colW - 1), c.color, 'bold')
  })
  return [top, ` ${titles.join(' ')}`]
}

function footer(W) {
  const now = Date.now()
  const msg = flash && flash.until > now ? paint(fit(` ${flash.text}`, W - 1), flash.error ? 'red' : 'green') : loadError ? paint(fit(` ${loadError}`, W - 1), 'red') : paint('─'.repeat(W - 1), 'gray')
  let keys
  if (mode === 'input') {
    const label = fit(` ${input.label}: `, Math.min(width(` ${input.label}: `), Math.floor(W / 2)))
    const room = Math.max(1, W - 1 - width(label) - 1 - 24)
    const chars = [...input.text]
    let shown = ''
    for (let i = chars.length - 1; i >= 0 && width(chars[i] + shown) <= room; i--) shown = chars[i] + shown
    keys = `${paint(label, 'bold')}${shown}${paint('█', 'gray')}${paint('  Enter ок · Esc отмена', 'gray')}`
  } else if (mode === 'category') {
    const list = cfg.categories.map((c, i) => `${paint(String(i + 1), 'bold')} ${c.title}`).join('  ')
    keys = ` Категория для ${selected()?.name ?? ''}: ${list}  ${paint('n', 'bold')} новая  ${paint('Esc', 'bold')} отмена`
  } else {
    const hints = [
      ['Enter', 'перейти'], ['m', 'написать'], ['w', 'ждёт…'], ['x', 'очистить'], ['c', 'категория'],
      ['z', 'усыпить'], ['1-9', 'фильтр'], ['o', 'веб'], ['r', 'обновить'], ['q', OVERLAY || !PANE ? 'закрыть' : 'назад'],
    ]
    keys = ''
    let used = 0
    for (const [key, text] of hints) {
      const w = width(` ${key} ${text} `)
      if (used + w > W - 1) break
      keys += ` ${paint(key, 'bold')} ${paint(text, 'gray')} `
      used += w
    }
  }
  return [msg, keys]
}

function render() {
  const W = out.columns || 80
  const H = out.rows || 24
  const bodyH = Math.max(1, H - HEADER_ROWS - FOOTER_ROWS)
  const { lines, tops, heights, colW } = isWide() ? bodyWide(W) : bodyNarrow(W)
  if (loading) lines.splice(0, lines.length, paint(' Загружаю…', 'gray'))
  else if (!items.length) lines.splice(0, lines.length, paint(' Агентов нет', 'gray'))
  if (follow && tops.has(sel)) {
    const top = tops.get(sel)
    const h = heights.get(sel) ?? 1
    if (top < scroll) scroll = Math.max(0, top - 1)
    if (top + h > scroll + bodyH) scroll = top + h - bodyH
    follow = false
  }
  scroll = Math.max(0, Math.min(scroll, Math.max(0, lines.length - bodyH)))
  const rows = [...header(W, colW), ...Array.from({ length: bodyH }, (_, i) => lines[scroll + i] ?? ''), ...footer(W)]
  out.write(`\x1b[?2026h${rows.map((r, i) => `${CSI}${i + 1};1H${r}${CSI}0m${CSI}K`).join('')}\x1b[?2026l`)
}

// ---------------------------------------------------------------- lifecycle
function cleanup() {
  out.write('\x1b[?1004l\x1b[?1000l\x1b[?1006l\x1b[?2004l\x1b[?25h\x1b[?1049l')
  try {
    if (JSON.parse(readFileSync(BOARD_FILE, 'utf8')).pid === process.pid) unlinkSync(BOARD_FILE)
  } catch {}
}
function quit(code = 0) {
  cleanup()
  process.exit(code)
}

mkdirSync(CARDS_DIR, { recursive: true })
mkdirSync(STATE_DIR, { recursive: true })
writeFileSync(BOARD_FILE, JSON.stringify({ pane: PANE, pid: process.pid, overlay: OVERLAY }))
process.on('SIGINT', () => quit())
process.on('SIGTERM', () => quit())
process.on('SIGHUP', () => quit())
// run.mjs asks for a restart when the plugin's code changed: put the terminal back, then go.
process.on('message', m => m === 'restart' && quit(75))
process.on('uncaughtException', err => {
  cleanup()
  console.error(err)
  process.exit(1)
})

out.write('\x1b[?1049h\x1b[?25l\x1b[?1000h\x1b[?1006h\x1b[?2004h\x1b[?1004h')
out.on('resize', render)
if (process.stdin.isTTY) process.stdin.setRawMode(true)
process.stdin.setEncoding('utf8')
process.stdin.on('data', onData)

let watchTimer = null
try {
  watch(CARDS_DIR, () => {
    clearTimeout(watchTimer)
    watchTimer = setTimeout(refresh, 150)
  })
} catch {}
setInterval(refresh, Math.max(1, cfg.refreshSec) * 1000)
render()
refresh()

// The web board's server runs here, alongside; another board already serving the port is fine.
const webLog = msg => {
  try {
    writeFileSync(join(STATE_DIR, 'web.log'), `${new Date().toISOString()} ${msg}\n`, { flag: 'a' })
  } catch {}
}
// Right after a restart the previous process may still hold the port for a moment: retry a few times.
async function serve(tries = 8) {
  try {
    web = await startServer({ cfg, log: webLog })
    webLog(`serving ${web.url}`)
  } catch (err) {
    if (err.code === 'EADDRINUSE' && tries > 1) return setTimeout(() => serve(tries - 1), 500)
    webLog(err.code === 'EADDRINUSE' ? 'port taken, another board serves the web' : `server: ${err.message}`)
  }
}
if (cfg.web !== false) serve()
