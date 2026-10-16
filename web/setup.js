// The quiet setup note in the toolbar. It shows only while something the board needs does not
// work on this computer (the server checks, src/setup.mjs, and sends `setup: { todo, sig }` with
// the board), and "Hide until something changes" puts it away until the problems are other ones.
// A click opens the list anchored to the note: what is set up and what is not, what each missing
// piece costs and how to fix it, commands to copy. Optional pieces that are off (herdr-wake,
// desktop notifications) are listed but never raise the note.
import { reducedMotion, Spring } from './spring.js'

const HIDDEN_KEY = 'board.setupHidden'
const ORDER = { error: 0, warn: 1, off: 2, na: 3, ok: 4 }
const MARK = {
  ok: '<svg viewBox="0 0 20 20"><path d="m5 10.5 3.2 3.2L15 7"/></svg>',
  warn: '<svg viewBox="0 0 20 20"><path d="M10 5.5v5.5M10 14.2v.3"/></svg>',
  error: '<svg viewBox="0 0 20 20"><path d="M10 5.5v5.5M10 14.2v.3"/></svg>',
  off: '<svg viewBox="0 0 20 20"><circle cx="10" cy="10" r="2.2"/></svg>',
  na: '<svg viewBox="0 0 20 20"><circle cx="10" cy="10" r="2.2"/></svg>',
}
const COPY = '<svg viewBox="0 0 20 20"><rect x="7" y="7" width="9" height="9" rx="2"/><path d="M13 4.5H6A1.5 1.5 0 0 0 4.5 6v7"/></svg>'

