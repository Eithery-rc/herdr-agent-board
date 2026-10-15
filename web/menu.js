// The board's context menu, in the manner of macOS: it grows out of the point it opened at,
// keeps on screen (menu-model.js places it), nests submenus beside their item, and answers the
// keyboard: arrows, Enter or Space, Esc, Home and End, and typing a label's first letters.
// Gray items say why. A click outside only closes it; it does not also act on what is there.
import { firstIndex, lastIndex, nextIndex, placeMenu, placeSubmenu, shareReasons, typeahead } from './menu-model.js'
import { reducedMotion, Spring } from './spring.js'

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
const CHECK = '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="m4.5 10.5 3.5 3.5 7.5-8"/></svg>'
const CHEV = '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="m8 5 5 5-5 5"/></svg>'

export function initMenu({ onChange = () => {} } = {}) {
  let layers = [] // the root menu and its open submenus, outermost first
  let pick = () => {}
  let restore = null
  let openedAt = 0
  let downInside = false
  let typed = ''
  let typedAt = 0
  let hover = 0 // timer: a submenu opens (or closes) once the pointer rests
  let seq = 0
  let swallowUntil = 0

  const viewport = () => ({ width: document.documentElement.clientWidth, height: innerHeight })

  /**
   * Open `items` at x, y (client coordinates). source: mouse, touch or keyboard (keyboard lights
   * the first item). onPick(id, item) runs after the menu closed.
   */
  function open(items, { x, y, source = 'mouse', origin = null, onPick = () => {}, label = '' }) {
    if (!items?.length) return
    clear(false)
    pick = onPick
    restore = origin ?? document.activeElement
    openedAt = performance.now()
    downInside = false
    typed = ''
    const layer = build(items, 0)
    layer.el.classList.toggle('touch', source === 'touch')
    if (label) layer.el.setAttribute('aria-label', label)
    document.body.append(layer.el)
    const r = layer.el.getBoundingClientRect()
    const p = placeMenu({ x, y }, { width: r.width, height: r.height }, viewport())
    place(layer, p)
    grow(layer, `${p.originX} ${p.originY}`)
    layers = [layer]
    if (source === 'keyboard') light(layer, firstIndex(layer.items))
    layer.el.focus({ preventScroll: true })
    onChange()
  }

  function build(raw, depth) {
    const { items, note } = shareReasons(raw)
    const el = document.createElement('div')
    el.className = 'menu'
    el.setAttribute('role', 'menu')
    el.tabIndex = -1
    const id = `menu-${++seq}`
    const checks = items.some(it => it.checked !== undefined)
    el.innerHTML =
      items
        .map((it, i) => {
          if (it.separator) return '<div class="menu-sep" role="separator"></div>'
          const role = it.checked !== undefined ? 'menuitemcheckbox' : 'menuitem'
          const attrs = [
            `id="${id}-${i}"`,
            `role="${role}"`,
            `data-i="${i}"`,
            it.disabled ? 'aria-disabled="true"' : '',
            it.checked !== undefined ? `aria-checked="${!!it.checked}"` : '',
            it.submenu ? 'aria-haspopup="menu" aria-expanded="false"' : '',
          ].join(' ')
          const dot = it.swatch || it.dot ? `<span class="mi-dot${it.dot ? ' round' : ''}" style="--dot:${esc(it.swatch || it.dot)}"></span>` : ''
          const tail = it.submenu ? `<span class="mi-chev">${CHEV}</span>` : it.hint ? `<span class="mi-hint">${esc(it.hint)}</span>` : ''
          return `<div class="menu-item${it.danger ? ' danger' : ''}" ${attrs}>${checks ? `<span class="mi-check">${it.checked ? CHECK : ''}</span>` : ''}${dot}<span class="mi-text"><span class="mi-label">${esc(it.label)}</span>${it.reason ? `<span class="mi-reason">${esc(it.reason)}</span>` : ''}</span>${tail}</div>`
        })
        .join('') + (note ? `<div class="menu-note" role="note">${esc(note)}</div>` : '')
    if (!checks) el.classList.add('no-checks')
    const layer = { el, items, active: -1, depth, sub: -1, spring: null }
    el.addEventListener('pointermove', e => onMove(layer, e))
    el.addEventListener('pointerleave', () => onLeave(layer))
    el.addEventListener('pointerdown', e => {
      downInside = true
      e.preventDefault() // keep the focus on the menu
    })
    el.addEventListener('pointerup', e => onUp(layer, e))
    el.addEventListener('contextmenu', e => e.preventDefault())
    return layer
  }

  function place(layer, p) {
    layer.el.style.left = `${p.x}px`
    layer.el.style.top = `${p.y}px`
    layer.el.style.maxHeight = `${p.maxHeight}px`
  }

  /** It grows out of its corner (or the side of its parent item), critically damped and quick. */
  function grow(layer, origin) {
    const el = layer.el
    el.style.transformOrigin = origin
    layer.spring = new Spring({
      value: 0,
      damping: 1,
      response: 0.2,
      precision: 0.003,
      onUpdate: v => {
        el.style.opacity = String(Math.min(1, v * 1.4))
        el.style.transform = reducedMotion.matches ? '' : `scale(${0.94 + 0.06 * v})`
      },
      onRest: v => {
        if (v === 0) el.remove()
        else el.style.transform = ''
      },
    })
    layer.spring.to(1)
  }

  function fade(layer) {
    layer.el.style.pointerEvents = 'none'
    layer.el.removeAttribute('id')
    if (!layer.spring || reducedMotion.matches) return layer.el.remove()
    layer.spring.to(0, { response: 0.14 })
  }

  const itemEl = (layer, i) => layer.el.querySelector(`[data-i="${i}"]`)

  function light(layer, i) {
    if (layer.active === i) return
    itemEl(layer, layer.active)?.classList.remove('active')
    layer.active = i
    const el = itemEl(layer, i)
    if (el) {
      el.classList.add('active')
      layer.el.setAttribute('aria-activedescendant', el.id)
      el.scrollIntoView({ block: 'nearest' })
    } else layer.el.removeAttribute('aria-activedescendant')
  }

  const indexAt = e => Number(e.target.closest?.('.menu-item')?.dataset.i ?? -1)

  function onMove(layer, e) {
    const i = indexAt(e)
    const it = layer.items[i]
    const usable = it && !it.disabled
    if (usable) light(layer, i)
    else if (layer.sub < 0) light(layer, -1)
    // A submenu follows the pointer once it rests a moment, so a diagonal move toward an open
    // submenu across other items does not swap it.
    clearTimeout(hover)
    if (usable && it.submenu && layer.sub !== i) hover = setTimeout(() => openSub(layer, i, false), 140)
    else if (layer.sub >= 0 && layer.sub !== i) hover = setTimeout(() => closeFrom(layer.depth + 1), 260)
  }

  function onLeave(layer) {
    clearTimeout(hover)
    if (layer.sub < 0) light(layer, -1)
    else light(layer, layer.sub)
  }

  function onUp(layer, e) {
    // The release of the press that opened the menu is not a choice (macOS opens on press).
    if (!downInside && performance.now() - openedAt < 350) return
    downInside = false
    const i = indexAt(e)
    if (i >= 0) activate(layer, i)
  }

  function openSub(layer, i, focusFirst) {
    const it = layer.items[i]
    if (!it?.submenu?.length || it.disabled) return
    if (layer.sub === i && layers[layer.depth + 1]) {
      if (focusFirst) light(layers[layer.depth + 1], firstIndex(layers[layer.depth + 1].items))
      return
    }
    closeFrom(layer.depth + 1)
    const sub = build(it.submenu, layer.depth + 1)
    sub.el.classList.toggle('touch', layers[0].el.classList.contains('touch'))
    document.body.append(sub.el)
    const r = sub.el.getBoundingClientRect()
    const p = placeSubmenu(itemEl(layer, i).getBoundingClientRect(), layer.el.getBoundingClientRect(), { width: r.width, height: r.height }, viewport())
    place(sub, p)
    grow(sub, p.side === 'right' ? 'left top' : 'right top')
    layer.sub = i
    itemEl(layer, i)?.setAttribute('aria-expanded', 'true')
    layers.push(sub)
    if (focusFirst) light(sub, firstIndex(sub.items))
  }

  function closeFrom(depth) {
    while (layers.length > depth) {
      const gone = layers.pop()
      fade(gone)
      const parent = layers.at(-1)
      if (parent) {
        itemEl(parent, parent.sub)?.setAttribute('aria-expanded', 'false')
        parent.sub = -1
      }
    }
  }

  function activate(layer, i) {
    const it = layer.items[i]
    if (!it || it.separator || it.disabled) return
    if (it.submenu) return openSub(layer, i, true)
    const run = pick
    clear(true)
    run(it.id, it)
  }

  /** Close every level; `focus` gives the focus back to where it was. */
  function clear(focus = true) {
    clearTimeout(hover)
    if (!layers.length) return
    closeFrom(0)
    if (focus && restore?.isConnected) restore.focus({ preventScroll: true })
    restore = null
    onChange()
  }

  function onKey(e) {
    if (!layers.length) return
    const top = layers.at(-1)
    e.stopImmediatePropagation()
    const key = e.key
    if (key === 'ArrowDown' || key === 'ArrowUp') {
      e.preventDefault()
      light(top, nextIndex(top.items, top.active, key === 'ArrowDown' ? 1 : -1))
    } else if (key === 'Home' || key === 'End') {
      e.preventDefault()
      light(top, key === 'Home' ? firstIndex(top.items) : lastIndex(top.items))
    } else if (key === 'ArrowRight') {
      e.preventDefault()
      if (top.items[top.active]?.submenu) openSub(top, top.active, true)
    } else if (key === 'ArrowLeft') {
      e.preventDefault()
      if (layers.length > 1) {
        closeFrom(layers.length - 1)
        layers.at(-1).el.focus({ preventScroll: true })
      }
    } else if (key === 'Enter' || key === ' ') {
      e.preventDefault()
      if (top.active >= 0) activate(top, top.active)
    } else if (key === 'Escape') {
      e.preventDefault()
      if (layers.length > 1) closeFrom(layers.length - 1)
      else clear(true)
    } else if (key === 'Tab') {
      e.preventDefault()
      clear(true)
    } else if (key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault()
      const now = performance.now()
      typed = now - typedAt > 700 ? key : typed + key
      typedAt = now
      light(top, typeahead(top.items, typed, top.active))
    }
  }

  addEventListener('keydown', onKey, true)
  // A press outside closes the menu and is spent on that; a right press opens the next menu.
  addEventListener(
    'pointerdown',
    e => {
      if (!layers.length || layers.some(l => l.el.contains(e.target))) return
      if (e.button === 0) swallowUntil = performance.now() + 600
      clear(e.button !== 0)
    },
    true,
  )
  addEventListener(
    'click',
    e => {
      if (performance.now() > swallowUntil) return
      swallowUntil = 0
      e.preventDefault()
      e.stopImmediatePropagation()
    },
    true,
  )
  addEventListener('blur', () => clear(false))
  addEventListener('resize', () => clear(false))
  addEventListener('scroll', e => layers.length && !layers.some(l => l.el.contains(e.target)) && clear(false), true)

  return { open, close: () => clear(true), isOpen: () => layers.length > 0 }
}
