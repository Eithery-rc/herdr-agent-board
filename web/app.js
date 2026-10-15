// Agent board, web. Live data over Server-Sent Events; every change of place animates with a
// spring from where the card is on screen (FLIP), drags stay glued to the pointer and land
// with the pointer's velocity, and the session sheet can be flicked away.
import { LANGUAGES, translator } from './i18n.js'
import { markdown } from './markdown.js'
import { project, reducedMotion, rubberband, Spring, velocityOf } from './spring.js'

const $ = sel => document.querySelector(sel)

// Texts in the board's language; the server says which one (config `language`), the toolbar switches it.
let t = translator(document.documentElement.lang)
const q = s => t('q', { s })

const COLORS = { work: 'var(--green)', me: 'var(--orange)', ext: 'var(--purple)', done: 'var(--blue)', idle: 'var(--gray)' }
const ICON = {
  focus: '<svg viewBox="0 0 20 20"><path d="M7 4.5h8.5V13M15 5 5 15"/></svg>',
  write: '<svg viewBox="0 0 20 20"><path d="M12.5 4.5l3 3L8 15H5v-3l7.5-7.5Z"/></svg>',
  moon: '<svg class="moon" viewBox="0 0 20 20"><path d="M15.5 12.2A6.5 6.5 0 0 1 7.8 4.5a6.5 6.5 0 1 0 7.7 7.7Z"/></svg>',
  clock: '<svg viewBox="0 0 20 20"><circle cx="10" cy="10" r="7"/><path d="M10 6v4l2.5 2"/></svg>',
  spin: '<svg class="spin" viewBox="0 0 20 20"><path d="M10 3a7 7 0 1 1-7 7"/></svg>',
  chev: '<svg class="chev" viewBox="0 0 20 20"><path d="m8 5 5 5-5 5"/></svg>',
  check: '<svg viewBox="0 0 20 20"><path d="m4.5 10.5 3.5 3.5 7.5-8"/></svg>',
  pin: '<svg viewBox="0 0 20 20"><circle cx="10" cy="7" r="3.5"/><path d="M10 10.5V17"/></svg>',
}

// ---------------------------------------------------------------- small helpers
const store = {
  get(k, d) {
    try {
      return localStorage.getItem(k) ?? d
    } catch {
      return d
    }
  },
  set(k, v) {
    try {
      localStorage.setItem(k, v)
    } catch {}
  },
}
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
/** Markdown down to plain text, for one-glance card lines. */
const plain = s =>
  String(s ?? '')
    .replace(/```[\s\S]*?```/g, ' … ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^\s*(#+|[-*•]|\d+\.)\s+/gm, '')
    .replace(/[*_`>]+/g, '')
    .replace(/\s+/g, ' ')
    .trim()
/** Previews of images sent from the board: their paths in a message point into the uploads folder. */
const UPLOAD_IMAGE = /agent-board[\\/]uploads[\\/](\d{4}-\d{2}-\d{2})[\\/]([^\s\\/]+\.(?:png|jpe?g|gif|webp))/gi
const thumbs = text => {
  const urls = [...String(text ?? '').matchAll(UPLOAD_IMAGE)].map(m => `/uploads/${m[1]}/${encodeURIComponent(m[2])}`)
  return urls.length ? `<div class="thumbs">${urls.map(u => `<a href="${u}" target="_blank" rel="noopener"><img src="${u}" alt="" loading="lazy"></a>`).join('')}</div>` : ''
}
function ago(ms) {
  if (!ms) return ''
  const m = Math.floor((Date.now() - ms) / 60_000)
  if (m < 1) return t('ago.now')
  if (m < 60) return t('ago.min', { n: m })
  const h = Math.floor(m / 60)
  return h < 24 ? t('ago.h', { n: h }) : t('ago.d', { n: Math.floor(h / 24) })
}
const clock = ms => (ms ? new Date(ms).toLocaleTimeString(t.lang, { hour: '2-digit', minute: '2-digit' }) : '')

// ---------------------------------------------------------------- state
const state = {
  data: { items: [], categories: [], columns: [] },
  filter: store.get('board.filter', 'all'),
  query: '',
  sleepers: store.get('board.sleepers', '1') === '1',
  open: null, // key of the session in the sheet
  detail: null,
  busy: new Map(), // key -> what is happening ("Waking…")
  moved: new Map(), // key -> category the user dropped it in, until the server agrees
  movedCol: new Map(), // key -> { col, at }: column the user dropped it in, until the server agrees
}
const itemOf = key => state.data.items.find(i => i.key === key)
const catOf = it => state.moved.get(it.key) ?? it.category
const colOf = it => state.movedCol.get(it.key)?.col ?? it.column
/** A turn is on: it works, or a dialog stopped it midway. */
const inTurn = it => it.status === 'working' || it.status === 'blocked'
const catInfo = id => state.data.categories.find(c => c.id === id) ?? { id, title: id, color: 'var(--gray)' }
const compact = it => it.sleeping && it.column === 'idle'

function visibleItems() {
  const q = state.query.trim().toLowerCase()
  return state.data.items.filter(it => {
    if (!state.sleepers && it.sleeping && it.column === 'idle') return false
    if (!q) return true
    return [it.name, it.doing, it.wait, it.title, it.lastText, it.prompt, it.workspace, catInfo(catOf(it)).title]
      .some(v => v && String(v).toLowerCase().includes(q))
  })
}

// ---------------------------------------------------------------- data
let lastDetailStamp = ''
function onData(data) {
  // The page's own files changed (the plugin was updated): load the new page.
  if (state.version && data.version && data.version !== state.version) return location.reload()
  state.version = data.version
  state.data = data
  // Right after a switch from this page, a board sent before it may still come in: let it pass.
  const asked = state.langAsked && Date.now() - state.langAsked.at < 4000 ? state.langAsked.lang : null
  if (data.lang && data.lang !== t.lang && (!asked || data.lang === asked)) setLanguage(data.lang)
  for (const [key, cat] of state.moved) if (itemOf(key)?.category === cat) state.moved.delete(key)
  for (const [key, m] of state.movedCol) if (itemOf(key)?.column === m.col || Date.now() - m.at > 8000) state.movedCol.delete(key)
  render()
  if (state.open) {
    const it = itemOf(state.open)
    const stamp = it ? `${it.activity}|${it.status}|${it.column}|${it.wait}|${it.doing}|${it.category}` : ''
    if (stamp !== lastDetailStamp) {
      lastDetailStamp = stamp
      loadDetail(state.open)
    }
  }
}

function connect() {
  const live = $('#live')
  const source = new EventSource('/api/events')
  source.onopen = () => {
    live.classList.add('on')
    live.title = t('live.on')
  }
  source.onerror = () => {
    live.classList.remove('on')
    live.title = t('live.off')
  }
  source.onmessage = e => {
    try {
      onData(JSON.parse(e.data))
    } catch {}
  }
}

async function act(key, action, body = {}) {
  try {
    const res = await fetch(`/api/session/${encodeURIComponent(key)}/${action}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-board': '1' },
      body: JSON.stringify(body),
    })
    const r = await res.json().catch(() => ({}))
    return res.ok && r.ok !== false ? { ok: true } : { ok: false, error: r.error || t('err.status', { code: res.status }) }
  } catch (err) {
    return { ok: false, error: t('err.offline', { why: err.message }) }
  }
}

function setBusy(key, label) {
  if (label) state.busy.set(key, label)
  else state.busy.delete(key)
  render()
}

/** A question that does not need an answer: off the "Needs me" column until the next one. */
async function dismissAsk(key) {
  const it = itemOf(key)
  const r = await act(key, 'card', { dismiss: true })
  const name = it?.name ?? t('session')
  toast(r.ok ? (it?.attention === 'later' ? t('toast.unparked', { name, col: q(colTitle('me')) }) : t('toast.dismissed', { name })) : r.error, !r.ok)
}

/** Claude exits through herdr-wake; the pane stays as 💤 and wakes on a message or "Wake". */
async function sleepSession(key) {
  const it = itemOf(key)
  if (!it || it.sleeping) return
  setBusy(key, t('busy.sleeping'))
  const r = await act(key, 'sleep')
  setBusy(key, null)
  toast(r.ok ? t('asleep', { name: it.name }) : r.error, !r.ok)
}

