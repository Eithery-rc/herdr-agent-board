import { test } from 'node:test'
import assert from 'node:assert/strict'
import { project, Spring } from '../web/spring.js'
import {
  atFit,
  clampView,
  EDGE_RESPONSE,
  fitView,
  fixedPoint,
  glide,
  GLIDE_RESPONSE,
  hardView,
  isDoubleTap,
  MAX_ZOOM,
  panBounds,
  pinchView,
  pixelated,
  softScale,
  softView,
  stepScale,
  toggleView,
  unsoftScale,
  wheelPan,
  wheelZoom,
  zoomAt,
  zoomInScale,
  zoomLimits,
  zoomTo,
} from '../web/zoom-model.js'

// A 1900 × 993 screenshot in the quick look's stage on a laptop.
const shot = { w: 1900, h: 993 }
const stage = { w: 1032, h: 780, pad: 24 }
const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} ≈ ${b}`)
/** The image point (in image pixels) under stage point `p`. */
const under = (v, p) => ({ x: (p.x - v.x) / v.s, y: (p.y - v.y) / v.s })

test('fit shows the whole image inside the margin, never above 100%; the limit is eight times the pixels', () => {
  const { fit, max } = zoomLimits(shot, stage)
  near(fit, (1032 - 48) / 1900)
  assert.equal(max, MAX_ZOOM)
  // A small image keeps its own size, and can still be zoomed up to fill the window twice over.
  const icon = zoomLimits({ w: 16, h: 16 }, stage)
  assert.equal(icon.fit, 1)
  near(icon.max, 2 * (780 - 48) / 16)
})

test('a fitted image sits in the middle, like the CSS layout it takes over from', () => {
  const v = fitView(shot, stage)
  near(v.x, 24)
  near(v.y, (780 - 993 * v.s) / 2)
  assert.ok(atFit(v.s, zoomLimits(shot, stage).fit))
  assert.ok(atFit(v.s * 1.005, v.s), 'a hair off fit is still fit')
  assert.ok(!atFit(v.s * 1.05, v.s))
})

test('a zoomed image moves from edge to edge, each edge stopping at the margin; an axis that fits stays centred', () => {
  const b = panBounds(1, shot, stage)
  assert.deepEqual(b, { minX: 1032 - 24 - 1900, maxX: 24, minY: 780 - 24 - 993, maxY: 24 })
  const wide = panBounds(0.6, shot, stage)
  near(wide.minY, (780 - 993 * 0.6) / 2)
  assert.equal(wide.minY, wide.maxY)
  assert.deepEqual(clampView({ s: 1, x: 500, y: -5000 }, shot, stage), { s: 1, x: 24, y: 780 - 24 - 993 })
})

test('zooming around a point keeps the part of the image under it in place', () => {
  const v = fitView(shot, stage)
  const p = { x: 700, y: 300 }
  const z = zoomAt(v, 3, p)
  near(under(z, p).x, under(v, p).x)
  near(under(z, p).y, under(v, p).y)
  // Within the limits and the edges: the scale is capped, the image stays in.
  const far = zoomTo(v, 40, p, shot, stage)
  assert.equal(far.s, MAX_ZOOM)
  assert.deepEqual(far, clampView(far, shot, stage))
  assert.equal(zoomTo(v, 0.01, p, shot, stage).s, v.s)
})

test('a double-click zooms in to 100% at the spot, and back to fit from any zoom', () => {
  const v = fitView(shot, stage)
  const p = { x: 600, y: 400 }
  const z = toggleView(v, p, shot, stage)
  assert.equal(z.s, 1)
  near(under(z, p).x, under(v, p).x)
  near(under(z, p).y, under(v, p).y)
  assert.deepEqual(toggleView(z, p, shot, stage), v)
  // A click in the margin does not pull the image's edge away from it.
  const corner = toggleView(v, { x: 5, y: 100 }, shot, stage)
  assert.equal(corner.x, 24)
  assert.equal(corner.y, 24)
})

test('in from fit goes to 100%, or to twice fit when 100% would hardly show a difference', () => {
  assert.equal(zoomInScale({ fit: 0.5, max: 8 }), 1)
  assert.equal(zoomInScale({ fit: 0.66, max: 8 }), 1)
  near(zoomInScale({ fit: 0.8, max: 8 }), 1.6)
  assert.equal(zoomInScale({ fit: 1, max: 8 }), 2)
  assert.equal(zoomInScale({ fit: 1, max: 1.5 }), 1.5)
})

test('+ and − step through round scales, fit and the limit included, and stop there', () => {
  const lim = { fit: 0.52, max: 8 }
  const up = [lim.fit]
  while (up.at(-1) < lim.max) up.push(stepScale(up.at(-1), 1, lim))
  assert.deepEqual(up, [0.52, 0.75, 1, 1.5, 2, 3, 4, 6, 8])
  assert.equal(stepScale(8, 1, lim), 8)
  assert.equal(stepScale(1, -1, lim), 0.75)
  assert.equal(stepScale(0.75, -1, lim), 0.52)
  assert.equal(stepScale(0.52, -1, lim), 0.52)
  // From between two stops, the next one in that direction.
  assert.equal(stepScale(1.2, 1, lim), 1.5)
  assert.equal(stepScale(1.2, -1, lim), 1)
})

test('past fit or the limit a pinch follows ever more slowly, and the inverse finds the fingers again', () => {
  const lo = 0.5
  const hi = 8
  assert.equal(softScale(2, lo, hi), 2)
  let last = lo
  for (const raw of [0.45, 0.3, 0.1, 0.01]) {
    const s = softScale(raw, lo, hi)
    assert.ok(s < last && s > lo / 2, `${raw} → ${s}`)
    near(unsoftScale(s, lo, hi), raw, 1e-9 * raw + 1e-12)
    last = s
  }
  assert.ok(softScale(100, lo, hi) < hi * 2)
  near(unsoftScale(softScale(12, lo, hi), lo, hi), 12, 1e-9)
})

test('dragged past an edge the image follows less and less; a grab mid-bounce starts where the finger would be', () => {
  const b = panBounds(1, shot, stage)
  const raw = { s: 1, x: b.maxX + 300, y: b.minY - 120 }
  const shown = softView(raw, shot, stage)
  assert.ok(shown.x > b.maxX && shown.x < b.maxX + 300)
  assert.ok(shown.y < b.minY && shown.y > b.minY - 120)
  const back = hardView(shown, shot, stage)
  near(back.x, raw.x, 1e-6)
  near(back.y, raw.y, 1e-6)
  // Within the edges nothing changes either way.
  const inside = { s: 1, x: -100, y: -50 }
  assert.deepEqual(softView(inside, shot, stage), inside)
  assert.deepEqual(hardView(inside, shot, stage), inside)
})

test('a pinch keeps the image point between the fingers between them, as they spread and move', () => {
  const start = fitView(shot, stage)
  const c0 = { x: 400, y: 300 }
  const c = { x: 460, y: 280 }
  const v = pinchView(start, start.s * 2.5, c0, c)
  near(v.s, start.s * 2.5)
  near(under(v, c).x, under(start, c0).x)
  near(under(v, c).y, under(start, c0).y)
})

test('a zoom animates around the one point that takes the image from where it is to where it goes', () => {
  const a = { s: 3, x: -2000, y: -900 }
  const b = fitView(shot, stage)
  const p = fixedPoint(a, b)
  const end = zoomAt(a, b.s, p)
  near(end.x, b.x, 1e-6)
  near(end.y, b.y, 1e-6)
  // Halfway in log scale the image is between the two, in scale and in place.
  const half = zoomAt(a, Math.sqrt(a.s * b.s), p)
  assert.ok(half.x > a.x && half.x < b.x)
  // The same scale has no such point: that is a plain move.
  assert.equal(fixedPoint(a, { ...a, x: 0 }), null)
})

test('a flick glides to where a scroll view would stop it, and bounces at an edge it runs into', () => {
  const free = glide(-300, 500, -900, 24)
  assert.equal(free.edge, null)
  near(free.to, -300 + project(500, 0.998))
  assert.equal(free.response, GLIDE_RESPONSE)
  // Too strong: it glides towards the projection and turns at the edge.
  const hard = glide(-300, 3000, -900, 24)
  assert.equal(hard.edge, 24)
  assert.ok(hard.to > 24)
  // Let go past an edge: back to it on a spring, whatever the flick.
  assert.deepEqual(glide(60, 400, -900, 24), { to: 24, response: EDGE_RESPONSE, edge: null })
  assert.deepEqual(glide(60, 0, -900, 24), { to: 24, response: EDGE_RESPONSE, edge: null })
  // From past an edge, thrown back in hard enough, it glides in.
  assert.equal(glide(60, -1500, -900, 24).edge, null)
  // Centred on an axis, a flick still answers: out and back.
  assert.deepEqual(glide(100, 500, 100, 100), { to: 100, response: EDGE_RESPONSE, edge: null })
})

test('the glide spring decelerates exactly like a scroll view: no push after the release, no overshoot', () => {
  const v0 = 1200
  const end = project(v0, 0.998)
  const s = new Spring({ value: 0, damping: 1, response: GLIDE_RESPONSE })
  s.target = end
  s.velocity = v0
  const lambda = -Math.log(0.998) * 1000
  let last = v0
  for (let t = 1 / 60; t <= 2; t += 1 / 60) {
    s.step(1 / 60)
    assert.ok(s.velocity <= last + 1e-9, 'never speeds up')
    assert.ok(s.value <= end + 1e-6, 'never passes its rest point')
    near(s.value, end * (1 - Math.exp(-lambda * t)), end * 0.01)
    last = s.velocity
  }
})

test('Ctrl+wheel: a trackpad pinch follows as it comes, a mouse notch is one gentle step', () => {
  const pinch = wheelZoom({ deltaY: -6.5, deltaMode: 0 })
  near(pinch.factor, Math.exp(0.065))
  assert.equal(pinch.notch, false)
  const notch = wheelZoom({ deltaY: -100, deltaMode: 0 })
  near(notch.factor, Math.exp(0.25))
  assert.equal(notch.notch, true)
  assert.ok(wheelZoom({ deltaY: 120 }).factor < 1)
  assert.equal(wheelZoom({ deltaY: 3, deltaMode: 1 }).notch, true)
})

test('a plain wheel moves a zoomed image; Shift turns it sideways', () => {
  assert.deepEqual(wheelPan({ deltaX: 4, deltaY: -12 }), { dx: 4, dy: -12, notch: false })
  assert.deepEqual(wheelPan({ deltaY: 100, shiftKey: true }), { dx: 100, dy: 0, notch: true })
  assert.deepEqual(wheelPan({ deltaY: 3, deltaMode: 1 }), { dx: 0, dy: 48, notch: true })
  assert.equal(wheelPan({ deltaY: 1, deltaMode: 2 }, 700).dy, 700)
})

test('a double-tap is two taps close in time and place', () => {
  const a = { x: 100, y: 100, t: 1000 }
  assert.ok(isDoubleTap(a, { x: 110, y: 95, t: 1200 }))
  assert.ok(!isDoubleTap(a, { x: 110, y: 95, t: 1500 }))
  assert.ok(!isDoubleTap(a, { x: 200, y: 100, t: 1100 }))
  assert.ok(!isDoubleTap(null, a))
})

test('pixels turn into crisp squares from three device pixels each', () => {
  assert.ok(!pixelated(2, 1))
  assert.ok(pixelated(3, 1))
  assert.ok(pixelated(2, 1.5))
  assert.ok(!pixelated(1, 2))
})
