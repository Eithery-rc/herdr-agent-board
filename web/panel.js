// The side panels: a session, the categories. One open at a time, in one place both share, so the
// board keeps its shape when one replaces the other. The place is the viewer's (this browser):
// docked right (the default), left or at the bottom, where the board makes room for it like a
// column, or floating over the board as a window of its own.
//
// Everything is a spring from where the panel is on screen, so any motion can be caught midway:
// - its edge resizes it 1:1, softly past the limits, and lets go with the pointer's speed;
//   flung below half the smallest size it folds away, like a sidebar; double-click: default size;
// - its head flicks it away along its own edge, as it came; pulled any other way it resists,
//   then comes loose as a window that follows the pointer, and a throw towards an edge docks
//   it there (the pointer's projected rest decides, a preview shows where);
// - a menu in its head picks the place, for keys and for those who would rather not throw.
// Phones (760 px and narrower) keep the full-height sheet: it flicks right, no resizing, no docks.
import {
  clampFloat,
  defaultFloat,
  dockFromThrow,
  dockRect,
  dockSize,
  DOCKS,
  flicksAway,
  floatLanding,
  foldsAway,
  keyFloat,
  keySize,
  MARGIN,
  offRect,
  outward,
  rectFor,
  resizeFloat,
  restoreLayout,
  roomFor,
  serializeLayout,
  sizeLimits,
  soft,
} from './panel-layout.js'
import { reducedMotion, rubberband, Spring, velocityOf } from './spring.js'

const html = document.documentElement
const phone = matchMedia('(max-width: 760px)')
const viewport = () => ({ w: html.clientWidth, h: html.clientHeight })
const sample = e => ({ x: e.clientX, y: e.clientY, t: e.timeStamp })
const SIDES = ['left', 'right', 'bottom']
const EDGES = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw']
const CURSOR = { n: 'row-resize', s: 'row-resize', e: 'col-resize', w: 'col-resize', ne: 'nesw-resize', sw: 'nesw-resize', nw: 'nwse-resize', se: 'nwse-resize' }
/** Pulled this far (px) any way but out, a docked panel comes loose. */
const TEAR = 56

const FRAME = '<rect x="2.5" y="4" width="15" height="12" rx="2.2"/>'
export const GLYPHS = {
  right: `<svg viewBox="0 0 20 20" aria-hidden="true"><path class="fill" d="M12 4h3.3a2.2 2.2 0 0 1 2.2 2.2v7.6a2.2 2.2 0 0 1-2.2 2.2H12Z"/>${FRAME}<path d="M12 4v12"/></svg>`,
  left: `<svg viewBox="0 0 20 20" aria-hidden="true"><path class="fill" d="M8 4H4.7a2.2 2.2 0 0 0-2.2 2.2v7.6A2.2 2.2 0 0 0 4.7 16H8Z"/>${FRAME}<path d="M8 4v12"/></svg>`,
  bottom: `<svg viewBox="0 0 20 20" aria-hidden="true"><path class="fill" d="M2.5 11h15v2.8a2.2 2.2 0 0 1-2.2 2.2H4.7a2.2 2.2 0 0 1-2.2-2.2Z"/>${FRAME}<path d="M2.5 11h15"/></svg>`,
  float: `<svg viewBox="0 0 20 20" aria-hidden="true">${FRAME}<rect class="fill" x="8.5" y="7" width="6.5" height="6" rx="1.2"/><rect x="8.5" y="7" width="6.5" height="6" rx="1.2"/></svg>`,
  reset: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M3.5 10h13M3.5 10 6 7.5M3.5 10 6 12.5M16.5 10 14 7.5m2.5 2.5L14 12.5"/></svg>',
  check: '<svg class="check" viewBox="0 0 20 20" aria-hidden="true"><path d="m4.5 10.5 3.5 3.5 7.5-8"/></svg>',
}

// ---------------------------------------------------------------- the viewer's layout
const KEY = 'board.panel'
let layout = restoreLayout(read())
function read() {
  try {
    return localStorage.getItem(KEY)
  } catch {
    return null
  }
}
function save() {
  try {
    localStorage.setItem(KEY, serializeLayout(layout))
  } catch {}
}
const modeNow = () => (phone.matches ? 'mobile' : layout.dock)