// The page's own dictionary, so a switch from here shows at once (the server's titles come from the same one).
const colTitle = id => t(`col.${id}`)

/**
 * Move a card to another lane and/or column: on screen at once, then on the server. A column is
 * a pin that holds until the session works again; dragged while it works, the card stays under
 * "Working" and moves when that turn is over. Its own column (`auto`) takes the pin off.
 */
async function moveCard(key, { cat = null, column = null }) {
  const it = itemOf(key)
  if (!it || (!cat && !column)) return
  const turn = inTurn(it)
  if (cat) state.moved.set(key, cat)
  if (column && !turn) state.movedCol.set(key, { col: column, at: Date.now() })
  render()
  if (state.open === key) renderSheetBody(false)
  const r = await act(key, 'card', { ...(cat && { category: cat }), ...(column && { column }) })
  if (!r.ok) {
    state.moved.delete(key)
    state.movedCol.delete(key)
    render()
    return toast(r.error, true)
  }
  const parts = cat ? [catInfo(cat).title] : []
  if (column) parts.push(t(column === it.auto ? 'move.auto' : turn ? 'move.afterTurn' : 'q', { col: q(colTitle(column)), s: colTitle(column) }))
  toast(t('moved', { name: it.name, where: parts.join(', ') }))
}

async function focusSession(key) {
  const it = itemOf(key)
  if (!it) return
  if (it.sleeping) setBusy(key, t('busy.waking'))
  const r = await act(key, 'focus')
  setBusy(key, null)
  toast(r.ok ? t('toast.focused', { name: it.name }) : r.error, !r.ok)
}

// ---------------------------------------------------------------- language
/** The page in another language: the static texts by their data-i18n attributes, and every part drawn already. */
function setLanguage(lang) {
  t = translator(lang)
  document.documentElement.lang = t.lang
  applyTexts()
  for (const lane of lanes.values()) for (const [id, col] of lane.cols) col.querySelector('.col-label').lastChild.textContent = colTitle(id)
  for (const row of catRows.values()) row.remove()
  catRows.clear()
  if (catDraft) renderDraft()
  sheetCard._html = ''
  if (state.open) renderSheetBody(false)
  renderAttachments()
  syncComposer()
}

function applyTexts() {
  for (const el of document.querySelectorAll('[data-i18n]')) el.textContent = t(el.dataset.i18n)
  for (const el of document.querySelectorAll('[data-i18n-title]')) el.title = t(el.dataset.i18nTitle)
  for (const el of document.querySelectorAll('[data-i18n-label]')) el.setAttribute('aria-label', t(el.dataset.i18nLabel))
  for (const el of document.querySelectorAll('[data-i18n-placeholder]')) el.placeholder = t(el.dataset.i18nPlaceholder)
  const live = $('#live')
  live.title = t(live.classList.contains('on') ? 'live.on' : 'live.none')
  const names = state.data.languages ?? LANGUAGES
  $('#lang-code').textContent = t.lang.toUpperCase()
  $('#lang').title = t('tb.lang', { name: names[t.lang] ?? t.lang })
}

// ---------------------------------------------------------------- toolbar
const segThumb = { x: new Spring({ damping: 1, response: 0.32 }), w: new Spring({ damping: 1, response: 0.32 }) }
function renderToolbar(visible) {
  const all = state.data.items
  const count = col => all.filter(i => i.column === col).length
  const asleep = all.filter(i => i.sleeping).length
  const parts = [`<b>${all.length}</b> ${t('sum.sessions', { n: all.length })}`]
  if (count('work')) parts.push(`<b>${count('work')}</b> ${t('sum.working', { n: count('work') })}`)
  if (count('me')) parts.push(`<b>${count('me')}</b> ${t('sum.needYou', { n: count('me') })}`)
  if (count('ext')) parts.push(`<b>${count('ext')}</b> ${t('sum.waitOthers', { n: count('ext') })}`)
  if (asleep) parts.push(`${asleep} ${t('sum.asleep', { n: asleep })}`)
  $('#summary').innerHTML = parts.join(' · ')
  document.title = count('me') ? `(${count('me')}) Agent board` : 'Agent board'

  // Lanes control: "All" and the categories that have sessions.
  const seg = $('#lanes')
  const used = state.data.categories.filter(c => visible.some(i => catOf(i) === c.id) || c.id === state.filter)
  const options = [{ id: 'all', title: t('all'), n: visible.length }, ...used.map(c => ({ id: c.id, title: c.title, n: visible.filter(i => catOf(i) === c.id).length }))]
  const sig = options.map(o => `${o.id}:${o.title}:${o.n}`).join('|')
  if (seg.dataset.sig !== sig) {
    seg.dataset.sig = sig
    seg.innerHTML = `<span class="thumb"></span>${options
      .map(o => `<button role="tab" data-id="${esc(o.id)}" aria-selected="${o.id === state.filter}">${esc(o.title)}<span class="n">${o.n}</span></button>`)
      .join('')}`
    const thumb = seg.querySelector('.thumb')
    const apply = () => {
      thumb.style.transform = `translateX(${segThumb.x.value}px)`
      thumb.style.width = `${segThumb.w.value}px`
    }
    segThumb.x.onUpdate = segThumb.w.onUpdate = apply
    placeThumb(true)
  }
  for (const b of seg.querySelectorAll('button')) b.setAttribute('aria-selected', String(b.dataset.id === state.filter))
  placeThumb(false)

  // Column heads with counts.
  const head = $('#columns-head')
  const html = state.data.columns
    .map(c => `<div class="col-head"><span class="dot" style="--c:${COLORS[c.id]}"></span>${esc(colTitle(c.id))}<span class="n">${visible.filter(i => i.column === c.id && laneShown(catOf(i))).length}</span></div>`)
    .join('')
  if (head.innerHTML !== html) head.innerHTML = html
}

function placeThumb(jump) {
  const seg = $('#lanes')
  const btn = seg.querySelector(`button[data-id="${CSS.escape(state.filter)}"]`) ?? seg.querySelector('button')
  if (!btn) return
  const x = btn.offsetLeft
  const w = btn.offsetWidth
  if (jump || !segThumb.w.value) {
    segThumb.x.set(x)
    segThumb.w.set(w)
  } else if (segThumb.x.target !== x || segThumb.w.target !== w) {
    segThumb.x.to(x)
    segThumb.w.to(w)
  }
}

const laneShown = cat => state.filter === 'all' || state.filter === cat

// ---------------------------------------------------------------- board
const lanes = new Map() // category id -> { root, grid, tag, count, cols: Map(column id -> el) }
const cards = new Map() // key -> article

function laneOf(cat) {
  let lane = lanes.get(cat)
  if (lane) return lane
  const root = document.createElement('section')
  root.className = 'lane'
  root.dataset.cat = cat
  root.innerHTML = '<header class="lane-head"><span class="lane-tag"></span><span class="lane-count"></span></header><div class="lane-grid"></div>'
  const grid = root.querySelector('.lane-grid')
  const cols = new Map()
  for (const c of state.data.columns) {
    const col = document.createElement('div')
    col.className = 'col'
    col.dataset.col = c.id
    col.innerHTML = `<div class="col-label"><span class="dot" style="--c:${COLORS[c.id]}"></span>${esc(colTitle(c.id))}</div>`
    grid.append(col)
    cols.set(c.id, col)
  }
  lane = { root, grid, cols, tag: root.querySelector('.lane-tag'), count: root.querySelector('.lane-count') }
  lanes.set(cat, lane)
  return lane
}

const dismissable = it => it.attention === 'ask' || it.attention === 'question' || it.attention === 'later'

