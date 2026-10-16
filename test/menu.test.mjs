import assert from 'node:assert/strict'
import { test } from 'node:test'
import { translator } from '../web/i18n.js'
import { boardMenu, cardMenu, chipMenu, firstIndex, laneMenu, lastIndex, launchMenu, nextIndex, placeMenu, placeSubmenu, shareReasons, tidy, typeahead, wantsNativeMenu } from '../web/menu-model.js'

const t = translator('en')
const vp = { width: 1000, height: 700 }

test('a menu opens down and right of the click, flips at the edges, and scrolls when taller than the window', () => {
  assert.deepEqual(placeMenu({ x: 100, y: 100 }, { width: 220, height: 300 }, vp), { x: 100, y: 100, originX: 'left', originY: 'top', maxHeight: 684 })
  // Near the right edge it opens to the left of the pointer, near the bottom above it.
  const corner = placeMenu({ x: 950, y: 650 }, { width: 220, height: 300 }, vp)
  assert.deepEqual([corner.x, corner.y, corner.originX, corner.originY], [730, 350, 'right', 'bottom'])
  // No room either way: pressed against the margin, never off screen.
  const wide = placeMenu({ x: 150, y: 20 }, { width: 900, height: 200 }, { width: 960, height: 700 })
  assert.equal(wide.x, 52)
  const tall = placeMenu({ x: 10, y: 300 }, { width: 200, height: 1200 }, vp)
  assert.deepEqual([tall.y, tall.maxHeight], [8, 684])
  for (const p of [{ x: 0, y: 0 }, { x: 999, y: 699 }, { x: 500, y: 350 }]) {
    const m = placeMenu(p, { width: 240, height: 320 }, vp)
    assert.ok(m.x >= 8 && m.x + 240 <= 992 && m.y >= 8 && m.y + 320 <= 692, JSON.stringify(p))
  }
})

test('a submenu opens beside its item, on the left when the right has no room, and moves up at the bottom', () => {
  const parent = { left: 100, right: 320, top: 50, bottom: 400 }
  const item = { top: 120, bottom: 144 }
  assert.deepEqual(placeSubmenu(item, parent, { width: 200, height: 150 }, vp), { x: 317, y: 115, side: 'right', maxHeight: 684 })
  const right = placeSubmenu(item, { left: 700, right: 920, top: 50, bottom: 400 }, { width: 200, height: 150 }, vp)
  assert.deepEqual([right.x, right.side], [503, 'left'])
  const low = placeSubmenu({ top: 640, bottom: 664 }, parent, { width: 200, height: 150 }, vp)
  assert.equal(low.y, 542)
})

test('keys move over separators and gray items, Home and End, and type to select', () => {
  const items = [{ label: 'Open' }, { separator: true }, { label: 'Sleep', disabled: true }, { label: 'Status' }, { label: 'Search' }, { label: 'Copy' }]
  assert.equal(firstIndex(items), 0)
  assert.equal(lastIndex(items), 5)
  assert.equal(nextIndex(items, 0, 1), 3)
  assert.equal(nextIndex(items, 3, -1), 0)
  assert.equal(nextIndex(items, 5, 1), 0) // wraps
  assert.equal(nextIndex([{ separator: true }], -1, 1), -1)
  assert.equal(typeahead(items, 's', -1), 3) // the gray "Sleep" is passed over
  assert.equal(typeahead(items, 's', 3), 4) // the same letter again: the next one
  assert.equal(typeahead(items, 'ss', 4), 3)
  assert.equal(typeahead(items, 'se', 3), 4)
  assert.equal(typeahead(items, 'x', 3), 3)
})

test('a shared reason goes under the menu once; separators only between groups', () => {
  const r = shareReasons([{ label: 'A', disabled: true, reason: 'stale' }, { label: 'B', disabled: true, reason: 'stale' }, { label: 'C', disabled: true, reason: 'own' }])
  assert.equal(r.note, 'stale')
  assert.deepEqual(r.items.map(i => i.reason), ['', '', 'own'])
  assert.equal(shareReasons([{ label: 'A', disabled: true, reason: 'one' }]).note, '')
  const sep = { separator: true }
  assert.deepEqual(tidy([sep, { label: 'A' }, sep, sep, false, { label: 'B' }, sep]), [{ label: 'A' }, sep, { label: 'B' }])
})

const categories = [{ id: 'acme', title: 'Acme', color: '#007AFF' }, { id: 'other', title: 'Other', color: '#8E8E93' }]
const ids = items => items.filter(i => !i.separator).map(i => i.id)
const find = (items, id) => items.find(i => i.id === id)
const idle = { key: 's1', session: 's1', pane: 'w1:p1', name: 'acme', cwd: 'C:\\Acme', status: 'idle', column: 'idle', auto: 'idle', category: 'acme' }
const fresh = { t, canMutate: true, canEdit: true, categories, column: 'idle', category: 'acme' }

