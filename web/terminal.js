// The board's terminal: a window over the dimmed board, grown out of the button it was opened
// from, like the quick look. It shows one of two terminals of a session, live:
//   Shell   a shell the board opens in the session's folder (a herdr tab of its own), to run
//           something there: a login, an unlock, the tests.
//   Agent   the session's own pane, to answer its terminal where the board has no form for it
//           (/login, /mcp, a menu).
// Keys go to the terminal while its screen has the focus: a click or a tap gives it, Ctrl+]
// takes it back (then Esc closes the window), and the screen's ring says which it is. The
// session's own terminal starts without it, so an Esc meant for the window never stops a turn.
// Typed text and keys go to the server in order, one request at a time; the screen comes back
// as line diffs over Server-Sent Events (src/terminal.mjs).
import { modalFocus } from './modal-focus.js'
import { reducedMotion, Spring } from './spring.js'
import { keyStep, MAX_STEPS, MAX_TEXT, mergeSteps, textSteps } from './term-keys.js'
import { applyDiff, caretSpot, fitFont, parseLine, withLinks } from './term-model.js'

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
const svg = body => `<svg viewBox="0 0 20 20" aria-hidden="true">${body}</svg>`
export const TERM_ICON = svg('<rect x="2.5" y="3.5" width="15" height="13" rx="2.6"/><path d="m6 8.2 2.6 2.1L6 12.4M10.4 12.6h3.6"/>')
const ICONS = {
  herdr: svg('<path d="M7 4.5h8.5V13M15 5 5 15"/>'),
  close: svg('<path d="m5.5 5.5 9 9m0-9-9 9"/>'),
  spin: '<svg class="spin" viewBox="0 0 20 20" aria-hidden="true"><path d="M10 3a7 7 0 1 1-7 7"/></svg>',
}
// What one request may carry (the server checks the same).
const MAX_PASTE = MAX_TEXT
// Keys waiting to go, at most; and how long a request may take before the page gives up on it
// (longer than the server types for one: src/terminal.mjs).
const MAX_PENDING = 400
const INPUT_TIMEOUT = 8000
// The row of keys a phone's keyboard does not have.
const KEY_ROW = [
  { key: 'esc', label: 'Esc' },
  { key: 'tab', label: 'Tab' },
  { key: 'ctrl+c', label: '⌃C' },
  { key: 'left', label: '←', aria: 'Left' },
  { key: 'up', label: '↑', aria: 'Up' },
  { key: 'down', label: '↓', aria: 'Down' },
  { key: 'right', label: '→', aria: 'Right' },
]
const coarse = matchMedia('(pointer: coarse)')

/**
 * t(): the page's translator. item(key): the session. canMutate(): fresh herdr data (typing and
 * opening a shell need it; looking does not). token(): the per-run token for the stream.
 * shells(): the sessions the board has a shell open for. wake(key), focusAgent(key): the sheet's own.
 */