function cardHTML(it) {
  const dismiss = dismissable(it) ? `<button data-act="dismiss" title="${esc(it.attention === 'later' ? t('card.seen', { col: q(colTitle('me')) }) : t('card.noReply'))}">${ICON.check}</button>` : ''
  const sleep = !it.sleeping && it.session && !inTurn(it) ? `<button data-act="sleep" title="${esc(t('card.sleep'))}">${ICON.moon}</button>` : ''
  const actions = `<div class="card-actions">${dismiss}${sleep}<button data-act="write" title="${esc(t('card.write'))}">${ICON.write}</button><button data-act="focus" title="${esc(t('card.focus'))}">${ICON.focus}</button></div>`
  const dot = it.sleeping ? ICON.moon : `<span class="dot ${it.column}" style="--c:${COLORS[it.column]}"></span>`
  const age = ago(it.column === 'ext' ? it.waitSince || it.activity : it.activity)
  const pin = it.pin && it.pin === it.column ? `<span class="pinned" title="${esc(t('card.pinned'))}">${ICON.pin}</span>` : ''
  const top = `<div class="card-top">${dot}<span class="name">${esc(it.name)}</span>${pin}<span class="age">${esc(age)}</span></div>`
  if (compact(it)) return top + actions
  // What it works on: its own words, else Claude's title of the session, else your last request.
  const own = plain(it.doing || (it.title && it.title !== it.name ? it.title : ''))
  const asked = own ? '' : plain(it.prompt)
  const what = own || asked
  const said = plain(it.column === 'done' || it.column === 'idle' ? it.result || it.lastText : it.lastText)
  let body = own ? `<div class="what">${esc(own)}</div>` : asked ? `<div class="what"><span class="you">${esc(t('card.you'))}</span> ${esc(asked)}</div>` : ''
  if (it.column === 'me') body += `<div class="ask"><b>${esc(t(it.attention ? `att.${it.attention}` : 'att.default'))}:</b> ${esc(plain(it.question) || t(it.attention === 'later' ? 'card.lookLater' : 'card.needsDecision'))}</div>`
  if (it.column === 'ext') body += `<div class="chip">${ICON.clock}<span>${esc(it.wait || t('note.parked'))}</span></div>`
  if (it.column !== 'me' && said && said !== what) body += `<div class="said">${esc(said)}</div>`
  if (it.column === 'work') {
    const tool = it.tool
    body += tool?.pending
      ? `<div class="now">${ICON.spin}<span class="tool">${esc(tool.label)}</span><span class="detail">${esc(tool.detail)}</span></div>`
      : `<div class="now idle">${ICON.spin}<span class="tool">${esc(t('card.thinking'))}</span><span class="detail">${tool ? esc(t('card.after', { tool: tool.label })) : ''}</span></div>`
  }
  return top + body + actions
}

function updateCard(card, it) {
  const html = cardHTML(it)
  if (card._html !== html) {
    card.innerHTML = html
    card._html = html
  }
  card.dataset.col = it.column
  card.classList.toggle('compact', compact(it))
  card.classList.toggle('selected', state.open === it.key)
  const busy = state.busy.get(it.key)
  card.classList.toggle('busy', !!busy)
  if (busy) card.dataset.busy = busy
}

function cardOf(key) {
  let card = cards.get(key)
  if (card) return card
  card = document.createElement('article')
  card.className = 'card'
  card.dataset.key = key
  card.tabIndex = 0
  card.addEventListener('pointerdown', onCardDown)
  card.addEventListener('click', onCardClick)
  card.addEventListener('keydown', e => {
    if (e.key === 'Enter' && e.target === card) openSheet(key)
  })
  cards.set(key, card)
  appear(card)
  return card
}

function render() {
  const first = measure()
  const visible = visibleItems()
  renderToolbar(visible)
  const board = $('#board')
  const order = state.data.categories.map(c => c.id)
  const seen = new Set()
  let anyShown = false
  // Lanes move in the DOM only when their order changes: moving a node drops a pointer capture.
  const placed = [...board.children].filter(n => n.classList.contains('lane')).map(n => n.dataset.cat)
  const reorder = placed.join('|') !== order.join('|')
  for (const id of order) {
    const lane = laneOf(id)
    const info = catInfo(id)
    const its = visible.filter(i => catOf(i) === id)
    lane.root.style.setProperty('--lane', info.color)
    if (lane.tag.textContent !== info.title) lane.tag.textContent = info.title
    lane.count.textContent = its.length || ''
    lane.root.classList.toggle('empty-lane', !its.length)
    lane.root.classList.toggle('filtered', !laneShown(id))
    if (its.length && laneShown(id)) anyShown = true
    for (const [colId, col] of lane.cols) {
      const list = its.filter(i => colOf(i) === colId)
      col.classList.toggle('has-cards', list.length > 0)
      let prev = col.firstElementChild // the narrow-window label stays first
      for (const it of list) {
        const card = cardOf(it.key)
        updateCard(card, it)
        seen.add(it.key)
        if (prev.nextElementSibling !== card) prev.after(card)
        prev = card
      }
      while (prev.nextElementSibling) {
        const extra = prev.nextElementSibling
        if (seen.has(extra.dataset.key)) prev = extra
        else extra.remove()
      }
    }
    if (reorder) board.append(lane.root)
  }
  for (const [key, card] of cards) {
    if (!seen.has(key) && card !== drag?.card) {
      card.remove()
      cards.delete(key)
    }
  }
  let empty = board.querySelector('.empty')
  if (!anyShown) {
    if (!empty) {
      empty = document.createElement('p')
      empty.className = 'empty'
      board.prepend(empty)
    }
    empty.textContent = t(state.data.items.length ? 'empty.none' : 'empty.noSessions')
  } else empty?.remove()
  flip(first)
  if (state.open) renderSheetHead()
  renderCats()
}

// ---------------------------------------------------------------- motion: FLIP with springs
const motion = new WeakMap() // card -> { x, y } springs of its offset from its layout place

function motionOf(el) {
  let m = motion.get(el)
  if (m) return m
  const apply = () => {
    const { x, y } = m
    if (!x.moving && !y.moving && !x.value && !y.value) {
      el.style.transform = ''
      el.classList.remove('moving')
    } else el.style.transform = `translate3d(${x.value}px, ${y.value}px, 0)`
  }
  m = {
    x: new Spring({ damping: 1, response: 0.42, precision: 0.2, onUpdate: apply, onRest: apply }),
    y: new Spring({ damping: 1, response: 0.42, precision: 0.2, onUpdate: apply, onRest: apply }),
    apply,
  }
  motion.set(el, m)
  return m
}

function measure() {
  const rects = new Map()
  if (reducedMotion.matches) return rects
  for (const [key, el] of cards) if (el.isConnected && el.offsetParent) rects.set(key, el.getBoundingClientRect())
  return rects
}

/** Cards that changed place start from where they were on screen and spring into the new one. */
function flip(first) {
  for (const [key, before] of first) {
    const el = cards.get(key)
    if (!el?.offsetParent) continue
    const after = el.getBoundingClientRect()
    const dx = before.left - after.left
    const dy = before.top - after.top
    if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) continue
    const m = motionOf(el)
    el.classList.add('moving')
    m.x.value += dx
    m.y.value += dy
    m.apply() // this frame already, or it would flash at its new place
    m.x.to(0)
    m.y.to(0)
  }
}

/** A new card materializes: a little scale and fade, critically damped. */
function appear(el) {
  if (reducedMotion.matches) return
  const s = new Spring({
    value: 0,
    damping: 1,
    response: 0.35,
    precision: 0.002,
    onUpdate: v => {
      el.style.opacity = String(v)
      el.style.scale = String(0.96 + 0.04 * v)
    },
    onRest: () => {
      el.style.opacity = ''
      el.style.scale = ''
    },
  })
  s.to(1)
}

// ---------------------------------------------------------------- drag a card to another lane or column
let drag = null

function onCardDown(e) {
  if (e.button !== 0 || e.target.closest('[data-act]')) return
  const card = e.currentTarget
  const rect = card.getBoundingClientRect()
  drag = {
    card,
    key: card.dataset.key,
    id: e.pointerId,
    sx: e.clientX,
    sy: e.clientY,
    ox: e.clientX - rect.left, // where it was grabbed, kept for the whole drag
    oy: e.clientY - rect.top,
    rect,
    samples: [{ x: e.clientX, y: e.clientY, t: e.timeStamp }],
    started: false,
    target: null, // what a drop here changes (dropTarget)
    lit: null, // the lane or column lit up as the drop place
  }
  card.setPointerCapture(e.pointerId)
  card.addEventListener('pointermove', onDragMove)
  card.addEventListener('pointerup', onDragEnd)
  card.addEventListener('pointercancel', onDragEnd)
}

