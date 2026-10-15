// Times for the board's scheduler, in local time: when a one-off reminder is due ("in 30m",
// "at 15:30", "tomorrow 9:00", "fri 17:00", "2026-10-20 14:00") and when a cron schedule
// (5 fields, or @daily and the like) runs next.

const UNIT_MS = { s: 1e3, m: 60e3, h: 3600e3, d: 86400e3, w: 604800e3 }
const UNIT_WORDS = [
  [/^(s|secs?|seconds?)$/, 's'],
  [/^(m|mins?|minutes?)$/, 'm'],
  [/^(h|hrs?|hours?)$/, 'h'],
  [/^(d|days?)$/, 'd'],
  [/^(w|wks?|weeks?)$/, 'w'],
]
const DAY_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']
const MONTH_NAMES = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
// A date without a time of day: the morning, so "tomorrow" does not ring at midnight.
const MORNING = { h: 9, min: 0 }

/** "1h30m", "90 min", "2 hours", "1.5h" in milliseconds, or null. */
export function parseDuration(text) {
  let rest = String(text ?? '').trim()
  let ms = 0
  let any = false
  while (rest) {
    const m = /^(\d+(?:[.,]\d+)?)\s*([a-z]+)\s*(?:and\s+|,\s*)?/.exec(rest)
    const unit = m && UNIT_WORDS.find(([re]) => re.test(m[2]))?.[1]
    if (!unit) return null
    ms += Number(m[1].replace(',', '.')) * UNIT_MS[unit]
    any = true
    rest = rest.slice(m[0].length)
  }
  return any ? Math.round(ms) : null
}

/** "15:30", "9.05", "3pm", "3:30pm"; a bare hour ("9") only when `bare` (it followed "at"). */
function clockOf(word, bare) {
  const m = /^(\d{1,2})(?:[:.h](\d{2})(?::(\d{2}))?)?(am|pm)?$/.exec(word)
  if (!m || (m[2] === undefined && !m[4] && !bare)) return null
  let h = Number(m[1])
  const min = m[2] === undefined ? 0 : Number(m[2])
  if (m[4]) {
    if (h < 1 || h > 12) return null
    h = (h % 12) + (m[4] === 'pm' ? 12 : 0)
  }
  return h > 23 || min > 59 ? null : { h, min }
}

/** today = 0, tomorrow = 1, a weekday = { dow }, else null. */
function dayOf(word) {
  if (word === 'today' || word === 'tonight') return 0
  if (word === 'tomorrow' || word === 'tmrw') return 1
  const dow = DAY_NAMES.indexOf(word.slice(0, 3))
  return dow >= 0 && /^[a-z]{3,9}$/.test(word) && (word.length === 3 || DAY_FULL[dow].startsWith(word)) ? { dow } : null
}
const DAY_FULL = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']

const at = (base, dayOffset, { h, min }) => new Date(base.getFullYear(), base.getMonth(), base.getDate() + dayOffset, h, min).getTime()

/**
 * When a reminder is due, in ms, or null when `text` is not a time. A time of day alone is its
 * next occurrence (tomorrow when it has passed today); everything else is taken as written, so
 * the caller checks that it is in the future.
 */
export function parseWhen(text, now = Date.now()) {
  const s = String(text ?? '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/(\d) (am|pm)\b/g, '$1$2')
    .trim()
  if (!s) return null
  let m = /^(?:in|\+) ?(.+)$/.exec(s)
  if (m) {
    const ms = parseDuration(m[1])
    return ms === null ? null : now + ms
  }
  // An ISO time with its own zone is a moment as it is.
  if (/^\d{4}-\d{2}-\d{2}t\d{2}:\d{2}(:\d{2}(\.\d+)?)?(z|[+-]\d{2}:?\d{2})$/.test(s)) {
    const ms = Date.parse(s.toUpperCase())
    return Number.isNaN(ms) ? null : ms
  }
  m = /^(\d{4})-(\d{2})-(\d{2})(?:[ t](?:at )?(.+))?$/.exec(s)
  if (m) {
    const clock = m[4] ? clockOf(m[4], true) : MORNING
    if (!clock) return null
    const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), clock.h, clock.min)
    // 2026-02-30 rolls over in Date: not a date.
    return d.getMonth() === Number(m[2]) - 1 && d.getDate() === Number(m[3]) ? d.getTime() : null
  }
  let day = null
  let clock = null
  let prev = ''
  for (const word of s.split(' ')) {
    if (['at', 'on', 'next', 'this'].includes(word)) {
      prev = word
      continue
    }
    const d = day === null ? dayOf(word) : null
    const c = d === null && !clock ? clockOf(word, prev === 'at') : null
    if (d !== null) day = d
    else if (c) clock = c
    else return null
    prev = word
  }
  const base = new Date(now)
  if (day === null) {
    if (!clock) return null
    const today = at(base, 0, clock)
    return today > now ? today : at(base, 1, clock)
  }
  if (typeof day === 'number') return day === 0 && !clock ? null : at(base, day, clock ?? MORNING)
  // A weekday: the next one, today included while its time is still ahead.
  const ahead = (day.dow - base.getDay() + 7) % 7
  const time = at(base, ahead, clock ?? MORNING)
  return time > now ? time : at(base, ahead + 7, clock ?? MORNING)
}

