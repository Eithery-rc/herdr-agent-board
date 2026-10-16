// Zoom for an image in the quick look, as in Preview and Photos: Ctrl+wheel or a trackpad pinch,
// two fingers on a phone, a click (a double-tap) into the spot and a double-click back to fit,
// + − 0 and the arrows from the keyboard. A zoomed image follows the mouse or the finger 1:1,
// glides on after a flick and resists past its edges; a plain wheel moves it. Every motion is a
// spring from where the image is now, so a new gesture takes it over midway. Reduced motion: no
// glide and no soft edges, every change at once.
import { reducedMotion, Spring, velocityOf } from './spring.js'
import {
  atFit,
  clampView,
  EDGE_RESPONSE,
  fitView,
  fixedPoint,
  glide,
  hardView,
  isDoubleTap,
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
} from './zoom-model.js'

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))
const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 })
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y)

/**
 * Make `img` zoomable inside `stage` (its positioned box, whose padding is the fitted margin);
 * `size` is the image's own size in pixels, `vector` keeps it smooth at any zoom. `onChange`
 * hears { s, fit, to } on every change: the scale shown, whether it is headed for fit, and
 * where a zoom in from fit goes.
 */
export function zoomImage(stage, img, { size, vector = false, onChange = () => {} }) {
  const measure = () => ({ w: stage.clientWidth, h: stage.clientHeight, pad: parseFloat(getComputedStyle(stage).paddingLeft) || 0 })
  const soft = () => !reducedMotion.matches
  let room = measure()
  let view = fitView(size, room)
  // Where the image is headed: the view itself at rest or under a finger, else the animation's
  // end, which wheel notches and keys add up from.
  let goal = view
  const limits = () => zoomLimits(size, room)

  stage.classList.add('zoomable')
  img.draggable = false

  function paint() {
    const dpr = devicePixelRatio || 1
    const px = v => Math.round(v * dpr) / dpr
    img.style.width = `${size.w * view.s}px`
    img.style.height = `${size.h * view.s}px`
    img.style.transform = `translate(${px(view.x)}px, ${px(view.y)}px)`
    img.classList.toggle('pixelated', !vector && pixelated(view.s, dpr))
    const lim = limits()
    const fit = atFit(goal.s, lim.fit)
    stage.dataset.zoom = fit ? 'fit' : 'in'
    onChange({ s: view.s, fit, to: zoomInScale(lim) })
  }

  // A zoom moves the scale on one spring, in log scale, around the point that takes the image
  // from where it is to where it goes; a pan or a glide moves each axis on its own spring, and a
  // glide that meets an edge turns there into a bounce.
  let zoomFrom = view
  let anchor = { x: 0, y: 0 }
  const zs = new Spring({
    precision: 0.0005,
    onUpdate: z => {
      view = zoomAt(zoomFrom, Math.exp(z), anchor)
      paint()
    },
  })
  const edges = { x: null, y: null }
  const axis = name =>
    new Spring({
      precision: 0.05,
      onUpdate: v => {
        view = { ...view, [name]: v }
        const edge = edges[name]
        if (edge && (v - edge.at) * edge.side > 0) {
          edges[name] = null
          springs[name].to(edge.at, { damping: 1, response: EDGE_RESPONSE })
        }
        paint()
      },
    })
  const springs = { x: axis('x'), y: axis('y') }

  function stop() {
    zs.stop()
    springs.x.stop()
    springs.y.stop()
    edges.x = edges.y = null
    goal = view
  }

  /** Head for `target` (within the limits) from wherever the image is now. */
  function animate(target, response = 0.4) {
    edges.x = edges.y = null
    goal = target
    const p = fixedPoint(view, target)
    if (!p) {
      zs.stop()
      for (const name of ['x', 'y']) {
        const s = springs[name]
        if (!s.moving) {
          s.value = view[name]
          s.velocity = 0
        }
        s.to(target[name], { damping: 1, response })
      }
      return
    }
    springs.x.stop()
    springs.y.stop()
    if (!zs.moving) {
      zs.value = Math.log(view.s)
      zs.velocity = 0
    }
    zoomFrom = view
    anchor = p
    zs.to(Math.log(target.s), { damping: 1, response })
  }

  /** Let go at velocity `v`: back within the limits, or a glide on from the flick. */
  function settle(v, center) {
    const lim = limits()
    if (view.s < lim.fit * 0.999 || view.s > lim.max * 1.001) {
      return animate(zoomTo(view, view.s, center ?? { x: room.w / 2, y: room.h / 2 }, size, room), EDGE_RESPONSE)
    }
    if (!soft()) v = { x: 0, y: 0 }
    const b = panBounds(view.s, size, room)
    zs.stop()
    const plan = { x: glide(view.x, v.x, b.minX, b.maxX), y: glide(view.y, v.y, b.minY, b.maxY) }
    goal = { s: view.s, x: clamp(plan.x.to, b.minX, b.maxX), y: clamp(plan.y.to, b.minY, b.maxY) }
    for (const name of ['x', 'y']) {
      const g = plan[name]
      edges[name] = g.edge === null ? null : { at: g.edge, side: g.to > g.edge ? 1 : -1 }
      springs[name].value = view[name]
      springs[name].to(g.to, { velocity: v[name], damping: 1, response: g.response })
    }
  }

  // ------------------------------------------------------------ pointers
  const pointers = new Map()
  let gesture = null
  let samples = []
  let press = null
  let lastTap = null

  /** A point in the stage's own pixels (the quick look may still be growing as it opens). */
  function local(e) {
    const r = stage.getBoundingClientRect()
    const k = r.width / stage.offsetWidth || 1
    return { x: (e.clientX - r.left) / k, y: (e.clientY - r.top) / k }
  }

  /** Start or restart the gesture from the fingers down now and the view as it is. */
  function begin() {
    const pts = [...pointers.values()]
    const start = soft() ? hardView(view, size, room) : view
    samples = []
    stage.classList.add('dragging')
    if (pts.length >= 2) {
      const lim = limits()
      press.pinched = true
      gesture = { pinch: true, start, raw: soft() ? unsoftScale(view.s, lim.fit, lim.max) : view.s, c0: mid(pts[0], pts[1]), d0: dist(pts[0], pts[1]) }
    } else gesture = { pinch: false, start, p0: pts[0] }
  }

  function follow(t) {
    const pts = [...pointers.values()]
    let next
    let at
    if (gesture.pinch) {
      const lim = limits()
      at = mid(pts[0], pts[1])
      const raw = gesture.raw * (gesture.d0 > 0 ? dist(pts[0], pts[1]) / gesture.d0 : 1)
      gesture.at = at
      next = pinchView(gesture.start, soft() ? softScale(raw, lim.fit, lim.max) : clamp(raw, lim.fit, lim.max), gesture.c0, at)
    } else {
      at = pts[0]
      next = { s: gesture.start.s, x: gesture.start.x + at.x - gesture.p0.x, y: gesture.start.y + at.y - gesture.p0.y }
    }
    samples.push({ ...at, t })
    if (samples.length > 12) samples.shift()
    view = goal = soft() ? softView(next, size, room) : clampView(next, size, room)
    paint()
  }

  // A finger catches a moving image as it lands. The mouse catches a glide too, but a zoom only
  // once it drags, so the second press of a double-click does not stop the zoom the first began.
  stage.addEventListener('pointerdown', e => {
    if (e.pointerType === 'mouse' && e.button !== 0) return
    e.preventDefault()
    stage.setPointerCapture(e.pointerId)
    const p = local(e)
    if (!pointers.size) press = { type: e.pointerType, x: p.x, y: p.y, t: e.timeStamp, moved: false, pinched: false }
    pointers.set(e.pointerId, p)
    if (e.pointerType !== 'mouse') {
      stop()
      begin()
    } else if (springs.x.moving || springs.y.moving) stop()
  })
  stage.addEventListener('pointermove', e => {
    if (!pointers.has(e.pointerId)) return
    const p = local(e)
    pointers.set(e.pointerId, p)
    if (!press.moved && Math.hypot(p.x - press.x, p.y - press.y) > (press.type === 'mouse' ? 3 : 10)) {
      press.moved = true
      if (!gesture) {
        stop()
        begin()
        // Counted from where the button went down: the point grabbed stays under the mouse.
        gesture.p0 = { x: press.x, y: press.y }
      }
    }
    if (gesture) follow(e.timeStamp)
  })
  function end(e) {
    if (!pointers.has(e.pointerId)) return
    const p = pointers.get(e.pointerId)
    pointers.delete(e.pointerId)
    // A finger left a pinch: the one still down goes on moving the image.
    if (pointers.size) return begin()
    const g = gesture
    gesture = null
    stage.classList.remove('dragging')
    // A mouse press that never dragged is a click (below), and leaves any motion running.
    if (!g) return
    const center = g.pinch ? (g.at ?? g.c0) : p
    if (e.type !== 'pointerup') return settle({ x: 0, y: 0 }, center)
    // Held still before letting go: no glide.
    samples.push({ ...(g.pinch ? center : local(e)), t: e.timeStamp })
    if (press.type !== 'mouse' && !press.moved && !press.pinched && e.timeStamp - press.t < 400) {
      const tap = { x: p.x, y: p.y, t: e.timeStamp }
      if (isDoubleTap(lastTap, tap)) {
        lastTap = null
        return animate(toggleView(goal, p, size, room), 0.42)
      }
      lastTap = tap
    }
    settle(velocityOf(samples), center)
  }
  stage.addEventListener('pointerup', end)
  stage.addEventListener('pointercancel', end)
  stage.addEventListener('lostpointercapture', end)

  // The mouse: a click zooms in from fit, a double-click goes back (the second click of the one
  // that zoomed in does nothing more). A drag is not a click.
  let clickedIn = false
  stage.addEventListener('click', e => {
    if (!press || press.type !== 'mouse' || press.moved) return
    const fit = atFit(goal.s, limits().fit)
    if (e.detail <= 1) {
      clickedIn = fit
      if (fit) animate(toggleView(goal, local(e), size, room), 0.42)
    } else if (e.detail === 2 && !clickedIn && !fit) animate(fitView(size, room), 0.42)
  })

  stage.addEventListener(
    'wheel',
    e => {
      e.preventDefault()
      if (gesture) return
      const p = local(e)
      if (e.ctrlKey) {
        const { factor, notch } = wheelZoom(e)
        if (notch) return animate(zoomTo(goal, goal.s * factor, p, size, room), 0.28)
        stop()
        view = goal = zoomTo(view, view.s * factor, p, size, room)
        return paint()
      }
      if (atFit(goal.s, limits().fit)) return
      const { dx, dy, notch } = wheelPan(e, room.h * 0.9)
      if (notch) return animate(clampView({ ...goal, x: goal.x - dx, y: goal.y - dy }, size, room), 0.28)
      stop()
      view = goal = clampView({ ...view, x: view.x - dx, y: view.y - dy }, size, room)
      paint()
    },
    { passive: false },
  )

  // Safari on a Mac sends a trackpad pinch as gesture events, not as a Ctrl+wheel. On an iPhone
  // the fingers are pointers already: there the events are only kept from zooming the page.
  let pinchStart = null
  function onGesture(e) {
    e.preventDefault()
    if (pointers.size) return
    if (e.type === 'gesturestart') {
      stop()
      pinchStart = { view, at: local(e) }
    } else if (e.type === 'gesturechange' && pinchStart) {
      view = goal = zoomTo(pinchStart.view, pinchStart.view.s * e.scale, pinchStart.at, size, room)
      paint()
    } else pinchStart = null
  }
  for (const type of ['gesturestart', 'gesturechange', 'gestureend']) stage.addEventListener(type, onGesture)

  // A new window size keeps a fitted image fitted, and a zoomed one on the same spot.
  const resize = new ResizeObserver(() => {
    const was = room
    const next = measure()
    if (!next.w || !next.h || (next.w === was.w && next.h === was.h && next.pad === was.pad)) return
    const fitted = atFit(goal.s, zoomLimits(size, was).fit)
    stop()
    room = next
    if (fitted) view = fitView(size, room)
    else {
      const lim = limits()
      const kept = zoomAt(view, clamp(view.s, lim.fit, lim.max), { x: was.w / 2, y: was.h / 2 })
      view = clampView({ s: kept.s, x: kept.x + (room.w - was.w) / 2, y: kept.y + (room.h - was.h) / 2 }, size, room)
    }
    goal = view
    paint()
  })
  resize.observe(stage)
  paint()

  const center = () => ({ x: room.w / 2, y: room.h / 2 })
  return {
    /** The zoom keys; true when the key was one of them. */
    key(e) {
      if (!stage.isConnected || e.altKey || gesture) return false
      const lim = limits()
      const k = e.key
      if (k === '+' || k === '=') animate(zoomTo(goal, stepScale(goal.s, 1, lim), center(), size, room), 0.3)
      else if (k === '-' || k === '_') animate(zoomTo(goal, stepScale(goal.s, -1, lim), center(), size, room), 0.3)
      else if (k === '0') animate(fitView(size, room), 0.4)
      else if (/^Arrow/.test(k) && !e.ctrlKey && !e.metaKey && !e.shiftKey && !atFit(goal.s, lim.fit)) {
        const dx = k === 'ArrowLeft' ? -1 : k === 'ArrowRight' ? 1 : 0
        const dy = k === 'ArrowUp' ? -1 : k === 'ArrowDown' ? 1 : 0
        animate(clampView({ ...goal, x: goal.x - dx * room.w * 0.2, y: goal.y - dy * room.h * 0.2 }, size, room), 0.3)
      } else return false
      return true
    },
    /** The footer's button: in from fit around the middle, else back to fit. */
    toggle: () => animate(toggleView(goal, center(), size, room), 0.42),
    destroy() {
      stop()
      resize.disconnect()
    },
  }
}
