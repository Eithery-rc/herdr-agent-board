// Shared focus ownership for quick look and launch dialogs. The stack lets a
// dialog temporarily cover another dialog without making its background reachable.
export function modalFocusManager(doc) {
  const stack = []
  const saved = new Map()
  const top = () => stack.at(-1)
  const auxiliary = node => node?.closest?.('.menu, .rename, .toasts')
  const visible = el => el.getClientRects().length && (el.checkVisibility?.() ?? true)
  const controls = scope => [...scope.win.querySelectorAll('button, input, textarea, select, a[href], [tabindex], summary')]
    .filter(el => !el.disabled && el.tabIndex >= 0 && !el.closest('[hidden], [inert]') && visible(el))
  function sync() {
    for (const [el, inert] of saved) el.inert = inert
    saved.clear()
    if (!top()) return
    for (const el of doc.body.children) {
      if (el === top().layer || auxiliary(el)) continue
      saved.set(el, el.inert)
      el.inert = true
    }
  }
  const focusFirst = scope => (controls(scope)[0] ?? scope.win).focus({ preventScroll: true })
  doc.addEventListener('focusin', e => {
    const scope = top()
    if (scope && !scope.layer.contains(e.target) && !auxiliary(e.target)) focusFirst(scope)
  }, true)
  doc.addEventListener('keydown', e => {
    const scope = top()
    // A field that takes its own keys (the terminal's) keeps Tab: it goes to the terminal.
    if (!scope || e.key !== 'Tab' || auxiliary(e.target) || e.target.closest?.('[data-own-keys]')) return
    const all = controls(scope)
    const at = all.indexOf(doc.activeElement)
    if (!all.length || (e.shiftKey ? at <= 0 : at < 0 || at === all.length - 1)) {
      e.preventDefault()
      ;(e.shiftKey ? all.at(-1) : all[0])?.focus({ preventScroll: true })
      if (!all.length) scope.win.focus({ preventScroll: true })
    }
  }, true)
  return (layer, win) => {
    const scope = { layer, win, origin: null }
    return {
      open(origin = doc.activeElement) {
        if (!stack.includes(scope)) { scope.origin = origin; stack.push(scope) }
        sync()
        win.focus({ preventScroll: true })
      },
      close() {
        const index = stack.indexOf(scope)
        if (index < 0) return
        const wasTop = top() === scope
        stack.splice(index, 1)
        sync()
        if (!wasTop) return
        const origin = scope.origin
        if (origin?.isConnected && !origin.closest('[inert], [hidden]') && visible(origin)) origin.focus({ preventScroll: true })
        else if (top()) focusFirst(top())
      },
      isTop: () => top() === scope,
    }
  }
}

let manager
export function modalFocus(layer, win) {
  manager ??= modalFocusManager(document)
  return manager(layer, win)
}
