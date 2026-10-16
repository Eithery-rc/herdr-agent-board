import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  clampFloat,
  defaultFloat,
  dockAt,
  dockFromThrow,
  dockZone,
  DOCK_HOLD,
  dockSize,
  flicksAway,
  floatLanding,
  foldsAway,
  keyFloat,
  keySize,
  MARGIN,
  MIN,
  offRect,
  overFor,
  overlays,
  rectFor,
  resizeFloat,
  restoreLayout,
  roomFor,
  serializeLayout,
  sizeLimits,
  snap,
  soft,
} from '../web/panel-layout.js'

const vp = { w: 1600, h: 1000 }
const fresh = { dock: 'right', side: null, bottom: null, float: null }

test('the panel lands on whole device pixels, so its text stays sharp', () => {
  assert.equal(snap(813.8), 814)
  assert.equal(snap(813.3, 1.25), 813.6) // 1017 device pixels
  assert.equal(snap(813.3, 1.5) * 1.5, 1220)
  assert.equal(snap(-0.4), -0)
})

test('size limits leave the board its room and never invert in a small window', () => {
  assert.deepEqual(sizeLimits('right', vp), { min: 360, max: 1200 })
  assert.deepEqual(sizeLimits('left', { w: 1000, h: 800 }), { min: 360, max: 1000 - 320 })
  assert.deepEqual(sizeLimits('bottom', vp), { min: 320, max: 1000 - 180 })
  const tiny = { w: 700, h: 400 }
  for (const dock of ['right', 'bottom']) {
    const { min, max } = sizeLimits(dock, tiny)
    assert.ok(min <= max, dock)
  }
})

test('docked sizes: the viewer’s own within today’s limits, else the default', () => {
  assert.equal(dockSize(fresh, 'right', vp), 560)
  assert.equal(dockSize(fresh, 'bottom', vp), 420)
  assert.equal(dockSize({ ...fresh, side: 9000 }, 'left', vp), 1200)
  assert.equal(dockSize({ ...fresh, side: 100 }, 'right', vp), MIN.side)
  // A wide panel in a narrower window: shown smaller, kept as chosen for the next wide window.
  const wide = { ...fresh, side: 900 }
  assert.equal(dockSize(wide, 'right', { w: 1000, h: 800 }), 1000 - 320)
  assert.equal(wide.side, 900)
})

test('rectangles per dock, flush with the window like a sidebar, and the way in and out along the same edge', () => {
  assert.deepEqual(rectFor(fresh, vp), { x: 1600 - 560, y: 0, w: 560, h: 1000 })
  assert.deepEqual(rectFor({ ...fresh, dock: 'left' }, vp), { x: 0, y: 0, w: 560, h: 1000 })
  assert.deepEqual(rectFor({ ...fresh, dock: 'bottom' }, vp), { x: 0, y: 1000 - 420, w: 1600, h: 420 })
  const right = rectFor(fresh, vp)
  assert.ok(offRect('right', right).x >= vp.w)
  const left = rectFor({ ...fresh, dock: 'left' }, vp)
  assert.ok(offRect('left', left).x + left.w <= 0)
  const bottom = rectFor({ ...fresh, dock: 'bottom' }, vp)
  assert.ok(offRect('bottom', bottom).y >= vp.h)
  assert.deepEqual(offRect('float', right), right)
})

test('a side panel the window has no room for lies over the board, still docked, and keeps the toolbar clear', () => {
  const laptop = { w: 1440, h: 900 }
  assert.equal(overlays(fresh, laptop), true)
  assert.deepEqual(rectFor(fresh, laptop), { x: 1440 - 560, y: 0, w: 560, h: 900 })
  assert.deepEqual(rectFor({ ...fresh, dock: 'left' }, laptop), { x: 0, y: 0, w: 560, h: 900 })
  assert.deepEqual(overFor(fresh, laptop), { left: 0, right: 572 })
  assert.deepEqual(overFor({ ...fresh, dock: 'left' }, laptop), { left: 572, right: 0 })
  assert.equal(overlays(fresh, vp), false)
  assert.deepEqual(overFor(fresh, vp), { left: 0, right: 0 })
  assert.equal(overlays({ ...fresh, dock: 'bottom' }, laptop), false)
  assert.equal(overlays({ ...fresh, dock: 'float' }, laptop), false)
})