export const panels = []
const openPanel = () => panels.find(p => p.isOpen)

// ---------------------------------------------------------------- the board makes room
// Margins of the page (--room-left/right/bottom) on springs. While they move, the card the
// panel is about keeps its place on screen, and stays clear of a panel at the bottom.
let keep = { target: () => null, top: () => 0 }
/** `target()`: the element to keep in sight while the board makes room; `top()`: where the board's visible part starts. */
export function keepInSight(k) {
  keep = k
}
let anchor = null // { el, y }
let following = false // a gesture sets the room 1:1
let queued = false
const room = Object.fromEntries(
  SIDES.map(side => [
    side,
    new Spring({
      damping: 1,
      response: 0.4,
      precision: 0.3,
      onUpdate: () => queueRoom(),
      onRest: () => queueRoom(),
    }),
  ]),
)
/** The room a panel at the bottom takes now: where the board's visible part ends. */
export const roomBelow = () => room.bottom.value

function queueRoom() {
  if (queued) return
  queued = true
  // All three springs step in one frame; the page lays out once, after them.
  queueMicrotask(applyRoom)
}
function applyRoom() {
  queued = false
  for (const side of SIDES) html.style.setProperty(`--room-${side}`, `${Math.round(room[side].value * 10) / 10}px`)
  if (anchor?.el.isConnected) {
    const r = anchor.el.getBoundingClientRect()
    const lowest = viewport().h - room.bottom.value - r.height - 16
    const want = Math.max(keep.top() + 8, Math.min(anchor.y, lowest))
    if (Math.abs(r.top - want) > 0.5) scrollBy(0, r.top - want)
  }
  // Once the room is still (and no edge is held), the browser's own scroll anchoring is back.
  if (!following && !SIDES.some(side => room[side].moving)) dropAnchor()
}
function holdAnchor() {
  const el = keep.target()
  const r = el?.isConnected ? el.getBoundingClientRect() : null
  anchor = r && r.height && r.bottom > keep.top() && r.top < viewport().h - room.bottom.value ? { el, y: r.top } : null
  // Our own anchoring, not the browser's, while the board reflows around the card.
  html.style.overflowAnchor = anchor ? 'none' : ''
}
function dropAnchor() {
  anchor = null
  html.style.overflowAnchor = ''
}

/** The board's room for the open panel (none on a phone, or for a floating one). */
function syncRoom({ jump = false, velocity = {}, response = 0.4 } = {}) {
  const want = openPanel() && !phone.matches ? roomFor(layout, viewport()) : { left: 0, right: 0, bottom: 0 }
  if (jump) return SIDES.forEach(side => room[side].set(want[side]))
  holdAnchor()
  for (const side of SIDES) if (room[side].target !== want[side] || velocity[side]) room[side].to(want[side], { velocity: velocity[side], response })
  queueRoom()
}

// ---------------------------------------------------------------- where a thrown panel will dock
const preview = (() => {
  const el = document.createElement('div')
  el.className = 'dock-preview'
  el.hidden = true
  document.body.append(el)
  const paint = () => {
    el.style.transform = `translate3d(${x.value}px, ${y.value}px, 0)`
    el.style.width = `${w.value}px`
    el.style.height = `${h.value}px`
    el.style.opacity = String(Math.max(0, Math.min(1, o.value)))
  }
  const spring = precision => new Spring({ damping: 1, response: 0.28, precision, onUpdate: paint })
  const x = spring(0.3)
  const y = spring(0.3)
  const w = spring(0.3)
  const h = spring(0.3)
  const o = new Spring({ damping: 1, response: 0.2, precision: 0.01, onUpdate: paint, onRest: v => v === 0 && (el.hidden = true) })
  let dock = null
  return {
    /** Show where `next` would put the panel, grown out of the panel's rectangle `from`. Null hides it. */
    show(next, from) {
      if (next === dock) return
      dock = next
      if (!next) return o.to(0)
      const r = rectFor({ ...layout, dock: next }, viewport())
      if (el.hidden || o.value < 0.05) {
        el.hidden = false
        for (const [s, v] of [[x, from.x], [y, from.y], [w, from.w], [h, from.h]]) s.set(v)
      }
      x.to(r.x)
      y.to(r.y)
      w.to(r.w)
      h.to(r.h)
      o.to(1)
    },
    hide() {
      dock = null
      o.to(0)
    },
  }
})()