function onDragMove(e) {
  if (!drag || e.pointerId !== drag.id) return
  drag.samples.push({ x: e.clientX, y: e.clientY, t: e.timeStamp })
  if (drag.samples.length > 12) drag.samples.shift()
  if (!drag.started) {
    if (Math.hypot(e.clientX - drag.sx, e.clientY - drag.sy) < 6) return
    startDrag()
  }
  drag.x.set(e.clientX - drag.ox)
  drag.y.set(e.clientY - drag.oy)
  const target = dropTarget(drag.key, document.elementFromPoint(e.clientX, e.clientY))
  // The column lights up when the card changes column there, else the lane when only the lane changes.
  const lit = target?.column ? target.colEl : target?.cat ? target.lane : null
  if (lit !== drag.lit) {
    drag.lit?.classList.remove('drop')
    lit?.classList.add('drop')
    drag.lit = lit
  }
  drag.target = target
  if (e.clientY < 150) scrollBy(0, -14)
  else if (e.clientY > innerHeight - 70) scrollBy(0, 14)
}

/**
 * What dropping the card on `el` changes: { cat, column, lane, colEl }, null when nothing. A lane
 * head or the gap between columns changes only the lane; "Working" takes no cards.
 */
function dropTarget(key, el) {
  const it = itemOf(key)
  const lane = el?.closest('.lane')
  if (!it || !lane) return null
  const colEl = el.closest('.col')
  const cat = lane.dataset.cat !== catOf(it) ? lane.dataset.cat : null
  const column = colEl && colEl.dataset.col !== 'work' && colEl.dataset.col !== colOf(it) ? colEl.dataset.col : null
  return cat || column ? { cat, column, lane, colEl } : null
}

function startDrag() {
  const d = drag
  d.started = true
  const ghost = d.card.cloneNode(true)
  ghost.classList.remove('selected', 'moving')
  ghost.classList.add('ghost')
  ghost.style.width = `${d.rect.width}px`
  ghost.style.transformOrigin = `${d.ox}px ${d.oy}px`
  ghost.style.transform = ''
  document.body.append(ghost)
  d.ghost = ghost
  const apply = () => (ghost.style.transform = `translate3d(${d.x.value}px, ${d.y.value}px, 0) scale(${d.s.value})`)
  d.x = new Spring({ value: d.rect.left, damping: 0.8, response: 0.35, precision: 0.3, onUpdate: apply })
  d.y = new Spring({ value: d.rect.top, damping: 0.8, response: 0.35, precision: 0.3, onUpdate: apply })
  d.s = new Spring({ value: 1, damping: 0.75, response: 0.28, precision: 0.001, onUpdate: apply })
  d.s.to(1.035)
  apply()
  d.card.classList.add('placeholder')
  document.body.classList.add('dragging')
}

function onDragEnd(e) {
  const d = drag
  if (!d || e.pointerId !== d.id) return
  drag = null
  d.card.removeEventListener('pointermove', onDragMove)
  d.card.removeEventListener('pointerup', onDragEnd)
  d.card.removeEventListener('pointercancel', onDragEnd)
  if (!d.started) return // a plain click; onCardClick opens the sheet
  // The click that may follow this release is not a click; one that comes later is.
  d.card._draggedAt = performance.now()
  const v = velocityOf(d.samples)
  d.lit?.classList.remove('drop')
  document.body.classList.remove('dragging')
  if (d.target) moveCard(d.key, d.target)
  else render()
  // Land where the card now lives, carrying the release velocity into the spring.
  const r = d.card.getBoundingClientRect()
  let resting = 0
  const done = () => {
    if (++resting < 3) return
    d.ghost.remove()
    d.card.classList.remove('placeholder')
  }
  d.x.onRest = d.y.onRest = d.s.onRest = done
  d.x.to(r.left, { velocity: v.x })
  d.y.to(r.top, { velocity: v.y })
  d.s.to(1, { damping: 1, response: 0.3 })
  if (reducedMotion.matches) {
    d.ghost.remove()
    d.card.classList.remove('placeholder')
  }
}

function onCardClick(e) {
  const card = e.currentTarget
  if (performance.now() - (card._draggedAt ?? -1e9) < 350) return
  const key = card.dataset.key
  const btn = e.target.closest('[data-act]')
  if (btn?.dataset.act === 'focus') return focusSession(key)
  if (btn?.dataset.act === 'write') return openSheet(key, { compose: true })
  if (btn?.dataset.act === 'dismiss') return dismissAsk(key)
  if (btn?.dataset.act === 'sleep') return sleepSession(key)
  openSheet(key)
}

// ---------------------------------------------------------------- side panels
// A panel slides in from the right edge and leaves the same way. It follows the pointer 1:1
// when dragged by its head, resists leftwards, and the release velocity decides: a projected
// landing point past half its width closes it. Only one panel is open at a time.
const panels = []
class Panel {
  constructor(el, { onClose = () => {} } = {}) {
    this.el = el
    this.isOpen = false
    this.onClose = onClose
    this.x = new Spring({ damping: 1, response: 0.34, precision: 0.3, onUpdate: v => (el.style.transform = `translateX(${v}px)`) })
    el.querySelector('[data-close]')?.addEventListener('click', () => this.close())
    this.flick()
    panels.push(this)
  }

  off() {
    return this.el.offsetWidth + 32
  }

  /** Returns false when it was open already. */
  open() {
    if (this.isOpen) return false
    for (const p of panels) if (p !== this) p.close()
    this.isOpen = true
    this.el.classList.add('open')
    this.el.setAttribute('aria-hidden', 'false')
    this.x.onRest = () => {}
    if (!this.x.moving && !this.x.value) this.x.set(this.off())
    this.x.to(0, { damping: 0.9, response: 0.4 })
    return true
  }

  close(velocity = 0) {
    if (!this.isOpen) return
    this.isOpen = false
    this.x.onRest = () => {
      if (this.isOpen) return
      this.el.classList.remove('open')
      this.el.setAttribute('aria-hidden', 'true')
    }
    this.x.to(this.off(), { velocity, damping: 1, response: 0.3 })
    this.onClose()
  }

  flick() {
    let g = null
    const el = this.el
    el.addEventListener('pointerdown', e => {
      if (e.button !== 0 || !e.target.closest('.sheet-head, .sheet-grip') || e.target.closest('button, input')) return
      this.x.stop()
      g = { id: e.pointerId, sx: e.clientX, base: this.x.value, samples: [{ x: e.clientX, y: 0, t: e.timeStamp }], moved: false }
      el.setPointerCapture(e.pointerId)
    })
    el.addEventListener('pointermove', e => {
      if (!g || e.pointerId !== g.id) return
      g.samples.push({ x: e.clientX, y: 0, t: e.timeStamp })
      if (g.samples.length > 12) g.samples.shift()
      if (!g.moved && Math.abs(e.clientX - g.sx) < 6) return
      g.moved = true
      const dx = g.base + e.clientX - g.sx
      this.x.set(dx >= 0 ? dx : rubberband(dx, el.offsetWidth))
    })
    const end = e => {
      if (!g || e.pointerId !== g.id) return
      const { moved, samples } = g
      g = null
      if (!moved) return
      const v = velocityOf(samples).x
      if (this.x.value + project(v) > el.offsetWidth / 2) this.close(v)
      else this.x.to(0, { velocity: v, damping: 0.8, response: 0.3 })
    }
    el.addEventListener('pointerup', end)
    el.addEventListener('pointercancel', end)
  }
}

// A click on the board beside an open panel closes it. A card switches the panel to its own
// session instead, controls keep their own job, and a press that travelled (a card drag, a text
// selection ending outside the panel) is not a click.
{
  let down = null
  const keeps = '.sheet, .card, .lane-head, button, input, textarea, select, label, a, [data-act]'
  addEventListener('pointerdown', e => (down = e.button === 0 ? { x: e.clientX, y: e.clientY, target: e.target } : null), true)
  addEventListener('click', e => {
    const d = down
    down = null
    const open = panels.find(p => p.isOpen)
    if (!open || !d || Math.hypot(e.clientX - d.x, e.clientY - d.y) > 6) return
    if (d.target.closest?.(keeps) || e.target.closest?.(keeps)) return
    open.close()
  })
}

// ---------------------------------------------------------------- the session sheet
const sheetBody = $('#sheet-body')
const sessionPanel = new Panel($('#sheet'), {
  onClose: () => {
    state.open = null
    render()
  },
})
let detailSeq = 0
let draftFor = null // the session the composer's attachments were added for; outlives a close

