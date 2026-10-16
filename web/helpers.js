// A session's helpers in a window over the dimmed board, grown out of the row or the line it was
// opened from and shrunk back into it, like the quick look: every subagent, fork, workflow agent
// and teammate of the session, and one helper's own conversation, rendered as the session's is
// and live while the helper works. Esc closes it; Backspace (or the back button) goes from a
// helper to the list.
import { modalFocus } from './modal-focus.js'
import { reducedMotion, Spring } from './spring.js'
import { clock, groupHelpers, helperTitle, toneOf, tokens, took } from './helper-model.js'

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
const svg = body => `<svg viewBox="0 0 20 20" aria-hidden="true">${body}</svg>`
export const HELPER_ICONS = {
  agent: svg('<circle cx="10" cy="6.8" r="3"/><path d="M4.5 16.5a5.5 5.5 0 0 1 11 0"/>'),
  fork: svg('<path d="M10 17v-5.5L5.2 6.7M10 11.5l4.8-4.8"/><path d="M4.2 3.5h3.3v3.3M15.8 3.5h-3.3v3.3"/>'),
  workflow: svg('<rect x="3" y="3.5" width="5.5" height="5.5" rx="1.4"/><rect x="11.5" y="11" width="5.5" height="5.5" rx="1.4"/><path d="M8.5 6.2h3.2a1.8 1.8 0 0 1 1.8 1.8v3"/>'),
  teammate: svg('<circle cx="7.5" cy="7.2" r="2.6"/><path d="M2.8 16a4.7 4.7 0 0 1 9.4 0"/><path d="M12.4 4.9a2.6 2.6 0 1 1 .9 4.9M14.2 11.6A4.7 4.7 0 0 1 17.2 16"/>'),
  stack: svg('<rect x="3" y="7" width="9.5" height="9.5" rx="2.2"/><path d="M7 4.5h7a2.5 2.5 0 0 1 2.5 2.5v7"/>'),
  back: svg('<path d="m12 4.5-5.5 5.5 5.5 5.5"/>'),
  close: svg('<path d="m5.5 5.5 9 9m0-9-9 9"/>'),
  check: svg('<path d="m4.5 10.5 3.5 3.5 7.5-8"/>'),
  cross: svg('<path d="m6 6 8 8M14 6l-8 8"/>'),
  stop: svg('<rect x="6" y="6" width="8" height="8" rx="1.5"/>'),
  idle: svg('<path d="M6 10h.01M10 10h.01M14 10h.01" stroke-width="2.6"/>'),
  spin: '<svg class="spin" viewBox="0 0 20 20" aria-hidden="true"><path d="M10 3a7 7 0 1 1-7 7"/></svg>',
}

/** The mark for a status: a spinner while it works, else a small round sign. */
export function statusMark(status) {
  if (status === 'running') return `<span class="h-mark run">${HELPER_ICONS.spin}</span>`
  const tone = toneOf(status)
  return `<span class="h-mark ${tone}">${{ ok: HELPER_ICONS.check, fail: HELPER_ICONS.cross, idle: HELPER_ICONS.idle }[tone] ?? HELPER_ICONS.stop}</span>`
}

/** A helper's icon by its kind, in its teammate color when it has one. */
export const kindIcon = h => `<span class="h-icon k-${esc(h.kind)}"${h.color ? ` data-color="${esc(h.color)}"` : ''}>${HELPER_ICONS[h.kind] ?? HELPER_ICONS.agent}</span>`

/**
 * A helper as a row: its icon, title, what it does now (or what it is), how long it ran and its
 * status. A row that runs carries data-since: the page's clock moves it on every second.
 */