// ---------------------------------------------------------------- the place menu
const menu = (() => {
  const el = document.createElement('div')
  el.className = 'layout-menu'
  el.setAttribute('role', 'menu')
  el.hidden = true
  el.innerHTML =
    DOCKS.map(d => `<button role="menuitemradio" data-dock="${d}" tabindex="-1">${GLYPHS[d]}<span data-i18n="panel.${d}"></span>${GLYPHS.check}</button>`).join('') +
    `<div class="layout-sep" role="separator"></div><button role="menuitem" data-reset tabindex="-1">${GLYPHS.reset}<span data-i18n="panel.reset"></span></button>`
  document.body.append(el)
  let owner = null
  let button = null
  // Grows out of the button that opened it; critically damped, nothing bounces in a menu.
  const s = new Spring({
    damping: 1,
    response: 0.22,
    precision: 0.002,
    onUpdate: v => {
      el.style.opacity = String(Math.max(0, Math.min(1, v * 1.5)))
      el.style.transform = `scale(${0.92 + 0.08 * v})`
    },
    onRest: v => v === 0 && (el.hidden = true),
  })
  const items = () => [...el.querySelectorAll('button')]
  // On the document, so the page's own listener on the window sees the press first (app.js).
  const outside = e => {
    if (!el.contains(e.target) && !button?.contains(e.target)) close()
  }
  function open(panel, btn) {
    owner = panel
    button = btn
    for (const b of el.querySelectorAll('[data-dock]')) b.setAttribute('aria-checked', String(b.dataset.dock === layout.dock))
    el.hidden = false
    el.style.transform = 'none'
    const m = el.getBoundingClientRect()
    const r = btn.getBoundingClientRect()
    const vp = viewport()
    const left = Math.max(8, Math.min(r.right - m.width, vp.w - 8 - m.width))
    const below = r.bottom + 6 + m.height <= vp.h - 8
    const top = below ? r.bottom + 6 : Math.max(8, r.top - 6 - m.height)
    el.style.left = `${left}px`
    el.style.top = `${top}px`
    el.style.transformOrigin = `${r.left + r.width / 2 - left}px ${below ? 0 : m.height}px`
    if (s.value < 0.01) {
      // From folded, without set(): its rest would put the menu away again.
      s.stop()
      s.value = s.velocity = 0
      s.onUpdate(0)
    }
    s.to(1)
    btn.setAttribute('aria-expanded', 'true')
    ;(el.querySelector('[aria-checked="true"]') ?? items()[0]).focus({ preventScroll: true })
    document.addEventListener('pointerdown', outside, true)
  }
  function close(refocus = false) {
    if (s.target === 0) return
    s.to(0)
    document.removeEventListener('pointerdown', outside, true)
    button?.setAttribute('aria-expanded', 'false')
    if (refocus) button?.focus({ preventScroll: true })
  }
  el.addEventListener('click', e => {
    const b = e.target.closest('button')
    if (!b || !owner) return
    close(true)
    if (b.dataset.dock) owner.setDock(b.dataset.dock)
    else owner.resetSize()
  })
  el.addEventListener('keydown', e => {
    if (e.key === 'Tab') return close()
    // The menu's keys stay in the menu: Esc must not close the panel too, letters must not reach the board.
    e.stopPropagation()
    const list = items()
    const i = list.indexOf(document.activeElement)
    const go = { ArrowDown: i + 1, ArrowUp: i - 1, Home: 0, End: list.length - 1 }[e.key]
    if (go !== undefined) {
      e.preventDefault()
      list[(go + list.length) % list.length].focus()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      close(true)
    }
  })
  return { open, close, toggle: (panel, btn) => (s.target === 1 ? close() : open(panel, btn)), isOpen: () => s.target === 1 }
})()

