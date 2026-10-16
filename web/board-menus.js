// Which menu a right click, a long press or the menu key opens on the board, and what its items
// do. Cards, lanes, the board's empty space, the open session's head, starting sessions and
// file chips get the board's own menu; fields, selected text and links keep the browser's, and
// Shift+right click always gives the browser's (copy, paste, the inspector).
import { boardMenu, cardMenu, chipMenu, laneMenu, launchMenu, wantsNativeMenu } from './menu-model.js'

const LONG_PRESS_MS = 480
const SLOP = 9 // px a finger may wander before a long press becomes a scroll

/**
 * board: what the page knows and can do (app.js): t(), menu, canMutate(), canEdit(), item(key),
 * column(it), category(it), state(), launch (launch.js), and do: { open, focus, write, wake,
 * sleep, rename, move, dismiss, clear, changes, history, terminal, mokupilot, newSession, cats, filter,
 * sleepers, search, copy, openPath, look, focusLaunch }.
 */
export function initBoardMenus(board) {
  const { menu } = board
  let keyAt = -1e9
  let pressAt = -1e9
  let swallowUntil = 0

  const ctx = () => ({ t: board.t(), canMutate: board.canMutate(), canEdit: board.canEdit() })
  const pointRect = (x, y) => ({ left: x - 12, top: y - 12, right: x + 12, bottom: y + 12, width: 24, height: 24 })

  /** The menu for whatever is under `target`, or null when the browser's own should show. */
  function menuFor(target, at) {
    const el = target instanceof Element ? target : target?.parentElement
    if (!el) return null
    const t = board.t()
    const chip = el.closest('[data-fs="file"], [data-fs="dir"]')
    if (chip) {
      const path = chip.dataset.abs
      return {
        items: chipMenu({ dir: chip.dataset.fs === 'dir' }, ctx()),
        label: path,
        pick: id => {
          if (id === 'look') board.do.look({ path, line: Number(chip.dataset.line) || null }, chip)
          else if (id === 'open' || id === 'reveal') board.do.openPath(path, id)
          else if (id === 'copyPath') board.do.copy(chip.dataset.line ? `${path}:${chip.dataset.line}` : path, t('ql.copied'))
          else if (id === 'newHere') board.do.newSession({ cwd: path }, chip)
        },
      }
    }
    if (el.closest('.ql, .launch, .limits-pop, .rename, .menu')) return null
    const head = el.closest('#sheet .sheet-head')
    if (head) {
      const key = board.state().open
      return key && board.item(key) ? forCard(key, head.querySelector('#sheet-name') ?? head, at) : null
    }
    if (el.closest('.sheet')) return null
    const card = el.closest('.card[data-key]')
    if (card) {
      const key = card.dataset.key
      if (key.startsWith('launch:')) return forLaunch(key.slice(7), card)
      return board.item(key) ? forCard(key, card, at) : null
    }
    const lane = el.closest('.lane[data-cat]')
    if (lane) {
      const cat = board.state().data.categories.find(c => c.id === lane.dataset.cat)
      if (cat) return forLane(cat, at)
    }
    return forBoard(at)
  }

  function forCard(key, el, at) {
    const it = board.item(key)
    const t = board.t()
    const state = board.state()
    const nameEl = el.matches?.('.card') ? el.querySelector('.name') : el
    return {
      label: it.name,
      items: cardMenu(it, { ...ctx(), terminal: state.data.terminal !== false, mokupilot: !!state.data.mokupilot, categories: state.data.categories, column: board.column(it), category: board.category(it) }),
      pick: id => {
        const [what, arg] = id.split(/:(.*)/s)
        const from = el.isConnected ? el : pointRect(at.x, at.y)
        if (what === 'cat') return board.do.move(key, { cat: arg })
        if (what === 'col') return board.do.move(key, { column: arg })
        if (what === 'copy') {
          const value = { name: it.name, cwd: it.cwd, session: it.session, pane: it.pane }[arg]
          return board.do.copy(value, t('menu.copied'))
        }
        if (id === 'rename') return board.do.rename(key, nameEl)
        if (id === 'reveal') return board.do.openPath(it.cwd, 'open')
        if (id === 'newHere') return board.do.newSession({ item: it }, from)
        board.do[id]?.(key, from)
      },
    }
  }

  function forLaunch(id, el) {
    const t = board.t()
    const l = board.launch.placeholders().find(x => x.launch.id === id)?.launch
    if (!l) return null
    return {
      label: l.name,
      items: launchMenu(l, ctx()),
      pick: what => {
        if (what === 'focus') board.do.focusLaunch(id)
        else if (what === 'trust') board.launch.trust(id)
        else if (what === 'closeTab') board.launch.closeTab(id)
        else if (what === 'retry') board.launch.retry(l, el)
        else if (what === 'copyError') board.do.copy(l.error, t('menu.copied'))
        else if (what === 'copy:cwd') board.do.copy(l.cwd, t('menu.copied'))
        else if (what === 'dismiss') board.launch.dismiss(id)
      },
    }
  }

  function forLane(cat, at) {
    const state = board.state()
    return {
      label: cat.title,
      items: laneMenu(cat, { ...ctx(), filter: state.filter }),
      pick: id => {
        const from = pointRect(at.x, at.y)
        if (id === 'new') board.do.newSession({ category: cat.id }, from)
        else if (id === 'newWorkspace') board.do.newSession({ category: cat.id, newWorkspace: true }, from)
        else if (id === 'editCat') board.do.cats(cat.id)
        else if (id === 'showOnly') board.do.filter(cat.id)
        else if (id === 'showAll') board.do.filter('all')
      },
    }
  }

  function forBoard(at) {
    const state = board.state()
    return {
      items: boardMenu({ ...ctx(), filter: state.filter, sleepers: state.sleepers }),
      pick: id => {
        const from = pointRect(at.x, at.y)
        if (id === 'new') board.do.newSession({}, from)
        else if (id === 'newWorkspace') board.do.newSession({ newWorkspace: true }, from)
        else if (id === 'cats') board.do.cats()
        else if (id === 'sleepers') board.do.sleepers()
        else if (id === 'showAll') board.do.filter('all')
        else if (id === 'search') board.do.search()
      },
    }
  }

  function show(target, at, source) {
    const m = menuFor(target, at)
    if (!m) return false
    menu.open(m.items, { x: at.x, y: at.y, source, label: m.label, onPick: m.pick, origin: document.activeElement })
    return true
  }

  /** Text the user selected, under the pointer: the browser's menu copies it. */
  function inSelection(target) {
    const sel = getSelection()
    if (!sel || sel.isCollapsed || !sel.rangeCount) return false
    return sel.getRangeAt(0).intersectsNode(target)
  }

  document.addEventListener('contextmenu', e => {
    const now = performance.now()
    // The menu key and a long press open ours themselves; the browser's that follows them must
    // not. A touch that was no long press of ours (text, the toolbar) keeps the browser's.
    if (e.pointerType === 'touch') return void (now - pressAt < 1500 && e.preventDefault())
    if (e.button !== 2 && now - keyAt < 1500) return void e.preventDefault() // the key's own event: button -1
    const el = e.target instanceof Element ? e.target : e.target.parentElement
    const editable = !!el?.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"]')
    const link = !!el?.closest('a[href]:not([data-fs="file"]):not([data-fs="dir"])')
    if (wantsNativeMenu({ shift: e.shiftKey, editable, inSelection: inSelection(e.target), link })) return
    if (show(e.target, { x: e.clientX, y: e.clientY }, 'mouse')) e.preventDefault()
  })

  // The menu key and Shift+F10: the menu of what has the focus, under it.
  addEventListener('keydown', e => {
    if (!(e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey)) || menu.isOpen()) return
    const el = document.activeElement
    if (el?.closest('input, textarea, select, [contenteditable]')) return
    const target = el && el !== document.body ? el : document.querySelector('#board')
    const r = target.getBoundingClientRect()
    const at = el && el !== document.body ? { x: r.left + Math.min(24, r.width / 2), y: r.top + Math.min(r.height - 4, 30) } : { x: r.left + 24, y: r.top + 8 }
    if (show(target, at, 'keyboard')) {
      e.preventDefault()
      keyAt = performance.now()
    }
  })

  // Touch: a long press opens the menu where the finger is, unless the finger moved (a scroll)
  // or lifted first. The tap it ends in does not also open the card.
  let press = null
  addEventListener(
    'pointerdown',
    e => {
      if (e.pointerType !== 'touch' || !e.isPrimary) return
      const el = e.target instanceof Element ? e.target : null
      if (!el || el.closest('input, textarea, select, button, a[href], .sheet, .ql, .launch, .menu, .rename, .toolbar')) return
      if (!el.closest('.card, .lane, #board')) return
      clearTimeout(press?.timer)
      press = {
        id: e.pointerId,
        x: e.clientX,
        y: e.clientY,
        target: el,
        timer: setTimeout(() => {
          const p = press
          press = null
          if (!p) return
          if (show(p.target, { x: p.x, y: p.y }, 'touch')) {
            pressAt = performance.now()
            swallowUntil = pressAt + 900
            getSelection()?.removeAllRanges()
            navigator.vibrate?.(8)
          }
        }, LONG_PRESS_MS),
      }
    },
    true,
  )
  const cancel = e => {
    if (!press || (e.pointerId !== undefined && e.pointerId !== press.id)) return
    if (e.type === 'pointermove' && Math.hypot(e.clientX - press.x, e.clientY - press.y) < SLOP) return
    clearTimeout(press.timer)
    press = null
  }
  for (const type of ['pointermove', 'pointerup', 'pointercancel']) addEventListener(type, cancel, true)
  addEventListener('scroll', () => press && cancel({ type: 'scroll' }), true)
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

  return { menuFor }
}
