// The quick look's zoom as plain geometry, shared by the page (zoom.js) and the tests. A view is
// { s, x, y }: the scale (CSS pixels per image pixel, 1 = 100%) and where the image's top left
// corner sits in the stage, in CSS pixels. An image has a `size` { w, h } in image pixels; the
// stage is { w, h, pad }, `pad` being the margin a fitted image keeps and a zoomed one can be
// dragged back to.
import { project, rubberband } from './spring.js'

/** The largest zoom: eight screen pixels to an image pixel (more for a tiny image). */
export const MAX_ZOOM = 8
/** What + and − step through, between fit and the largest zoom. */
const STOPS = [0.05, 0.1, 0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4, 6, 8, 12, 16, 24, 32, 48, 64]
/** How far past fit or the largest zoom a pinch still goes, in log scale: half or twice at most. */
const SOFT_SCALE = Math.LN2
/** A flick's glide decelerates like a scroll view's (Apple's normal deceleration rate). */
const DECELERATION = 0.998
/**
 * Aimed at the projected rest point from the release velocity, a critically damped spring of
 * this response decelerates exactly as that scroll does: e^(-λt) with λ = −ln(rate) per second.
 */
export const GLIDE_RESPONSE = (2 * Math.PI) / (-Math.log(DECELERATION) * 1000)
/** Back from past an edge, and the bounce at an edge a glide runs into. */
export const EDGE_RESPONSE = 0.4
export const DOUBLE_TAP = { ms: 320, px: 40 }

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))

/** Fit (never above 100%: a small image keeps its size) and the largest zoom. */
export function zoomLimits(size, stage) {
  const contain = Math.max(1e-3, Math.min((stage.w - 2 * stage.pad) / size.w, (stage.h - 2 * stage.pad) / size.h))
  return { fit: Math.min(1, contain), max: Math.max(MAX_ZOOM, contain * 2) }
}

/** Fitted, or within a hair of it: what a double-click zooms in from. */
export const atFit = (s, fit) => Math.abs(Math.log(s / fit)) < 0.01

/**
 * Where the image's corner may be at scale `s`: centred on an axis while the image fits it,
 * else anywhere from one edge to the other, each edge stopping at the margin.
 */
export function panBounds(s, size, stage) {
  const axis = (len, room) => {
    const w = len * s
    if (w <= room - 2 * stage.pad) return [(room - w) / 2, (room - w) / 2]
    return [room - stage.pad - w, stage.pad]
  }
  const [minX, maxX] = axis(size.w, stage.w)
  const [minY, maxY] = axis(size.h, stage.h)
  return { minX, maxX, minY, maxY }
}

export function clampView(v, size, stage) {
  const b = panBounds(v.s, size, stage)
  return { s: v.s, x: clamp(v.x, b.minX, b.maxX), y: clamp(v.y, b.minY, b.maxY) }
}

export const fitView = (size, stage) => clampView({ s: zoomLimits(size, stage).fit, x: 0, y: 0 }, size, stage)

/** Scale to `s` around stage point `p`: the part of the image under it stays under it. */
export function zoomAt(v, s, p) {
  const k = s / v.s
  return { s, x: p.x - (p.x - v.x) * k, y: p.y - (p.y - v.y) * k }
}

/** Zoom to `s` (kept within the limits) around `p`, then back within the edges. */
export function zoomTo(v, s, p, size, stage) {
  const { fit, max } = zoomLimits(size, stage)
  return clampView(zoomAt(v, clamp(s, fit, max), p), size, stage)
}

/** Where a click or double-tap zooms in to: 100%, or twice fit when 100% is hardly bigger. */
export function zoomInScale({ fit, max }) {
  return Math.min(max, fit * 1.5 <= 1 ? 1 : fit * 2)
}

/** A double-click or double-tap at `p`: in from fit, around the point; back to fit from any zoom. */
export function toggleView(v, p, size, stage) {
  const lim = zoomLimits(size, stage)
  return atFit(v.s, lim.fit) ? zoomTo(v, zoomInScale(lim), p, size, stage) : fitView(size, stage)
}

/** The next stop up (`dir` 1) or down (−1) from `s`, fit and the largest zoom included. */
export function stepScale(s, dir, { fit, max }) {
  const stops = [fit, ...STOPS.filter(z => z > fit * 1.01 && z < max / 1.01), max]
  return dir > 0 ? (stops.find(z => z > s * 1.01) ?? max) : (stops.findLast(z => z < s / 1.01) ?? fit)
}