/** The place menu is up: a press outside only puts it away. */
export const menuOpen = () => menu.isOpen()

// ---------------------------------------------------------------- a panel
export class Panel {
  /** `text(key)`: a text in the page's language. */
  constructor(el, { onClose = () => {}, onChange = () => {}, text = key => key } = {}) {
    this.el = el
    this.text = text
    this.isOpen = false
    this.onClose = onClose
    this.onChange = onChange
    this.mode = null // mobile, or the dock it is painted for
    this.g = null // the gesture in progress
    const spring = precision => new Spring({ damping: 1, response: 0.4, precision, onUpdate: () => this.paint(), onRest: () => this.settle() })
    this.x = spring(0.3)
    this.y = spring(0.3)
    this.w = spring(0.3)
    this.h = spring(0.3)
    // 1 shown; a floating panel shrinks a little and fades towards 0 as it comes and goes.
    this.p = spring(0.002)
    this.p.value = this.p.target = 1
    this.edges = EDGES.map(edge => {
      const handle = document.createElement('div')
      handle.className = 'sheet-edge'
      handle.dataset.edge = edge
      handle.dataset.i18nTitle = 'panel.resize'
      el.append(handle)
      return handle
    })
    this.layoutButton = el.querySelector('[data-layout]')
    this.layoutButton?.addEventListener('click', e => menu.toggle(this, e.currentTarget))
    el.querySelector('[data-close]')?.addEventListener('click', () => this.close())
    el.addEventListener('pointerdown', e => this.down(e))
    el.addEventListener('pointermove', e => this.move(e))
    el.addEventListener('pointerup', e => this.up(e))
    el.addEventListener('pointercancel', e => this.up(e, true))
    el.addEventListener('dblclick', e => e.target.closest('.sheet-edge') && this.resetSize())
    el.addEventListener('keydown', e => e.target.matches('.sheet-edge') && this.key(e))
    this.setMode(modeNow())
    panels.push(this)
  }

  get moving() {
    return [this.x, this.y, this.w, this.h, this.p].some(s => s.moving)
  }

  /** Where it is on screen now. */
  at() {
    return { x: this.x.value, y: this.y.value, w: this.w.value, h: this.h.value }
  }

  /** Where it rests in its place, or (`off`) where it comes in from and leaves to. */
  rest(off = false) {
    if (this.mode === 'mobile') return { x: off ? this.el.offsetWidth + 32 : 0, y: 0, w: this.w.value, h: this.h.value, p: 1 }
    const r = rectFor(layout, viewport())
    return off ? { ...offRect(layout.dock, r), p: layout.dock === 'float' ? 0 : 1 } : { ...r, p: 1 }
  }

  jump(to) {
    for (const k of ['x', 'y', 'w', 'h', 'p']) this[k].set(to[k])
  }

  go(to, { velocity = {}, damping = 1, response = 0.4 } = {}) {
    for (const k of ['x', 'y', 'w', 'h']) this[k].to(to[k], { velocity: velocity[k], damping, response })
    this.p.to(to.p, { damping: 1, response: to.p ? 0.3 : 0.24 })
  }

  paint() {
    const el = this.el
    if (this.mode === 'mobile') {
      el.style.transform = `translate3d(${this.x.value}px, 0, 0)`
      return
    }
    const g = this.g
    if (g?.mode === 'move') {
      // Glued to the pointer where it was grabbed (a share of the width, as the width changes),
      // plus what is left of the catch-up after it came loose.
      this.x.value = this.x.target = g.px - g.fx * this.w.value + (g.ox?.value ?? 0)
      this.y.value = this.y.target = g.py - g.gy + (g.oy?.value ?? 0)
    }
    const p = this.p.value
    el.style.width = `${this.w.value}px`
    el.style.height = `${this.h.value}px`
    el.style.transform = `translate3d(${this.x.value}px, ${this.y.value}px, 0)${p < 1 ? ` scale(${0.94 + 0.06 * Math.max(0, p)})` : ''}`
    el.style.opacity = p < 1 ? String(Math.max(0, Math.min(1, p * 1.6))) : ''
  }