export function helperRowHTML(h, tr) {
  const title = helperTitle(h)
  const what = h.status === 'running' && (h.now || h.after || h.waiting)
    ? h.now ? `<b>${esc(h.now.label)}</b> ${esc(h.now.detail)}` : h.waiting ? esc(tr('helpers.waitingBg', { n: h.waiting })) : esc(tr('helpers.after', { tool: h.after }))
    : esc([h.status === 'running' ? tr('helpers.thinking') : '', h.type, h.name && h.name !== title ? h.name : '', h.phase].filter(Boolean).join(' · '))
  const time = took(h)
  return `<button class="helper-row${h.depth ? ' nested' : ''}" data-helper="${esc(h.id)}" data-status="${esc(h.status)}" title="${esc(`${title} · ${tr(`helpers.status.${h.status}`)}`)}">
    ${kindIcon(h)}
    <span class="h-main"><span class="h-title">${esc(title)}</span><span class="h-now">${what}</span></span>
    <span class="h-time"${h.status === 'running' && h.startedAt ? ` data-since="${h.startedAt}"` : ''}>${time != null ? esc(clock(time)) : ''}</span>
    ${statusMark(h.status)}
  </button>`
}

/** A workflow run as a row: its name, its agents, its status. */
export function runRowHTML(w, tr) {
  const time = w.startedAt ? (w.status === 'running' ? Date.now() : (w.endedAt ?? w.activity)) - w.startedAt : null
  return `<button class="helper-row" data-run-open="${esc(w.id)}" data-status="${esc(w.status)}">
    ${kindIcon({ kind: 'workflow' })}
    <span class="h-main"><span class="h-title">${esc(w.name || w.id)}</span><span class="h-now">${esc([tr('helpers.kind.run'), w.agents && tr('helpers.agents', { n: w.agents })].filter(Boolean).join(' · '))}</span></span>
    <span class="h-time"${w.status === 'running' && w.startedAt ? ` data-since="${w.startedAt}"` : ''}>${time != null ? esc(clock(time)) : ''}</span>
    ${statusMark(w.status)}
  </button>`
}

/**
 * t(): the page's translator. item(key): the session. detail(key): its sheet's data ({ helpers,
 * workflows }) while that session is open. renderThread(conv, ctx): the session thread's own
 * renderer. upgrade(el, cwd): file chips. openSession(key): show another session.
 */
