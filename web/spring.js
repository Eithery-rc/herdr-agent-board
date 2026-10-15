// Springs in Apple's two designer parameters: damping ratio (1 = no overshoot, < 1 bounces)
// and response (seconds to get there; not a duration). A spring always starts from where the
// value is now and keeps its velocity when retargeted, so any motion can be grabbed and
// reversed mid-flight without a jump. One shared requestAnimationFrame loop drives them all.

export const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)')

const active = new Set()
let frame = 0
let last = 0

function loop(now) {
  const dt = Math.min(0.064, (now - (last || now)) / 1000)
  last = now
  for (const s of [...active]) s.step(dt)
  frame = active.size ? requestAnimationFrame(loop) : 0
  if (!frame) last = 0
}

export class Spring {
  constructor({ value = 0, damping = 1, response = 0.35, precision = 0.01, onUpdate = () => {}, onRest = () => {} } = {}) {
    this.value = value
    this.target = value
    this.velocity = 0
    this.precision = precision
    this.onUpdate = onUpdate
    this.onRest = onRest
    this.configure({ damping, response })
  }

  configure({ damping = this.damping, response = this.response }) {
    this.damping = damping
    this.response = response
    this.stiffness = (2 * Math.PI / response) ** 2
    this.friction = (4 * Math.PI * damping) / response
    return this
  }

  /** Head for `target` from the current value; `velocity` (units/s) hands over a gesture's speed. */
  to(target, { velocity, damping, response } = {}) {
    if (damping !== undefined || response !== undefined) this.configure({ damping, response })
    if (velocity !== undefined) this.velocity = velocity
    this.target = target
    if (reducedMotion.matches) return this.set(target)
    active.add(this)
    if (!frame) frame = requestAnimationFrame(loop)
    return this
  }

  /** Jump there, no motion (a 1:1 drag, or reduced motion). */
  set(value) {
    active.delete(this)
    this.value = this.target = value
    this.velocity = 0
    this.onUpdate(value)
    this.onRest(value)
    return this
  }

  stop() {
    active.delete(this)
    return this
  }

  get moving() {
    return active.has(this)
  }

  step(dt) {
    // Semi-implicit Euler in small fixed steps: stable for stiff, quick springs.
    for (let left = dt; left > 0; left -= 1 / 240) {
      const h = Math.min(left, 1 / 240)
      const force = -this.stiffness * (this.value - this.target) - this.friction * this.velocity
      this.velocity += force * h
      this.value += this.velocity * h
    }
    if (Math.abs(this.velocity) < this.precision * 10 && Math.abs(this.value - this.target) < this.precision) {
      active.delete(this)
      this.value = this.target
      this.velocity = 0
      this.onUpdate(this.value)
      this.onRest(this.value)
      return
    }
    this.onUpdate(this.value)
  }
}

/** Where a flick would come to rest (Apple's projection, the scroll-view deceleration curve). */
export function project(velocity, decelerationRate = 0.998) {
  return ((velocity / 1000) * decelerationRate) / (1 - decelerationRate)
}

/** Soft limit: the further past the edge, the less the element follows. */
export function rubberband(overshoot, dimension, constant = 0.55) {
  return (overshoot * dimension * constant) / (dimension + constant * Math.abs(overshoot))
}

/** Velocity (px/s) from the last ~100 ms of pointer samples [{ x, y, t }]. */
export function velocityOf(samples) {
  const lastSample = samples.at(-1)
  if (!lastSample) return { x: 0, y: 0 }
  const first = samples.find(s => lastSample.t - s.t <= 100) ?? lastSample
  const dt = (lastSample.t - first.t) / 1000
  return dt > 0 ? { x: (lastSample.x - first.x) / dt, y: (lastSample.y - first.y) / dt } : { x: 0, y: 0 }
}
