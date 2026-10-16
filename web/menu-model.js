// The board's context menus without a page: where a menu goes so it stays on screen, which
// items a card, a lane or the board gets in each state, and keyboard movement through them.
// The DOM side is menu.js; the items' actions are wired up in app.js.
//
// An item: { id, label, hint?, checked?, disabled?, reason?, danger?, submenu?, color? }, or
// { separator: true }. `reason` says why a disabled item is gray.

/**
 * Where a menu of `size` opens for a click at `point`: down and to the right of it, flipped
 * left or up when it would leave the viewport, and pressed against the margin when it fits
 * neither way. Taller than the viewport: it scrolls (maxHeight). origin is the corner it grows from.
 */
export function placeMenu(point, size, viewport, margin = 8) {
  const maxHeight = viewport.height - 2 * margin
  const h = Math.min(size.height, maxHeight)
  const w = Math.min(size.width, viewport.width - 2 * margin)
  let x = point.x
  let originX = 'left'
  if (x + w > viewport.width - margin) {
    if (point.x - w >= margin) {
      x = point.x - w
      originX = 'right'
    } else x = viewport.width - margin - w
  }
  let y = point.y
  let originY = 'top'
  if (y + h > viewport.height - margin) {
    if (point.y - h >= margin) {
      y = point.y - h
      originY = 'bottom'
    } else y = viewport.height - margin - h
  }
  // A click inside the margin itself: the flipped menu still keeps the margin.
  const clamp = (v, size, room) => Math.max(margin, Math.min(v, room - margin - size))
  return { x: clamp(x, w, viewport.width), y: clamp(y, h, viewport.height), originX, originY, maxHeight }
}

/**
 * A submenu beside the item that opens it: right of the parent menu with its first item level
 * with that item (`inset`: the menu's top padding), left when the right has no room, moved up
 * when it would leave the bottom.
 */
export function placeSubmenu(item, parent, size, viewport, { margin = 8, inset = 5, overlap = 3 } = {}) {
  let x = parent.right - overlap
  let side = 'right'
  if (x + size.width > viewport.width - margin) {
    const left = parent.left - size.width + overlap
    if (left >= margin) {
      x = left
      side = 'left'
    } else x = viewport.width - margin - size.width
  }
  const maxHeight = viewport.height - 2 * margin
  const h = Math.min(size.height, maxHeight)
  let y = item.top - inset
  if (y + h > viewport.height - margin) y = viewport.height - margin - h
  return { x: Math.max(margin, x), y: Math.max(margin, y), side, maxHeight }
}

const usable = it => it && !it.separator && !it.disabled

/** The next item to light from `from` going `dir` (+1 / -1), over separators and gray items, wrapping. */
export function nextIndex(items, from, dir) {
  const n = items.length
  if (!n) return -1
  let i = from
  for (let step = 0; step < n; step++) {
    i = i < 0 ? (dir > 0 ? 0 : n - 1) : (i + dir + n) % n
    if (usable(items[i])) return i
  }
  return -1
}

/** First and last usable items, for Home and End. */
export const firstIndex = items => nextIndex(items, -1, 1)
export const lastIndex = items => nextIndex(items, -1, -1)

/**
 * Type to select: the next usable item after `from` whose label starts with what was typed. The
 * same letter again moves on to the next item that starts with it, as macOS menus do.
 */
export function typeahead(items, typed, from) {
  const q = String(typed ?? '').toLowerCase()
  if (!q) return from
  const same = [...q].every(c => c === q[0])
  const n = items.length
  const starts = i => usable(items[i]) && String(items[i].label ?? '').toLowerCase().startsWith(same ? q[0] : q)
  const begin = same || from < 0 ? from + 1 : from
  for (let k = 0; k < n; k++) {
    const i = (Math.max(0, begin) + k) % n
    if (starts(i)) return i
  }
  return from
}

/**
 * When several items are gray for the same reason (no fresh herdr data), the reason goes once
 * under the menu instead of under each of them. Returns { items, note }.
 */