export function initSetupNote({ t, esc, store, onDialogChange = () => {} }) {
  const note = document.getElementById('setup-note')
  const pop = document.getElementById('setup-pop')
  const content = document.getElementById('setup-content')
  const recheck = pop.querySelector('[data-setup="recheck"]')
  let summary = null
  let checks = null
  let copies = [] // the commands on show, for their copy buttons
  let loadedLang = ''
  let open = false

  // Out of the note and back into it: scale and fade from the note's corner, critically damped.
  const motion = new Spring({
    value: 0,
    damping: 1,
    response: 0.28,
    precision: 0.002,
    onUpdate: v => {
      pop.style.opacity = String(v)
      pop.style.transform = reducedMotion.matches ? 'none' : `scale(${0.94 + 0.06 * v})`
    },
    onRest: v => {
      if (v === 0 && !open) pop.hidden = true
    },
  })

  const hiddenSig = () => store.get(HIDDEN_KEY, '')
  const shown = () => summary?.todo > 0 && (open || hiddenSig() !== summary.sig)

  function paintNote() {
    note.hidden = !shown()
    if (note.hidden) return
    const label = t()('setup.incomplete')
    note.innerHTML = `<span class="setup-dot" aria-hidden="true"></span><span>${esc(label)}</span>`
    note.title = t()('setup.incompleteHint')
    note.setAttribute('aria-label', label)
  }

  /** The board sent its summary: the note follows it, and an open list is read again when it changed. */
  function render(next) {
    const changed = (next?.sig ?? '') !== (summary?.sig ?? '')
    summary = next ?? null
    paintNote()
    if (open && (changed || loadedLang !== t().lang)) load()
  }

  /** A command to copy: the text, and a small button in its corner. */
  function code(text) {
    copies.push(text)
    const label = esc(t()('setup.copy'))
    return `<div class="setup-code"><pre>${esc(text)}</pre><button class="setup-copy" type="button" data-copy="${copies.length - 1}" aria-label="${label}" title="${label}">${COPY}</button></div>`
  }

  function list() {
    const tr = t()
    copies = []
    const sorted = [...(checks ?? [])].sort((a, b) => ORDER[a.level] - ORDER[b.level])
    // A command that fixes several of them (the install, as a rule) is shown once, on top.
    const uses = new Map()
    for (const c of sorted) if (c.level !== 'ok' && c.code) uses.set(c.code, (uses.get(c.code) ?? 0) + 1)
    const common = [...uses].find(([, n]) => n > 1)?.[0]
    const lead = common && sorted.find(c => c.code === common && c.fix)
    const top = lead ? `<div class="setup-common"><p>${esc(lead.fix)}</p>${code(common)}</div>` : ''
    const rows = sorted
      .map(c => {
        const problem = c.level !== 'ok'
        const shared = c.code && c.code === common
        const parts = [`<b>${esc(c.title)}</b>`]
        if (c.detail) parts.push(problem ? `<p>${esc(c.detail)}</p>` : `<span class="setup-quiet"> · ${esc(c.detail)}</span>`)
        if (problem && c.fix && !(shared && c.fix === lead.fix)) parts.push(`<p class="setup-fix">${esc(c.fix)}</p>`)
        if (problem && c.code && !shared) parts.push(code(c.code))
        return `<li class="setup-row" data-level="${esc(c.level)}"><span class="setup-mark" aria-hidden="true">${MARK[c.level] ?? ''}</span><span class="sr-only">${esc(tr(`setup.level.${c.level}`))}: </span><div class="setup-text">${parts.join('')}</div></li>`
      })
      .join('')
    return `${top}<ul class="setup-list">${rows}</ul>`
  }

  function paintList() {
    const tr = t()
    const n = (checks ?? []).filter(c => c.level === 'error' || c.level === 'warn').length
    content.innerHTML = checks
      ? `<p class="setup-sum">${esc(n ? tr('setup.todo', { n }) : tr('setup.allSet'))}</p>${list()}`
      : `<p class="setup-sum">${esc(tr('setup.checking'))}</p>`
    pop.querySelector('[data-setup="hide"]').hidden = !summary?.todo
    if (open) position()
  }

  async function load(fresh = false) {
    recheck.disabled = true
    if (fresh) recheck.textContent = t()('setup.checking')
    try {
      const res = await fetch(`/api/setup${fresh ? '?fresh=1' : ''}`, { cache: 'no-store' })
      if (!res.ok) throw new Error(String(res.status))
      const r = await res.json()
      checks = r.checks
      loadedLang = t().lang
      summary = { todo: r.todo, sig: r.sig }
      paintNote()
    } catch {
      checks = checks ?? null
    } finally {
      recheck.disabled = false
      recheck.textContent = t()('setup.recheck')
      paintList()
    }
  }

  // Under the note when there is room, its right edge on the note's, grown out of its corner.
  function position() {
    const r = note.getBoundingClientRect()
    const w = pop.offsetWidth
    const h = pop.offsetHeight
    const left = Math.max(8, Math.min(r.right - w, innerWidth - w - 8))
    const below = r.bottom + 8 + h <= innerHeight
    const top = below ? r.bottom + 8 : Math.max(8, r.top - h - 8)
    pop.style.left = `${left}px`
    pop.style.top = `${top}px`
    pop.style.transformOrigin = `${Math.round(r.left + r.width / 2 - left)}px ${below ? 0 : h}px`
  }

  function show() {
    if (open) return
    open = true
    pop.querySelector('h3').textContent = t()('setup.title')
    pop.querySelector('[data-setup="hide"]').textContent = t()('setup.hide')
    pop.querySelector('.setup-cli').textContent = t()('setup.cli')
    recheck.textContent = t()('setup.recheck')
    pop.hidden = false
    paintList()
    position()
    note.setAttribute('aria-expanded', 'true')
    motion.to(1)
    pop.focus({ preventScroll: true })
    onDialogChange()
    load(true)
  }

  function close(refocus = false) {
    if (!open) return
    open = false
    note.setAttribute('aria-expanded', 'false')
    motion.to(0)
    if (reducedMotion.matches) pop.hidden = true
    paintNote()
    onDialogChange()
    if (refocus) (note.hidden ? document.getElementById('search') : note)?.focus({ preventScroll: true })
  }

  note.addEventListener('click', () => (open ? close() : show()))
  document.getElementById('setup-close').addEventListener('click', () => close(true))
  recheck.addEventListener('click', () => load(true))
  pop.querySelector('[data-setup="hide"]').addEventListener('click', () => {
    if (summary?.sig) store.set(HIDDEN_KEY, summary.sig)
    close(true)
  })
  content.addEventListener('click', async e => {
    const b = e.target.closest('[data-copy]')
    if (!b) return
    try {
      await navigator.clipboard.writeText(copies[Number(b.dataset.copy)] ?? '')
      b.innerHTML = MARK.ok
      b.classList.add('done')
      b.setAttribute('aria-label', t()('setup.copied'))
      setTimeout(() => {
        b.innerHTML = COPY
        b.classList.remove('done')
        b.setAttribute('aria-label', t()('setup.copy'))
      }, 1500)
    } catch {}
  })
  addEventListener('pointerdown', e => open && !e.target.closest('#setup-pop, #setup-note') && close(), true)
  addEventListener('keydown', e => {
    if (e.key === 'Escape' && open) {
      e.preventDefault()
      e.stopImmediatePropagation()
      close(true)
    }
  }, true)
  addEventListener('resize', () => open && position())

  return { render, isOpen: () => open, close }
}
