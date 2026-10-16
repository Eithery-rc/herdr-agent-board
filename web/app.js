import { boardConnection, dialogHistory } from './lifecycle.js'
import { outsidePanelPress, panelPress } from './click-away.js'
import { detailResource } from './detail-resource.js'
// Agent board, web. Live data over Server-Sent Events; every change of place animates with a
// spring from where the card is on screen (FLIP), drags stay glued to the pointer and land
// with the pointer's velocity, and the session sheet can be flicked away.
import { attentionTime, nextAttention, recordView, resultToken, unseenResult } from './attention.js'
import { initBoardMenus } from './board-menus.js'
import { draftBook } from './drafts.js'
import { initFiles } from './files.js'
import { findHelper, helperTitle, liveCount, relatedKeys, sessionByName, took } from './helper-model.js'
import { helperRowHTML, HELPER_ICONS, initHelpers, kindIcon, redraw, runRowHTML, statusMark, tickClocks, timeHTML } from './helpers.js'
import { LANGUAGES, translator } from './i18n.js'
import { initLaunch } from './launch.js'
import { updateLive } from './live.js'
import { limitInfo } from './limits-model.js'
import { markdown } from './markdown.js'
import { initMenu } from './menu.js'
import { noticeLine } from './notice-model.js'
import { initQuestions } from './questions.js'
import { keepInSight, menuOpen, Panel, panelDock, panels, placePanels, resetPanelSize, roomBelow } from './panel.js'
import { renameInPlace } from './rename.js'
import { initSetupNote } from './setup.js'
import { reducedMotion, rubberband, Spring, velocityOf } from './spring.js'
import { initTerminal } from './terminal.js'
import { capital, dayLabel, longWhen, shortWhen, span, timeOf } from './when.js'

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
  cross: '<svg viewBox="0 0 20 20"><path d="m6 6 8 8M14 6l-8 8"/></svg>',
  stop: '<svg viewBox="0 0 20 20"><rect x="6" y="6" width="8" height="8" rx="1.5"/></svg>',
  pin: '<svg viewBox="0 0 20 20"><circle cx="10" cy="7" r="3.5"/><path d="M10 10.5V17"/></svg>',
  plus: '<svg viewBox="0 0 20 20"><path d="M10 4.5v11M4.5 10h11"/></svg>',
  alarm: '<svg viewBox="0 0 20 20"><circle cx="10" cy="11" r="6"/><path d="M10 8v3.2l2 1.3M3.6 5.4 6 3.3M16.4 5.4 14 3.3"/></svg>',
  repeat: '<svg viewBox="0 0 20 20"><path d="M4 9.5V8a3 3 0 0 1 3-3h8.5m-2.5-2.5L15.5 5 13 7.5M16 10.5V12a3 3 0 0 1-3 3H4.5M7 12.5 4.5 15 7 17.5"/></svg>',
  trash: '<svg viewBox="0 0 20 20"><path d="M4.5 6h11M8 6V4.5h4V6m-6 0 .7 9.5h6.6L14 6"/></svg>',
  bolt: '<svg viewBox="0 0 20 20"><path d="M11 2.5 4.5 11H10l-1 6.5L15.5 9H10Z"/></svg>',
  hourglass: '<svg viewBox="0 0 20 20"><path d="M6 3h8M6 17h8M7 3v2.6c0 1.2.6 2.1 1.6 2.8L10 9.4l1.4-1c1-.7 1.6-1.6 1.6-2.8V3M7 17v-2.6c0-1.2.6-2.1 1.6-2.8l1.4-1 1.4 1c1 .7 1.6 1.6 1.6 2.8V17"/></svg>',
  // Sessions working together: who started it, whom it started, a message out and in.
  from: '<svg viewBox="0 0 20 20"><path d="M8 4.5 4.5 8 8 11.5"/><path d="M4.5 8H12a3.5 3.5 0 0 1 3.5 3.5v4"/></svg>',
  spawned: '<svg viewBox="0 0 20 20"><path d="M4.5 4v5.5A3.5 3.5 0 0 0 8 13h7.5"/><path d="M12 9.5 15.5 13 12 16.5"/></svg>',
  out: '<svg viewBox="0 0 20 20"><path d="M3.5 10.5 16.5 4l-4 12.5-2.6-5.3Z"/><path d="m9.9 11.2 2.6-2.6"/></svg>',
  peer: '<svg viewBox="0 0 20 20"><path d="M4 5.5A1.5 1.5 0 0 1 5.5 4h9A1.5 1.5 0 0 1 16 5.5v6a1.5 1.5 0 0 1-1.5 1.5H9.2L6 16v-3h-.5A1.5 1.5 0 0 1 4 11.5Z"/></svg>',
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
/** Previews of images sent from the board: their paths in a message point into the uploads folder. A click opens the quick look. */
const UPLOAD_IMAGE = /((?:[A-Za-z]:[\\/]|\/)[^\s"'<>]*?agent-board[\\/]uploads[\\/](\d{4}-\d{2}-\d{2})[\\/]([^\s\\/]+\.(?:png|jpe?g|gif|webp)))/gi
const thumbs = text => {
  const shots = [...String(text ?? '').matchAll(UPLOAD_IMAGE)].map(m => ({ path: m[1], url: `/uploads/${m[2]}/${encodeURIComponent(m[3])}` }))
  return shots.length
    ? `<div class="thumbs">${shots.map(s => `<a class="fs-inline" data-path="${esc(s.path)}" href="${s.url}" target="_blank" rel="noopener"><img src="${s.url}" alt="" loading="lazy"></a>`).join('')}</div>`
    : ''
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

let viewed = {}
try { viewed = JSON.parse(store.get('board.viewed', '{}')) ?? {} } catch {}

// ---------------------------------------------------------------- state
const state = {
  data: { items: [], categories: [], columns: [], schedules: [], scheduleLog: [], stale: true, lastSuccessfulRefreshAt: null },
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
let launchUI = null // new sessions (launch.js), set up with the sheet below
let questionsUI = null // questions asked in a terminal (questions.js), set up with the sheet below
let termUI = null // the terminal window (terminal.js), set up with the sheet below
let helpersUI = null // a session's helpers in a window (helpers.js), set up with the sheet below
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
    return [it.name, it.autoName, it.doing, it.wait, it.title, it.lastText, it.prompt, it.workspace, catInfo(catOf(it)).title, ...(it.helpers?.live ?? []).map(h => h.label)]
      .some(v => v && String(v).toLowerCase().includes(q))
  }).concat(launchUI?.placeholders() ?? []) // sessions on their way show whatever the search
}

// ---------------------------------------------------------------- data
let lastDetailStamp = ''
// The session a page opened for (web-open.mjs, a notification clicked while no board was open):
// #session=<key>, shown once the board is in.
let revealOnLoad = new URLSearchParams(location.hash.slice(1)).get('session')
function onData(data) {
  const recovered = state.data.stale && !data.stale
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
  syncAvailability()
  if (revealOnLoad) {
    const key = revealOnLoad
    revealOnLoad = null
    history.replaceState(history.state, '', location.pathname + location.search)
    if (itemOf(key)) return reveal(key)
  }
  if (state.open) {
    const it = itemOf(state.open)
    if (it) state.selectedItem = it
    if (!it && !data.stale) { detail.missing(); return }
    // A helper at work changes the sheet too, while the session itself may wait for it.
    const stamp = it ? `${it.activity}|${it.status}|${it.column}|${it.wait}|${it.doing}|${it.category}|${it.helpers?.at ?? ''}|${it.helpers?.running ?? ''}` : ''
    if (it && (stamp !== lastDetailStamp || recovered || state.detailState?.status === 'missing')) {
      lastDetailStamp = stamp
      loadDetail(state.open)
    }
  }
}

/** Show a session a notification was about: its sheet, and its card in view. */
function reveal(key) {
  if (!itemOf(key)) return
  if (state.open !== key || !sessionPanel.isOpen) openSheet(key)
  document.querySelector(`.card[data-key="${CSS.escape(key)}"]`)?.scrollIntoView({ block: 'nearest', behavior: reducedMotion.matches ? 'auto' : 'smooth' })
}

const connection = boardConnection({
  source: () => {
    const stream = new EventSource('/api/events')
    // A notification clicked while this page is open (web-open.mjs through /api/reveal).
    stream.addEventListener('reveal', event => {
      try {
        reveal(JSON.parse(event.data).key)
      } catch {}
    })
    return stream
  },
  snapshot: signal => fetch('/api/board', { cache: 'no-store', signal }).then(response => {
    if (!response.ok) throw new Error('Snapshot unavailable')
    return response.json()
  }),
  data: onData,
  connected(value) {
    const returned = value && !state.connected
    state.connected = value
    renderLimits()
    updateLive($('#live'), value ? state.data : { stale: true, lastSuccessfulRefreshAt: null }, t)
    if (!value) $('#live').title = t('live.off')
    syncAvailability()
    if (returned && state.open && itemOf(state.open)) loadDetail(state.open)
  },
})
// Two conditions. Edits the board keeps itself (cards, lanes, language, files) need only the
// board; what goes through herdr (a message, going to a session, waking, putting to sleep) also
// needs fresh herdr data, or it would act on a session that may have moved on.
const canMutate = () => state.connected && state.data.stale === false && state.data.lastSuccessfulRefreshAt != null
const canEdit = () => !!state.connected
const HERDR_ACTIONS = ['focus', 'wake', 'sleep', 'message', 'answer', 'permit']
function syncAvailability() {
  const blocked = !canMutate()
  const missing = !!state.open && (!itemOf(state.open) || state.detailState?.status === 'missing')
  for (const banner of document.querySelectorAll('#connection-state, #sheet-connection-state')) {
    banner.hidden = !blocked
    banner.textContent = t(canEdit() ? 'mobile.readOnly' : 'live.off')
  }
  for (const element of document.querySelectorAll('#sheet-focus, #sheet-sleep, #sheet-wake, [data-act="focus"], [data-act="sleep"]')) element.disabled = blocked || (missing && !!element.closest('#sheet')) || (element.id === 'sheet-sleep' && inTurn(itemOf(state.open) ?? {}))
  for (const element of document.querySelectorAll('#attach, #cat-new, #sheet-mokupilot, #sheet-card button:not(.rel-chip):not(.rel-more), #sheet-card input, #cats-sheet button:not([data-close]):not([data-layout]), #cats-sheet input, #sched-body .sched-x, #sched-body .sched-mode, [data-act="dismiss"]')) element.disabled = !canEdit()
  // New sessions go through herdr: they wait for fresh data like going to a session does.
  for (const element of document.querySelectorAll('#new-session, #sheet-new, .lane-new')) {
    element.disabled = blocked
    element.title = t(blocked ? 'mobile.readOnly' : element.dataset.hint ?? 'launch.inLane')
  }
  launchUI?.syncAvailability()
  if (missing) for (const element of document.querySelectorAll('#sheet-card button, #sheet-card input, #sheet [data-act], #sheet-new, #sheet-mokupilot, #attach, #sheet-changes, #sheet-history')) element.disabled = true
  else for (const element of document.querySelectorAll('#sheet-changes, #sheet-history')) element.disabled = false
  files.refreshAvailability()
  termUI?.sync()
  questionsUI?.sync()
  syncComposer()
  renderDetailState()
}
function resumeBoard() { if (!document.hidden && navigator.onLine !== false) connection.resume() }
addEventListener('pageshow', resumeBoard)
addEventListener('online', resumeBoard)
addEventListener('offline', () => connection.suspend())
document.addEventListener('visibilitychange', () => document.hidden ? connection.suspend() : resumeBoard())

async function act(key, action, body = {}) {
  if (!itemOf(key)) return { ok: false, error: t('detail.missing') }
  if (HERDR_ACTIONS.includes(action) ? !canMutate() : !canEdit()) return { ok: false, error: t(canEdit() ? 'mobile.readOnly' : 'live.off') }
  try {
    const res = await fetch(`/api/session/${encodeURIComponent(key)}/${action}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-board': '1' },
      body: JSON.stringify(body),
    })
    const r = await res.json().catch(() => ({}))
    return res.ok && r.ok !== false ? { ...r, ok: true } : { ...r, ok: false, error: r.error || t('err.status', { code: res.status }) }
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

/** A MokuPilot call whose agent is a fork of the session (src/mokupilot.mjs): the session goes on as it was. */
async function callMokuPilot(key) {
  const it = itemOf(key)
  if (!it) return
  const r = await act(key, 'mokupilot')
  toast(r.ok ? t('mokupilot.started', { name: it.name }) : r.error, !r.ok)
}

// ---------------------------------------------------------------- language
/** The page in another language: the static texts by their data-i18n attributes, and every part drawn already. */
function setLanguage(lang) {
  t = translator(lang)
  document.documentElement.lang = t.lang
  applyTexts()
  for (const lane of lanes.values()) for (const [id, col] of lane.cols) col.querySelector('.col-label').lastChild.textContent = colTitle(id)
  for (const b of document.querySelectorAll('.lane-new')) b.title = b.ariaLabel = t('launch.inLane')
  launchUI.relabel()
  for (const row of catRows.values()) row.remove()
  catRows.clear()
  if (catDraft) renderDraft()
  sheetCard._html = ''
  schedBody._html = ''
  if (state.open) renderSheetBody(false)
  renderAttachments()
  syncComposer()
  files.relabel()
  termUI?.relabel()
  helpersUI?.relabel()
}

function applyTexts() {
  for (const el of document.querySelectorAll('[data-i18n]')) el.textContent = t(el.dataset.i18n)
  for (const el of document.querySelectorAll('[data-i18n-title]')) el.title = t(el.dataset.i18nTitle)
  for (const el of document.querySelectorAll('[data-i18n-label]')) el.setAttribute('aria-label', t(el.dataset.i18nLabel))
  for (const el of document.querySelectorAll('[data-i18n-placeholder]')) el.placeholder = t(el.dataset.i18nPlaceholder)
  if (state.connected) updateLive($('#live'), state.data, t)
  else $('#live').title = t('live.none')
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
  const helping = all.reduce((n, i) => n + liveCount(i), 0)
  if (helping) parts.push(`<b>${helping}</b> ${t('sum.helpers', { n: helping })}`)
  if (asleep) parts.push(`${asleep} ${t('sum.asleep', { n: asleep })}`)
  $('#summary').innerHTML = parts.join(' · ')
  $('.titles').title = $('#summary').textContent // the summary hides in a narrower toolbar
  const attentionCount = visible.filter(it => !it.launchOnly && laneShown(catOf(it)) && (it.column === 'me' || unseenResult(it, viewed))).length
  const next = $('#next-attention')
  next.disabled = !attentionCount
  next.querySelector('span').textContent = attentionCount ? `${t('attention.next')} · ${attentionCount}` : t('attention.noneShort')
  next.title = t(attentionCount ? 'attention.nextHint' : 'attention.none')
  next.setAttribute('aria-label', attentionCount ? t('attention.nextCount', { n: attentionCount }) : t('attention.none'))
  document.title = count('me') ? `(${count('me')}) Agent board` : 'Agent board'
  renderLimits()

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
  fadeLanes()

  // Column heads with counts; a column without cards narrows to its head.
  const shown = visible.filter(i => laneShown(catOf(i)))
  const filled = state.data.columns.map(c => shown.some(i => colOf(i) === c.id))
  const head = $('#columns-head')
  const html = state.data.columns
    .map((c, k) => `<div class="col-head${filled[k] ? '' : ' vacant'}"><span class="dot" style="--c:${COLORS[c.id]}"></span><span class="t">${esc(colTitle(c.id))}</span><span class="n">${shown.filter(i => i.column === c.id).length}</span></div>`)
    .join('')
  if (head.innerHTML !== html) head.innerHTML = html
  // Nothing on show at all: the columns keep their even widths.
  fitColumns(state.data.columns.map(c => c.id), filled.some(Boolean) ? filled : filled.map(() => true))
}

// Each column's share of the board's width: 1 with cards, 0 without, when it keeps only its
// minimum (--col-min, the head's width). The shares move on springs, so cards glide to their new
// width when a column fills or empties instead of the board jumping.
const colShares = new Map() // column id -> Spring
let colIds = []
let colsQueued = false
function fitColumns(ids, filled) {
  colIds = ids
  ids.forEach((id, k) => {
    const want = filled[k] ? 1 : 0
    const share = colShares.get(id)
    if (!share) colShares.set(id, new Spring({ value: want, damping: 1, response: 0.4, precision: 0.002, onUpdate: queueColumns }))
    else if (share.target !== want) share.to(want)
  })
  queueColumns()
}
function queueColumns() {
  if (colsQueued) return
  colsQueued = true
  queueMicrotask(() => {
    colsQueued = false
    const tracks = colIds.map(id => `minmax(var(--col-min), ${Math.max(0, colShares.get(id).value).toFixed(3)}fr)`)
    document.documentElement.style.setProperty('--cols', tracks.join(' '))
  })
}

/** Claude's usage windows from the usagebar cache, when there is one: a small pill by the live dot. */
function renderLimits() {
  const lim = limitInfo(state.data.limits, { connected: !!state.connected })
  const pill = $('#limits')
  pill.hidden = false
  pill.setAttribute('aria-label', t('limits.title'))
  const heat = p => (p >= 90 ? ' class="hot"' : p >= 70 ? ' class="warm"' : '')
  pill.innerHTML = lim.windows.length ? lim.windows.map(w => `<span${heat(w.usedPercentage)}>${esc(t(w.minutes === 300 ? 'limits.5h' : 'limits.7d'))} <b>${Math.round(w.usedPercentage)}%</b></span>`).join('') : esc(t('limits.unknown'))
  pill.classList.toggle('stale', !!lim.windows.length && lim.stale)
  pill.title = t('limits.open')
  const time = lim.observedAt ? new Date(lim.observedAt).toLocaleString(t.lang, { dateStyle: 'medium', timeStyle: 'short' }) : t('limits.unknownTime')
  const source = t(lim.source === 'usagebar' ? 'limits.hintUsagebar' : lim.source === 'statusline' ? 'limits.hint' : 'limits.unknownSource', { time })
  $('#limits-content').innerHTML = lim.windows.length
    ? `<p><b>${esc(t('limits.used'))}</b> ${lim.windows.map(w => `${esc(t(w.minutes === 300 ? 'limits.5h' : 'limits.7d'))}: ${Math.round(w.usedPercentage)}%`).join(' · ')}</p><p>${esc(source)}</p><p class="${lim.stale ? 'limits-warning' : ''}">${esc(t(lim.stale ? 'limits.stale' : 'limits.localReport', { time }))}</p>`
    : `<p>${esc(t('limits.unavailable'))}</p>`
  if (limitsOpen()) positionLimits()
  setupNote?.render(state.data.setup)
}

// The quiet note that part of the board is not set up on this computer (setup.js).
let setupNote = null
const limitsOpen = () => !$('#limits-pop').hidden
function positionLimits() {
  const pop = $('#limits-pop'), rect = $('#limits').getBoundingClientRect(), size = pop.getBoundingClientRect()
  pop.style.left = `${Math.max(8, Math.min(rect.left, innerWidth - size.width - 8))}px`
  pop.style.top = `${rect.bottom + size.height + 8 <= innerHeight ? rect.bottom + 8 : Math.max(8, rect.top - size.height - 8)}px`
}
function closeLimits(refocus = false) {
  if (!limitsOpen()) return
  $('#limits-pop').hidden = true
  $('#limits').setAttribute('aria-expanded', 'false')
  dialogBack.sync()
  if (refocus) $('#limits').focus({ preventScroll: true })
}
$('#limits').addEventListener('click', () => {
  if (limitsOpen()) return closeLimits()
  renderLimits()
  const pop = $('#limits-pop')
  pop.hidden = false
  positionLimits()
  $('#limits').setAttribute('aria-expanded', 'true')
  pop.focus({ preventScroll: true })
  dialogBack.sync()
})
$('#limits-close').addEventListener('click', () => closeLimits(true))
addEventListener('pointerdown', e => { if (limitsOpen() && !e.target.closest('#limits-pop, #limits')) closeLimits() }, true)
addEventListener('keydown', e => { if (e.key === 'Escape' && limitsOpen()) { e.preventDefault(); e.stopImmediatePropagation(); closeLimits(true) } }, true)
addEventListener('resize', () => closeLimits())

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

/** The lanes control fades at an edge with more lanes past it. */
function fadeLanes() {
  const seg = $('#lanes')
  const hidden = seg.scrollWidth - seg.clientWidth
  seg.classList.toggle('fade-start', seg.scrollLeft > 1)
  seg.classList.toggle('fade-end', hidden - seg.scrollLeft > 1)
}
$('#lanes').addEventListener('scroll', fadeLanes, { passive: true })

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
  root.innerHTML = `<div class="lane-bar"><header class="lane-head"><span class="lane-tag"></span><span class="lane-count"></span></header><button class="lane-new" title="${esc(t('launch.inLane'))}" aria-label="${esc(t('launch.inLane'))}">${ICON.plus}</button></div><div class="lane-grid"></div>`
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

/** The session's schedule entries, soonest first (the server sorts them). */
const schedulesOf = key => (state.data.schedules ?? []).filter(e => e.key === key)
const overdue = e => e.next <= Date.now()

/** A clock by the name with the soonest time, orange while a due one waits for the session. */
function alarmBadge(it) {
  const list = schedulesOf(it.key)
  if (!list.length) return ''
  const first = list[0]
  const title = t('sched.badge', { n: list.length, when: longWhen(first.next, t), text: plain(first.text) })
  return `<span class="alarm${overdue(first) ? ' due' : ''}" title="${esc(title)}">${first.cron ? ICON.repeat : ICON.alarm}<span>${esc(shortWhen(first.next, t))}</span></span>`
}

function cardHTML(it) {
  if (it.launchOnly) return launchUI.cardHTML(it)
  const dismiss = dismissable(it) ? `<button data-act="dismiss" title="${esc(it.attention === 'later' ? t('card.seen', { col: q(colTitle('me')) }) : t('card.noReply'))}">${ICON.check}</button>` : ''
  const sleep = !it.sleeping && it.session && !inTurn(it) ? `<button data-act="sleep" title="${esc(t('card.sleep'))}">${ICON.moon}</button>` : ''
  const actions = `<div class="card-actions">${dismiss}${sleep}<button data-act="write" title="${esc(t('card.write'))}">${ICON.write}</button><button data-act="focus" title="${esc(t('card.focus'))}">${ICON.focus}</button></div>`
  const dot = it.sleeping ? ICON.moon : `<span class="dot ${it.column}" style="--c:${COLORS[it.column]}"></span>`
  // Under "Needs me" the age says how long it has waited for you: since its question, else since its last activity.
  const waiting = attentionTime(it)
  const age = ago(waiting || (it.column === 'ext' ? it.waitSince || it.activity : it.activity))
  const ageTitle = waiting ? t(it.askSince ? 'attention.waitAge' : 'attention.activityAge', { age: ago(waiting) }) : ''
  const pin = it.pin && it.pin === it.column ? `<span class="pinned" title="${esc(t('card.pinned'))}">${ICON.pin}</span>` : ''
  // A result you have not opened yet: a dot by the name.
  const unseen = unseenResult(it, viewed) ? `<span class="unseen-dot" title="${esc(t('attention.unseen'))}"></span>` : ''
  const top = `<div class="card-top">${dot}<span class="name"${it.name !== it.autoName && it.autoName ? ` title="${esc(t('rename.was', { name: it.autoName }))}"` : ''}>${esc(it.name)}</span>${unseen}${pin}${alarmBadge(it)}<span class="age"${ageTitle ? ` title="${esc(ageTitle)}"` : ''}>${esc(age)}</span></div>`
  if (compact(it)) return top + actions
  // What it works on: its own words, else Claude's title of the session, else your last request.
  const own = plain(it.doing || (it.title && it.title !== it.name ? it.title : ''))
  const asked = own ? '' : plain(it.prompt)
  const what = own || asked
  const said = plain(it.column === 'done' || it.column === 'idle' ? it.result || it.lastText : it.lastText)
  let body = own ? `<div class="what">${esc(own)}</div>` : asked ? `<div class="what"><span class="you">${esc(t('card.you'))}</span> ${esc(asked)}</div>` : ''
  // A launch held at the trust dialog says what it asks itself (launch.js), with its buttons.
  if (it.column === 'me' && it.launch?.state !== 'trust') body += questionsUI?.cardAsk(it, plain) || `<div class="ask"><b>${esc(t(it.attention ? `att.${it.attention}` : 'att.default'))}:</b> ${esc(plain(it.question) || t(it.attention === 'later' ? 'card.lookLater' : 'card.needsDecision'))}</div>`
  if (it.column === 'ext') body += `<div class="chip">${ICON.clock}<span>${esc(it.wait || t('note.parked'))}</span></div>`
  if (it.column !== 'me' && said && said !== what) body += `<div class="said">${esc(said)}</div>`
  if (it.column === 'work') {
    const tool = it.tool
    body += tool?.pending
      ? `<div class="now">${ICON.spin}<span class="tool">${esc(tool.label)}</span><span class="detail">${esc(tool.detail)}</span></div>`
      : `<div class="now idle">${ICON.spin}<span class="tool">${esc(t('card.thinking'))}</span><span class="detail">${tool ? esc(t('card.after', { tool: tool.label })) : ''}</span></div>`
  }
  body += helpersChip(it) + relationsLine(it)
  // Started from the board and not done starting: how it goes, or why it failed.
  if (it.launch) body += launchUI.note(it.launch)
  return top + body + actions
}

/**
 * Helpers at work, on the card: a dot for each (its kind's color, a teammate's own), how many,
 * and what the newest one does. Only while they work: a finished helper is the sheet's to show.
 */
function helpersChip(it) {
  const n = liveCount(it)
  if (!n) return ''
  const live = it.helpers.live ?? []
  const dots = live.slice(0, 3).map(h => `<i class="hd k-${esc(h.kind)}"${h.color ? ` data-color="${esc(h.color)}"` : ''}></i>`).join('') || '<i class="hd k-workflow"></i>'
  const label = live[0]?.label ?? ''
  return `<div class="helpers-row"><button class="helpers-chip" data-act="helpers" title="${esc(t('helpers.chipHint'))}"><span class="hdots">${dots}</span><span class="n">${esc(t('helpers.chip', { n }))}</span>${label ? `<span class="d">${esc(label)}</span>` : ''}</button></div>`
}

/** Who started this session and how many it started, quietly at the card's foot. */
function relationsLine(it) {
  const l = it.links
  if (!l) return ''
  const parts = []
  const from = l.from && itemOf(l.from.key)
  if (from) parts.push(`<button class="rel" data-act="rel" data-key="${esc(from.key)}" title="${esc(t('rel.fromHint', { name: from.name }))}">${ICON.from}<span>${esc(from.name)}</span></button>`)
  const started = (l.started ?? []).map(x => itemOf(x.key)).filter(Boolean)
  if (started.length) parts.push(`<span class="rel" title="${esc(t('rel.startedHint', { names: started.map(x => x.name).join(', ') }))}">${ICON.spawned}<span>${esc(t('rel.started', { n: started.length }))}</span></span>`)
  return parts.length ? `<div class="rels">${parts.join('')}</div>` : ''
}

function updateCard(card, it) {
  const html = cardHTML(it)
  if (card._html !== html) {
    card.innerHTML = html
    card._html = html
  }
  card.dataset.col = it.column
  card.classList.toggle('launch-card', !!it.launchOnly)
  card.classList.toggle('compact', compact(it))
  card.classList.toggle('unseen', unseenResult(it, viewed))
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
    if (e.key === 'Enter' && e.target === card && itemOf(card.dataset.key)) openSheet(card.dataset.key)
  })
  // Pointing at a card, or tabbing to it, marks the sessions it works with.
  card.addEventListener('pointerenter', e => e.pointerType === 'mouse' && showRelated(card.dataset.key))
  card.addEventListener('pointerleave', () => showRelated(null))
  card.addEventListener('focusin', () => showRelated(card.dataset.key))
  card.addEventListener('focusout', e => !card.contains(e.relatedTarget) && showRelated(null))
  cards.set(key, card)
  appear(card)
  return card
}

let relatedTo = null // the card whose sessions are marked
function showRelated(key) {
  relatedTo = key
  const keys = key ? relatedKeys(itemOf(key)) : new Set()
  for (const [k, el] of cards) el.classList.toggle('related', keys.has(k))
}

function render() {
  const first = measure()
  const visible = visibleItems()
  renderToolbar(visible)
  const board = $('#board')
  const order = state.data.categories.map(c => c.id)
  const seen = new Set()
  let anyShown = false
  // A session the board started takes over its starting card, so it moves on from where that was.
  for (const l of state.data.launches ?? []) {
    const el = cards.get(`launch:${l.id}`)
    if (el && l.key && itemOf(l.key) && !cards.has(l.key)) {
      cards.delete(`launch:${l.id}`)
      cards.set(l.key, el)
      el.dataset.key = l.key
    }
  }
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
  if (relatedTo) showRelated(cards.has(relatedTo) ? relatedTo : null)
  flip(first)
  if (state.open) {
    renderSheetHead()
    const it = itemOf(state.open)
    if (it && !collapsing) renderSheetCard(it)
  }
  renderCats()
  renderScheduleCount()
  renderSchedule()
  syncAvailability()
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
  if (!canEdit() || e.pointerType === 'touch' || e.button !== 0 || e.target.closest('[data-act], [data-launch]') || !itemOf(e.currentTarget.dataset.key)) return
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
  else if (e.clientY > innerHeight - roomBelow() - 70) scrollBy(0, 14) // above a panel at the bottom
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
  if (getSelection()?.isCollapsed === false) return
  const card = e.currentTarget
  if (performance.now() - (card._draggedAt ?? -1e9) < 350) return
  const key = card.dataset.key
  if (launchUI.onCardAction(e) || !itemOf(key)) return // a starting session's own buttons; its card opens nothing
  const btn = e.target.closest('[data-act]')
  if (btn?.dataset.act === 'focus') return focusSession(key)
  if (btn?.dataset.act === 'write') return openSheet(key, { compose: true })
  if (btn?.dataset.act === 'dismiss') return dismissAsk(key)
  if (btn?.dataset.act === 'sleep') return sleepSession(key)
  if (btn?.dataset.act === 'rel') return goToSession(btn.dataset.key)
  openSheet(key)
}

/** Another session, from a link to it: its sheet, and its card brought into sight with a glint. */
function goToSession(key) {
  if (!itemOf(key)) return toast(t('rel.notOnBoard'), true)
  openSheet(key)
  const card = cards.get(key)
  if (!card?.offsetParent) return
  card.scrollIntoView({ block: 'nearest', behavior: reducedMotion.matches ? 'auto' : 'smooth' })
  if (!reducedMotion.matches) card.animate([{ boxShadow: 'var(--shadow-card), 0 0 0 4px color-mix(in srgb, var(--accent) 45%, transparent)' }, { boxShadow: 'var(--shadow-card), 0 0 0 2px var(--accent)' }], { duration: 900, easing: 'ease-out' })
}

// ---------------------------------------------------------------- side panels
// The session and the categories open in a panel (panel.js): docked right, left or at the
// bottom, or floating, sized and placed by the viewer. Only one is open at a time.

// A click on the board beside an open panel closes it. A card switches the panel to its own
// session instead, controls keep their own job, and a press that travelled (a card drag, a text
// selection ending outside the panel) is not a click, nor is one that only put the panel's
// place menu away.
{
  let down = null
  const keeps = '.sheet, .ql, .launch, .limits-pop, .setup-pop, .menu, .rename, .card, .lane-head, .layout-menu, button, input, textarea, select, label, a, [data-act]'
  addEventListener('pointerdown', e => (down = panelPress(e, keeps, menuOpen())), true)
  addEventListener('click', e => {
    const d = down
    down = null
    const open = panels.find(p => p.isOpen)
    if (!open || !outsidePanelPress(d, e, keeps)) return
    open.close()
  })
}

// ---------------------------------------------------------------- the session sheet
const sheetBody = $('#sheet-body')
const sheetQuestion = $('#sheet-question')
const narrowSheet = matchMedia('(max-width: 760px)')
let propertiesOpen = false
function syncSheetProperties() {
  $('#sheet-card').hidden = narrowSheet.matches && !propertiesOpen
  $('#sheet-properties-toggle').setAttribute('aria-expanded', String(propertiesOpen))
}
$('#sheet-properties-toggle').addEventListener('click', () => { propertiesOpen = !propertiesOpen; syncSheetProperties() })
narrowSheet.addEventListener('change', syncSheetProperties)
// Paths in the thread become chips with a quick look; web links open in the default browser.
const files = initFiles({ t: () => t, token: () => state.data.fsToken, toast, canMutate: canEdit, onDialogChange: () => { dialogBack.sync(); syncAvailability() } })
// Layers above the board, topmost first: Back on a phone closes them one at a time.
const menu = initMenu({
  onChange: () => {
    dialogBack.sync()
    if (!menu.isOpen()) for (const b of document.querySelectorAll('#sheet-more, #settings')) b.setAttribute('aria-expanded', 'false')
  },
})
const dialogBack = dialogHistory({
  history,
  mobile: () => matchMedia('(max-width: 760px)').matches,
  // Asked at once when a reload finds the Back sentinel: launchUI is set up just below.
  isOpen: () => menu.isOpen() || !!launchUI?.isOpen() || files.isOpen() || !!termUI?.isOpen() || !!helpersUI?.isOpen() || limitsOpen() || !!setupNote?.isOpen() || panels.some(panel => panel.isOpen),
  closeTop: () => menu.isOpen() ? menu.close() : launchUI?.isOpen() ? launchUI.close() : files.isOpen() ? files.back() : termUI?.isOpen() ? termUI.close() : helpersUI?.isOpen() ? helpersUI.back() : limitsOpen() ? closeLimits(true) : setupNote?.isOpen() ? setupNote.close(true) : panels.find(panel => panel.isOpen)?.close(),
})
setupNote = initSetupNote({ t: () => t, esc, store, onDialogChange: () => dialogBack.sync() })
setupNote.render(state.data.setup)
launchUI = initLaunch({
  t: () => t,
  toast,
  canMutate,
  data: () => ({ ...state.data, filter: state.filter }),
  onDialogChange: () => dialogBack.sync(),
  onStarted: l => {
    // The new card must be in sight: its lane shown, then drawn at once.
    if (state.filter !== 'all' && state.filter !== l.category) {
      state.filter = l.category
      store.set('board.filter', state.filter)
    }
    render()
  },
  focusLaunch,
})
addEventListener('popstate', () => dialogBack.pop())
// A shell in the session's folder, or the session's own terminal, live in a window (terminal.js).
termUI = initTerminal({
  t: () => t,
  toast,
  canMutate,
  item: itemOf,
  token: () => state.data.fsToken,
  shells: () => state.data.shells,
  wake: async key => {
    setBusy(key, t('busy.waking'))
    const r = await act(key, 'wake')
    setBusy(key, null)
    if (!r.ok) toast(r.error, true)
  },
  focusAgent: key => focusSession(key),
  openUrl: href => files.openUrl(href),
  onDialogChange: () => dialogBack.sync(),
})
function openTerminal(key, from) {
  if (state.data.terminal === false || !itemOf(key)) return
  termUI.open(key, from)
}
// Subagents, forks, workflow agents and teammates of the session in the sheet (helpers.js): the
// list, and one helper's conversation drawn as the session's is.
helpersUI = initHelpers({
  t: () => t,
  item: itemOf,
  detail: key => (key === state.open ? state.detail : null),
  renderThread: (conv, ctx) => thread(conv, itemOf(ctx.key) ?? {}, ctx),
  upgrade: (el, cwd) => files.upgrade(el, cwd),
  openSession: key => goToSession(key),
  onDialogChange: () => dialogBack.sync(),
})
/** A helper of the session in the sheet ({ id }) or the list of them ({ run }), grown from `el`. */
function openHelpers(ref, el) {
  if (state.open && itemOf(state.open)) helpersUI.open(state.open, ref, el)
}
questionsUI = initQuestions({
  box: sheetQuestion,
  t: () => t,
  item: () => itemOf(state.open),
  act,
  toast,
  canMutate,
  focusSession,
})
const sessionPanel = new Panel($('#sheet'), {
  onClose: () => {
    saveDraft()
    detail.cancel()
    state.open = null
    render()
  },
  onChange: () => dialogBack.sync(),
  text: key => t(key),
})
// While the board makes room for a docked panel, the card it shows keeps its place on screen.
keepInSight({ target: () => (state.open ? cards.get(state.open) : null), top: () => $('.toolbar').getBoundingClientRect().bottom })
const detail = detailResource({
  async read(key, signal) {
    const response = await fetch(`/api/session/${encodeURIComponent(key)}`, { signal, cache: 'no-store' })
    const data = await response.json()
    if (!response.ok) throw Object.assign(new Error(data.error || t('err.unavailable')), { missing: response.status === 404 })
    return data
  },
  changed(value) {
    if (state.open !== value.key) return
    state.detailState = value
    state.detail = value.data
    $('#sheet-changes').hidden = !value.data?.checkout
    if (value.status === 'ready' && !state.data.stale && value.data.item.column === 'done' && resultToken(value.data.item) === resultToken(itemOf(value.key) ?? {})) {
      viewed = recordView(viewed, value.data.item)
      store.set('board.viewed', JSON.stringify(viewed))
      render()
    }
    renderSheetHead()
    renderSheetBody(false)
    helpersUI.sync()
  },
})
// The text being written to a session stays with that session (this browser only), through a
// close, a switch to another session or a reload; a session without a Claude id goes by its card.
const drafts = draftBook({ getItem: key => localStorage.getItem(key), setItem: (key, value) => localStorage.setItem(key, value), removeItem: key => localStorage.removeItem(key) })
const draftKey = it => it?.session || it?.key
const sending = new Set() // sessions with a message on its way
let currentDraft = null
let draftFor = null // the session the composer's attachments were added for; outlives a close
let draftIdentity = null

function openSheet(key, { compose = false } = {}) {
  if (state.open !== key) propertiesOpen = false
  syncSheetProperties()
  const switching = sessionPanel.isOpen && state.open !== key
  // Attachments belong to the session they were added for, never to the next one. Closing the
  // panel and opening the same session again keeps them.
  if (draftFor !== key && attachments.length) {
    clearAttachments()
    toast(t('toast.attachDropped'))
  }
  if (state.open && state.open !== key) saveDraft()
  draftFor = key
  state.open = key
  state.selectedItem = itemOf(key)
  draftIdentity = draftKey(state.selectedItem) || key
  detail.reset(key)
  state.detailState = detail.snapshot()
  currentDraft = drafts.read(draftKey(itemOf(key)))
  message.value = currentDraft?.text ?? ''
  syncComposer()
  state.detail = null
  $('#sheet-changes').hidden = true // until the detail says the folder is in git
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
  if (state.open === key && itemOf(key)) return detail.load(key)
}

function renderDetailState() {
  const box = $('#sheet-detail-state'), value = state.detailState
  if (!box || !state.open || !value) return
  const missing = !itemOf(state.open) || value.status === 'missing'
  const outdated = !state.connected || state.data.stale
  const text = missing ? t('detail.missing') : value.status === 'error' ? t('detail.error', { error: value.error }) : outdated && value.data ? t('detail.stale') : value.status === 'loading' && value.data ? t('detail.refreshing') : ''
  box.hidden = !text
  sheetBody.classList.toggle('has-detail-state', !!text)
  const stamp = value.at ? t('detail.readAt', { time: new Date(value.at).toLocaleTimeString(t.lang, { hour: '2-digit', minute: '2-digit' }) }) : ''
  const html = `<span>${esc(text)}${stamp ? `<small>${esc(stamp)}</small>` : ''}</span><button class="button" data-detail-retry${!canEdit() || !itemOf(state.open) || value.status === 'loading' ? ' disabled' : ''}>${esc(t('detail.retry'))}</button>`
  if (box._html !== html) { box.innerHTML = html; box._html = html }
}
sheetBody.addEventListener('click', e => e.target.closest('[data-detail-retry]') && state.open && loadDetail(state.open))
// The thread's links: a helper's conversation, a workflow's agents, another session.
sheetBody.addEventListener('click', e => {
  const link = e.target.closest('[data-helper], [data-run-open], [data-session]')
  if (!link) return
  // Inside a line that folds open (a message sent, a report), the link opens, not the fold.
  e.preventDefault()
  if (link.dataset.helper) return openHelpers({ id: link.dataset.helper }, link)
  if (link.dataset.runOpen) return openHelpers({ list: true, run: link.dataset.runOpen }, link)
  goToSession(link.dataset.session)
})

function renderSheetHead() {
  const it = itemOf(state.open) ?? state.selectedItem
  if (!it) return
  const pill = $('#sheet-status')
  pill.style.setProperty('--c', COLORS[it.column])
  pill.innerHTML = !itemOf(state.open) || state.detailState?.status === 'missing' ? esc(t('detail.missingShort')) : it.sleeping ? `${ICON.moon}${esc(t('sheet.asleep'))}` : `<span class="dot ${it.column}" style="--c:${COLORS[it.column]}"></span>${esc(colTitle(it.column))}`
  $('#sheet-name').textContent = it.name
  $('#sheet-name').title = it.name
  const tokens = it.context >= 1000 ? `${Math.round(it.context / 1000)}k` : it.context
  const context = it.contextPct != null ? t('meta.contextPct', { pct: Math.round(it.contextPct), tokens }) : it.context ? t('meta.context', { tokens }) : ''
  // Each fact whole on its line: the line breaks between them, after a separator, never inside one.
  $('#sheet-meta').innerHTML = [catInfo(catOf(it)).title, it.workspace && t('meta.workspace', { name: it.workspace }), it.activity && (ago(it.activity) === t('ago.now') ? t('meta.activeNow') : t('meta.active', { ago: ago(it.activity) })), context].filter(Boolean).map(part => `<span>${esc(part)}</span>`).join(' · ')
  $('#sheet-meta').title = context ? t('meta.contextHint') : ''
  $('#sheet-history').hidden = !it.session // a Claude project to look back in
  const term = $('#sheet-term')
  term.hidden = state.data.terminal === false || !(it.cwd || it.pane)
  term.classList.toggle('has-shell', (state.data.shells ?? []).includes(it.key))
  term.title = t((state.data.shells ?? []).includes(it.key) ? 'term.shellOpen' : 'term.hint')
  $('#sheet-mokupilot').hidden = !(state.data.mokupilot && it.session && it.agent === 'claude')
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
      ${scheduleRow(it)}
      ${relationsRow(it)}
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

/**
 * The sessions this one works with, in its sheet: who started it, whom it started, whom it wrote
 * with and how often each way. A name opens that session.
 */
const relAll = new Set() // sessions whose sheet shows every linked session, not the first few
function relationsRow(it) {
  const peers = linkedSessions(it)
  if (!peers.length) return ''
  const all = relAll.has(it.key) || peers.length <= 6
  const chips = (all ? peers : peers.slice(0, 5)).map(p => {
    const other = itemOf(p.key)
    const marks = `${p.from ? ICON.from : ''}${p.started ? ICON.spawned : ''}`
    const io = p.in || p.out ? `<span class="rel-io">${p.in ? `<i>↓${p.in}</i>` : ''}${p.out ? `<i>↑${p.out}</i>` : ''}</span>` : ''
    const title = [p.from && t('rel.fromHint', { name: other.name }), p.started && t('rel.startedThis'), (p.in || p.out) && t('rel.talkHint', { name: other.name, in: p.in, out: p.out, when: ago(p.at) })].filter(Boolean).join('\n')
    return `<button class="rel-chip" data-session="${esc(p.key)}" style="--lane:${catInfo(catOf(other)).color}" title="${esc(title)}">${marks ? `<span class="rel-marks">${marks}</span>` : ''}<span class="rel-name">${esc(other.name)}</span>${io}</button>`
  })
  if (!all) chips.push(`<button class="rel-more" data-rel-all>${esc(t('rel.more', { n: peers.length - 5 }))}</button>`)
  return `<div class="row rel-row"><span class="row-label">${esc(t('rel.row'))}</span><div class="row-value rel-chips">${chips.join('')}</div></div>`
}

/** Each session this one is linked with, once: who started it first, then by the latest contact. */
function linkedSessions(it) {
  const l = it.links
  if (!l) return []
  const by = new Map()
  const get = key => by.get(key) ?? by.set(key, { key, from: false, started: false, in: 0, out: 0, at: 0 }).get(key)
  if (l.from) Object.assign(get(l.from.key), { from: true, at: l.from.at })
  for (const s of l.started ?? []) Object.assign(get(s.key), { started: true, at: Math.max(get(s.key).at, s.at) })
  for (const x of l.talks ?? []) Object.assign(get(x.key), { in: x.in, out: x.out, at: Math.max(get(x.key).at, x.at) })
  return [...by.values()].filter(p => itemOf(p.key)).sort((a, b) => b.from - a.from || b.at - a.at)
}

/** The session's reminders in its sheet: the first three, the rest in the schedule panel. */
function scheduleRow(it) {
  const list = schedulesOf(it.key)
  if (!list.length) return ''
  const shown = list.slice(0, 3).map(e => {
    const what = `${e.cron ? ICON.repeat : ICON.alarm}${esc(capital(longWhen(e.next, t), t))}`
    return `<div class="sched-mini" data-id="${esc(e.id)}"><span class="when${overdue(e) ? ' due' : ''}" title="${esc(e.cron ? `${t('sched.repeat')}: ${e.cron}` : t('sched.once'))}">${what}</span><span class="text" title="${esc(e.text)}">${esc(e.text)}</span>${modeButton(e, true)}${cancelButton(e)}</div>`
  })
  const more = list.length > 3 ? `<button class="sched-more" data-sched-more>${esc(t('sched.more', { n: list.length - 3 }))}</button>` : ''
  return `<div class="row sched-row"><span class="row-label">${esc(t('sched.row'))}</span><div class="row-value">${shown.join('')}${more}</div></div>`
}

function renderSheetBody(reset) {
  const it = itemOf(state.open) ?? state.selectedItem
  if (!it) return
  renderSheetCard(it)
  const atBottom = sheetBody.scrollHeight - sheetBody.scrollTop - sheetBody.clientHeight < 40
  let html = '<div class="detail-status" id="sheet-detail-state" role="status" hidden></div>', question = ''
  // A question form or a permission prompt is answered right here; the raw screen stays one click away.
  const form = questionsUI.mount(it, state.detail)
  if (form && state.detail?.screen) html += `<details class="qa-screen"><summary>${esc(t('qa.screen'))}</summary><pre class="screen">${esc(state.detail.screen)}</pre></details>`
  else if (it.column === 'me') {
    const later = it.attention === 'later'
    const why = t(it.attention ? `why.${it.attention}` : 'why.default')
    const wave = dismissable(it) ? `<button class="button asked-dismiss" data-act="dismiss">${ICON.check}<span>${esc(t(later ? 'asked.seen' : 'asked.noReply'))}</span></button>` : ''
    const text = later ? t('asked.later') : it.question || t('asked.terminal')
    question = `<div class="asked"><b>${esc(why)}</b>${esc(text)}${wave}</div>`
    if (state.detail?.screen) html += `<pre class="screen">${esc(state.detail.screen)}</pre>`
  }
  if (!form && sheetQuestion._html !== question) { sheetQuestion.innerHTML = question; sheetQuestion._html = question }
  sheetQuestion.hidden = !question && !form
  renderHelpersStrip()
  html += `<div class="section-title">${esc(t('thread.title'))}</div><div class="thread">`
  const conv = state.detail?.conversation
  if (!conv) html += `<p class="row-value muted">${esc(t(['error', 'missing'].includes(state.detailState?.status) ? 'detail.noTranscript' : 'loading'))}</p>`
  else if (!conv.length) html += `<p class="row-value muted">${esc(t('thread.empty'))}</p>`
  else html += thread(conv, it)
  html += '</div>'
  // The same thread draws the same markup (running clocks are filled in after): a redraw keeps the focus and the open folds.
  redraw(sheetBody, html)
  files.upgrade(sheetBody, it.cwd)
  syncAvailability()
  if (reset || atBottom) sheetBody.scrollTop = sheetBody.scrollHeight
}

/**
 * The session's helpers above its conversation: the ones at work with what each does now and a
 * running clock, else the newest one in a line. A row opens the helper's conversation, "All" the
 * whole list (helpers.js).
 */
const sheetHelpers = $('#sheet-helpers')
function renderHelpersStrip() {
  const list = state.detail?.helpers ?? []
  const runs = state.detail?.workflows ?? []
  let html = ''
  if (list.length || runs.length) {
    const running = list.filter(h => h.status === 'running')
    const liveRuns = runs.filter(w => w.status === 'running')
    const sum = [running.length && t('helpers.running', { n: running.length }), list.length - running.length && t('helpers.done', { n: list.length - running.length })].filter(Boolean).join(' · ')
    let rows = liveRuns.map(w => runRowHTML(w, t)).join('') + running.filter(h => !h.workflow).slice(0, 4).map(h => helperRowHTML(h, t)).join('')
    const more = running.filter(h => !h.workflow).length - 4
    if (more > 0) rows += `<button class="helper-more" data-helpers-all>${esc(t('helpers.more', { n: more }))}</button>`
    if (!rows) {
      // The newest of the session's own helpers or workflow runs (not an agent inside a run).
      const last = [...list.filter(h => !h.workflow), ...runs].sort((a, b) => (b.endedAt ?? b.activity ?? 0) - (a.endedAt ?? a.activity ?? 0))[0]
      const when = last.endedAt ?? last.activity
      rows = `<button class="helper-last" ${last.kind ? `data-helper="${esc(last.id)}"` : `data-run-open="${esc(last.id)}"`}>${kindIcon(last.kind ? last : { kind: 'workflow' })}<span>${esc(t('helpers.last', { title: last.kind ? helperTitle(last) : last.name || last.id, when: ago(when) }))}</span>${statusMark(last.status)}</button>`
    }
    html = `<header class="helpers-head"><h3 id="sheet-helpers-title">${esc(t('helpers.title'))}</h3><span class="helpers-sum">${esc(sum)}</span><button class="helpers-all" data-helpers-all title="${esc(t('helpers.allHint'))}">${esc(t('helpers.all'))}${ICON.chev}</button></header><div class="helper-rows">${rows}</div>`
  }
  sheetHelpers.hidden = !html
  redraw(sheetHelpers, html)
}
sheetHelpers.addEventListener('click', e => {
  const row = e.target.closest('[data-helper]')
  if (row) return openHelpers({ id: row.dataset.helper }, row)
  const run = e.target.closest('[data-run-open]')
  if (run) return openHelpers({ list: true, run: run.dataset.runOpen }, run)
  const all = e.target.closest('[data-helpers-all]')
  if (all) openHelpers({ list: true }, all)
})

// The clocks of what works now move on every second, wherever they are on show.
setInterval(() => tickClocks(), 1000)

/**
 * Messages as bubbles; runs of tool calls fold into one line that opens to show them. A call that
 * works with others is a line of its own: a helper it started (opens its conversation), a
 * workflow, a message to another session, a session it started. Another session's or a
 * teammate's message is a bubble with their name. `ctx.helper` draws a helper's own
 * conversation (helpers.js): what the session asked it is the other side there.
 */
function thread(conv, it, ctx = {}) {
  let html = ''
  let run = []
  let i = 0
  const helpers = state.detail?.helpers ?? []
  const flush = () => {
    if (!run.length) return
    const lastTool = run.at(-1)
    const live = !lastTool.done && (ctx.helper ? ctx.helper.status === 'running' : it.column === 'work')
    const summary = live ? t('run.now', { tool: lastTool.label }) : `${t('run.actions', { n: run.length })} · ${lastTool.label}`
    html += `<details class="tools" data-i="${i++}"><summary>${live ? ICON.spin : ICON.chev}<span>${esc(summary)}</span></summary>${run
      .map(x => `<div class="tool-line${x.done ? '' : ' pending'}"><span class="t">${esc(x.label)}</span><span class="d${x.path ? ' fs-inline' : ''}"${x.path ? ` data-path="${esc(x.path)}"` : ''}>${esc(x.detail)}</span></div>`)
      .join('')}</details>`
    run = []
  }
  for (const m of conv) {
    // A question form is a turn of its own: what was asked, and the answer.
    if (m.role === 'tool' && m.ask) {
      flush()
      html += questionsUI.threadHTML(m, it.status === 'blocked', clock(m.at))
      continue
    }
    if (m.role === 'tool' && !(m.helper || m.workflow || m.send || m.spawn)) {
      run.push(m)
      continue
    }
    flush()
    if (m.role === 'tool') {
      html += linkLine(m, it, ctx, helpers)
      continue
    }
    if (m.role === 'notice') {
      html += notice(m, helpers)
      continue
    }
    if (m.role === 'peer' || (ctx.helper && m.role === 'user')) {
      html += peerBubble(m, it, ctx, helpers)
      continue
    }
    html += `<div class="msg ${m.role}"><div class="md">${markdown(m.text)}</div>${thumbs(m.text)}<span class="when">${clock(m.at)}</span></div>`
  }
  flush()
  return html
}

/** A name in the thread that leads somewhere: a session on the board, a teammate, or just the name. */
function whoHTML(name, it, ctx, helpers, key = null) {
  // In a helper's own conversation, its session goes by "main" or "team-lead".
  if (ctx.helper && ['main', 'team-lead'].includes(name)) return `<b>${esc(it.name ?? name)}</b>`
  // A reply to a message pipe whose session is gone: no name to give.
  if (!name && !key) return `<b>${esc(t('thread.anotherSession'))}</b>`
  // The session's own helper goes by that name first (a teammate, a named agent), then a session.
  const mate = !key && findHelper(helpers, { name })
  if (mate) return `<button class="who" data-helper="${esc(mate.id)}" title="${esc(t('helpers.open'))}">${esc(mate.name || helperTitle(mate))}</button>`
  const session = (key && itemOf(key)) || sessionByName(state.data.items, name, it.key)
  if (session) return `<button class="who" data-session="${esc(session.key)}" title="${esc(t('rel.open', { name: session.name }))}">${esc(session.name)}</button>`
  return `<b>${esc(name)}</b>`
}

/** A call that works with others, as a line of its own (see thread). */
function linkLine(m, it, ctx, helpers) {
  const when = `<span class="when">${clock(m.at)}</span>`
  if (m.helper) {
    const h = findHelper(helpers, { id: m.helper.id, tool: m.id })
    const kind = h?.kind ?? m.helper.kind
    const title = h ? helperTitle(h) : m.detail || m.helper.name || m.helper.type
    const sub = [h?.type ?? m.helper.type, (h?.name ?? m.helper.name) !== title ? (h?.name ?? m.helper.name) : '', t((h ? h.background : m.helper.background) ? 'helpers.background' : 'helpers.foreground')].filter(Boolean).join(' · ')
    const mark = h ? `${timeHTML(h.startedAt, h.status, took(h))}${statusMark(h.status)}` : !m.done ? statusMark('running') : ''
    const line = `${kindIcon({ kind, color: h?.color })}<span class="link-text"><span class="link-title">${esc(t('thread.helper', { kind: t(`helpers.kind.${kind}`), title }))}</span>${sub ? ` <small>${esc(sub)}</small>` : ''}</span>${mark}`
    return h ? `<button class="link-line" data-helper="${esc(h.id)}" title="${esc(t('helpers.open'))}">${line}</button>` : `<div class="link-line">${line}${when}</div>`
  }
  if (m.workflow) {
    const w = (state.detail?.workflows ?? []).find(x => x.id === m.workflow.run)
    const line = `${kindIcon({ kind: 'workflow' })}<span class="link-text"><span class="link-title">${esc(t('thread.workflow', { name: w?.name || m.workflow.name || m.workflow.run }))}</span>${w?.agents ? ` <small>${esc(t('helpers.agents', { n: w.agents }))}</small>` : ''}</span>${w ? statusMark(w.status) : !m.done ? statusMark('running') : ''}`
    return w ? `<button class="link-line" data-run-open="${esc(w.id)}" title="${esc(t('helpers.open'))}">${line}</button>` : `<div class="link-line">${line}${when}</div>`
  }
  if (m.spawn) {
    const target = state.data.items.find(x => x.pane && x.pane === m.spawn.pane && [x.name, x.autoName].includes(m.spawn.name)) ?? null
    const name = target ? `<button class="who" data-session="${esc(target.key)}" title="${esc(t('rel.open', { name: target.name }))}">${esc(target.name)}</button>` : `<b>${esc(m.spawn.name || '…')}</b>`
    const text = t(m.spawn.failed ? 'thread.spawnFailed' : 'thread.spawn', { name: '\u0000' }).split('\u0000')
    return `<div class="link-line${m.spawn.failed ? ' failed' : ''}"><span class="h-icon k-session">${ICON.spawned}</span><span class="link-text">${esc(text[0])}${name}${esc(text[1] ?? '')}</span>${!m.done ? statusMark('running') : ''}${when}</div>`
  }
  // A message to another session or a teammate: its first words in the line, the whole of it inside.
  const text = t('thread.sent', { name: '\u0000' }).split('\u0000')
  const line = `<span class="h-icon k-session">${ICON.out}</span><span class="link-text">${esc(text[0])}${whoHTML(m.send.to, it, ctx, helpers, m.send.key)}${esc(text[1] ?? '')}${m.send.summary ? ` <small>${esc(m.send.summary)}</small>` : ''}</span>${when}`
  if (!m.send.text) return `<div class="link-line">${line}</div>`
  return `<details class="link-line sent" data-i="sent-${esc(m.id)}"><summary>${line}${ICON.chev}</summary><div class="notice-body"><div class="md">${markdown(m.send.text)}</div></div></details>`
}

/** Another session's or a teammate's message; in a helper's conversation, what its session asked. */
function peerBubble(m, it, ctx, helpers) {
  const from = ctx.helper && m.role === 'user' ? `<b>${esc(it.name ?? '')}</b>` : whoHTML(m.from, it, ctx, helpers, m.key)
  const label = t(ctx.helper && m.role === 'user' ? 'thread.task' : 'thread.peer', { name: '\u0000' }).split('\u0000')
  const head = `<div class="peer-from">${m.team ? HELPER_ICONS.teammate : ICON.peer}<span>${esc(label[0])}${from}${esc(label[1] ?? '')}</span>${m.summary ? `<small>${esc(m.summary)}</small>` : ''}</div>`
  return `<div class="msg peer${m.team ? ' team' : ''}">${head}<div class="md">${markdown(m.text)}</div><span class="when">${clock(m.at)}</span></div>`
}

/**
 * A background task reporting back or a board reminder: a quiet line in the thread, not the
 * user's bubble. An agent's report or a monitor's lines open from it; a command's output file is
 * a click away.
 */
function notice(m, helpers = []) {
  const { text, sub, tone } = noticeLine(m, t)
  const mark = { ok: ICON.check, fail: ICON.cross, stop: ICON.stop }[tone] ?? (m.kind === 'reminder' || m.kind === 'schedule' ? ICON.alarm : ICON.bolt)
  const file = m.file && !m.detail ? `<span class="notice-file fs-inline" data-path="${esc(m.file)}">${esc(t('notice.output'))}</span>` : ''
  // An agent that reported back: its whole conversation is a click away.
  const agent = m.kind === 'agent' && m.id ? findHelper(helpers, { id: m.id }) : null
  // A workflow reports under its task id, which its run file keeps.
  const run = m.kind === 'workflow' && m.id ? (state.detail?.workflows ?? []).find(w => w.taskId === m.id) : null
  const open = agent ? `<button class="notice-open" data-helper="${esc(agent.id)}" title="${esc(t('helpers.open'))}">${esc(t('notice.open'))}</button>`
    : run ? `<button class="notice-open" data-run-open="${esc(run.id)}" title="${esc(t('helpers.open'))}">${esc(t('notice.open'))}</button>` : ''
  const line = `<span class="notice-mark">${mark}</span><span class="notice-text"${m.summary ? ` title="${esc(m.summary)}"` : ''}>${esc(text)}${sub ? ` <small>${esc(sub)}</small>` : ''}</span>${file}${open}<span class="when">${clock(m.at)}</span>`
  if (!m.detail) return `<div class="notice ${tone}">${line}</div>`
  // An agent's report is markdown; a monitor's lines and a tool's result are kept as they came.
  const body = ['agent', 'workflow'].includes(m.kind) ? `<div class="md">${markdown(m.detail)}</div>` : `<pre>${esc(m.detail)}</pre>`
  // Kept open across refreshes by this key: a task can report several times under one id.
  return `<details class="notice ${tone}" data-i="notice-${esc(`${m.id}-${m.at}`)}"><summary>${line}${ICON.chev}</summary><div class="notice-body">${body}</div></details>`
}

sheetCard.addEventListener('click', e => {
  const cancel = e.target.closest('[data-sched-cancel]')
  if (cancel) return cancelSchedule(cancel)
  const mode = e.target.closest('[data-sched-mode]')
  if (mode) return toggleMode(mode)
  if (e.target.closest('[data-sched-more]')) return openSchedule(state.open)
  const other = e.target.closest('[data-session]')
  if (other) return goToSession(other.dataset.session)
  if (e.target.closest('[data-rel-all]') && state.open) {
    relAll.add(state.open)
    return renderSheetCard(itemOf(state.open))
  }
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

sheetQuestion.addEventListener('click', e => {
  if (e.target.closest('[data-act="dismiss"]') && state.open) dismissAsk(state.open)
})
$('#sheet-focus').addEventListener('click', () => state.open && focusSession(state.open))
$('#sheet-term').addEventListener('click', e => state.open && openTerminal(state.open, e.currentTarget))
$('#sheet-mokupilot').addEventListener('click', () => state.open && callMokuPilot(state.open))
$('#sheet-wake').addEventListener('click', async () => {
  const key = state.open
  if (!key) return
  setBusy(key, t('busy.waking'))
  const r = await act(key, 'wake')
  setBusy(key, null)
  toast(r.ok ? t('toast.woke') : r.error, !r.ok)
})
$('#sheet-sleep').addEventListener('click', () => state.open && sleepSession(state.open))
$('#sheet-more').addEventListener('click', e => {
  const button = e.currentTarget, rect = button.getBoundingClientRect()
  const items = ['sheet-term', 'sheet-mokupilot', 'sheet-wake', 'sheet-sleep', 'sheet-changes', 'sheet-history', 'sheet-new']
    .map(id => document.getElementById(id)).filter(el => el && !el.hidden)
    .map(el => ({ id: el.id, label: el.textContent.trim(), disabled: el.disabled, reason: el.disabled ? (!canMutate() && ['sheet-wake', 'sheet-sleep', 'sheet-new'].includes(el.id) ? t('mobile.readOnly') : el.title || t('mobile.readOnly')) : '' }))
  menu.open(items, { x: rect.right, y: rect.top, source: e.detail === 0 ? 'keyboard' : matchMedia('(pointer: coarse)').matches ? 'touch' : 'mouse', origin: button, label: t('sheet.more'), onPick: id => {
    const action = document.getElementById(id)
    if (!action || action.disabled || action.hidden) return
    // Dialogs must return focus to this visible opener, not the hidden toolbar button.
    if (id === 'sheet-history') return state.open && files.lookHistory(state.open, itemOf(state.open)?.cwd ?? '', button)
    if (id === 'sheet-changes') return state.open && files.lookChanges(state.open, button)
    if (id === 'sheet-new') return state.open && newSession({ item: itemOf(state.open) }, button)
    if (id === 'sheet-term') return state.open && openTerminal(state.open, button)
    action.click()
  } })
  button.setAttribute('aria-expanded', 'true')
})

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
  sendBtn.disabled = !itemOf(state.open) || state.detailState?.status === 'missing' || sending.has(state.open) || !canMutate() || uploading || !(message.value.trim() || ready)
  const discard = $('#draft-cancel')
  discard.hidden = !(message.value || attachments.length)
  discard.disabled = sending.has(state.open)
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
  if (!canEdit()) return toast(t('live.off'), true)
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

function saveDraft() {
  const key = state.open && draftIdentity
  if (!key) return
  if (currentDraft?.text === message.value) return
  currentDraft = drafts.save(key, message.value)
}
message.addEventListener('input', () => { saveDraft(); syncComposer() })
$('#draft-cancel').addEventListener('click', () => {
  if (sending.has(state.open)) return
  drafts.clear(draftIdentity)
  currentDraft = null
  message.value = ''
  clearAttachments()
  syncComposer()
  message.focus()
})
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
  if (!canMutate() || !key || sending.has(key) || (!text && !files.length) || attachments.some(a => a.status === 'uploading')) return
  const it = itemOf(key)
  if (!it) return
  saveDraft()
  const request = currentDraft ?? (currentDraft = drafts.save(draftKey(it), message.value))
  sending.add(key)
  sendBtn.disabled = true
  if (it?.sleeping) setBusy(key, t('busy.waking'))
  const r = await act(key, 'message', { text, files, session: it.session ?? null, requestId: request.id })
  sending.delete(key)
  setBusy(key, null)
  if (r.ok) {
    drafts.clear(draftKey(it), request.id)
    if (state.open === key && currentDraft?.id === request.id) {
      message.value = ''
      currentDraft = null
      clearAttachments()
    }
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
  onChange: () => dialogBack.sync(),
  text: key => t(key),
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
  if (!canEdit()) return { ok: false, error: t('live.off') }
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

// ---------------------------------------------------------------- schedule
// What the agents set with `board remind` and `board every`: every entry by day, soonest first,
// then what was sent or missed lately. Cancelling takes two clicks, here and in a session's sheet.
const schedPanel = new Panel($('#sched-sheet'), {
  onClose: () => disarm(),
  onChange: () => dialogBack.sync(),
  text: key => t(key),
})
const schedBody = $('#sched-body')
let armed = null // { id, timer }: the entry whose cancel button asks "Cancel?"
let collapsing = 0 // rows on their way out; the panel redraws once they are gone

function openSchedule(key) {
  schedBody._fresh = true
  schedPanel.open()
  renderSchedule()
  const row = key && schedBody.querySelector(`.sched-entry[data-key="${CSS.escape(key)}"]`)
  if (!row) return
  row.scrollIntoView({ block: 'center' })
  if (!reducedMotion.matches) row.animate([{ background: 'color-mix(in srgb, var(--accent) 16%, transparent)' }, { background: 'transparent' }], { duration: 1400, easing: 'ease-out' })
}

const cancelButton = e => {
  const ask = armed?.id === e.id
  return `<button class="sched-x"${ask ? ' data-confirm' : ''} data-sched-cancel="${esc(e.id)}" title="${esc(t('sched.cancel'))}" aria-label="${esc(t(ask ? 'sched.confirm' : 'sched.cancel'))}">${ICON.trash}<span>${ask ? esc(t('sched.confirm')) : ''}</span></button>`
}

/** Why a due entry has not gone out yet. */
function pendingText(e) {
  if (!e.pendingSince) return ''
  const own = { gone: 'sched.gone', draft: 'sched.draft', dialog: 'sched.dialog', busy: 'sched.pending' }
  return t(own[e.why] ?? (e.why ? 'sched.failed' : 'sched.pending'), { why: e.why })
}

function entryHTML(e, when) {
  const it = itemOf(e.key)
  const pending = pendingText(e)
  // A session that left the board keeps its entries until they run out of patience or are cancelled.
  const note = pending || (it ? '' : t('sched.gone'))
  // Set by another session than the one it is for (`board remind --session`).
  const by = e.from && e.from.key !== (e.movedFrom?.key ?? e.key) ? t('sched.by', { name: itemOf(e.from.key)?.name || e.from.name || e.from.key.slice(0, 8) }) : ''
  const stats = [e.cron && `<code>${esc(e.cron)}</code>`, e.runs && esc(t('sched.runs', { n: e.runs })), e.missed && esc(t('sched.missedN', { n: e.missed })), by && esc(by)].filter(Boolean).join(' · ')
  return `<div class="sched-entry${pending ? ' waiting' : ''}" data-id="${esc(e.id)}" data-key="${esc(e.key)}">
    <div class="sched-time"><b>${esc(when(e))}</b><span>${e.cron ? `${ICON.repeat}${esc(t('sched.repeat'))}` : esc(t('sched.once'))}</span></div>
    <div class="sched-main">
      <button class="sched-who" data-open="${esc(e.key)}" style="--lane:${it ? catInfo(catOf(it)).color : 'var(--gray)'}"${it ? ` title="${esc(t('sched.open'))}"` : ' disabled'}>${esc(it?.name || e.name || t('session'))}</button>
      <div class="sched-text">${esc(e.text)}</div>
      <div class="sched-stats">${modeButton(e)}${stats ? `<span>${stats}</span>` : ''}</div>${note ? `<div class="sched-state${pending ? '' : ' muted'}">${esc(note)}</div>` : ''}
    </div>
    ${cancelButton(e)}
  </div>`
}

function logHTML(r) {
  const it = itemOf(r.key)
  const late = r.at - r.due
  const note =
    r.result === 'dropped' ? t('sched.why.dropped', { n: r.n ?? 3 })
    : r.result === 'missed' ? (['busy', 'gone', 'draft', 'dialog'].includes(r.why) ? t(`sched.why.${r.why}`) : r.why)
    : late > 120_000 ? t('sched.lateBy', { late: span(late, t) }) : ''
  const icon = { sent: ICON.check, missed: '!', dropped: '×' }[r.result] ?? '!'
  return `<div class="log-row ${esc(r.result)}"><span class="log-icon" title="${esc(t(`sched.${r.result === 'sent' || r.result === 'dropped' ? r.result : 'missed'}`))}">${icon}</span><span class="log-when">${esc(capital(longWhen(r.at, t), t))}</span><span class="log-what"><b>${esc(it?.name || r.name || t('session'))}</b> ${esc(r.text)}</span>${note ? `<span class="log-note">${esc(note)}</span>` : ''}</div>`
}

function renderSchedule() {
  if (!schedPanel.isOpen || collapsing) return
  const list = state.data.schedules ?? []
  // Due ones that wait for their session first, then by day.
  const groups = []
  const waiting = list.filter(overdue)
  if (waiting.length) groups.push({ title: t('sched.waiting'), list: waiting, when: e => shortWhen(e.next, t) })
  for (const e of list.filter(e => !overdue(e))) {
    const title = capital(dayLabel(e.next, t), t)
    if (groups.at(-1)?.title !== title) groups.push({ title, list: [], when: e => timeOf(e.next, t) })
    groups.at(-1).list.push(e)
  }
  let html = list.length ? '' : `<div class="sched-empty">${ICON.alarm}<p>${esc(t('sched.empty'))}</p><p class="hint">${t('sched.emptyHint')}</p></div>`
  for (const g of groups) html += `<div class="section-title">${esc(g.title)}</div><div class="group sched-group">${g.list.map(e => entryHTML(e, g.when)).join('')}</div>`
  const log = state.data.scheduleLog ?? []
  if (log.length) html += `<div class="section-title">${esc(t('sched.recent'))}</div><div class="group sched-log">${log.slice(0, 15).map(logHTML).join('')}</div>`
  if (schedBody._html === html) return
  // New entries materialize; on opening the panel its own slide is motion enough.
  const before = new Set([...schedBody.querySelectorAll('.sched-entry')].map(r => r.dataset.id))
  schedBody.innerHTML = html
  schedBody._html = html
  if (!schedBody._fresh) for (const row of schedBody.querySelectorAll('.sched-entry')) if (!before.has(row.dataset.id)) appear(row)
  schedBody._fresh = false
}

function renderScheduleCount() {
  const list = state.data.schedules ?? []
  $('#sched-count').textContent = list.length || ''
  $('#sched-open').classList.toggle('due', list.some(overdue))
}

function disarm(redraw = true) {
  if (!armed) return
  clearTimeout(armed.timer)
  armed = null
  if (redraw) render()
}

/** A row folds away: its height and opacity spring to nothing. */
function collapse(el) {
  if (reducedMotion.matches || !el.isConnected) return Promise.resolve()
  const h = el.offsetHeight
  const cs = getComputedStyle(el)
  const pt = parseFloat(cs.paddingTop)
  const pb = parseFloat(cs.paddingBottom)
  el.style.overflow = 'hidden'
  return new Promise(resolve => {
    const s = new Spring({
      value: 1,
      damping: 1,
      response: 0.32,
      precision: 0.004,
      onUpdate: v => {
        el.style.height = `${h * v}px`
        el.style.paddingTop = `${pt * v}px`
        el.style.paddingBottom = `${pb * v}px`
        el.style.opacity = String(v * v)
      },
      onRest: resolve,
    })
    s.to(0)
  })
}

/** On time or when the session is free: a pill in the panel, an icon in the sheet. */
function modeButton(e, short = false) {
  const label = t(e.idle ? 'sched.mode.idle' : 'sched.mode.onTime')
  const hint = t(e.idle ? 'sched.mode.idleHint' : 'sched.mode.onTimeHint')
  return `<button class="sched-mode${e.idle ? ' idle' : ''}${short ? ' short' : ''}" data-sched-mode="${esc(e.id)}" title="${esc(hint)}" aria-label="${esc(label)}" aria-pressed="${!e.idle}">${e.idle ? ICON.hourglass : ICON.bolt}${short ? '' : `<span>${esc(label)}</span>`}</button>`
}

async function toggleMode(btn) {
  const entry = (state.data.schedules ?? []).find(e => e.id === btn.dataset.schedMode)
  if (!entry) return
  const idle = !entry.idle
  // On screen at once; the live stream confirms it.
  entry.idle = idle || undefined
  render()
  const r = await postSchedule({ op: 'mode', id: entry.id, idle })
  if (!r.ok) {
    entry.idle = !idle || undefined
    render()
    return toast(r.error, true)
  }
  toast(t('sched.mode.set', { mode: t(idle ? 'sched.mode.idle' : 'sched.mode.onTime') }))
}

/** First click arms the button ("Cancel?"), a second one within four seconds removes the entry. */
async function cancelSchedule(btn) {
  const id = btn.dataset.schedCancel
  if (armed?.id !== id) {
    disarm(false)
    armed = { id, timer: setTimeout(() => disarm(), 4000) }
    return render()
  }
  disarm(false)
  const entry = (state.data.schedules ?? []).find(e => e.id === id)
  const rows = [...document.querySelectorAll(`.sched-entry[data-id="${CSS.escape(id)}"], .sched-mini[data-id="${CSS.escape(id)}"]`)]
  collapsing++
  let r
  try {
    ;[r] = await Promise.all([postSchedule({ op: 'cancel', id }), ...rows.map(collapse)])
  } finally {
    collapsing--
  }
  if (r.ok) {
    // Off the board at once; the live stream confirms it.
    state.data.schedules = (state.data.schedules ?? []).filter(e => e.id !== id)
    toast(t('sched.cancelled', { text: plain(entry?.text ?? '').slice(0, 60) }))
  } else {
    for (const row of rows) row.removeAttribute('style')
    toast(r.error, true)
  }
  render()
}

async function postSchedule(body) {
  if (!canEdit()) return { ok: false, error: t('live.off') }
  try {
    const res = await fetch('/api/schedule', { method: 'POST', headers: { 'content-type': 'application/json', 'x-board': '1' }, body: JSON.stringify(body) })
    const r = await res.json().catch(() => ({}))
    return res.ok && r.ok !== false ? { ok: true } : { ok: false, error: r.error || t('err.status', { code: res.status }) }
  } catch (err) {
    return { ok: false, error: t('err.offline', { why: err.message }) }
  }
}

schedBody.addEventListener('click', e => {
  const cancel = e.target.closest('[data-sched-cancel]')
  if (cancel) return cancelSchedule(cancel)
  const mode = e.target.closest('[data-sched-mode]')
  if (mode) return toggleMode(mode)
  const who = e.target.closest('[data-open]')
  if (who && itemOf(who.dataset.open)) openSheet(who.dataset.open)
})
$('#sched-open').addEventListener('click', () => (schedPanel.isOpen ? schedPanel.close() : openSchedule()))

// ---------------------------------------------------------------- toolbar controls and keys
$('#lanes').addEventListener('click', e => {
  const b = e.target.closest('button')
  if (!b) return
  state.filter = b.dataset.id
  store.set('board.filter', state.filter)
  render()
})
/** The board's language, for every board (the server keeps it in config.json). */
async function chooseLanguage(next) {
  if (!canEdit()) return toast(t('live.off'), true)
  if (next === t.lang) return
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
}
$('#search').addEventListener('input', e => {
  state.query = e.target.value
  render()
})
function setSleepers(on) {
  state.sleepers = on
  store.set('board.sleepers', on ? '1' : '0')
  render()
}

// ---------------------------------------------------------------- settings
// The gear: how the board looks (light, dark or as the system has it), its language, where the
// panels sit, and whether sleeping sessions show. Light or dark is this browser's (theme.js
// applies it before the page paints); the language is the board's, for every board.
const THEMES = ['auto', 'light', 'dark']
const themeNow = () => document.documentElement.dataset.theme ?? 'auto'
function setTheme(theme) {
  if (theme === themeNow()) return
  store.set('board.theme', theme)
  const apply = () => {
    if (theme === 'auto') delete document.documentElement.dataset.theme
    else document.documentElement.dataset.theme = theme
  }
  // A cross-fade, not a flash from one brightness to the other.
  if (document.startViewTransition && !reducedMotion.matches) document.startViewTransition(apply)
  else apply()
}
$('#settings').addEventListener('click', e => {
  const button = e.currentTarget
  const rect = button.getBoundingClientRect()
  const names = state.data.languages ?? LANGUAGES
  const edit = canEdit() ? {} : { disabled: true, reason: t('live.off') }
  const items = [
    { id: 'theme', label: t('set.theme'), submenu: THEMES.map(id => ({ id: `theme:${id}`, label: t(`set.theme.${id}`), checked: themeNow() === id })) },
    { id: 'lang', label: t('set.lang'), ...edit, submenu: Object.entries(names).map(([code, name]) => ({ id: `lang:${code}`, label: name, checked: t.lang === code })) },
    { id: 'panel', label: t('set.panel'), submenu: [...['right', 'left', 'bottom', 'float'].map(id => ({ id: `dock:${id}`, label: t(`panel.${id}`), checked: panelDock() === id })), { separator: true }, { id: 'dock:reset', label: t('panel.reset') }] },
    { separator: true },
    { id: 'sleepers', label: t('tb.sleepersTitle'), checked: state.sleepers },
  ]
  button.setAttribute('aria-expanded', 'true')
  menu.open(items, {
    x: rect.right,
    y: rect.bottom + 6,
    source: e.detail === 0 ? 'keyboard' : matchMedia('(pointer: coarse)').matches ? 'touch' : 'mouse',
    origin: button,
    label: t('set.title'),
    onPick: id => {
      const [kind, value] = id.split(':')
      if (kind === 'theme') setTheme(value)
      else if (kind === 'lang') chooseLanguage(value)
      else if (kind === 'dock') value === 'reset' ? resetPanelSize() : placePanels(value)
      else if (id === 'sleepers') setSleepers(!state.sleepers)
    },
  })
})

function openNextAttention() {
  const key = nextAttention(visibleItems().filter(it => !it.launchOnly && laneShown(catOf(it))), state.open, viewed)
  if (key) openSheet(key)
  else toast(t('attention.none'))
}
$('#next-attention').addEventListener('click', openNextAttention)

addEventListener('keydown', e => {
  // They take their keys first; the terminal window too, even while its screen has not the keys.
  if (menu.isOpen() || launchUI.isOpen() || termUI.isOpen() || helpersUI.isOpen()) return
  const typing = /^(INPUT|TEXTAREA)$/.test(document.activeElement?.tagName)
  if (e.key === 'Escape') {
    if (typing) return document.activeElement.blur()
    const open = panels.find(p => p.isOpen)
    if (open) return open.close()
    if (state.query) {
      $('#search').value = state.query = ''
      render()
    }
  } else if (['n', 'т'].includes(e.key.toLowerCase()) && e.shiftKey && !typing && !e.metaKey && !e.ctrlKey && !e.altKey && !files.isOpen()) {
    // Shift+N: a new session, in the lane on show.
    e.preventDefault()
    newSession(state.filter !== 'all' ? { category: state.filter } : {}, $('#new-session'))
  } else if (e.key === 'F2' && !typing && !files.isOpen()) {
    const card = document.activeElement?.closest?.('.card[data-key]')
    const key = card && itemOf(card.dataset.key) ? card.dataset.key : state.open
    if (!key) return
    e.preventDefault()
    startRename(key, card?.dataset.key === key ? card.querySelector('.name') : $('#sheet-name'))
  } else if (['n', 'т'].includes(e.key.toLowerCase()) && !typing && !e.metaKey && !e.ctrlKey && !e.altKey && !files.isOpen()) {
    e.preventDefault()
    openNextAttention()
  } else if (/^[1-9]$/.test(e.key) && state.open && sessionPanel.isOpen && !files.isOpen() && ($('#sheet').contains(document.activeElement) || document.activeElement?.closest?.('.card')?.dataset.key === state.open)) {
    // Digits pick an option of the question the session waits on, as in the terminal.
    if (questionsUI.onKey(e)) e.preventDefault()
  } else if (e.key === '/' && !typing) {
    e.preventDefault()
    $('#search').focus()
  } else if (e.code === 'Backquote' && e.ctrlKey && !e.altKey && !e.metaKey && state.open && sessionPanel.isOpen && !files.isOpen()) {
    // Ctrl+`: the terminal of the session in the sheet (its window closes with it again).
    e.preventDefault()
    openTerminal(state.open, $('#sheet-term'))
  }
})
addEventListener('scroll', () => $('.toolbar').classList.toggle('scrolled', scrollY > 2), { passive: true })
addEventListener('resize', () => {
  placeThumb(true)
  fadeLanes()
})
setInterval(render, 30_000) // ages

applyTexts()
resumeBoard()

// The checkout changes of the session's folder open in the quick look as a diff (files.js).
$('#sheet-changes').addEventListener('click', e => state.open && files.lookChanges(state.open, e.currentTarget))
// Past sessions of the project, searched in the quick look (files.js).
$('#sheet-history').addEventListener('click', e => state.open && files.lookHistory(state.open, itemOf(state.open)?.cwd ?? '', e.currentTarget))

// ---------------------------------------------------------------- new sessions, renaming, menus
// The "new session" window (launch.js) opens from the toolbar, a lane's +, the session sheet,
// the menus and Shift+N, and grows out of whichever it was.
{
  const button = document.createElement('button')
  button.className = 'pill-toggle icon-only new-session'
  button.id = 'new-session'
  button.dataset.hint = 'launch.toolbarHint'
  button.innerHTML = `${ICON.plus}<span data-i18n="launch.toolbar"></span>`
  $('.controls').prepend(button)
  button.addEventListener('click', () => newSession(state.filter !== 'all' ? { category: state.filter } : {}, button))
  const here = document.createElement('button')
  here.className = 'button'
  here.id = 'sheet-new'
  here.dataset.hint = 'launch.hereHint'
  here.innerHTML = `${ICON.plus}<span data-i18n="launch.here"></span>`
  $('#sheet .composer-actions').append(here)
  here.addEventListener('click', () => state.open && newSession({ item: itemOf(state.open) }, here))
  applyTexts()
}
$('#board').addEventListener('click', e => {
  const plus = e.target.closest('.lane-new')
  if (plus) newSession({ category: plus.closest('.lane').dataset.cat }, plus)
})

function newSession(ctx, from) {
  if (!canMutate()) return toast(t(canEdit() ? 'mobile.readOnly' : 'live.off'), true)
  launchUI.open(ctx, from)
}

async function focusLaunch(id) {
  if (!canMutate()) return toast(t('mobile.readOnly'), true)
  try {
    const res = await fetch(`/api/launch/${encodeURIComponent(id)}/focus`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-board': '1' }, body: '{}' })
    const r = await res.json().catch(() => ({}))
    if (!res.ok || r.ok === false) toast(r.error || t('err.status', { code: res.status }), true)
  } catch (err) {
    toast(t('err.offline', { why: err.message }), true)
  }
}

/**
 * Rename a session where its name is: on its card or in the sheet's head. The board keeps the
 * name on the card; Claude and herdr get it too only when the user ticks that, and only while
 * the session is idle, since /rename is typed into it.
 */
function startRename(key, el) {
  const it = itemOf(key)
  if (!it || !el) return
  if (!canEdit()) return toast(t('live.off'), true)
  const why = it.sleeping ? t('rename.why.asleep') : inTurn(it) ? t('rename.why.busy') : !canMutate() ? t('mobile.readOnly') : ''
  renameInPlace(el, {
    value: it.name,
    auto: it.autoName || it.name,
    claude: it.session && it.agent === 'claude' && it.pane ? { why } : null,
    t,
    onCommit: async (name, { claude }) => {
      const r = await act(key, 'rename', { name, claude })
      if (!r.ok) toast(r.error, true)
      // Claude says "Session renamed" when it took the name; without that, the toast says so.
      else toast(name ? t(claude ? (r.confirmed ? 'rename.doneClaude' : 'rename.unconfirmed') : 'rename.done', { name }) : t('rename.cleared', { name: it.autoName || it.name }))
      return r
    },
  })
}
$('#sheet-name').addEventListener('click', e => state.open && startRename(state.open, e.currentTarget))
$('#sheet-name').tabIndex = 0
$('#sheet-name').addEventListener('keydown', e => (e.key === 'Enter' || e.key === 'F2') && state.open && (e.preventDefault(), startRename(state.open, e.currentTarget)))

async function copyText(text, done) {
  try {
    await navigator.clipboard.writeText(String(text ?? ''))
    toast(done)
  } catch (err) {
    toast(err.message, true)
  }
}

async function openPath(path, how) {
  if (!canEdit()) return toast(t('live.off'), true)
  try {
    const res = await fetch('/api/fs/open', { method: 'POST', headers: { 'content-type': 'application/json', 'x-board': '1' }, body: JSON.stringify({ path, how }) })
    const r = await res.json().catch(() => ({}))
    if (!res.ok) toast(r.error || t('err.status', { code: res.status }), true)
  } catch (err) {
    toast(t('err.offline', { why: err.message }), true)
  }
}

initBoardMenus({
  t: () => t,
  menu,
  canMutate,
  canEdit,
  item: itemOf,
  column: colOf,
  category: catOf,
  state: () => state,
  launch: launchUI,
  do: {
    open: key => openSheet(key),
    focus: key => focusSession(key),
    write: key => openSheet(key, { compose: true }),
    wake: async key => {
      setBusy(key, t('busy.waking'))
      const r = await act(key, 'wake')
      setBusy(key, null)
      toast(r.ok ? t('toast.woke') : r.error, !r.ok)
    },
    sleep: key => sleepSession(key),
    rename: (key, el) => (el?.isConnected ? startRename(key, el) : (openSheet(key), setTimeout(() => startRename(key, $('#sheet-name')), 380))),
    move: (key, to) => moveCard(key, to),
    dismiss: key => dismissAsk(key),
    clear: async key => {
      const r = await act(key, 'card', { clear: true })
      toast(r.ok ? t('tui.cleared', { name: itemOf(key)?.name ?? '' }) : r.error, !r.ok)
    },
    changes: (key, el) => files.lookChanges(key, el),
    history: (key, el) => files.lookHistory(key, itemOf(key)?.cwd ?? '', el),
    terminal: (key, el) => openTerminal(key, el),
    mokupilot: key => callMokuPilot(key),
    newSession,
    cats: id => openCats(id),
    filter: id => {
      state.filter = id
      store.set('board.filter', id)
      render()
    },
    sleepers: () => setSleepers(!state.sleepers),
    search: () => $('#search').focus(),
    copy: copyText,
    openPath,
    look: (target, el) => files.look(target, el),
    focusLaunch,
  },
})