function openSheet(key, { compose = false } = {}) {
  const switching = sessionPanel.isOpen && state.open !== key
  // Attachments belong to the session they were added for, never to the next one. Closing the
  // panel and opening the same session again keeps them.
  if (draftFor !== key && attachments.length) {
    clearAttachments()
    toast(t('toast.attachDropped'))
  }
  draftFor = key
  state.open = key
  state.detail = null
  lastDetailStamp = ''
  if (!sessionPanel.open() && switching && !reducedMotion.matches) {
    sheetBody.animate([{ opacity: 0.3 }, { opacity: 1 }], { duration: 180, easing: 'ease-out' })
  }
  renderSheetHead()
  renderSheetBody(true)
  loadDetail(key)
  render()
  if (compose) setTimeout(() => $('#message').focus(), 50)
}

async function loadDetail(key) {
  const seq = ++detailSeq
  try {
    const res = await fetch(`/api/session/${encodeURIComponent(key)}`)
    const d = await res.json()
    if (seq !== detailSeq || state.open !== key) return
    if (!res.ok) return toast(d.error || t('err.unavailable'), true)
    state.detail = d
    renderSheetBody(false)
  } catch {}
}

function renderSheetHead() {
  const it = itemOf(state.open)
  if (!it) return
  const pill = $('#sheet-status')
  pill.style.setProperty('--c', COLORS[it.column])
  pill.innerHTML = it.sleeping ? `${ICON.moon}${esc(t('sheet.asleep'))}` : `<span class="dot ${it.column}" style="--c:${COLORS[it.column]}"></span>${esc(colTitle(it.column))}`
  $('#sheet-name').textContent = it.name
  $('#sheet-meta').textContent = [catInfo(catOf(it)).title, it.workspace && t('meta.workspace', { name: it.workspace }), it.activity && (ago(it.activity) === t('ago.now') ? t('meta.activeNow') : t('meta.active', { ago: ago(it.activity) }))].filter(Boolean).join(' · ')
  $('#sheet-wake').hidden = !it.sleeping
  const sleep = $('#sheet-sleep')
  sleep.hidden = it.sleeping || !it.session
  sleep.disabled = inTurn(it)
  sleep.title = t(inTurn(it) ? 'sheet.sleepBusy' : 'sheet.sleepHint')
}

const sheetCard = $('#sheet-card')

/** The card's own fields, pinned under the sheet's head. Left alone while one is being edited. */
function renderSheetCard(it) {
  const cats = state.data.categories
    .map(c => `<button data-cat="${esc(c.id)}" style="--lane:${c.color}" aria-pressed="${catOf(it) === c.id}">${esc(c.title)}</button>`)
    .join('')
  // Columns the user can put it in; "Auto" drops the pin and lets the board decide again.
  const pinned = it.pin && colOf(it) === it.pin
  const cols =
    state.data.columns
      .filter(c => c.id !== 'work')
      .map(c => `<button data-col="${c.id}" style="--lane:${COLORS[c.id]}" aria-pressed="${colOf(it) === c.id}">${esc(c.title)}</button>`)
      .join('') + (pinned ? `<button class="auto" data-col="${it.auto}" title="${esc(t('chip.autoTitle', { col: q(colTitle(it.auto)) }))}">${esc(t('chip.auto'))}</button>` : '')
  const html = `
    <div class="group">
      <div class="row"><span class="row-label">${esc(t('row.category'))}</span><div class="row-value chips" id="cats">${cats}</div></div>
      <div class="row"><span class="row-label">${esc(t('row.status'))}</span><div class="row-value chips" id="cols">${cols}</div></div>
      <div class="row"><span class="row-label">${esc(t('row.doing'))}</span><input class="row-value" id="doing" value="${esc(it.doing)}" placeholder="${esc(plain(it.title && it.title !== it.name ? it.title : '') || t('row.doingNone'))}"></div>
      <div class="row"><span class="row-label">${esc(t('row.wait'))}</span><input class="row-value" id="wait" value="${esc(it.wait)}" placeholder="${esc(t('row.waitNone'))}"></div>
    </div>`
  if (sheetCard._html === html) return
  if (sheetCard.contains(document.activeElement) && document.activeElement.tagName === 'INPUT') {
    for (const b of sheetCard.querySelectorAll('#cats button')) b.setAttribute('aria-pressed', String(b.dataset.cat === catOf(it)))
    for (const b of sheetCard.querySelectorAll('#cols button')) b.setAttribute('aria-pressed', String(!b.classList.contains('auto') && b.dataset.col === colOf(it)))
    return
  }
  sheetCard.innerHTML = html
  sheetCard._html = html
}

function renderSheetBody(reset) {
  const it = itemOf(state.open)
  if (!it) return
  renderSheetCard(it)
  const atBottom = sheetBody.scrollHeight - sheetBody.scrollTop - sheetBody.clientHeight < 40
  let html = ''
  if (it.column === 'me') {
    const later = it.attention === 'later'
    const why = t(it.attention ? `why.${it.attention}` : 'why.default')
    const wave = dismissable(it) ? `<button class="button asked-dismiss" data-act="dismiss">${ICON.check}<span>${esc(t(later ? 'asked.seen' : 'asked.noReply'))}</span></button>` : ''
    const text = later ? t('asked.later') : it.question || t('asked.terminal')
    html += `<div class="asked"><b>${esc(why)}</b>${esc(text)}${wave}</div>`
    if (state.detail?.screen) html += `<pre class="screen">${esc(state.detail.screen)}</pre>`
  }
  html += `<div class="section-title">${esc(t('thread.title'))}</div><div class="thread">`
  const conv = state.detail?.conversation
  if (!conv) html += `<p class="row-value muted">${esc(t('loading'))}</p>`
  else if (!conv.length) html += `<p class="row-value muted">${esc(t('thread.empty'))}</p>`
  else html += thread(conv, it)
  html += '</div>'
  const open = new Set([...sheetBody.querySelectorAll('details[open]')].map(d => d.dataset.i))
  if (sheetBody._html !== html) {
    sheetBody.innerHTML = html
    sheetBody._html = html
    for (const d of sheetBody.querySelectorAll('details')) if (open.has(d.dataset.i)) d.open = true
  }
  if (reset || atBottom) sheetBody.scrollTop = sheetBody.scrollHeight
}

/** Messages as bubbles; runs of tool calls fold into one line that opens to show them. */
function thread(conv, it) {
  let html = ''
  let run = []
  let i = 0
  const flush = () => {
    if (!run.length) return
    const lastTool = run.at(-1)
    const live = !lastTool.done && it.column === 'work'
    const summary = live ? t('run.now', { tool: lastTool.label }) : `${t('run.actions', { n: run.length })} · ${lastTool.label}`
    html += `<details class="tools" data-i="${i++}"><summary>${live ? ICON.spin : ICON.chev}<span>${esc(summary)}</span></summary>${run
      .map(x => `<div class="tool-line${x.done ? '' : ' pending'}"><span class="t">${esc(x.label)}</span><span class="d">${esc(x.detail)}</span></div>`)
      .join('')}</details>`
    run = []
  }
  for (const m of conv) {
    if (m.role === 'tool') {
      run.push(m)
      continue
    }
    flush()
    html += `<div class="msg ${m.role}"><div class="md">${markdown(m.text)}</div>${thumbs(m.text)}<span class="when">${clock(m.at)}</span></div>`
  }
  flush()
  return html
}

sheetCard.addEventListener('click', e => {
  const b = e.target.closest('#cats button, #cols button')
  if (!b || !state.open) return
  moveCard(state.open, b.dataset.cat ? { cat: b.dataset.cat } : { column: b.dataset.col })
})

sheetCard.addEventListener('keydown', async e => {
  const input = e.target
  if (!['doing', 'wait'].includes(input.id)) return
  if (e.key === 'Escape') {
    input.value = itemOf(state.open)?.[input.id] ?? ''
    input.blur()
    e.stopPropagation()
    return
  }
  if (e.key !== 'Enter') return
  e.preventDefault()
  const r = await act(state.open, 'card', { [input.id]: input.value })
  input.blur()
  toast(r.ok ? t(input.id === 'wait' ? (input.value.trim() ? 'toast.waitSet' : 'toast.waitCleared') : 'saved') : r.error, !r.ok)
})

