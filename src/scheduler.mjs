// Runs the schedule (schedule.mjs) in the board's process: when an entry is due, its text goes
// into the session's prompt as "[board reminder] <text>", waking the session first when
// herdr-wake put it to sleep. A session that works or waits on a dialog is not interrupted: it
// gets the text once it is free, tried on every tick, up to `scheduleWaitMin` minutes of trying;
// then the run is logged as missed. A one-off entry goes after its run; a cron one moves to its
// next time.
//
// Runs that came due while the board was off: a one-off is sent once, saying how late it is; the
// missed runs of a cron entry go as one, saying how many. Time the board was off does not count
// against the wait. An entry is claimed in its file before it is sent, so a second board (a
// restart that overlaps, a test copy) never sends the same run twice.
import { mkdirSync, watch } from 'node:fs'
import { send } from './actions.mjs'
import { t } from './lang.mjs'
import { busy, collect, forgetSleepers } from './model.mjs'
import { listEntries, logRun, removeEntry, SCHEDULE_DIR, updateEntry } from './schedule.mjs'
import { countRuns, nextRun } from './when.mjs'
import { longWhen, span } from '../web/when.js'

// A run on its way (waking a session takes up to three minutes) holds its claim this long.
const CLAIM_MS = 5 * 60_000
// Later than this, the prompt says by how much.
const LATE_MS = 2 * 60_000

/** What the session gets: "[board reminder] text", with a note when it is late or stands for several runs. */
export function promptOf(entry, now) {
  const notes = []
  if (entry.cron) {
    const runs = countRuns(entry.cron, entry.next, now)
    if (runs > 1) notes.push(t('sched.prompt.runs', { n: runs, since: longWhen(entry.next, t, now) }))
  } else if (now - entry.next > LATE_MS) {
    notes.push(t('sched.prompt.late', { late: span(now - entry.next, t), due: longWhen(entry.next, t, now) }))
  }
  // The tag stays in English: the hook knows a board prompt by it (hook.mjs).
  const tag = entry.cron ? `board schedule ${entry.id}: ${entry.cron}` : 'board reminder'
  return `[${tag}${notes.length ? `; ${notes.join('; ')}` : ''}] ${entry.text}`
}

/**
 * Start sending due entries. `cfg` is the live config: scheduleTickSec (15), scheduleWaitMin
 * (240). Returns { tick, stop }.
 */
export function startScheduler({ cfg, log = () => {}, onChange = () => {} }) {
  const tickMs = () => Math.max(0.1, cfg.scheduleTickSec ?? 15) * 1000
  const patience = () => (cfg.scheduleWaitMin ?? 240) * 60_000
  const flying = new Set() // sessions with a run on its way: one at a time per session
  let timer = null
  let ticking = false
  let stopped = false

  async function tick() {
    if (ticking || stopped) return
    ticking = true
    try {
      const now = Date.now()
      // A run that waits for its session is tried again once a tick, not on every file change.
      const due = listEntries().filter(e => e.next <= now && !flying.has(e.key) && !(e.tried > now - tickMs() * 0.9))
      if (!due.length) return
      // Fresh: whether a session sleeps or works decides what happens now.
      const items = await collect(cfg)
      for (const entry of due) {
        if (flying.has(entry.key)) continue
        flying.add(entry.key)
        run(entry, items.find(i => i.key === entry.key))
          .catch(err => log(`schedule ${entry.id}: ${err.message}`))
          .finally(() => {
            flying.delete(entry.key)
            onChange()
          })
      }
    } catch (err) {
      log(`schedule: ${err.message}`)
    } finally {
      ticking = false
    }
  }

  async function run(entry, item) {
    const now = Date.now()
    // A sleeping session is woken by send(); one at work or at a dialog is left alone.
    let why = !item ? 'gone' : !item.sleeping && busy(item.status) ? 'busy' : ''
    if (!why) {
      if (!claim(entry.id, now)) return
      const r = await send(cfg, item, promptOf(entry, Date.now()), { idle: true })
      if (item.sleeping) forgetSleepers()
      if (r.ok) return sent(entry)
      why = r.busy ? 'busy' : r.error
    }
    wait(entry, now, why)
  }

  /** Taken for this process, unless another board holds a fresh claim or it was handled already. */
  function claim(id, now) {
    return !!updateEntry(id, e => {
      if (e.next > now) return undefined
      if (e.claim && e.claim.pid !== process.pid && now - e.claim.at < CLAIM_MS) return undefined
      return { ...e, claim: { pid: process.pid, at: now } }
    })
  }

  function sent(entry) {
    const now = Date.now()
    if (entry.cron) updateEntry(entry.id, e => settle(e, now, { lastRun: now, runs: (e.runs ?? 0) + 1 }))
    else removeEntry(entry.id)
    logRun(record(entry, now, 'sent'))
  }

  const record = (entry, at, result, why) => ({ id: entry.id, key: entry.key, name: entry.name, text: entry.text, cron: entry.cron, due: entry.next, at, result, why })

  /** Not sent this time: try again on the next tick, or log it as missed once the wait is over. */
  function wait(entry, now, why) {
    // Only time spent trying counts: a gap (the board was off) is not waiting.
    const step = entry.tried ? Math.min(now - entry.tried, 2 * tickMs() + 5000) : 0
    const waited = (entry.waited ?? 0) + step
    if (waited < patience()) {
      updateEntry(entry.id, e => ({ ...e, pendingSince: e.pendingSince ?? now, tried: now, waited, why, claim: undefined }))
      return
    }
    if (entry.cron) updateEntry(entry.id, e => settle(e, now, { missed: (e.missed ?? 0) + 1 }))
    else removeEntry(entry.id)
    logRun(record(entry, now, 'missed', why))
  }

  /** A cron entry after a run: its next time, the waiting fields cleared. */
  function settle(e, now, counts) {
    const { pendingSince, tried, waited, why, claim, ...rest } = e
    const next = nextRun(e.cron, now)
    return next === null ? null : { ...rest, ...counts, next }
  }

  // The next tick comes at the soonest due time, or after tickMs at the latest.
  function plan(ms) {
    clearTimeout(timer)
    if (!stopped) timer = setTimeout(loop, Math.max(50, ms))
  }
  async function loop() {
    await tick()
    const now = Date.now()
    const soonest = Math.min(...listEntries().map(e => (e.next <= now ? Infinity : e.next)))
    plan(Math.min(tickMs(), soonest - now + 50))
  }
  // A new entry may be due sooner than the next tick.
  let watchTimer = null
  try {
    mkdirSync(SCHEDULE_DIR, { recursive: true })
    watch(SCHEDULE_DIR, () => {
      clearTimeout(watchTimer)
      watchTimer = setTimeout(() => plan(0), 300)
    })
  } catch {}
  plan(1000)

  return {
    tick,
    stop() {
      stopped = true
      clearTimeout(timer)
    },
  }
}