export function shareReasons(items, min = 2) {
  const counts = new Map()
  for (const it of items) if (it.disabled && it.reason) counts.set(it.reason, (counts.get(it.reason) ?? 0) + 1)
  const [shared] = [...counts].filter(([, n]) => n >= min).sort((a, b) => b[1] - a[1])[0] ?? []
  if (!shared) return { items, note: '' }
  return { items: items.map(it => (it.reason === shared ? { ...it, reason: '' } : it)), note: shared }
}

/** Separators only between groups: none first, last or twice in a row. */
export function tidy(items) {
  const out = []
  for (const it of items) {
    if (!it) continue
    if (it.separator && (!out.length || out.at(-1).separator)) continue
    out.push(it)
  }
  while (out.at(-1)?.separator) out.pop()
  return out
}

const SEP = { separator: true }
const PIN_COLUMNS = ['me', 'ext', 'done', 'idle']
const COLUMN_COLOR = { me: 'var(--orange)', ext: 'var(--purple)', done: 'var(--blue)', idle: 'var(--gray)', work: 'var(--green)' }

/**
 * A card's menu. `it` is the board item; ctx: { t, canMutate, canEdit, categories, column (where
 * it shows now), category (its lane now) }. Items gray out with the reason when herdr data is
 * stale (going to, waking, sleeping, renaming in Claude) or the board is offline (card edits).
 */
export function cardMenu(it, ctx) {
  const { t } = ctx
  const herdrWhy = ctx.canEdit ? t('mobile.readOnly') : t('live.off')
  const editWhy = t('live.off')
  const herdr = extra => (ctx.canMutate ? extra ?? {} : { disabled: true, reason: herdrWhy })
  const edit = () => (ctx.canEdit ? {} : { disabled: true, reason: editWhy })
  const turn = it.status === 'working' || it.status === 'blocked'
  const claude = !!it.session
  const dismissable = it.attention === 'ask' || it.attention === 'question' || it.attention === 'later'
  const pinned = it.pin && ctx.column === it.pin
  const columns = PIN_COLUMNS.map(id => ({ id: `col:${id}`, label: t(`col.${id}`), checked: ctx.column === id, dot: COLUMN_COLOR[id] }))
  if (pinned) columns.push(SEP, { id: `col:${it.auto}`, label: t('chip.auto'), hint: t(`col.${it.auto}`) })
  return tidy([
    { id: 'open', label: t('menu.open'), hint: 'Enter' },
    { id: 'focus', label: t(it.sleeping ? 'menu.wakeFocus' : 'menu.focus'), ...herdr() },
    // Looking needs no fresh data; typing and opening a shell wait for it in the window itself.
    ctx.terminal && (it.cwd || it.pane) && { id: 'terminal', label: t('term.open'), hint: 'Ctrl+`' },
    { id: 'write', label: t('menu.write'), ...(it.pane ? {} : { disabled: true, reason: t('err.noPane') }) },
    it.sleeping
      ? { id: 'wake', label: t('sheet.wake'), ...herdr() }
      : claude && { id: 'sleep', label: t('card.sleep'), ...herdr(turn ? { disabled: true, reason: t('sheet.sleepBusy') } : {}) },
    { id: 'rename', label: t('menu.rename'), hint: 'F2', ...edit() },
    SEP,
    { id: 'category', label: t('menu.category'), ...edit(), submenu: ctx.canEdit ? (ctx.categories ?? []).map(c => ({ id: `cat:${c.id}`, label: c.title, checked: c.id === ctx.category, swatch: c.color })) : null },
    { id: 'status', label: t('menu.status'), ...edit(), submenu: ctx.canEdit ? columns : null },
    dismissable && { id: 'dismiss', label: t(it.attention === 'later' ? 'asked.seen' : 'card.noReply'), ...edit() },
    SEP,
    it.cwd && { id: 'reveal', label: t('menu.openFolder'), ...edit() },
    it.cwd && { id: 'changes', label: t('changes.open') },
    claude && { id: 'history', label: t('history.open') },
    SEP,
    it.cwd && { id: 'newHere', label: t('menu.newHere'), ...herdr() },
    SEP,
    {
      id: 'copy',
      label: t('menu.copy'),
      submenu: [
        { id: 'copy:name', label: t('menu.copyName') },
        it.cwd && { id: 'copy:cwd', label: t('menu.copyPath') },
        claude && { id: 'copy:session', label: t('menu.copySession') },
        it.pane && { id: 'copy:pane', label: t('menu.copyPane') },
      ].filter(Boolean),
    },
    SEP,
    { id: 'clear', label: t('menu.clear'), danger: true, ...edit() },
  ])
}