sheetBody.addEventListener('click', e => {
  if (e.target.closest('[data-act="dismiss"]') && state.open) dismissAsk(state.open)
})
$('#sheet-focus').addEventListener('click', () => state.open && focusSession(state.open))
$('#sheet-wake').addEventListener('click', async () => {
  const key = state.open
  if (!key) return
  setBusy(key, t('busy.waking'))
  const r = await act(key, 'wake')
  setBusy(key, null)
  toast(r.ok ? t('toast.woke') : r.error, !r.ok)
})
$('#sheet-sleep').addEventListener('click', () => state.open && sleepSession(state.open))

// Composer: Enter sends, Shift+Enter breaks the line; the box grows with the text. Files come
// in through the clip, Ctrl+V (a screenshot) or a drop on the panel; each uploads at once and
// the message carries their paths.
const message = $('#message')
const sendBtn = $('#composer .send')
const attachments = [] // { id, name, size, image, url, status: uploading | done | error, path }
let attachSeq = 0

const syncComposer = () => {
  message.style.height = 'auto'
  message.style.height = `${Math.min(180, message.scrollHeight)}px`
  const uploading = attachments.some(a => a.status === 'uploading')
  const ready = attachments.some(a => a.status === 'done')
  sendBtn.disabled = uploading || !(message.value.trim() || ready)
  sendBtn.title = t(uploading ? 'compose.uploading' : 'compose.send')
}

const size = n => (n < 1024 ? t('size.b', { n }) : n < 1 << 20 ? t('size.kb', { n: Math.round(n / 1024) }) : t('size.mb', { n: (n / (1 << 20)).toFixed(1) }))

function renderAttachments() {
  const box = $('#attachments')
  box.innerHTML = attachments
    .map(
      a => `<div class="attachment ${a.status}" data-id="${a.id}" title="${esc(a.name)}">
        ${a.image ? `<img src="${a.url}" alt="">` : `<span class="file-icon"><svg viewBox="0 0 20 20"><path d="M5.5 2.5h6l3.5 3.5v11.5h-9.5Z"/><path d="M11.5 2.5V6H15"/></svg></span>`}
        <span class="att-text"><span class="att-name">${esc(a.name)}</span><span class="att-size">${a.status === 'uploading' ? esc(t('file.uploading')) : a.status === 'error' ? esc(t('file.failed')) : size(a.size)}</span></span>
        <button type="button" class="att-remove" title="${esc(t('file.remove'))}" aria-label="${esc(t('file.remove'))}">×</button>
      </div>`,
    )
    .join('')
  box.classList.toggle('has', attachments.length > 0)
}

async function upload(a, file) {
  try {
    const res = await fetch('/api/upload', {
      method: 'POST',
      headers: { 'x-board': '1', 'x-filename': encodeURIComponent(a.name), 'content-type': file.type || 'application/octet-stream' },
      body: file,
    })
    const r = await res.json().catch(() => ({}))
    if (!res.ok || !r.ok) throw new Error(r.error || t('err.status', { code: res.status }))
    a.status = 'done'
    a.path = r.path
  } catch (err) {
    a.status = 'error'
    toast(t('err.upload', { name: a.name, why: err.message }), true)
  }
  renderAttachments()
  syncComposer()
}

function addFiles(files) {
  for (let file of files) {
    // A pasted screenshot arrives as "image.png": give it a name that says what it is.
    if (/^image\.(png|jpe?g)$/i.test(file.name)) {
      const stamp = new Date().toTimeString().slice(0, 8).replace(/:/g, '')
      file = new File([file], `screenshot-${stamp}.${file.name.split('.').pop()}`, { type: file.type })
    }
    const image = /^image\/(png|jpeg|gif|webp)$/.test(file.type)
    const a = { id: ++attachSeq, name: file.name, size: file.size, image, url: image ? URL.createObjectURL(file) : '', status: 'uploading', path: '' }
    attachments.push(a)
    upload(a, file)
  }
  renderAttachments()
  syncComposer()
}

function clearAttachments() {
  for (const a of attachments.splice(0)) if (a.url) URL.revokeObjectURL(a.url)
  renderAttachments()
  syncComposer()
}

$('#attach').addEventListener('click', () => $('#file-input').click())
$('#file-input').addEventListener('change', e => {
  addFiles([...e.target.files])
  e.target.value = ''
  message.focus()
})
$('#attachments').addEventListener('click', e => {
  const btn = e.target.closest('.att-remove')
  if (!btn) return
  const i = attachments.findIndex(a => a.id === Number(btn.closest('.attachment').dataset.id))
  if (i >= 0) {
    const [a] = attachments.splice(i, 1)
    if (a.url) URL.revokeObjectURL(a.url)
  }
  renderAttachments()
  syncComposer()
})
message.addEventListener('paste', e => {
  const files = [...(e.clipboardData?.files ?? [])]
  if (!files.length) return
  e.preventDefault()
  addFiles(files)
})
{
  // Drop files anywhere on the session panel.
  const panel = $('#sheet')
  let depth = 0
  const hasFiles = e => [...(e.dataTransfer?.types ?? [])].includes('Files')
  panel.addEventListener('dragenter', e => {
    if (!hasFiles(e)) return
    depth++
    panel.classList.add('dropping')
  })
  panel.addEventListener('dragover', e => hasFiles(e) && e.preventDefault())
  panel.addEventListener('dragleave', () => {
    if (--depth <= 0) {
      depth = 0
      panel.classList.remove('dropping')
    }
  })
  panel.addEventListener('drop', e => {
    if (!hasFiles(e)) return
    e.preventDefault()
    depth = 0
    panel.classList.remove('dropping')
    addFiles([...e.dataTransfer.files])
  })
}

message.addEventListener('input', syncComposer)
message.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault()
    $('#composer').requestSubmit()
  }
})
$('#composer').addEventListener('submit', async e => {
  e.preventDefault()
  const key = state.open
  const text = message.value.trim()
  const files = attachments.filter(a => a.status === 'done').map(a => a.path)
  if (!key || (!text && !files.length) || attachments.some(a => a.status === 'uploading')) return
  const it = itemOf(key)
  sendBtn.disabled = true
  if (it?.sleeping) setBusy(key, t('busy.waking'))
  const r = await act(key, 'message', { text, files })
  setBusy(key, null)
  if (r.ok) {
    message.value = ''
    clearAttachments()
    toast(`${t('sent.to', { name: it?.name ?? t('session.lower') })}${files.length ? ` · ${t('sent.files', { n: files.length })}` : ''}`)
    setTimeout(() => state.open === key && loadDetail(key), 800)
  } else toast(r.error, true)
  syncComposer()
})
syncComposer()

// ---------------------------------------------------------------- toasts
function toast(text, error = false) {
  if (!text) return
  const el = document.createElement('div')
  el.className = `toast${error ? ' error' : ''}`
  el.textContent = text
  $('#toasts').append(el)
  const s = new Spring({
    value: 0,
    damping: 1,
    response: 0.3,
    precision: 0.002,
    onUpdate: v => {
      el.style.opacity = String(v)
      el.style.transform = `translateY(${(1 - v) * 14}px) scale(${0.97 + 0.03 * v})`
    },
  })
  s.to(1)
  setTimeout(() => {
    s.onRest = () => el.remove()
    s.to(0)
  }, error ? 6000 : 2600)
}

// ---------------------------------------------------------------- categories
// Lanes are edited where they are seen: rename, recolor, the folders that sort sessions in,
// delete, and drag to reorder. Every change goes to config.json at once and comes back over the
// live stream, to this page, the terminal board and the agents' next brief alike.
const catsPanel = new Panel($('#cats-sheet'), {
  onClose: () => {
    catDraft = null
    renderDraft()
  },
})
const catsList = $('#cats-list')
const catRows = new Map() // category id -> row
let catDraft = null // { touched } while a new category is being made
let catDrag = null

// A category titled in Cyrillic gets a latin id agents can type: "Ромашка" -> "romashka".
const TRANSLIT = { а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'c', ч: 'ch', ш: 'sh', щ: 'sch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya' }
const slug = s =>
  [...String(s).toLowerCase()]
    .map(c => TRANSLIT[c] ?? c)
    .join('')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32)