test('a card’s menu follows its state', () => {
  const m = cardMenu(idle, fresh)
  assert.deepEqual(ids(m), ['open', 'focus', 'write', 'sleep', 'rename', 'category', 'status', 'reveal', 'changes', 'history', 'newHere', 'copy', 'clear'])
  assert.equal(find(m, 'category').submenu.find(c => c.checked).id, 'cat:acme')
  assert.deepEqual(find(m, 'status').submenu.map(c => c.id), ['col:me', 'col:ext', 'col:done', 'col:idle'])
  assert.deepEqual(find(m, 'copy').submenu.map(c => c.id), ['copy:name', 'copy:cwd', 'copy:session', 'copy:pane'])

  // Working: it cannot sleep, and says why.
  const working = cardMenu({ ...idle, status: 'working', column: 'work' }, { ...fresh, column: 'work' })
  assert.equal(find(working, 'sleep').disabled, true)
  assert.match(find(working, 'sleep').reason, /working/)
  // Asleep: wake instead of sleep, and going there wakes it.
  const asleep = cardMenu({ ...idle, sleeping: true, status: 'sleeping' }, fresh)
  assert.ok(find(asleep, 'wake') && !find(asleep, 'sleep'))
  assert.match(find(asleep, 'focus').label, /Wake/)
  // A question it asked can be waved off; a pinned card can go back to Auto.
  assert.ok(find(cardMenu({ ...idle, attention: 'question', column: 'me' }, fresh), 'dismiss'))
  const pinned = cardMenu({ ...idle, pin: 'done', column: 'done', auto: 'idle' }, { ...fresh, column: 'done' })
  assert.equal(find(pinned, 'status').submenu.at(-1).id, 'col:idle')
  assert.equal(find(pinned, 'status').submenu.at(-1).label, 'Auto')
  // The terminal, where the board offers one: looking needs no fresh data, so it is never gray.
  assert.deepEqual(ids(cardMenu(idle, { ...fresh, terminal: true })).slice(0, 3), ['open', 'focus', 'terminal'])
  assert.equal(find(cardMenu(idle, { ...fresh, terminal: true, canMutate: false }), 'terminal').disabled, undefined)
  assert.ok(!find(cardMenu({ ...idle, cwd: '', pane: null }, { ...fresh, terminal: true }), 'terminal'))
  // Not a Claude session (no id): no sleep, no history, no session id to copy.
  const other = cardMenu({ ...idle, session: null, key: 'pane-w1:p2' }, fresh)
  assert.ok(!find(other, 'sleep') && !find(other, 'history'))
  assert.ok(!find(other, 'copy').submenu.some(c => c.id === 'copy:session'))
})

test('stale herdr data grays what goes through herdr, with the reason once; offline grays card edits too', () => {
  const stale = cardMenu(idle, { ...fresh, canMutate: false })
  for (const id of ['focus', 'sleep', 'newHere']) assert.equal(find(stale, id).disabled, true, id)
  for (const id of ['open', 'rename', 'category', 'status', 'clear', 'copy']) assert.ok(!find(stale, id).disabled, id)
  const { note } = shareReasons(stale)
  assert.match(note, /fresh data from herdr/)
  const offline = cardMenu(idle, { ...fresh, canMutate: false, canEdit: false })
  for (const id of ['rename', 'category', 'status', 'clear']) assert.equal(find(offline, id).disabled, true, id)
  assert.equal(find(offline, 'category').submenu, null)
  assert.ok(!find(offline, 'open').disabled && !find(offline, 'copy').disabled)
})

test('lanes, the board, starting sessions and file chips have menus of their own', () => {
  const lane = laneMenu(categories[0], { ...fresh, filter: 'all' })
  assert.deepEqual(ids(lane), ['new', 'newWorkspace', 'editCat', 'showOnly'])
  assert.match(find(lane, 'new').label, /Acme/)
  assert.deepEqual(ids(laneMenu(categories[0], { ...fresh, filter: 'acme' })).at(-1), 'showAll')
  assert.equal(find(laneMenu(categories[0], { ...fresh, canMutate: false, filter: 'all' }), 'new').disabled, true)
  assert.deepEqual(ids(boardMenu({ ...fresh, filter: 'all', sleepers: true })), ['new', 'newWorkspace', 'cats', 'sleepers', 'search'])
  assert.equal(find(boardMenu({ ...fresh, filter: 'acme', sleepers: false }), 'sleepers').checked, false)
  assert.deepEqual(ids(launchMenu({ state: 'failed', pane: 'w1:p3' }, fresh)), ['focus', 'retry', 'copyError', 'copy:cwd', 'dismiss'])
  assert.deepEqual(ids(launchMenu({ state: 'starting', pane: null }, fresh)), ['copy:cwd', 'dismiss'])
  assert.deepEqual(ids(chipMenu({ dir: true }, fresh)), ['look', 'open', 'reveal', 'copyPath', 'newHere'])
  assert.deepEqual(ids(chipMenu({ dir: false }, fresh)), ['look', 'open', 'reveal', 'copyPath'])
})

test('the browser keeps its own menu in fields, on selected text, on links, and with Shift', () => {
  assert.equal(wantsNativeMenu({}), false)
  for (const k of ['shift', 'editable', 'inSelection', 'link']) assert.equal(wantsNativeMenu({ [k]: true }), true, k)
})