/** A lane's menu: new sessions there, its category, the filter. */
export function laneMenu(cat, ctx) {
  const { t } = ctx
  const herdr = ctx.canMutate ? {} : { disabled: true, reason: ctx.canEdit ? t('mobile.readOnly') : t('live.off') }
  const only = ctx.filter === cat.id
  return tidy([
    { id: 'new', label: t('menu.newIn', { lane: cat.title }), hint: 'Shift+N', ...herdr },
    { id: 'newWorkspace', label: t('menu.newWorkspace'), ...herdr },
    SEP,
    { id: 'editCat', label: t('menu.editCat', { lane: cat.title }), ...(ctx.canEdit ? {} : { disabled: true, reason: t('live.off') }) },
    only ? { id: 'showAll', label: t('menu.showAll') } : { id: 'showOnly', label: t('menu.showOnly', { lane: cat.title }) },
  ])
}

/** The board's own menu, on empty space. */
export function boardMenu(ctx) {
  const { t } = ctx
  const herdr = ctx.canMutate ? {} : { disabled: true, reason: ctx.canEdit ? t('mobile.readOnly') : t('live.off') }
  return tidy([
    { id: 'new', label: t('menu.new'), hint: 'Shift+N', ...herdr },
    { id: 'newWorkspace', label: t('menu.newWorkspace'), ...herdr },
    SEP,
    { id: 'cats', label: t('menu.cats') },
    { id: 'sleepers', label: t('tb.sleepersTitle'), checked: ctx.sleepers },
    ctx.filter !== 'all' && { id: 'showAll', label: t('menu.showAll') },
    { id: 'search', label: t('menu.search'), hint: '/' },
  ])
}

/** A starting or failed new session's menu. */
export function launchMenu(l, ctx) {
  const { t } = ctx
  const herdr = ctx.canMutate ? {} : { disabled: true, reason: t('mobile.readOnly') }
  return tidy([
    l.state === 'trust' && { id: 'trust', label: t('launch.trust.go'), ...herdr },
    l.state === 'trust' && { id: 'closeTab', label: t('launch.trust.close'), ...herdr },
    l.state === 'trust' && SEP,
    l.pane && { id: 'focus', label: t('menu.focus'), ...herdr },
    // A launch that failed only at its first message has a running session: a retry would start a second one.
    l.state === 'failed' && l.kind !== 'message' && { id: 'retry', label: t('launch.retry') },
    l.state === 'failed' && { id: 'copyError', label: t('launch.copyError') },
    SEP,
    { id: 'copy:cwd', label: t('menu.copyPath') },
    SEP,
    { id: 'dismiss', label: t(l.state === 'failed' ? 'launch.dismiss' : 'launch.forget') },
  ])
}

/** A file or folder chip in the conversation: the quick look's own actions, and copying the path. */
export function chipMenu(chip, ctx) {
  const { t } = ctx
  const edit = ctx.canEdit ? {} : { disabled: true, reason: t('live.off') }
  return tidy([
    { id: 'look', label: t('menu.quickLook'), hint: 'Enter' },
    { id: 'open', label: t('ql.open'), ...edit },
    { id: 'reveal', label: t('ql.reveal'), ...edit },
    SEP,
    { id: 'copyPath', label: t('ql.copy') },
    chip.dir && { id: 'newHere', label: t('menu.newHere'), ...(ctx.canMutate ? {} : { disabled: true, reason: t('mobile.readOnly') }) },
  ])
}

/**
 * Whether a right click there keeps the browser's own menu: in fields, on selected text, on
 * links. Shift+right click always does (the way out to copy, paste and the inspector).
 */
export function wantsNativeMenu({ shift = false, editable = false, inSelection = false, link = false }) {
  return shift || editable || inSelection || link
}