  settle() {
    if (this.isOpen || this.moving) return
    this.el.classList.remove('open')
    this.el.setAttribute('aria-hidden', 'true')
  }

  setMode(mode) {
    this.mode = mode
    this.el.dataset.dock = mode
    if (mode === 'mobile') for (const k of ['width', 'height', 'opacity']) this.el.style[k] = ''
    this.syncChrome()
  }

  /** The handles and the menu button for the place it is in. */
  syncChrome() {
    const mode = this.mode
    const primary = { right: 'w', left: 'e', bottom: 'n', float: 'se' }[mode]
    for (const h of this.edges) {
      const on = h.dataset.edge === primary
      if (on) {
        h.tabIndex = 0
        h.dataset.i18nLabel = 'panel.resizeLabel'
        h.setAttribute('aria-label', this.text('panel.resizeLabel'))
      } else {
        h.removeAttribute('tabindex')
        delete h.dataset.i18nLabel
        h.removeAttribute('aria-label')
      }
      if (on && mode !== 'float') {
        const { min, max } = sizeLimits(mode, viewport())
        h.setAttribute('role', 'separator')
        h.setAttribute('aria-orientation', mode === 'bottom' ? 'horizontal' : 'vertical')
        h.setAttribute('aria-valuemin', String(min))
        h.setAttribute('aria-valuemax', String(Math.round(max)))
        h.setAttribute('aria-valuenow', String(Math.round(dockSize(layout, mode, viewport()))))
      } else for (const a of ['role', 'aria-orientation', 'aria-valuemin', 'aria-valuemax', 'aria-valuenow']) h.removeAttribute(a)
      h.setAttribute('aria-hidden', String(!on))
    }
    if (this.layoutButton && this.layoutButton.dataset.glyph !== layout.dock) {
      this.layoutButton.dataset.glyph = layout.dock
      this.layoutButton.innerHTML = GLYPHS[layout.dock]
    }
  }

  /** Returns false when it was open already. */
  open() {
    if (this.isOpen) return false
    this.isOpen = true
    for (const p of panels) if (p !== this) p.close()
    const mode = modeNow()
    const fresh = !this.el.classList.contains('open') || this.mode !== mode
    this.el.classList.add('open')
    this.el.setAttribute('aria-hidden', 'false')
    this.setMode(mode)
    // A fresh one comes in from its edge; one caught while leaving turns around from where it is.
    if (fresh) this.jump(this.rest(true))
    const float = mode === 'float'
    this.go(this.rest(), float ? { damping: 1, response: 0.32 } : { damping: 0.9, response: 0.4 })
    if (float && fresh) fadeIn(this.el)
    syncRoom()
    this.onChange()
    return true
  }

  /** `velocity` ({ x, y }, px/s): a flick's, carried on its way out. */
  close(velocity = {}) {
    if (!this.isOpen) return
    this.isOpen = false
    if (menu.isOpen()) menu.close()
    this.go(this.rest(true), { velocity, damping: 1, response: 0.3 })
    syncRoom({ response: 0.3 })
    this.onClose()
    this.onChange()
  }

  /** To another place, from where it is now. */
  setDock(dock) {
    if (dock === layout.dock || !DOCKS.includes(dock)) return
    layout = { ...layout, dock }
    save()
    this.place({ response: 0.42, fade: true })
  }

  /** Back to the default size of its place (a floating one: also the default spot). */
  resetSize() {
    if (this.mode === 'mobile') return
    layout = layout.dock === 'float' ? { ...layout, float: null } : { ...layout, [layout.dock === 'bottom' ? 'bottom' : 'side']: null }
    save()
    this.place({ response: 0.34 })
  }

  /** Into the current layout from wherever it is, the board along. */
  place({ velocity = {}, damping = 1, response = 0.4, fade = false } = {}) {
    this.setMode(modeNow())
    if (!this.isOpen) return
    this.go(this.rest(), { velocity, damping, response })
    if (fade) fadeIn(this.el)
    syncRoom({ response })
  }