/** Past fit or the largest zoom a pinch still follows, ever more slowly. */
export function softScale(s, lo, hi) {
  if (s < lo) return lo * Math.exp(rubberband(Math.log(s / lo), SOFT_SCALE))
  if (s > hi) return hi * Math.exp(rubberband(Math.log(s / hi), SOFT_SCALE))
  return s
}

/** The inverse of rubberband(): how far the finger is for the element to be `y` past the edge. */
export function unrubberband(y, dimension, constant = 0.55) {
  const a = Math.min(Math.abs(y), dimension * 0.999)
  return (Math.sign(y) * a * dimension) / (constant * (dimension - a))
}

export function unsoftScale(s, lo, hi) {
  if (s < lo) return lo * Math.exp(unrubberband(Math.log(s / lo), SOFT_SCALE))
  if (s > hi) return hi * Math.exp(unrubberband(Math.log(s / hi), SOFT_SCALE))
  return s
}

/** A dragged view past its edges, softened: the further out, the less it follows. */
export function softView(v, size, stage) {
  const b = panBounds(v.s, size, stage)
  const soft = (x, lo, hi, room) => (x < lo ? lo + rubberband(x - lo, room) : x > hi ? hi + rubberband(x - hi, room) : x)
  return { s: v.s, x: soft(v.x, b.minX, b.maxX, stage.w), y: soft(v.y, b.minY, b.maxY, stage.h) }
}

/** Where the finger would be for softView() to show `v`: a grab mid-bounce starts from there, without a jump. */
export function hardView(v, size, stage) {
  const b = panBounds(v.s, size, stage)
  const hard = (x, lo, hi, room) => (x < lo ? lo + unrubberband(x - lo, room) : x > hi ? hi + unrubberband(x - hi, room) : x)
  return { s: v.s, x: hard(v.x, b.minX, b.maxX, stage.w), y: hard(v.y, b.minY, b.maxY, stage.h) }
}

/**
 * The view while two fingers pinch, now at scale `s`: they started at `start` around `c0` and
 * are around `c` now. The image point that was under their centre stays under it.
 */
export function pinchView(start, s, c0, c) {
  const k = s / start.s
  return { s, x: c.x - (c0.x - start.x) * k, y: c.y - (c0.y - start.y) * k }
}

/**
 * The point a move from view `a` to view `b` scales around: zooming the scale alone (on a
 * spring, in log scale) around it lands exactly on `b`. Null when the scale stays the same.
 */
export function fixedPoint(a, b) {
  const r = b.s / a.s
  if (Math.abs(Math.log(r)) < 1e-3) return null
  return { x: (b.x - a.x * r) / (1 - r), y: (b.y - a.y * r) / (1 - r) }
}

/**
 * The motion of one axis after a release at `x` with velocity `v` (px/s), between `lo` and
 * `hi`: a glide to where the flick would come to rest; past an edge, back to it on a spring.
 * `edge` is set when the glide will run into one: there it turns into a bounce.
 */
export function glide(x, v, lo, hi) {
  const end = x + project(v, DECELERATION)
  if (end >= lo && end <= hi) return { to: end, response: GLIDE_RESPONSE, edge: null }
  const edge = end < lo ? lo : hi
  if ((edge === lo && x <= lo) || (edge === hi && x >= hi)) return { to: edge, response: EDGE_RESPONSE, edge: null }
  return { to: end, response: GLIDE_RESPONSE, edge }
}

/** The scale factor of a Ctrl+wheel (a trackpad pinch arrives as one); a mouse notch is one gentle step. */
export function wheelZoom({ deltaY, deltaMode = 0 }) {
  const px = deltaY * (deltaMode === 1 ? 16 : deltaMode === 2 ? 400 : 1)
  return { factor: Math.exp(-clamp(px, -25, 25) / 100), notch: deltaMode !== 0 || Math.abs(px) >= 50 }
}

/** How far a plain wheel moves a zoomed image; Shift turns a vertical wheel sideways. */
export function wheelPan({ deltaX = 0, deltaY = 0, deltaMode = 0, shiftKey = false }, page = 400) {
  const k = deltaMode === 1 ? 16 : deltaMode === 2 ? page : 1
  let dx = deltaX * k
  let dy = deltaY * k
  if (shiftKey && !dx) [dx, dy] = [dy, 0]
  return { dx, dy, notch: deltaMode !== 0 || Math.max(Math.abs(dx), Math.abs(dy)) >= 50 }
}

export function isDoubleTap(prev, tap) {
  return !!prev && tap.t - prev.t <= DOUBLE_TAP.ms && Math.hypot(tap.x - prev.x, tap.y - prev.y) <= DOUBLE_TAP.px
}

/** Image pixels as crisp squares once each covers three device pixels or more (raster images only). */
export const pixelated = (s, dpr = 1) => s * dpr >= 3