export function initTerminal({ t, toast, canMutate, item, token, shells, wake, focusAgent, openUrl, onDialogChange = () => {} }) {
  const tr = (key, vars) => t()(key, vars)
  const store = {
    get: (k, d) => { try { return localStorage.getItem(k) ?? d } catch { return d } },
    set: (k, v) => { try { localStorage.setItem(k, v) } catch {} },
  }

  const root = document.createElement('div')
  root.className = 'ql term'
  root.hidden = true
  root.innerHTML = `
    <div class="ql-scrim"></div>
    <section class="ql-win term-win" role="dialog" aria-modal="true" aria-labelledby="term-name" tabindex="-1">
      <header class="ql-head term-head">
        <span class="ql-icon">${TERM_ICON}</span>
        <div class="ql-titles"><h3 id="term-name"></h3><p class="term-sub"></p></div>
        <div class="ql-tools">
          <div class="ql-mode term-target" role="radiogroup"><button data-target="agent" role="radio"></button><button data-target="shell" role="radio"></button></div>
          <button class="icon-button term-herdr">${ICONS.herdr}</button>
        </div>
        <button class="icon-button ql-close term-x">${ICONS.close}</button>
      </header>
      <div class="term-screen">
        <div class="term-scroll"><div class="term-lines"></div></div>
        <div class="term-state" hidden></div>
        <div class="term-paste" hidden role="alertdialog"></div>
        <textarea class="term-input" data-own-keys rows="1" autocapitalize="off" autocomplete="off" autocorrect="off" spellcheck="false" enterkeyhint="send"></textarea>
      </div>
      <div class="term-keys" role="toolbar">${KEY_ROW.map(k => `<button type="button" data-key="${k.key}"${k.aria ? ` aria-label="${k.aria}"` : ''}>${esc(k.label)}</button>`).join('')}</div>
      <footer class="ql-foot term-foot"><span class="term-status"></span><button class="button term-close" hidden></button></footer>
    </section>`
  document.body.append(root)
  const $ = sel => root.querySelector(sel)
  const win = $('.ql-win')
  const scrim = $('.ql-scrim')
  const screen = $('.term-screen')
  const scroller = $('.term-scroll')
  const linesEl = $('.term-lines')
  const stateEl = $('.term-state')
  const pasteEl = $('.term-paste')
  const input = $('.term-input')
  const focus = modalFocus(root, win)

  const s = {
    key: null,
    target: 'shell',
    es: null,
    lines: [],
    nodes: [],
    cols: null,
    status: 'idle', // connecting | starting | live | none | gone | asleep | error
    error: '',
    missing: false, // gone because the session is off the board for now
    typing: false,
    pending: [],
    sending: false,
    seq: 0,
    paste: null,
    closeArmed: 0,
    waitingSend: false, // a request herdr takes long over
    slowNote: false, // keys were dropped: herdr was too slow
    paused: false, // the page is hidden: no reading meanwhile
  }

  // ------------------------------------------------------------ the window's motion
  // 0 = folded into the button it came from, 1 = open; a close while opening turns around.
  const motion = new Spring({ value: 0, damping: 1, response: 0.34, precision: 0.002, onUpdate: v => paint(v), onRest: v => v === 0 && finishClose() })
  let from = { dx: 0, dy: 24, s: 0.94 }
  let origin = null
  let openedAt = 0
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
  const it = () => (s.key ? item(s.key) : null)
  const agentName = x => (x?.agent ? (x.agent === 'claude' ? 'Claude' : x.agent[0].toUpperCase() + x.agent.slice(1)) : tr('term.agent'))
  const hasShell = key => (shells() ?? []).includes(key)

  /** Open the terminal of session `key` grown from `el`; `target` agent or shell (else the last used). */
  function open(key, el, target) {
    const x = item(key)
    if (!x) return
    const want = target ?? store.get('board.termTarget', 'shell')
    const switching = !root.hidden && s.key !== key
    s.key = key
    s.target = want === 'agent' && x.pane ? 'agent' : x.cwd ? 'shell' : 'agent'
    if (root.hidden || motion.target === 0) {
      openedAt = performance.now()
      origin = el ?? null
      root.hidden = false
      labels()
      from = measureFrom(el)
      if (motion.value <= 0.001) paint(0)
      motion.to(1, { damping: 1, response: 0.34 })
      focus.open(origin ?? document.activeElement)
      onDialogChange()
    } else if (switching) labels()
    connect({ focusScreen: s.target === 'shell' })
  }

  function close() {
    if (root.hidden || motion.target === 0) return
    disconnect()
    from = measureFrom(origin)
    motion.to(0, { damping: 1, response: 0.26 })
    if (reducedMotion.matches) motion.set(0)
    onDialogChange()
  }
  function finishClose() {
    root.hidden = true
    linesEl.textContent = ''
    s.nodes = []
    s.lines = []
    s.key = null
    focus.close()
  }

  function labels() {
    const x = it()
    $('#term-name').textContent = x?.name ?? ''
    $('.term-target [data-target="agent"]').textContent = agentName(x)
    $('.term-target [data-target="shell"]').textContent = tr('term.shell')
    for (const [sel, k] of [['.term-herdr', 'term.openHerdr'], ['.term-x', 'sheet.close']]) {
      $(sel).title = tr(k)
      $(sel).setAttribute('aria-label', tr(k))
    }
    $('.term-keys').setAttribute('aria-label', tr('term.keys'))
    input.setAttribute('aria-label', tr('term.input'))
    sync()
  }

  // ------------------------------------------------------------ the stream
  function disconnect() {
    s.es?.close()
    s.es = null
    s.seq++
    s.pending = []
    s.waitingSend = false
    s.slowNote = false
    s.paused = false
    s.paste = null
    pasteEl.hidden = true
    if (s.typing) input.blur()
  }

  /** Start showing the chosen terminal: open the shell first when there is none yet. */
  async function connect({ focusScreen = false } = {}) {
    disconnect()
    const seq = s.seq
    const x = it()
    clearScreen()
    s.cols = null
    s.closeArmed = 0
    s.missing = !x
    if (!x) return setStatus('gone')
    if (s.target === 'agent') {
      if (x.sleeping) return setStatus('asleep')
      return stream(seq, focusScreen)
    }
    if (hasShell(x.key)) return stream(seq, focusScreen)
    if (!canMutate()) return setStatus('none')
    setStatus('starting')
    const r = await post(`/api/term/${encodeURIComponent(x.key)}/shell/open`, {})
    if (seq !== s.seq) return
    if (!r.ok) return setStatus('error', r.error)
    stream(seq, focusScreen)
  }

  function stream(seq, focusScreen) {
    setStatus('connecting')
    const x = it()
    const es = new EventSource(`/api/term/${encodeURIComponent(x.key)}/${s.target}/stream?t=${encodeURIComponent(token() ?? '')}`)
    s.es = es
    let first = true
    es.onmessage = e => {
      if (seq !== s.seq) return es.close()
      let msg
      try {
        msg = JSON.parse(e.data)
      } catch {
        return
      }
      if (msg.t === 'frame') {
        if (first) {
          first = false
          clearScreen()
        }
        frame(msg)
        if (s.status === 'live' && s.error) setStatus('live') // herdr answers again
        if (s.status !== 'live') {
          setStatus('live')
          // Not on a phone: its keyboard would cover the screen before anything is on it.
          if (focusScreen && !coarse.matches) takeKeys()
          focusScreen = false
        }
      } else if (msg.t === 'gone') {
        es.close()
        setStatus('gone')
      } else if (msg.t === 'error') setStatus('live', tr('term.error', { why: msg.why }))
    }
    es.onerror = () => {
      if (seq !== s.seq) return es.close()
      // Closed for good: the server said no (no shell any more, the session left, the token).
      if (es.readyState === EventSource.CLOSED) setStatus(s.target === 'shell' && !hasShell(s.key) ? 'gone' : 'error', tr('term.error', { why: '' }).replace(/:\s*$/, ''))
      else setStatus('connecting')
    }
  }

  // ------------------------------------------------------------ the screen
  function clearScreen() {
    linesEl.textContent = ''
    s.nodes = []
    s.lines = []
    pinned = true
    lastTop = 0
  }

  function runHTML(r) {
    const st = r.style
    let fg = st.fg
    let bg = st.bg
    // Inverse with the screen's own colors swaps those too.
    if (st.inverse) [fg, bg] = [bg ?? 'screen', fg ?? 'ink']
    const cls = []
    const css = []
    if (typeof fg === 'number') cls.push(`f${fg}`)
    else if (fg === 'screen') cls.push('fs')
    else if (fg) css.push(`color:${fg}`)
    if (typeof bg === 'number') cls.push(`b${bg}`)
    else if (bg === 'ink') cls.push('bi')
    else if (bg) css.push(`background:${bg}`)
    if (st.bold) cls.push('tb')
    if (st.dim) cls.push('td')
    if (st.italic) cls.push('ti')
    if (st.underline || r.href) cls.push(st.strike ? 'tus' : 'tu')
    else if (st.strike) cls.push('ts')
    if (st.hidden) cls.push('th')
    if (r.href) cls.push('tlink')
    const attrs = `${cls.length ? ` class="${cls.join(' ')}"` : ''}${css.length ? ` style="${css.join(';')}"` : ''}${r.href ? ` data-url="${esc(r.href)}" title="${esc(r.href)}"` : ''}`
    return attrs ? `<span${attrs}>${esc(r.text)}</span>` : esc(r.text)
  }

  function lineNode(line) {
    const div = document.createElement('div')
    div.className = 'tl'
    div.innerHTML = withLinks(parseLine(line)).map(runHTML).join('')
    return div
  }

  // Pinned to the bottom, as a terminal is, until the user scrolls up; back down, pinned again.
  const atBottom = () => scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 6
  let pinned = true
  let lastTop = 0
  // Only a scroll up away from the bottom unpins: the view coming down to it (ours too, whose
  // event may arrive after the screen changed again) never does.
  scroller.addEventListener('scroll', () => {
    if (atBottom()) pinned = true
    else if (scroller.scrollTop < lastTop - 1) pinned = false
    lastTop = scroller.scrollTop
  }, { passive: true })
  const toBottom = () => (scroller.scrollTop = scroller.scrollHeight)

  function frame(d) {
    const stick = pinned || !s.nodes.length
    const keep = s.nodes.slice(d.drop, d.drop + d.keep)
    for (const n of s.nodes.slice(0, d.drop)) n.remove()
    for (const n of s.nodes.slice(d.drop + d.keep)) n.remove()
    const fresh = d.lines.map(lineNode)
    linesEl.append(...fresh)
    s.nodes = keep.concat(fresh)
    s.lines = applyDiff(s.lines, d)
    if (d.cols && d.cols !== s.cols) {
      s.cols = d.cols
      fit()
    }
    placeCaret()
    sync()
    if (stick) toBottom()
  }

  /**
   * herdr does not say where a terminal's cursor is: the caret goes where the screen says it
   * most likely is (term-model.js), after a shell's prompt or in Claude Code's input box. Shown
   * once the screen has been still for a moment, never while output runs.
   */
  let caretTimer = 0
  const caret = Object.assign(document.createElement('span'), { className: 'tcaret' })
  function placeCaret() {
    caret.remove()
    clearTimeout(caretTimer)
    const kind = s.target === 'shell' ? 'shell' : it()?.agent === 'claude' ? 'claude' : null
    if (!kind) return
    caretTimer = setTimeout(() => {
      const spot = caretSpot(s.lines, kind)
      const node = spot && s.nodes[spot.line]
      if (!node?.isConnected) return
      // Lines wrap at the window's edge: a row holds as many columns as fit there.
      const style = getComputedStyle(linesEl)
      const per = Math.max(1, Math.floor(linesEl.clientWidth / (charRatio() * parseFloat(style.fontSize)) + 0.01))
      caret.style.left = `${spot.col % per}ch`
      caret.style.top = `${node.offsetTop + Math.floor(spot.col / per) * parseFloat(style.lineHeight)}px`
      linesEl.append(caret)
    }, 350)
  }

  // The text's size: the pane's columns fit the window, down to a size that still reads; below
  // that the lines wrap sooner than the pane's (a phone).
  let ratio = 0
  function charRatio() {
    if (ratio) return ratio
    const probe = document.createElement('span')
    probe.className = 'term-probe'
    probe.textContent = 'M'.repeat(50)
    linesEl.append(probe)
    // Its layout width: the window may still be scaled by its spring, which the box would count.
    ratio = probe.offsetWidth / 50 / 100 || 0
    probe.remove()
    return ratio || 0.6
  }
  function fit() {
    const style = getComputedStyle(scroller)
    const width = scroller.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight)
    const { size } = fitFont({ width, cols: s.cols, ratio: charRatio(), min: coarse.matches ? 9.5 : 10, max: 14 })
    screen.style.setProperty('--term-size', `${size}px`)
  }
  // A new size (the window, the key row coming, a phone's keyboard) keeps a pinned view pinned.
  new ResizeObserver(() => {
    if (root.hidden) return
    if (s.cols) fit()
    if (pinned) toBottom()
  }).observe(scroller)

  // ------------------------------------------------------------ state and the footer
  const canInput = () => canMutate() && s.status === 'live' && !!it() && !(s.target === 'agent' && it()?.sleeping)

  function setStatus(status, error = '') {
    s.status = status
    s.error = error
    if (status !== 'live' && s.typing) input.blur()
    renderState()
    sync()
  }

  function renderState() {
    const x = it()
    const path = x?.cwd ?? ''
    let html = ''
    if (s.status === 'connecting' && !s.nodes.length) html = `<p>${ICONS.spin}${esc(tr('term.connecting'))}</p>`
    else if (s.status === 'starting') html = `<p>${ICONS.spin}${esc(tr('term.starting', { path }))}</p>`
    else if (s.status === 'none') html = `<p>${esc(tr('term.noShell', { path }))}</p><button class="button primary" data-do="start"${canMutate() ? '' : ' disabled'}>${esc(tr('term.start'))}</button>${canMutate() ? '' : `<small>${esc(tr('mobile.readOnly'))}</small>`}`
    else if (s.status === 'gone' && s.missing) html = `<p>${esc(tr('term.missing'))}</p>`
    else if (s.status === 'gone') html = s.target === 'shell' ? `<p>${esc(tr('term.gone'))}</p><button class="button primary" data-do="start"${canMutate() ? '' : ' disabled'}>${esc(tr('term.reopen'))}</button>` : `<p>${esc(tr('term.goneAgent'))}</p>`
    else if (s.status === 'asleep') html = `<p>${esc(tr('term.asleep', { name: x?.name ?? '' }))}</p><button class="button primary" data-do="wake"${canMutate() ? '' : ' disabled'}>${esc(tr('sheet.wake'))}</button>`
    else if (s.status === 'error') html = `<p>${esc(s.error || tr('err.unavailable'))}</p><button class="button" data-do="retry">${esc(tr('term.retry'))}</button>`
    stateEl.innerHTML = html
    stateEl.hidden = !html
    screen.classList.toggle('dimmed', !!html && s.nodes.length > 0)
  }

  /** The footer, the target switch, the buttons: from the state as it is now. */
  function sync() {
    if (root.hidden) return
    const x = it()
    const shell = s.target === 'shell'
    for (const b of root.querySelectorAll('.term-target button')) {
      const on = b.dataset.target === s.target
      b.setAttribute('aria-pressed', String(on))
      b.setAttribute('aria-checked', String(on))
      b.disabled = b.dataset.target === 'agent' ? !x?.pane : !x?.cwd
    }
    $('.term-sub').textContent = shell ? (x?.cwd ?? '') : tr('term.agentSub')
    $('.term-sub').title = shell ? (x?.cwd ?? '') : ''
    $('.term-herdr').disabled = !canMutate() || (shell ? !hasShell(s.key) : !x?.pane)
    const closeBtn = $('.term-close')
    closeBtn.hidden = !shell || !hasShell(s.key)
    closeBtn.disabled = !canMutate()
    const armed = Date.now() - s.closeArmed < 3000
    closeBtn.classList.toggle('armed', armed)
    closeBtn.textContent = tr(armed ? 'term.closeConfirm' : 'term.close')
    closeBtn.title = tr('term.closeHint')
    const live = s.status === 'live'
    // Out of the Tab order while it takes no keys, so Tab and Esc are the window's there.
    input.tabIndex = canInput() ? 0 : -1
    screen.classList.toggle('typing', s.typing)
    win.classList.toggle('can-type', canInput())
    $('.term-keys').hidden = !(coarse.matches || matchMedia('(max-width: 760px)').matches) || !live
    for (const b of root.querySelectorAll('.term-keys button')) b.disabled = !canInput()
    const status = $('.term-status')
    const text = !live ? '' : s.error ? s.error : s.waitingSend ? tr('term.waiting') : s.slowNote ? tr('term.slow') : !canMutate() ? tr('mobile.readOnly') : s.typing ? [shell ? tr('term.typing') : tr('term.typingAgent', { agent: agentName(x) }), !coarse.matches && tr('term.leaveKey')].filter(Boolean).join(' · ') : tr(coarse.matches ? 'term.tapToType' : 'term.clickToType')
    status.innerHTML = `${live && !s.error ? `<span class="term-dot${s.typing ? ' on' : ''}"></span>` : ''}<span>${esc(text)}</span>`
    status.classList.toggle('warn', !!s.error || (live && (!canMutate() || s.waitingSend || s.slowNote)))
  }

  // ------------------------------------------------------------ typing
  function takeKeys() {
    if (!canInput()) return
    // On a phone the keyboard comes up for a focused field: only on the user's own tap.
    input.focus({ preventScroll: true })
  }
  function leave() {
    input.blur()
    win.focus({ preventScroll: true })
  }
  input.addEventListener('focus', () => {
    s.typing = true
    input.value = ''
    placeCaret()
    sync()
  })
  input.addEventListener('blur', () => {
    s.typing = false
    sync()
  })

  const selection = () => {
    const sel = getSelection()
    return sel && !sel.isCollapsed && screen.contains(sel.anchorNode) ? sel.toString() : ''
  }

  function queue(steps) {
    if (!steps.length) return
    if (!canInput()) return sync()
    // herdr this slow: what is typed meanwhile is dropped, said so, rather than land much later.
    if (s.pending.length + steps.length > MAX_PENDING) return slow()
    s.pending.push(...steps)
    flush()
  }
  function slow() {
    s.pending = []
    s.slowNote = true
    sync()
  }

  async function flush() {
    if (s.sending || !s.pending.length) return
    s.sending = true
    const seq = s.seq
    const key = s.key
    // As much as one request takes: so many steps, so much text.
    let n = 0
    for (let size = 0; n < s.pending.length && n < MAX_STEPS; n++) {
      size += s.pending[n].text?.length ?? 0
      if (size > MAX_TEXT && n) break
    }
    const batch = mergeSteps(s.pending.splice(0, n))
    // A request herdr takes long over says so; one it does not answer in time is given up, and
    // the server types nothing of it that late either (src/terminal.mjs).
    const waiting = setTimeout(() => ((s.waitingSend = true), sync()), 1500)
    const r = await post(`/api/term/${encodeURIComponent(key)}/${s.target}/input`, { session: item(key)?.session ?? null, steps: batch }, INPUT_TIMEOUT)
    clearTimeout(waiting)
    s.sending = false
    s.waitingSend = false
    // Switched meanwhile: what was queued for the other terminal went; what came since goes now.
    if (seq !== s.seq) return flush()
    if (!r.ok) {
      // What was queued behind it would land somewhere unknown: it goes.
      s.pending = []
      if (r.timeout) s.slowNote = true
      else toast(tr('term.lost', { why: r.error }), true)
    } else s.slowNote = false
    sync()
    flush()
  }

  input.addEventListener('keydown', e => {
    if (s.paste) {
      if (e.key === 'Enter' || e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        settlePaste(e.key === 'Enter')
      }
      return
    }
    // Ctrl+` closes the window from anywhere in it, as it opened it.
    if (e.ctrlKey && e.code === 'Backquote') {
      e.preventDefault()
      e.stopPropagation()
      return close()
    }
    const step = keyStep(e, { selection: !!selection() })
    if (!step) return
    e.preventDefault()
    e.stopPropagation()
    if (step.leave) return leave()
    if (step.copy) return copySelection()
    queue([{ key: step.key }])
  })
  let composing = false
  input.addEventListener('compositionstart', () => (composing = true))
  input.addEventListener('compositionend', e => {
    composing = false
    queue(textSteps(e.data))
    input.value = ''
  })
  input.addEventListener('beforeinput', e => {
    if (e.isComposing || composing) return
    const kind = e.inputType
    if (kind === 'insertText' || kind === 'insertReplacementText') {
      e.preventDefault()
      queue(textSteps(e.data ?? e.dataTransfer?.getData('text/plain') ?? ''))
    } else if (kind === 'insertLineBreak' || kind === 'insertParagraph') {
      e.preventDefault()
      queue([{ key: 'enter' }])
    } else if (kind === 'deleteContentBackward') {
      e.preventDefault()
      queue([{ key: 'backspace' }])
    } else if (kind === 'deleteContentForward') {
      e.preventDefault()
      queue([{ key: 'delete' }])
    } else if (kind === 'deleteWordBackward') {
      e.preventDefault()
      queue([{ key: 'ctrl+backspace' }])
    } else if (kind === 'insertFromPaste' || kind === 'insertFromDrop') e.preventDefault()
  })
  // Where the browser would not let the text be taken before it lands (some phone keyboards).
  input.addEventListener('input', () => {
    if (composing || !input.value) return
    queue(textSteps(input.value))
    input.value = ''
  })
  input.addEventListener('paste', e => {
    e.preventDefault()
    paste(e.clipboardData?.getData('text/plain') ?? '')
  })

  /** One line goes as typed; more ask first, as every line runs. A last line break is left off. */
  function paste(text) {
    text = String(text).replace(/\r\n?/g, '\n').replace(/\n$/, '')
    if (!text) return
    if (text.length > MAX_PASTE) return toast(tr('term.pasteBig', { kb: MAX_PASTE >> 10 }), true)
    const n = text.split('\n').length
    if (n === 1) return queue(textSteps(text))
    s.paste = text
    // What would run: the first lines, each as far as it fits.
    const lines = text.split('\n')
    const shown = lines.slice(0, 3).map(l => (l.length > 120 ? `${l.slice(0, 120)}…` : l)).join('\n') + (n > 3 ? '\n…' : '')
    pasteEl.innerHTML = `<span>${esc(tr('term.paste', { n }))}</span><pre>${esc(shown)}</pre><button class="button primary" data-paste="yes">${esc(tr('term.pasteYes'))}</button><button class="button" data-paste="no">${esc(tr('term.pasteNo'))}</button>`
    pasteEl.hidden = false
  }
  function settlePaste(yes) {
    const text = s.paste
    s.paste = null
    pasteEl.hidden = true
    if (yes && text) queue(textSteps(text))
    if (s.status === 'live') takeKeys()
  }
  pasteEl.addEventListener('click', e => {
    const b = e.target.closest('[data-paste]')
    if (b) settlePaste(b.dataset.paste === 'yes')
  })

  async function copySelection() {
    const text = selection()
    if (!text) return
    try {
      await navigator.clipboard.writeText(text)
      toast(tr('ql.copied'))
    } catch (err) {
      toast(err.message, true)
    }
  }

  // A click on the screen gives it the keys, unless it made a selection or hit a link.
  screen.addEventListener('click', e => {
    if (performance.now() - openedAt < 450) return
    const link = e.target.closest('.tlink')
    if (link) {
      e.preventDefault()
      return openUrl(link.dataset.url)
    }
    if (e.target.closest('.term-state, .term-paste')) return
    if (!selection()) takeKeys()
  })
  stateEl.addEventListener('click', e => {
    const b = e.target.closest('[data-do]')
    if (!b || b.disabled) return
    if (b.dataset.do === 'start' || b.dataset.do === 'retry') connect({ focusScreen: s.target === 'shell' })
    else if (b.dataset.do === 'wake') wake(s.key).then(() => connect())
  })

  $('.term-keys').addEventListener('pointerdown', e => {
    // A key of the row must not take the focus from the field: the phone's keyboard stays up.
    if (e.target.closest('button')) e.preventDefault()
  })
  $('.term-keys').addEventListener('click', e => {
    const b = e.target.closest('[data-key]')
    if (!b || b.disabled) return
    queue([{ key: b.dataset.key }])
  })

  root.addEventListener('click', e => {
    // The click a tap leaves behind (a menu item picked on a phone) lands on what just opened.
    if (performance.now() - openedAt < 450) return
    if (e.target === scrim) return close()
    if (e.target.closest('.term-x')) return close()
    const target = e.target.closest('.term-target [data-target]')
    if (target && !target.disabled && target.dataset.target !== s.target) {
      s.target = target.dataset.target
      store.set('board.termTarget', s.target)
      return connect({ focusScreen: s.target === 'shell' })
    }
    if (e.target.closest('.term-herdr')) return toHerdr()
    if (e.target.closest('.term-close')) return closeShell()
  })

  async function toHerdr() {
    if (s.target === 'agent') return focusAgent(s.key)
    const r = await post(`/api/term/${encodeURIComponent(s.key)}/shell/focus`, {})
    if (!r.ok) toast(r.error, true)
  }

  /** Two clicks: the first arms the button, the second closes (what runs in it stops). */
  async function closeShell() {
    if (Date.now() - s.closeArmed > 3000) {
      s.closeArmed = Date.now()
      sync()
      setTimeout(sync, 3100)
      return
    }
    s.closeArmed = 0
    const key = s.key
    disconnect()
    const r = await post(`/api/term/${encodeURIComponent(key)}/shell/close`, {})
    if (key !== s.key) return
    if (!r.ok) {
      toast(r.error, true)
      return connect() // still there: back on show
    }
    toast(tr('term.closed'))
    clearScreen()
    setStatus('gone')
  }

  async function post(url, body, timeout = 0) {
    try {
      const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-board': '1' }, body: JSON.stringify(body), ...(timeout ? { signal: AbortSignal.timeout(timeout) } : {}) })
      const r = await res.json().catch(() => ({}))
      return res.ok && r.ok !== false ? { ...r, ok: true } : { ...r, ok: false, error: r.error || tr('err.status', { code: res.status }) }
    } catch (err) {
      if (err.name === 'TimeoutError') return { ok: false, timeout: true, error: tr('term.slow') }
      return { ok: false, error: tr('err.offline', { why: err.message }) }
    }
  }

  // The window's own keys while the screen does not have them: Esc closes, Ctrl+` too.
  addEventListener(
    'keydown',
    e => {
      if (root.hidden || motion.target === 0 || !focus.isTop() || e.target === input) return
      // A paste that asks first: Esc says no to it, the window stays.
      if (s.paste && e.key === 'Escape') {
        e.preventDefault()
        e.stopImmediatePropagation()
        return settlePaste(false)
      }
      if (e.key === 'Escape' || (e.code === 'Backquote' && e.ctrlKey)) {
        e.preventDefault()
        e.stopImmediatePropagation()
        close()
      }
    },
    true,
  )

  // A page out of sight reads nothing: the stream goes while it is hidden and comes back with it.
  document.addEventListener('visibilitychange', () => {
    if (root.hidden || motion.target === 0) return
    if (document.hidden && s.es) {
      disconnect()
      s.paused = true
    } else if (!document.hidden && s.paused) connect()
  })

  // A phone's keyboard takes the bottom of the screen: the window keeps above it.
  const vv = globalThis.visualViewport
  vv?.addEventListener('resize', () => root.style.setProperty('--term-vh', `${vv.height}px`))

  return {
    open,
    close,
    isOpen,
    /** The board changed: fresh data or not, the session still there, a shell opened or closed. */
    sync() {
      if (root.hidden || motion.target === 0) return
      const x = it()
      // A session can be off the board for a refresh or two (waking up, say): it comes back.
      if (!x && s.status !== 'gone') {
        disconnect()
        s.missing = true
        setStatus('gone')
      } else if (x && s.missing) {
        s.missing = false
        connect()
      } else if (x && s.target === 'agent' && x.sleeping !== (s.status === 'asleep') && ['asleep', 'live', 'connecting'].includes(s.status)) {
        // Woke up, or was put to sleep: its terminal is another program now.
        connect()
      }
      renderState()
      sync()
    },
    relabel: () => !root.hidden && labels(),
  }
}