  /** The window changed size: the panel keeps to its place (a spring caught midway keeps going there). */
  reflow() {
    if (!this.el.classList.contains('open') || this.g) return
    const mode = modeNow()
    if (mode !== this.mode) {
      this.setMode(mode)
      return this.jump(this.rest(!this.isOpen))
    }
    const to = this.rest(!this.isOpen)
    if (this.moving) this.go(to)
    else this.jump(to)
    this.syncChrome()
  }

  // -------------------------------------------------------------- gestures
  halt() {
    for (const s of [this.x, this.y, this.w, this.h]) s.stop()
  }

  down(e) {
    if (!this.isOpen || e.button !== 0) return
    const edge = e.target.closest('.sheet-edge')
    if (edge) return this.resizeStart(e, edge)
    if (e.pointerType === 'touch' && !e.target.closest('.sheet-grip')) return
    // The session's name renames it on a click: it does not move the panel.
    if (!e.target.closest('.sheet-head, .sheet-grip') || e.target.closest('button, input, textarea, a, #sheet-name')) return
    this.halt()
    const at = this.at()
    this.g = { kind: 'head', id: e.pointerId, sx: e.clientX, sy: e.clientY, px: e.clientX, py: e.clientY, at, samples: [sample(e)], mode: null, before: { ...layout } }
    this.el.setPointerCapture(e.pointerId)
  }

  move(e) {
    const g = this.g
    if (!g || e.pointerId !== g.id) return
    g.samples.push(sample(e))
    if (g.samples.length > 12) g.samples.shift()
    g.px = e.clientX
    g.py = e.clientY
    const dx = e.clientX - g.sx
    const dy = e.clientY - g.sy
    if (g.kind === 'resize') return this.resizeMove(dx, dy)
    if (!g.mode) {
      if (Math.hypot(dx, dy) < 6) return
      // Intent from the first move: out along its edge flicks it away; any other way pulls it loose.
      const o = outward(this.mode)
      const along = dx * o.x + dy * o.y
      g.mode = this.mode === 'float' ? 'move' : this.mode === 'mobile' || (along > 0 && along >= Math.abs(dx * o.y - dy * o.x)) ? 'dismiss' : 'pull'
      const rest = this.rest()
      g.base = (g.at.x - rest.x) * o.x + (g.at.y - rest.y) * o.y
      g.size = this.mode === 'mobile' ? this.el.offsetWidth : this.mode === 'bottom' ? g.at.h : g.at.w
      getSelection()?.removeAllRanges()
      document.body.classList.add('panel-grabbing')
      if (g.mode === 'move') this.grab(g)
    }
    if (g.mode === 'dismiss') {
      const o = outward(this.mode)
      const rest = this.rest()
      const along = g.base + dx * o.x + dy * o.y
      const off = along >= 0 ? along : rubberband(along, g.size)
      this.x.set(rest.x + off * o.x)
      if (this.mode !== 'mobile') this.y.set(rest.y + off * o.y)
    } else if (g.mode === 'pull') {
      this.x.set(g.at.x + rubberband(dx, 300))
      this.y.set(g.at.y + rubberband(dy, 300))
      if (Math.hypot(dx, dy) > TEAR) this.loosen(g)
    } else {
      this.paint()
      this.aim(g)
    }
  }

  /** A floating panel taken by its head: it follows the pointer from where it was grabbed. */
  grab(g) {
    g.fx = (g.sx - g.at.x) / g.at.w
    g.gy = g.sy - g.at.y
  }