const GRIP = '<svg viewBox="0 0 20 20"><path d="M7.5 5h0M12.5 5h0M7.5 10h0M12.5 10h0M7.5 15h0M12.5 15h0" stroke-width="2.6"/></svg>'
const TRASH = '<svg viewBox="0 0 20 20"><path d="M4.5 6h11M8 6V4.5h4V6m-6 0 .7 9.5h6.6L14 6"/></svg>'

async function editCats(body) {
  try {
    const res = await fetch('/api/categories', { method: 'POST', headers: { 'content-type': 'application/json', 'x-board': '1' }, body: JSON.stringify(body) })
    const r = await res.json().catch(() => ({}))
    if (res.ok && r.ok !== false) return true
    toast(r.error || t('err.status', { code: res.status }), true)
  } catch (err) {
    toast(t('err.offline', { why: err.message }), true)
  }
  return false
}

function openCats(focusId) {
  catsPanel.open()
  renderCats()
  const row = focusId && catRows.get(focusId)
  if (!row) return
  row.scrollIntoView({ block: 'center' })
  if (!reducedMotion.matches) row.animate([{ boxShadow: '0 0 0 3px var(--lane)' }, { boxShadow: 'var(--shadow-card)' }], { duration: 1200, easing: 'ease-out' })
}

function catRowOf(id) {
  let row = catRows.get(id)
  if (row) return row
  row = document.createElement('div')
  row.className = 'cat-row'
  row.dataset.id = id
  row.innerHTML = `
    <div class="cat-main">
      <button class="handle" title="${esc(t('cat.handle'))}" aria-label="${esc(t('cat.order'))}">${GRIP}</button>
      <button class="swatch" title="${esc(t('cat.color'))}" aria-label="${esc(t('cat.color'))}"></button>
      <input class="cat-title" spellcheck="false" aria-label="${esc(t('cat.titleLabel'))}">
      <span class="cat-count"></span>
      <button class="cat-add button" hidden>${esc(t('cat.add'))}</button>
      <button class="cat-del" title="${esc(t('cat.delete'))}">${TRASH}<span></span></button>
    </div>
    <div class="cat-sub">
      <span class="cat-id"></span>
      <span class="paths"></span>
      <input class="path-add" placeholder="${esc(t('cat.pathAdd'))}" spellcheck="false" aria-label="${esc(t('cat.pathAddLabel'))}">
    </div>
    <div class="palette" hidden></div>`
  catRows.set(id, row)
  return row
}

function updateCatRow(row, c, count) {
  row.style.setProperty('--lane', c.color)
  row.classList.toggle('adhoc', !c.configured)
  const title = row.querySelector('.cat-title')
  if (document.activeElement !== title) title.value = c.title
  title.readOnly = !c.configured
  row.querySelector('.cat-count').textContent = count ? t('cat.sessions', { n: count }) : t('cat.empty')
  row.querySelector('.cat-id').textContent = c.configured ? c.id : t('cat.byAgent', { id: c.id })
  row.querySelector('.cat-add').hidden = c.configured
  const del = row.querySelector('.cat-del')
  del.hidden = !c.configured || c.fallback
  if (!row.dataset.confirm) del.querySelector('span').textContent = ''
  const pathsSig = JSON.stringify(c.paths)
  const paths = row.querySelector('.paths')
  if (paths.dataset.sig !== pathsSig) {
    paths.dataset.sig = pathsSig
    paths.innerHTML = c.paths.map(p => `<span class="path"><span>${esc(p)}</span><button data-path="${esc(p)}" title="${esc(t('cat.pathRemove'))}" aria-label="${esc(t('file.remove'))}">×</button></span>`).join('')
  }
  row.querySelector('.path-add').hidden = !c.configured
  const palette = row.querySelector('.palette')
  const swSig = `${c.colorName}|${state.data.swatches?.length}`
  if (palette.dataset.sig !== swSig) {
    palette.dataset.sig = swSig
    palette.innerHTML = (state.data.swatches ?? [])
      .map(s => `<button class="sw" data-color="${s.name}" style="--sw:${s.hex}" title="${s.name}" aria-pressed="${s.name === c.colorName || s.hex.toLowerCase() === String(c.colorName).toLowerCase()}"></button>`)
      .join('')
  }
}

function renderCats() {
  if (!catsPanel.isOpen || catDrag) return
  const counts = new Map()
  for (const it of state.data.items) counts.set(catOf(it), (counts.get(catOf(it)) ?? 0) + 1)
  const seen = new Set()
  let prev = null
  for (const c of state.data.categories) {
    const row = catRowOf(c.id)
    updateCatRow(row, c, counts.get(c.id) ?? 0)
    seen.add(c.id)
    const misplaced = prev ? prev.nextElementSibling !== row : catsList.firstElementChild !== row
    if (misplaced) prev ? prev.after(row) : catsList.prepend(row)
    prev = row
  }
  for (const [id, row] of catRows) {
    if (seen.has(id)) continue
    row.remove()
    catRows.delete(id)
  }
}

/** The "new category" form at the end of the list. */
function renderDraft() {
  const box = $('#cat-draft')
  if (!catDraft) {
    box.innerHTML = ''
    $('#cat-new').hidden = false
    return
  }
  $('#cat-new').hidden = true
  if (box.firstElementChild) return
  const used = new Set(state.data.categories.map(c => c.colorName))
  const color = (state.data.swatches ?? []).find(s => !used.has(s.name))?.name ?? 'blue'
  catDraft.color = color
  const hex = state.data.swatches?.find(s => s.name === color)?.hex ?? 'var(--accent)'
  box.innerHTML = `
    <div class="cat-row draft" style="--lane:${hex}">
      <div class="cat-main">
        <span class="swatch"></span>
        <input class="cat-title draft-title" placeholder="${esc(t('cat.newTitle'))}" spellcheck="false">
        <button class="button primary draft-ok">${esc(t('cat.create'))}</button>
        <button class="icon-button draft-cancel" title="${esc(t('cancel'))}" aria-label="${esc(t('cancel'))}"><svg viewBox="0 0 20 20"><path d="m5.5 5.5 9 9m0-9-9 9"/></svg></button>
      </div>
      <div class="cat-sub">
        <input class="draft-id" placeholder="${esc(t('cat.idPlaceholder'))}" spellcheck="false" aria-label="id">
        <span class="hint">${t('cat.idHint')}</span>
      </div>
    </div>`
  setTimeout(() => box.querySelector('.draft-title').focus(), 30)
}

async function createDraft() {
  const box = $('#cat-draft')
  const title = box.querySelector('.draft-title').value.trim()
  const id = box.querySelector('.draft-id').value.trim() || slug(title)
  if (!title && !id) return box.querySelector('.draft-title').focus()
  if (await editCats({ op: 'create', id, title: title || id, color: catDraft?.color })) {
    catDraft = null
    renderDraft()
    toast(t('cat.created', { title: q(title || id) }))
    setTimeout(() => openCats(id), 300)
  }
}

$('#cat-new').addEventListener('click', () => {
  catDraft = { touched: false }
  renderDraft()
})
$('#cat-draft').addEventListener('input', e => {
  if (e.target.classList.contains('draft-id')) catDraft.touched = true
  if (e.target.classList.contains('draft-title') && !catDraft.touched) $('#cat-draft .draft-id').value = slug(e.target.value)
})
$('#cat-draft').addEventListener('keydown', e => {
  if (e.key === 'Enter') createDraft()
  if (e.key === 'Escape') {
    e.stopPropagation()
    catDraft = null
    renderDraft()
  }
})
$('#cat-draft').addEventListener('click', e => {
  if (e.target.closest('.draft-ok')) createDraft()
  if (e.target.closest('.draft-cancel')) {
    catDraft = null
    renderDraft()
  }
})