export function initHelpers({ t, item, detail, renderThread, upgrade, openSession, onDialogChange = () => {} }) {
  const tr = (key, vars) => t()(key, vars)
  const root = document.createElement('div')
  root.className = 'ql helpers'
  root.hidden = true
  root.innerHTML = `
    <div class="ql-scrim"></div>
    <section class="ql-win helper-win" role="dialog" aria-modal="true" aria-labelledby="helper-name" tabindex="-1">
      <header class="ql-head helper-head">
        <button class="icon-button ql-back helper-back" hidden>${HELPER_ICONS.back}</button>
        <span class="ql-icon helper-icon"></span>
        <div class="ql-titles"><h3 id="helper-name"></h3><p class="helper-sub"></p></div>
        <div class="ql-tools"><span class="helper-state" role="status"></span></div>
        <button class="icon-button ql-close helper-x">${HELPER_ICONS.close}</button>
      </header>
      <div class="ql-body helper-body"></div>
      <footer class="ql-foot helper-foot"></footer>
    </section>`
  document.body.append(root)
  const $ = sel => root.querySelector(sel)
  const win = $('.ql-win')
  const scrim = $('.ql-scrim')
  const body = $('.helper-body')
  const focus = modalFocus(root, win)

  const s = { key: null, stack: [], data: null, seq: 0, timer: 0, pinned: true }

  // ------------------------------------------------------------ the window's motion
  // 0 = folded into what it came from, 1 = open; a close while opening turns around.
  const motion = new Spring({ value: 0, damping: 1, response: 0.34, precision: 0.002, onUpdate: v => paint(v), onRest: v => v === 0 && finishClose() })
  let from = { dx: 0, dy: 24, s: 0.94 }
  let origin = null
  function measureFrom(el) {
    const saved = win.style.transform
    win.style.transform = 'none'
    const w = win.getBoundingClientRect()
    win.style.transform = saved
    const r = el?.isConnected ? el.getBoundingClientRect() : null
    if (!r || !r.width || r.bottom < 0 || r.top > innerHeight) return { dx: 0, dy: 24, s: 0.94 }
    return { dx: r.left + r.width / 2 - (w.left + w.width / 2), dy: r.top + r.height / 2 - (w.top + w.height / 2), s: Math.max(0.06, Math.min(0.5, r.width / w.width)) }
  }
  function paint(p) {
    const q = Math.max(0, p)
    if (reducedMotion.matches) {
      win.style.transform = ''
      win.style.opacity = String(Math.min(1, q))
    } else {
      const sc = from.s + (1 - from.s) * q
      win.style.transform = `translate(${from.dx * (1 - q)}px, ${from.dy * (1 - q)}px) scale(${sc})`
      win.style.opacity = String(Math.min(1, q * 1.8))
    }
    scrim.style.opacity = String(Math.min(1, q))
  }

  const isOpen = () => !root.hidden && motion.target === 1
  const top = () => s.stack.at(-1)

  /** Open the helpers of session `key` grown from `el`: { id } one helper, { list, run } the list. */
  function open(key, ref, el) {
    if (!item(key)) return
    if (isOpen() && s.key === key) {
      s.stack.push(ref)
      return show()
    }
    s.key = key
    s.stack = ref.id ? [ref] : [{ list: true, run: ref.run ?? null }]
    origin = el ?? null
    root.hidden = false
    labels()
    show()
    from = measureFrom(el)
    if (motion.value <= 0.001) paint(0)
    motion.to(1, { damping: 1, response: 0.34 })
    focus.open(origin ?? document.activeElement)
    onDialogChange()
  }

  function close() {
    if (root.hidden || motion.target === 0) return
    stopPolling()
    from = measureFrom(origin)
    motion.to(0, { damping: 1, response: 0.26 })
    if (reducedMotion.matches) motion.set(0)
    onDialogChange()
  }
  function finishClose() {
    root.hidden = true
    body.innerHTML = ''
    s.key = null
    s.stack = []
    s.data = null
    focus.close()
    // The row it came from may have been drawn anew meanwhile: the same row takes the focus back.
    if (origin && !origin.isConnected && document.activeElement === document.body) {
      const same = ['helper', 'runOpen'].find(k => origin.dataset?.[k])
      const sel = same ? `[data-${same === 'helper' ? 'helper' : 'run-open'}="${CSS.escape(origin.dataset[same])}"]` : origin.matches?.('[data-helpers-all]') ? '[data-helpers-all]' : ''
      if (sel) document.querySelector(`#sheet ${sel}`)?.focus({ preventScroll: true })
    }
  }
  function back() {
    if (s.stack.length < 2) return close()
    s.stack.pop()
    show()
  }

  function labels() {
    for (const [sel, k] of [['.helper-back', 'helpers.back'], ['.helper-x', 'sheet.close']]) {
      $(sel).title = tr(k)
      $(sel).setAttribute('aria-label', tr(k))
    }
  }

  // ------------------------------------------------------------ what it shows
  function show() {
    stopPolling()
    s.seq++
    s.data = null
    s.pinned = true
    $('.helper-back').hidden = s.stack.length < 2
    const ref = top()
    if (ref.list) return showList(ref)
    // What the sheet knows already shows at once; the conversation follows.
    const h = (detail(s.key)?.helpers ?? []).find(x => x.id === ref.id)
    head(h ?? { id: ref.id, kind: 'agent', status: '' })
    body.className = 'ql-body helper-body'
    body.innerHTML = `<div class="ql-wait">${esc(tr('loading'))}</div>`
    $('.helper-foot').textContent = ''
    load(s.seq, true)
  }

  function head(h) {
    $('.helper-icon').innerHTML = h.list ? HELPER_ICONS.stack : kindIcon(h)
    $('#helper-name').textContent = h.list ? tr('helpers.listTitle', { name: item(s.key)?.name ?? '' }) : helperTitle(h)
    const sub = h.list ? [] : [tr(`helpers.kind.${h.kind}`), h.name && h.name !== helperTitle(h) ? h.name : '', h.type, h.model, h.phase && tr('helpers.phase', { phase: h.phase }), h.kind === 'teammate' ? '' : tr(h.background ? 'helpers.background' : 'helpers.foreground')]
    $('.helper-sub').textContent = sub.filter(Boolean).join(' · ')
    $('.helper-state').innerHTML = h.status ? `${statusMark(h.status)}<span>${esc(tr(`helpers.status.${h.status}`))}</span>` : ''
    $('.helper-state').dataset.tone = h.status ? toneOf(h.status) : ''
  }

  // ---------------------------------------------------------------- the list
  const rowHTML = h => helperRowHTML(h, tr)

  function showList(ref) {
    head({ list: true })
    const d = detail(s.key)
    body.className = 'ql-body helper-body k-list'
    if (!d) {
      body.innerHTML = `<div class="ql-wait">${esc(tr('loading'))}</div>`
      return
    }
    const g = groupHelpers(d.helpers, d.workflows)
    const section = (title, rows, extra = '') => (rows ? `<section class="helper-section"${extra}><h4>${esc(title)}</h4><div class="helper-rows">${rows}</div></section>` : '')
    let html = section(tr('helpers.section.running'), g.running.map(rowHTML).join(''))
    for (const run of g.runs) {
      const stats = [run.agents.length && tr('helpers.agents', { n: run.agents.length }), run.tokens && tr('helpers.tokens', { n: tokens(run.tokens) }), run.summary].filter(Boolean).join(' · ')
      html += section(`${tr('helpers.kind.run')} · ${run.name || run.id}`, `<div class="helper-run" data-status="${esc(run.status)}">${statusMark(run.status)}<span>${esc(stats || tr(`helpers.status.${run.status}`))}</span></div>${run.agents.map(rowHTML).join('')}`, ` data-run="${esc(run.id)}"`)
    }
    html += section(tr('helpers.section.teammates'), g.teammates.map(rowHTML).join(''))
    html += section(tr('helpers.section.finished'), g.finished.map(rowHTML).join(''))
    body.innerHTML = html || `<div class="ql-empty">${HELPER_ICONS.stack}<p>${esc(tr('helpers.none'))}</p></div>`
    const all = d.helpers.length
    const running = d.helpers.filter(h => h.status === 'running').length
    $('.helper-foot').textContent = [tr('helpers.count', { n: all }), running && tr('helpers.running', { n: running }), d.workflows.length && tr('helpers.runs', { n: d.workflows.length })].filter(Boolean).join(' · ')
    if (ref.run) {
      const sec = body.querySelector(`[data-run="${CSS.escape(ref.run)}"]`)
      ref.run = null // once: a later redraw keeps the reader's place
      if (sec) requestAnimationFrame(() => {
        sec.scrollIntoView({ block: 'start' })
        if (!reducedMotion.matches) sec.animate([{ background: 'color-mix(in srgb, var(--accent) 14%, transparent)' }, { background: 'transparent' }], { duration: 1400, easing: 'ease-out' })
      })
    }
  }

  // ---------------------------------------------------------------- one helper
  async function load(seq, first = false) {
    const ref = top()
    let d = null
    let error = ''
    try {
      const res = await fetch(`/api/session/${encodeURIComponent(s.key)}/helper/${encodeURIComponent(ref.id)}`, { cache: 'no-store' })
      d = await res.json().catch(() => null)
      if (!res.ok) error = d?.error || tr('err.status', { code: res.status })
    } catch (err) {
      error = tr('err.offline', { why: err.message })
    }
    if (seq !== s.seq || root.hidden) return
    if (error) {
      if (!s.data) body.innerHTML = `<div class="ql-empty">${HELPER_ICONS.stack}<p>${esc(error)}</p></div>`
      return poll(seq, 4000)
    }
    s.data = d
    render(first)
    if (d.helper.status === 'running') poll(seq, 1500)
  }

  function render(first) {
    const { helper: h, conversation } = s.data
    head(h)
    const keep = !first && !s.pinned ? body.scrollTop : null
    const html = conversation.length ? `<div class="thread helper-thread">${renderThread(conversation, { helper: h, key: s.key })}</div>` : `<div class="ql-empty">${HELPER_ICONS[h.kind] ?? HELPER_ICONS.agent}<p>${esc(tr('thread.empty'))}</p></div>`
    if (body._html !== html) {
      const open = new Set([...body.querySelectorAll('details[open]')].map(x => x.dataset.i))
      body.innerHTML = html
      body._html = html
      for (const x of body.querySelectorAll('details')) if (open.has(x.dataset.i)) x.open = true
      upgrade(body, item(s.key)?.cwd ?? '')
    }
    if (keep != null) body.scrollTop = keep
    else body.scrollTop = body.scrollHeight
    const time = took(h)
    const foot = [
      h.status === 'running' ? `<span data-since="${h.startedAt ?? ''}">${esc(clock(time ?? 0))}</span>` : time != null ? esc(tr('helpers.took', { time: clock(time) })) : '',
      h.tools ? esc(tr('helpers.tools', { n: h.tools })) : '',
      h.tokens ? esc(tr('helpers.tokens', { n: tokens(h.tokens) })) : '',
      h.startedAt ? esc(tr('helpers.started', { time: new Date(h.startedAt).toLocaleString(t().lang, { dateStyle: 'short', timeStyle: 'short' }) })) : '',
    ].filter(Boolean)
    $('.helper-foot').innerHTML = foot.join(' · ')
  }

  // While it works, read it again; a hidden page reads nothing until it is back.
  function poll(seq, ms) {
    stopPolling()
    s.timer = setTimeout(() => {
      if (seq !== s.seq || !isOpen()) return
      if (document.hidden) return poll(seq, ms)
      load(seq)
    }, ms)
  }
  function stopPolling() {
    clearTimeout(s.timer)
    s.timer = 0
  }

  body.addEventListener('scroll', () => (s.pinned = body.scrollHeight - body.scrollTop - body.clientHeight < 40), { passive: true })

  root.addEventListener('click', e => {
    if (e.target === scrim) return close()
    if (e.target.closest('.helper-x')) return close()
    if (e.target.closest('.helper-back')) return back()
    const row = e.target.closest('[data-helper]')
    if (row && (detail(s.key)?.helpers ?? []).some(h => h.id === row.dataset.helper)) {
      s.stack.push({ id: row.dataset.helper })
      return show()
    }
    const run = e.target.closest('[data-run-open]')
    if (run) {
      s.stack.push({ list: true, run: run.dataset.runOpen })
      return show()
    }
    const other = e.target.closest('[data-session]')
    if (other && item(other.dataset.session)) {
      close()
      openSession(other.dataset.session)
    }
  })

  // Before the page's own keys: Esc here must not close the session sheet as well.
  addEventListener(
    'keydown',
    e => {
      if (!isOpen() || !focus.isTop()) return
      const typing = /^(INPUT|TEXTAREA)$/.test(document.activeElement?.tagName)
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopImmediatePropagation()
        close()
      } else if ((e.key === 'Backspace' && !typing) || (e.key === 'ArrowLeft' && e.altKey)) {
        e.preventDefault()
        e.stopImmediatePropagation()
        back()
      }
    },
    true,
  )

  return {
    open,
    close,
    back,
    isOpen,
    /** The sheet's data changed: the list shows it, a helper reads itself again if it waits. */
    sync() {
      if (!isOpen()) return
      if (top()?.list) showList(top())
    },
    relabel() {
      if (!isOpen()) return
      labels()
      if (top()?.list) showList(top())
      else if (s.data) render(false)
    },
  }
}