  /** Pulled far enough, a docked panel comes loose as a window, sized as the viewer's floating one. */
  loosen(g) {
    const vp = viewport()
    const now = this.at()
    g.mode = 'move'
    this.grab(g)
    // From the rubber-banded spot to under the pointer: an offset that springs away (additive), so nothing jumps.
    const catchUp = value => {
      const s = new Spring({ value, damping: 1, response: 0.26, precision: 0.3, onUpdate: () => this.paint() })
      s.to(0)
      return s
    }
    g.ox = catchUp(now.x - (g.px - g.fx * now.w))
    g.oy = catchUp(now.y - (g.py - g.gy))
    const size = clampFloat(layout.float ?? defaultFloat(vp), vp)
    layout = { ...layout, dock: 'float' } // the drop decides what is kept
    this.setMode('float')
    this.w.to(size.w, { damping: 1, response: 0.32 })
    this.h.to(size.h, { damping: 1, response: 0.32 })
    syncRoom({ response: 0.34 })
  }

  /** While a loose panel moves: the dock it would land in now, shown as a preview. */
  aim(g) {
    clearTimeout(g.idle)
    const v = velocityOf(g.samples)
    preview.show(dockFromThrow({ x: g.px, y: g.py }, v, viewport()), this.at())
    // Held still, the throw is over: aim again without the speed it had.
    g.idle = setTimeout(() => this.g === g && preview.show(dockFromThrow({ x: g.px, y: g.py }, { x: 0, y: 0 }, viewport()), this.at()), 120)
  }

  up(e, cancelled = false) {
    const g = this.g
    if (!g || e.pointerId !== g.id) return
    this.g = null
    clearTimeout(g.idle)
    document.body.classList.remove('panel-grabbing', 'panel-resizing')
    if (!cancelled) g.samples.push(sample(e))
    const v = cancelled ? { x: 0, y: 0 } : velocityOf(g.samples)
    if (g.kind === 'resize') return this.resizeEnd(g, v)
    if (!g.mode) return // a press on the head, not a drag
    if (g.mode === 'dismiss') {
      const o = outward(this.mode)
      const rest = this.rest()
      const off = (this.x.value - rest.x) * o.x + (this.y.value - rest.y) * o.y
      const along = v.x * o.x + v.y * o.y
      const velocity = { x: along * o.x, y: along * o.y }
      if (flicksAway(off, along, g.size)) return this.close(velocity)
      return this.go(this.rest(), { velocity, damping: 0.8, response: 0.3 })
    }
    if (g.mode === 'pull') return this.go(this.rest(), { velocity: v, damping: 0.8, response: 0.3 })
    // Let go loose: docks where the throw would come to rest near an edge, else floats there.
    preview.hide()
    g.ox?.stop()
    g.oy?.stop()
    const vp = viewport()
    const dock = dockFromThrow({ x: g.px, y: g.py }, v, vp)
    if (dock) layout = { ...layout, dock }
    else {
      const w = this.w.target
      const h = this.h.target
      layout = { ...layout, dock: 'float', float: floatLanding({ x: g.px - g.fx * w, y: g.py - g.gy, w, h }, v, vp) }
    }
    save()
    const fast = Math.hypot(v.x, v.y) > 600
    this.place({ velocity: { x: v.x, y: v.y }, damping: fast ? 0.82 : 1, response: 0.42, fade: true })
  }

  resizeStart(e, handle) {
    if (this.mode === 'mobile') return
    e.preventDefault() // no text selection on the way
    this.halt()
    this.g = { kind: 'resize', edge: handle.dataset.edge, handle, id: e.pointerId, sx: e.clientX, sy: e.clientY, at: this.at(), samples: [sample(e)], moved: false, before: { ...layout } }
    handle.setPointerCapture(e.pointerId)
    handle.classList.add('active')
    document.body.style.setProperty('--grab-cursor', CURSOR[handle.dataset.edge])
    document.body.classList.add('panel-resizing')
    holdAnchor()
    following = true
  }

  resizeMove(dx, dy) {
    const g = this.g
    const vp = viewport()
    g.moved ||= dx !== 0 || dy !== 0
    if (this.mode === 'float') return this.jump({ ...resizeFloat(g.at, g.edge, dx, dy, vp), p: 1 })
    g.raw = this.mode === 'right' ? g.at.w - dx : this.mode === 'left' ? g.at.w + dx : g.at.h - dy
    const size = soft(g.raw, sizeLimits(this.mode, vp))
    this.jump({ ...dockRect(this.mode, size, vp), p: 1 })
    room[this.mode].set(size + MARGIN)
  }