test('the board makes room without collapsing columns at modest desktop widths', () => {
  assert.deepEqual(roomFor(fresh, { ...vp, w: 1440 }), { left: 0, right: 0, bottom: 0 })
  assert.deepEqual(roomFor(fresh, { ...vp, w: 1800 }), { left: 0, right: 560, bottom: 0 })
  assert.deepEqual(roomFor({ ...fresh, dock: 'left' }, { ...vp, w: 1440 }), { left: 0, right: 0, bottom: 0 })
  assert.deepEqual(roomFor({ ...fresh, dock: 'left' }, { ...vp, w: 1800 }), { left: 560, right: 0, bottom: 0 })
  assert.deepEqual(roomFor(fresh, { ...vp, w: 1520 }), { left: 0, right: 0, bottom: 0 })
  assert.deepEqual(roomFor(fresh, { ...vp, w: 1521 }), { left: 0, right: 560, bottom: 0 })
  assert.deepEqual(roomFor({ ...fresh, dock: 'bottom', bottom: 400 }, vp), { left: 0, right: 0, bottom: 400 })
  assert.deepEqual(roomFor({ ...fresh, dock: 'float' }, vp), { left: 0, right: 0, bottom: 0 })
})

test('floating panels stay whole inside the window', () => {
  const r = clampFloat({ x: 1500, y: -50, w: 5000, h: 100 }, vp)
  assert.deepEqual(r, { x: 12, y: 12, w: 1576, h: MIN.h })
  const d = defaultFloat(vp)
  assert.ok(d.x >= MARGIN && d.x + d.w <= vp.w - MARGIN && d.y >= MARGIN && d.y + d.h <= vp.h - MARGIN)
  assert.deepEqual(rectFor({ ...fresh, dock: 'float', float: { x: 2000, y: 2000, w: 500, h: 600 } }, vp), { x: 1600 - 12 - 500, y: 1000 - 12 - 600, w: 500, h: 600 })
})

test('soft limits: inside 1:1, past them less and less', () => {
  const lim = { min: 360, max: 900 }
  assert.equal(soft(500, lim), 500)
  const a = soft(1000, lim) - 900
  const b = soft(1200, lim) - 900
  assert.ok(a > 0 && a < 100 && b > a && b - a < 100)
  assert.ok(soft(200, lim) < 360 && soft(200, lim) > 200)
})

test('the dock zones are easy to hit and the preview holds steady at their line', () => {
  assert.deepEqual(dockZone(vp), { x: 160, y: 120 })
  assert.deepEqual(dockZone({ w: 600, h: 400 }), { x: 72, y: 72 })
  // Held still: where the pointer is.
  assert.equal(dockAt({ x: 1460, y: 500 }, { x: 0, y: 0 }, vp), 'right')
  assert.equal(dockAt({ x: 1420, y: 500 }, { x: 0, y: 0 }, vp), null)
  assert.equal(dockAt({ x: 120, y: 500 }, { x: 0, y: 0 }, vp), 'left')
  assert.equal(dockAt({ x: 800, y: 900 }, { x: 0, y: 0 }, vp), 'bottom')
  assert.equal(dockAt({ x: 800, y: 20 }, { x: 0, y: 0 }, vp), null)
  // Shown, a dock stays until the pointer is clearly out of its zone.
  assert.equal(dockAt({ x: 1420, y: 500 }, { x: 0, y: 0 }, vp, 'right'), 'right')
  assert.equal(dockAt({ x: 1600 - 160 - DOCK_HOLD - 2, y: 500 }, { x: 0, y: 0 }, vp, 'right'), null)
  // Moving, the pointer is carried only a short way: a wobble near the line does not flip it.
  assert.equal(dockAt({ x: 1400, y: 500 }, { x: 300, y: 0 }, vp), null)
  assert.equal(dockAt({ x: 1400, y: 500 }, { x: 800, y: 0 }, vp), 'right')
})

test('a panel lands where the preview shows; without one a throw docks where the pointer would come to rest', () => {
  assert.equal(dockFromThrow({ x: 900, y: 500 }, { x: -3000, y: 0 }, vp, 'right'), 'right')
  assert.equal(dockFromThrow({ x: 1590, y: 500 }, { x: 0, y: 0 }, vp), 'right')
  assert.equal(dockFromThrow({ x: 900, y: 500 }, { x: 0, y: 0 }, vp), null)
  // Thrown from the middle: the projection reaches the edge.
  assert.equal(dockFromThrow({ x: 900, y: 500 }, { x: 2000, y: 0 }, vp), 'right')
  assert.equal(dockFromThrow({ x: 700, y: 500 }, { x: -2000, y: 100 }, vp), 'left')
  assert.equal(dockFromThrow({ x: 800, y: 700 }, { x: 0, y: 1500 }, vp), 'bottom')
  // Upwards: the toolbar's edge, no dock.
  assert.equal(dockFromThrow({ x: 800, y: 300 }, { x: 0, y: -3000 }, vp), null)
  // A corner goes to the edge reached furthest.
  assert.equal(dockFromThrow({ x: 1500, y: 900 }, { x: 1000, y: 200 }, vp), 'right')
  assert.equal(dockFromThrow({ x: 1500, y: 900 }, { x: 100, y: 1200 }, vp), 'bottom')
})