catsList.addEventListener('click', async e => {
  const row = e.target.closest('.cat-row')
  if (!row) return
  const id = row.dataset.id
  const cat = state.data.categories.find(c => c.id === id)
  if (e.target.closest('.swatch')) {
    const palette = row.querySelector('.palette')
    for (const p of catsList.querySelectorAll('.palette')) if (p !== palette) p.hidden = true
    if (cat?.configured) palette.hidden = !palette.hidden
    return
  }
  const sw = e.target.closest('.sw')
  if (sw) {
    row.style.setProperty('--lane', sw.style.getPropertyValue('--sw'))
    row.querySelector('.palette').hidden = true
    return editCats({ op: 'update', id, color: sw.dataset.color })
  }
  const unpath = e.target.closest('[data-path]')
  if (unpath && cat) return editCats({ op: 'update', id, paths: cat.paths.filter(p => p !== unpath.dataset.path) })
  if (e.target.closest('.cat-add') && cat) return editCats({ op: 'create', id, title: cat.title })
  const del = e.target.closest('.cat-del')
  if (del) {
    if (row.dataset.confirm) {
      delete row.dataset.confirm
      if (await editCats({ op: 'delete', id })) toast(t('cat.deleted', { title: q(cat?.title ?? id) }))
      return
    }
    // Destructive: the first click only asks.
    const n = state.data.items.filter(i => catOf(i) === id).length
    row.dataset.confirm = '1'
    del.querySelector('span').textContent = n ? t('cat.confirmN', { n }) : t('cat.confirm')
    setTimeout(() => {
      delete row.dataset.confirm
      del.querySelector('span').textContent = ''
    }, 4000)
  }
})

catsList.addEventListener('keydown', e => {
  const row = e.target.closest('.cat-row')
  if (!row) return
  const id = row.dataset.id
  const cat = state.data.categories.find(c => c.id === id)
  if (e.target.classList.contains('cat-title')) {
    if (e.key === 'Enter') e.target.blur()
    if (e.key === 'Escape') {
      e.stopPropagation()
      e.target.value = cat?.title ?? ''
      e.target.blur()
    }
  } else if (e.target.classList.contains('path-add')) {
    if (e.key === 'Escape') {
      e.stopPropagation()
      e.target.value = ''
      e.target.blur()
    }
    if (e.key !== 'Enter' || !cat) return
    const path = e.target.value.trim()
    if (!path) return
    e.target.value = ''
    editCats({ op: 'update', id, paths: [...cat.paths, path] })
  }
})

catsList.addEventListener('focusout', e => {
  if (!e.target.classList.contains('cat-title')) return
  const row = e.target.closest('.cat-row')
  const cat = state.data.categories.find(c => c.id === row?.dataset.id)
  const title = e.target.value.trim()
  if (!cat?.configured || !title || title === cat.title) {
    if (cat) e.target.value = cat.title
    return
  }
  editCats({ op: 'update', id: cat.id, title })
})

// Reorder: the row follows the pointer 1:1, the others make room with springs, and on release
// everything settles into the new order from where it is on screen.
function rowSpring(row) {
  if (row._y) return row._y
  row._y = new Spring({ damping: 1, response: 0.3, precision: 0.2, onUpdate: v => (row.style.transform = v ? `translateY(${v}px)` : '') })
  return row._y
}

catsList.addEventListener('pointerdown', e => {
  const handle = e.target.closest('.handle')
  if (!handle || e.button !== 0) return
  e.preventDefault()
  const row = handle.closest('.cat-row')
  const rows = [...catsList.children]
  const rects = rows.map(r => r.getBoundingClientRect())
  const from = rows.indexOf(row)
  const gap = rects.length > 1 ? rects[1].top - rects[0].bottom : 8
  catDrag = { row, rows, rects, from, to: from, gap, sy: e.clientY, id: e.pointerId, samples: [{ x: 0, y: e.clientY, t: e.timeStamp }] }
  for (const p of catsList.querySelectorAll('.palette')) p.hidden = true
  row.classList.add('lifted')
  handle.setPointerCapture(e.pointerId)
})

catsList.addEventListener('pointermove', e => {
  const d = catDrag
  if (!d || e.pointerId !== d.id) return
  d.samples.push({ x: 0, y: e.clientY, t: e.timeStamp })
  if (d.samples.length > 12) d.samples.shift()
  const top = d.rects[0].top - d.rects[d.from].top
  const bottom = d.rects.at(-1).top - d.rects[d.from].top
  let dy = e.clientY - d.sy
  if (dy < top) dy = top + rubberband(dy - top, 200)
  if (dy > bottom) dy = bottom + rubberband(dy - bottom, 200)
  rowSpring(d.row).set(dy)
  const center = d.rects[d.from].top + d.rects[d.from].height / 2 + dy
  let to = d.from
  d.rects.forEach((r, i) => {
    if (i > d.from && center > r.top + r.height / 2) to = i
    if (i < d.from && center < r.top + r.height / 2 && i < to) to = i
  })
  d.to = to
  const room = d.rects[d.from].height + d.gap
  d.rows.forEach((r, i) => {
    if (r === d.row) return
    const shift = d.from < to && i > d.from && i <= to ? -room : to < d.from && i >= to && i < d.from ? room : 0
    if (rowSpring(r).target !== shift) rowSpring(r).to(shift)
  })
})

function endCatDrag(e) {
  const d = catDrag
  if (!d || e.pointerId !== d.id) return
  const v = velocityOf(d.samples).y
  // FLIP: where everything is now, the new order in the DOM, then spring from there to rest.
  const before = new Map(d.rows.map(r => [r, r.getBoundingClientRect().top]))
  for (const r of d.rows) {
    rowSpring(r).stop()
    r.style.transform = ''
  }
  const order = d.rows.slice()
  order.splice(d.to, 0, ...order.splice(d.from, 1))
  for (const r of order) catsList.append(r)
  for (const r of order) {
    const s = rowSpring(r)
    s.value = before.get(r) - r.getBoundingClientRect().top
    s.velocity = r === d.row ? v : 0
    s.onUpdate(s.value)
    s.to(0)
  }
  d.row.classList.remove('lifted')
  catDrag = null
  if (d.to === d.from) return
  // Lanes take the new order right away; the live stream confirms it.
  const ids = order.map(r => r.dataset.id)
  state.data.categories.sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id))
  render()
  editCats({ op: 'order', ids })
}
catsList.addEventListener('pointerup', endCatDrag)
catsList.addEventListener('pointercancel', endCatDrag)

$('#cats-open').addEventListener('click', () => (catsPanel.isOpen ? catsPanel.close() : openCats()))
$('#board').addEventListener('click', e => {
  const head = e.target.closest('.lane-head')
  if (head) openCats(head.closest('.lane').dataset.cat)
})

// ---------------------------------------------------------------- toolbar controls and keys
$('#lanes').addEventListener('click', e => {
  const b = e.target.closest('button')
  if (!b) return
  state.filter = b.dataset.id
  store.set('board.filter', state.filter)
  render()
})
$('#lang').addEventListener('click', async () => {
  const codes = Object.keys(state.data.languages ?? LANGUAGES)
  const next = codes[(codes.indexOf(t.lang) + 1) % codes.length]
  state.langAsked = { lang: next, at: Date.now() }
  setLanguage(next)
  render()
  try {
    const res = await fetch('/api/settings', { method: 'POST', headers: { 'content-type': 'application/json', 'x-board': '1' }, body: JSON.stringify({ language: next }) })
    const r = await res.json().catch(() => ({}))
    if (!res.ok || r.ok === false) toast(r.error || t('err.status', { code: res.status }), true)
  } catch (err) {
    toast(t('err.offline', { why: err.message }), true)
  }
})
$('#search').addEventListener('input', e => {
  state.query = e.target.value
  render()
})
$('#sleepers').addEventListener('click', e => {
  state.sleepers = !state.sleepers
  store.set('board.sleepers', state.sleepers ? '1' : '0')
  e.currentTarget.setAttribute('aria-pressed', String(state.sleepers))
  render()
})
$('#sleepers').setAttribute('aria-pressed', String(state.sleepers))

addEventListener('keydown', e => {
  const typing = /^(INPUT|TEXTAREA)$/.test(document.activeElement?.tagName)
  if (e.key === 'Escape') {
    if (typing) return document.activeElement.blur()
    const open = panels.find(p => p.isOpen)
    if (open) return open.close()
    if (state.query) {
      $('#search').value = state.query = ''
      render()
    }
  } else if (e.key === '/' && !typing) {
    e.preventDefault()
    $('#search').focus()
  }
})
addEventListener('scroll', () => $('.toolbar').classList.toggle('scrolled', scrollY > 2), { passive: true })
addEventListener('resize', () => placeThumb(true))
setInterval(render, 30_000) // ages

applyTexts()
fetch('/api/board')
  .then(r => r.json())
  .then(d => d.items && onData(d))
  .catch(() => {})
connect()