  resizeEnd(g, v) {
    g.handle.classList.remove('active')
    following = false
    if (!g.moved) return queueRoom()
    const vp = viewport()
    if (this.mode === 'float') {
      const r = clampFloat(this.at(), vp)
      layout = { ...layout, float: r }
      save()
      const e = g.edge
      const velocity = { x: e.includes('w') ? v.x : 0, y: e.includes('n') ? v.y : 0, w: e.includes('e') ? v.x : e.includes('w') ? -v.x : 0, h: e.includes('s') ? v.y : e.includes('n') ? -v.y : 0 }
      return this.go({ ...r, p: 1 }, { velocity, damping: 0.85, response: 0.32 })
    }
    const lim = sizeLimits(this.mode, vp)
    // How fast it grows (px/s).
    const vs = this.mode === 'right' ? -v.x : this.mode === 'left' ? v.x : -v.y
    if (foldsAway(g.raw, vs, lim.min)) {
      const o = outward(this.mode)
      return this.close({ x: Math.abs(vs) * o.x, y: Math.abs(vs) * o.y })
    }
    const size = Math.round(Math.max(lim.min, Math.min(lim.max, this.mode === 'bottom' ? this.h.value : this.w.value)))
    layout = { ...layout, [this.mode === 'bottom' ? 'bottom' : 'side']: size }
    save()
    const velocity = this.mode === 'right' ? { x: -vs, w: vs } : this.mode === 'left' ? { w: vs } : { y: -vs, h: vs }
    this.go(this.rest(), { velocity, damping: 0.85, response: 0.32 })
    syncRoom({ velocity: { [this.mode]: vs }, response: 0.32 })
    this.syncChrome()
  }

  /** Esc while dragging: everything goes back to where it was. */
  cancel() {
    const g = this.g
    if (!g) return
    this.g = null
    clearTimeout(g.idle)
    try {
      ;(g.handle ?? this.el).releasePointerCapture(g.id)
    } catch {}
    g.handle?.classList.remove('active')
    following = false
    document.body.classList.remove('panel-grabbing', 'panel-resizing')
    preview.hide()
    g.ox?.stop()
    g.oy?.stop()
    layout = g.before
    this.place({ damping: 1, response: 0.34, fade: true })
  }

  key(e) {
    if (this.mode === 'mobile' || e.altKey || e.ctrlKey || e.metaKey) return
    const vp = viewport()
    if (this.mode === 'float') {
      const r = keyFloat(rectFor(layout, vp), e.key, e.shiftKey, vp)
      if (!r) return
      e.preventDefault()
      layout = { ...layout, float: r }
    } else {
      const size = keySize(this.mode, dockSize(layout, this.mode, vp), e.key, e.shiftKey, sizeLimits(this.mode, vp))
      if (size == null) return
      e.preventDefault()
      layout = { ...layout, [this.mode === 'bottom' ? 'bottom' : 'side']: size }
    }
    save()
    this.place({ response: 0.26 })
  }
}

/** With reduced motion a change of place is a cross-fade, not a slide. */
function fadeIn(el) {
  if (reducedMotion.matches) el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 180, easing: 'ease-out' })
}

// ---------------------------------------------------------------- the window around them
let last = viewport()
function relayout() {
  const vp = viewport()
  if (vp.w === last.w && vp.h === last.h) return
  last = vp
  for (const p of panels) p.reflow()
  syncRoom({ jump: true })
}
addEventListener('resize', relayout)
// The page's width also changes when its scrollbar comes or goes.
new ResizeObserver(relayout).observe(html)
phone.addEventListener('change', () => {
  last = { w: -1, h: -1 }
  relayout()
})
// Esc during a drag puts it back; before the page's own Esc, which would close the panel.
addEventListener(
  'keydown',
  e => {
    const p = e.key === 'Escape' && panels.find(panel => panel.g)
    if (!p) return
    e.preventDefault()
    e.stopImmediatePropagation()
    p.cancel()
  },
  true,
)
