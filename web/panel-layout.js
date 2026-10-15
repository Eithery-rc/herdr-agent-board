// Where the side panel sits and how big it is: plain geometry, shared by the page (panel.js) and
// the tests. A panel docks right, left or at the bottom, where the board makes room for it, or
// floats over the board. Rectangles are { x, y, w, h } in CSS pixels of the window `vp` ({ w, h }).
import { project, rubberband } from './spring.js'

export const DOCKS = ['right', 'left', 'bottom', 'float']
/** The panel's inset from the window's edges. */
export const MARGIN = 12
/** A docked panel leaves the board at least this much: width beside it, height above it. */
export const BOARD_MIN = { w: 320, h: 180 }
export const MIN = { side: 360, bottom: 320, w: 360, h: 440 }
export const MAX_SIDE = 1200
/** Sizes before the viewer picks one: bottom is a share of the window's height. */
export const DEFAULT = { side: 560, bottom: 0.42, w: 480, h: 680 }

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))
const finite = v => typeof v === 'number' && Number.isFinite(v)

/** Smallest and largest size (width beside, height at the bottom) of a panel docked at `dock`. */
export function sizeLimits(dock, vp) {
  if (dock === 'bottom') return { min: MIN.bottom, max: Math.max(MIN.bottom, vp.h - 2 * MARGIN - BOARD_MIN.h) }
  return { min: MIN.side, max: Math.max(MIN.side, Math.min(MAX_SIDE, vp.w - 2 * MARGIN - BOARD_MIN.w)) }
}

export function floatLimits(vp) {
  return { minW: MIN.w, minH: MIN.h, maxW: Math.max(MIN.w, vp.w - 2 * MARGIN), maxH: Math.max(MIN.h, vp.h - 2 * MARGIN) }
}

/** The size docked at `dock`: the viewer's own, else the default, within today's limits. */
export function dockSize(layout, dock, vp) {
  const { min, max } = sizeLimits(dock, vp)
  const own = dock === 'bottom' ? layout.bottom : layout.side
  return clamp(own ?? (dock === 'bottom' ? Math.round(vp.h * DEFAULT.bottom) : DEFAULT.side), min, max)
}

/** A docked panel's rectangle at `size`, unlimited: a drag shows sizes past the limits, softened. */
export function dockRect(dock, size, vp) {
  if (dock === 'left') return { x: MARGIN, y: MARGIN, w: size, h: vp.h - 2 * MARGIN }
  if (dock === 'bottom') return { x: MARGIN, y: vp.h - MARGIN - size, w: vp.w - 2 * MARGIN, h: size }
  return { x: vp.w - MARGIN - size, y: MARGIN, w: size, h: vp.h - 2 * MARGIN }
}

/** A floating panel, whole and inside the window. */
export function clampFloat(r, vp) {
  const lim = floatLimits(vp)
  const w = clamp(r.w, lim.minW, lim.maxW)
  const h = clamp(r.h, lim.minH, lim.maxH)
  return { x: clamp(r.x, MARGIN, vp.w - MARGIN - w), y: clamp(r.y, MARGIN, vp.h - MARGIN - h), w, h }
}

/** A floating panel before the viewer has placed one: by the right edge, below the toolbar's controls. */
export function defaultFloat(vp) {
  const w = DEFAULT.w
  const h = Math.min(DEFAULT.h, vp.h - 176)
  return clampFloat({ x: vp.w - w - 48, y: 152, w, h }, vp)
}

/** Where the panel rests for `layout` ({ dock, side, bottom, float }). */
export function rectFor(layout, vp) {
  if (layout.dock === 'float') return clampFloat(layout.float ?? defaultFloat(vp), vp)
  return dockRect(layout.dock, dockSize(layout, layout.dock, vp), vp)
}

/** Where a docked panel comes in from and leaves to: just past its own edge. A floating one fades in place. */
export function offRect(dock, r) {
  if (dock === 'left') return { ...r, x: r.x - r.w - 32 }
  if (dock === 'bottom') return { ...r, y: r.y + r.h + 32 }
  if (dock === 'float') return { ...r }
  return { ...r, x: r.x + r.w + 32 }
}

/** The room the board leaves a docked panel, per side. A floating one gets none: it floats over. */
export function roomFor(layout, vp) {
  const room = { left: 0, right: 0, bottom: 0 }
  if (layout.dock !== 'float') room[layout.dock] = dockSize(layout, layout.dock, vp) + MARGIN
  return room
}

/** The way a docked panel leaves (a unit vector); a phone's sheet leaves to the right. */
export function outward(dock) {
  if (dock === 'left') return { x: -1, y: 0 }
  if (dock === 'bottom') return { x: 0, y: 1 }
  return { x: 1, y: 0 }
}