// ---------------------------------------------------------------- cron

const MACROS = {
  '@yearly': '0 0 1 1 *',
  '@annually': '0 0 1 1 *',
  '@monthly': '0 0 1 * *',
  '@weekly': '0 0 * * 0',
  '@daily': '0 0 * * *',
  '@midnight': '0 0 * * *',
  '@hourly': '0 * * * *',
}
const FIELDS = [
  { name: 'minute', min: 0, max: 59 },
  { name: 'hour', min: 0, max: 23 },
  { name: 'day of month', min: 1, max: 31 },
  { name: 'month', min: 1, max: 12, names: MONTH_NAMES, base: 1 },
  { name: 'day of week', min: 0, max: 7, names: DAY_NAMES, base: 0 },
]

function fieldValue(token, f) {
  if (/^\d+$/.test(token)) {
    const v = Number(token)
    if (v < f.min || v > f.max) throw new Error(`${f.name} ${v} is out of range ${f.min}-${f.max}`)
    return v
  }
  const i = f.names?.indexOf(token.slice(0, 3)) ?? -1
  if (i < 0 || token.length < 3) throw new Error(`bad ${f.name} "${token}"`)
  return i + f.base
}

function fieldSet(text, f) {
  const set = new Set()
  for (const item of text.split(',')) {
    const m = /^(\*|[a-z0-9]+(?:-[a-z0-9]+)?)(?:\/(\d+))?$/.exec(item)
    if (!m) throw new Error(`bad ${f.name} "${item}"`)
    // "*" for the day of week is 0-6: 7 is Sunday again.
    let lo = f.min
    let hi = f.name === 'day of week' ? 6 : f.max
    if (m[1] !== '*') {
      const [a, b] = m[1].split('-')
      lo = fieldValue(a, f)
      // "5/15": from 5 to the end, every 15.
      hi = b !== undefined ? fieldValue(b, f) : m[2] ? f.max : lo
    }
    const step = m[2] === undefined ? 1 : Number(m[2])
    if (!step) throw new Error(`bad step in ${f.name} "${item}"`)
    if (lo > hi) throw new Error(`bad range in ${f.name} "${item}"`)
    for (let v = lo; v <= hi; v += step) set.add(f.name === 'day of week' && v === 7 ? 0 : v)
  }
  return set
}

/** A cron schedule: 5 fields (minute hour day-of-month month day-of-week) or a macro. Throws on a bad one. */
export function parseCron(text) {
  const expr = String(text ?? '').trim().toLowerCase().replace(/\s+/g, ' ')
  const parts = (MACROS[expr] ?? expr).split(' ')
  if (parts.length !== 5 || !parts[0]) {
    throw new Error(`a cron schedule has 5 fields (minute hour day-of-month month day-of-week), "${expr}" has ${parts[0] ? parts.length : 0}`)
  }
  const [minute, hour, dom, month, dow] = parts.map((p, i) => fieldSet(p, FIELDS[i]))
  // As in cron: with both days restricted, either one matches.
  return { expr, minute, hour, dom, month, dow, anyDom: parts[2].startsWith('*'), anyDow: parts[4].startsWith('*') }
}

function dayMatches(c, d) {
  const dom = c.dom.has(d.getDate())
  const dow = c.dow.has(d.getDay())
  if (c.anyDom && c.anyDow) return true
  if (c.anyDom) return dow
  if (c.anyDow) return dom
  return dom || dow
}

const HORIZON_MS = 8 * 366 * 86400e3

/** The first run strictly after `after` (ms), or null when it never runs (Feb 30). */
export function nextRun(cron, after) {
  const c = typeof cron === 'string' ? parseCron(cron) : cron
  const d = new Date(after)
  d.setSeconds(0, 0)
  d.setMinutes(d.getMinutes() + 1)
  while (d.getTime() - after < HORIZON_MS) {
    const was = d.getTime()
    // Whole months, days and hours are skipped in local time; a DST change cannot stall it.
    if (!c.month.has(d.getMonth() + 1)) {
      d.setMonth(d.getMonth() + 1, 1)
      d.setHours(0, 0, 0, 0)
    } else if (!dayMatches(c, d)) {
      d.setDate(d.getDate() + 1)
      d.setHours(0, 0, 0, 0)
    } else if (!c.hour.has(d.getHours())) {
      d.setHours(d.getHours() + 1, 0, 0, 0)
    } else if (!c.minute.has(d.getMinutes())) {
      d.setMinutes(d.getMinutes() + 1, 0, 0)
    } else {
      return d.getTime()
    }
    if (d.getTime() <= was) d.setTime(was + 60_000)
  }
  return null
}

/** How many runs fall in [from, to], counting at most `cap`. */
export function countRuns(cron, from, to, cap = 9999) {
  const c = typeof cron === 'string' ? parseCron(cron) : cron
  let n = 0
  for (let at = nextRun(c, from - 1); at !== null && at <= to && n < cap; at = nextRun(c, at)) n++
  return n
}