test('a floating panel let go glides a little and stays inside', () => {
  const r = { x: 400, y: 200, w: 480, h: 600 }
  assert.deepEqual(floatLanding(r, { x: 0, y: 0 }, vp), r)
  const glide = floatLanding(r, { x: 1000, y: 0 }, vp)
  assert.ok(glide.x > 400 && glide.x < 600)
  assert.equal(floatLanding(r, { x: 0, y: 30000 }, vp).y, vp.h - MARGIN - 600)
})

test('flicks away and folds away by projection', () => {
  assert.equal(flicksAway(300, 0, 560), true)
  assert.equal(flicksAway(100, 0, 560), false)
  assert.equal(flicksAway(100, 1200, 560), true)
  assert.equal(flicksAway(300, -1500, 560), false)
  assert.equal(foldsAway(170, 0, 360), true)
  assert.equal(foldsAway(300, 0, 360), false)
  assert.equal(foldsAway(300, -500, 360), true)
})

test('resizing a floating panel keeps the opposite edges and softens past the limits', () => {
  const r = { x: 400, y: 200, w: 480, h: 600 }
  assert.deepEqual(resizeFloat(r, 'se', 40, 30, vp), { x: 400, y: 200, w: 520, h: 630 })
  const nw = resizeFloat(r, 'nw', 40, 30, vp)
  assert.equal(nw.x + nw.w, 880)
  assert.equal(nw.y + nw.h, 800)
  const squeezed = resizeFloat(r, 'w', 400, 0, vp)
  assert.ok(squeezed.w < MIN.w && MIN.w - squeezed.w < (MIN.w - 80) / 2)
  assert.equal(squeezed.x + squeezed.w, 880)
  // Past the window's edge it resists too.
  const out = resizeFloat(r, 'e', 2000, 0, vp)
  assert.ok(out.x + out.w > vp.w - MARGIN && out.x + out.w < vp.w - MARGIN + 400)
})

test('keyboard resizing grows towards the board and stops at the limits', () => {
  const lim = sizeLimits('right', vp)
  assert.equal(keySize('right', 560, 'ArrowLeft', false, lim), 576)
  assert.equal(keySize('right', 560, 'ArrowRight', true, lim), 496)
  assert.equal(keySize('left', 560, 'ArrowRight', false, lim), 576)
  assert.equal(keySize('bottom', 400, 'ArrowUp', false, sizeLimits('bottom', vp)), 416)
  assert.equal(keySize('right', 370, 'ArrowRight', true, lim), 360)
  assert.equal(keySize('right', 560, 'End', false, lim), 1200)
  assert.equal(keySize('right', 560, 'Home', false, lim), 360)
  assert.equal(keySize('right', 560, 'ArrowUp', false, lim), null)
  assert.deepEqual(keyFloat({ x: 100, y: 100, w: 480, h: 600 }, 'ArrowRight', false, vp), { x: 100, y: 100, w: 496, h: 600 })
  assert.equal(keyFloat({ x: 100, y: 100, w: 480, h: 600 }, 'a', false, vp), null)
})

test('the layout survives storage, and garbage falls back field by field', () => {
  const mine = { dock: 'float', side: 720, bottom: 380, float: { x: 300, y: 140, w: 520, h: 640 } }
  assert.deepEqual(restoreLayout(serializeLayout(mine)), mine)
  assert.deepEqual(restoreLayout(null), fresh)
  assert.deepEqual(restoreLayout('{oops'), fresh)
  assert.deepEqual(restoreLayout('42'), fresh)
  assert.deepEqual(restoreLayout(JSON.stringify({ dock: 'top', side: -5, bottom: '300', float: { x: 1, y: 2, w: 'w', h: 4 } })), fresh)
  assert.deepEqual(restoreLayout(JSON.stringify({ dock: 'left', side: 611.6 })), { ...fresh, dock: 'left', side: 612 })
})