/** A size past its limits, softened: the further past, the less it follows. */
export function soft(size, { min, max }, dimension = 400) {
  if (size < min) return min + rubberband(size - min, dimension)
  if (size > max) return max + rubberband(size - max, dimension)
  return size
}

/**
 * A position or size on whole device pixels. The panel is its own compositor layer: placed
 * between pixels (a drag leaves it at 813.8px), its text is resampled and looks blurred.
 */
export function snap(v, dpr = 1) {
  return Math.round(v * dpr) / dpr
}

/** Let go `offset` px along its way out at `velocity` px/s: does the flick carry it past half its size? */
export function flicksAway(offset, velocity, size) {
  return offset + project(velocity) > size / 2
}

/** Its edge dragged (or flung) to less than half the smallest size: the panel folds away, like a sidebar. */
export function foldsAway(size, velocity, min) {
  return size + project(velocity) < min / 2
}

/**
 * The dock a panel lands in when let go with the pointer at `at` ({ x, y }) moving at `v` (px/s):
 * where the pointer would come to rest, if that is within `zone` of an edge or past it; the edge
 * reached furthest wins a corner. Null: it floats. The top edge belongs to the toolbar.
 */
export function dockFromThrow(at, v, vp, zone = 36) {
  const x = at.x + project(v.x)
  const y = at.y + project(v.y)
  const reach = { right: x - (vp.w - zone), left: zone - x, bottom: y - (vp.h - zone) }
  let best = null
  for (const dock of ['right', 'left', 'bottom']) if (reach[dock] >= 0 && (best === null || reach[dock] > reach[best])) best = dock
  return best
}

/** Where a floating panel let go at `r` with velocity `v` comes to rest: a short glide, inside the window. */
export function floatLanding(r, v, vp) {
  return clampFloat({ ...r, x: r.x + project(v.x, 0.99), y: r.y + project(v.y, 0.99) }, vp)
}

/**
 * A floating panel resized from `r` by its `edge` (n, s, e, w, or a corner: ne, nw, se, sw)
 * dragged (dx, dy). The opposite edges stay put; sizes past the limits or the window soften.
 */
export function resizeFloat(r, edge, dx, dy, vp) {
  const lim = floatLimits(vp)
  let { x, y, w, h } = r
  if (edge.includes('e')) w = soft(r.w + dx, { min: lim.minW, max: Math.max(lim.minW, vp.w - MARGIN - r.x) })
  if (edge.includes('w')) {
    w = soft(r.w - dx, { min: lim.minW, max: Math.max(lim.minW, r.x + r.w - MARGIN) })
    x = r.x + r.w - w
  }
  if (edge.includes('s')) h = soft(r.h + dy, { min: lim.minH, max: Math.max(lim.minH, vp.h - MARGIN - r.y) })
  if (edge.includes('n')) {
    h = soft(r.h - dy, { min: lim.minH, max: Math.max(lim.minH, r.y + r.h - MARGIN) })
    y = r.y + r.h - h
  }
  return { x, y, w, h }
}

/** Keys on a docked panel's edge: the size they ask for, or null. Arrows grow towards the board; Shift takes bigger steps. */
export function keySize(dock, size, key, shift, { min, max }) {
  const step = shift ? 64 : 16
  const grow = { right: 'ArrowLeft', left: 'ArrowRight', bottom: 'ArrowUp' }[dock]
  const shrink = { right: 'ArrowRight', left: 'ArrowLeft', bottom: 'ArrowDown' }[dock]
  if (key === grow) return clamp(size + step, min, max)
  if (key === shrink) return clamp(size - step, min, max)
  if (key === 'Home') return min
  if (key === 'End') return max
  return null
}

/** Arrows on a floating panel's corner: wider, narrower, taller, shorter. Null for other keys. */
export function keyFloat(r, key, shift, vp) {
  const step = shift ? 64 : 16
  const d = { ArrowRight: [step, 0], ArrowLeft: [-step, 0], ArrowDown: [0, step], ArrowUp: [0, -step] }[key]
  return d ? clampFloat({ ...r, w: r.w + d[0], h: r.h + d[1] }, vp) : null
}

/** The viewer's layout from storage. Whatever cannot be read falls back to the default, field by field. */
export function restoreLayout(raw) {
  let v = null
  try {
    v = JSON.parse(raw)
  } catch {}
  const size = n => (finite(n) && n > 0 ? Math.round(n) : null)
  const f = v?.float
  const float = f && [f.x, f.y, f.w, f.h].every(finite) && f.w > 0 && f.h > 0 ? { x: Math.round(f.x), y: Math.round(f.y), w: Math.round(f.w), h: Math.round(f.h) } : null
  return { dock: DOCKS.includes(v?.dock) ? v.dock : 'right', side: size(v?.side), bottom: size(v?.bottom), float }
}

export function serializeLayout(layout) {
  return JSON.stringify({ v: 1, dock: layout.dock, side: layout.side, bottom: layout.bottom, float: layout.float })
}
