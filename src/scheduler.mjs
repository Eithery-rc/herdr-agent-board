// Runs the schedule (schedule.mjs) in the board's process: when an entry is due, its text goes
// into the session's prompt as "[board reminder] <text>", waking the session first when
// herdr-wake put it to sleep. On time by default: a working session gets it queued into its turn.
// A session that waits on a dialog or has the user's unsent text in its input box (and, for an
// `idle` entry, one that works) gets it once it is free, tried on every tick, up to
// `scheduleWaitMin` minutes of trying; then the run is logged as missed. A one-off entry goes
// after its run; a cron one moves to its next time.
//
// Runs that came due while the board was off: a one-off is sent once, saying how late it is; the
// missed runs of a cron entry go as one, saying how many. Time the board was off does not count
// against the wait. An entry is claimed in its file before it is sent, so a second board (a
// restart that overlaps, a test copy) never sends the same run twice.
import { mkdirSync, watch } from 'node:fs'
import { send, wake } from './actions.mjs'
import { t } from './lang.mjs'
import { collect, forgetSleepers } from './model.mjs'
import { CALL_NOTE } from './notices.mjs'
import { getEntry, listEntries, logRun, removeEntry, SCHEDULE_DIR, updateEntry } from './schedule.mjs'
import { countRuns, nextRun } from './when.mjs'
import { callTitle } from '../web/notice-model.js'
import { longWhen, span } from '../web/when.js'

// A run on its way (waking a session takes up to three minutes) holds its claim this long.
const CLAIM_MS = 5 * 60_000
// Later than this, the prompt says by how much.
const LATE_MS = 2 * 60_000
// Sessions woken at once, so a board back after a night does not start every sleeper together.
const MAX_WAKING = 2
// A cron entry whose session is gone for this many runs in a row is dropped: it would wait and
// miss forever.
const GONE_RUNS = 3

/**
 * What the session gets: "[board reminder] text", with a note when it is late or stands for
 * several runs. A MokuPilot call's results (kind 'call') come as "[mokupilot call report]", the
 * report on lines of its own, and a closing note that they are for its information.
 */
export function promptOf(entry, now) {
  const notes = []
  if (entry.cron) {
    const runs = countRuns(entry.cron, entry.next, now)
    if (runs > 1) notes.push(t('sched.prompt.runs', { n: runs, since: longWhen(entry.next, t, now) }))
  } else if (now - entry.next > LATE_MS) {
    notes.push(t('sched.prompt.late', { late: span(now - entry.next, t), due: longWhen(entry.next, t, now) }))
  }
  // Set by another session, or for the one this pane held before /clear: the receiver judges it.
  const before = entry.movedFrom
  const setter = entry.from && entry.from.key !== (before?.key ?? entry.key) ? entry.from.name || entry.from.key.slice(0, 8) : ''
  if (before) notes.push(t(setter ? 'sched.prompt.clearedFor' : 'sched.prompt.cleared', { name: before.name || before.key.slice(0, 8) }))
  // The tag stays in English: the hook knows a board prompt by it (hook.mjs).
  const from = setter ? ` from ${setter}` : ''
  if (entry.kind === 'call') return `[mokupilot call report${notes.length ? `; ${notes.join('; ')}` : ''}]\n${entry.text}\n\n${CALL_NOTE}`
  const tag = entry.cron ? `board schedule ${entry.id}${from}: ${entry.cron}` : `board reminder${from}`
  return `[${tag}${notes.length ? `; ${notes.join('; ')}` : ''}] ${entry.text}`
}

const folder = p => String(p ?? '').replace(/[\\/]+/g, '/').replace(/\/$/, '').toLowerCase()

/**
 * The session an entry is for: by its id, else the Claude session now in its pane and folder.
 * /clear gives a session a new id in the same pane; the reminder follows it there.
 */
export function targetOf(entry, items) {
  const own = items.find(i => i.key === entry.key)
  if (own || !entry.pane || !entry.cwd) return own
  return items.find(i => i.pane === entry.pane && i.session && !i.sleeping && folder(i.cwd) === folder(entry.cwd))
}

const positive = (v, fallback) => (Number(v) > 0 ? Number(v) : fallback)

/**
 * Start sending due entries. `cfg` is the live config: scheduleTickSec (15), scheduleWaitMin
 * (240). Returns { tick, stop }.
 */
export function startScheduler({ cfg, log = () => {}, onChange = () => {} }) {
  // Five minutes at most: setTimeout takes no more than 24 days, and a larger value runs at once.
  const tickMs = () => Math.min(300, Math.max(0.1, positive(cfg.scheduleTickSec, 15))) * 1000
  const patience = () => positive(cfg.scheduleWaitMin, 240) * 60_000
  const flying = new Set() // sessions with a run on its way: one at a time per session
  // Runs that went out but whose entry could not be updated (its lock was taken): the next
  // tick finishes the entry instead of sending it again.
  const delivered = new Map() // id -> next
  let waking = 0
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
        if (delivered.get(entry.id) === entry.next) {
          finish(entry)
          continue
        }
        const item = targetOf(entry, items)
        if (flying.has(entry.key) || (item && flying.has(item.key)) || (item?.sleeping && waking >= MAX_WAKING)) continue
        const keys = [entry.key, item?.key].filter(Boolean)
        for (const k of keys) flying.add(k)
        run(entry, item)
          .catch(err => log(`schedule ${entry.id}: ${err.message}`))
          .finally(() => {
            for (const k of keys) flying.delete(k)
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
    // On time (the default) goes into a working session too, queued into its turn as the user's
    // own mid-turn messages are; `idle` entries wait until it is free. A dialog always waits:
    // typing would answer it.
    const held = item && !item.sleeping && (item.status === 'blocked' || (entry.idle && item.status === 'working'))
    let why = !item ? 'gone' : held ? (item.status === 'blocked' ? 'dialog' : 'busy') : ''
    if (!why) {
      if (!claim(entry.id, now)) return
      if (item.key !== entry.key) {
        // Followed into the session that took its pane: the card and the log say the new one, the
        // prompt the one it was set for.
        const movedFrom = entry.movedFrom ?? { key: entry.key, name: entry.name }
        entry = { ...entry, key: item.key, name: item.name, movedFrom }
        updateEntry(entry.id, e => ({ ...e, key: item.key, name: item.name, movedFrom: e.movedFrom ?? movedFrom }))
      }
      let r = { ok: true }
      if (item.sleeping) {
        waking++
        r = await wake(cfg, item).finally(() => {
          waking--
          forgetSleepers()
        })
        // Cancelled while the session woke up: nothing to send.
        if (r.ok && !getEntry(entry.id)) return
      }
      if (r.ok) r = await send(cfg, { ...item, sleeping: false }, promptOf(entry, Date.now()), { free: !!entry.idle, draft: true })
      if (r.ok) return sent(entry)
      why = r.draft ? 'draft' : r.dialog ? 'dialog' : r.busy ? 'busy' : r.error
    }
    wait(entry, now, why)
  }

  /**
   * Taken for this process, unless another board holds a fresh claim or it was handled already.
   * Delivery is at least once: a board that dies between typing the text and finish() leaves
   * its claim, and the run goes out again once that claim expires (CLAIM_MS).
   */
  function claim(id, now) {
    return !!updateEntry(id, e => {
      if (e.next > now) return undefined
      if (e.claim && e.claim.pid !== process.pid && now - e.claim.at < CLAIM_MS) return undefined
      return { ...e, claim: { pid: process.pid, at: now } }
    })
  }

  function sent(entry) {
    const now = Date.now()
    delivered.set(entry.id, entry.next)
    finish(entry, now)
    logRun(record(entry, now, 'sent'))
  }

  /** After a run went out: a one-off goes, a cron entry moves on. */
  function finish(entry, now = Date.now()) {
    try {
      if (entry.cron) updateEntry(entry.id, e => settle(e, now, { lastRun: now, runs: (e.runs ?? 0) + 1 }))
      else removeEntry(entry.id)
      delivered.delete(entry.id)
    } catch (err) {
      log(`schedule ${entry.id}: ${err.message}`)
    }
  }

  // A call's results go into the log by their title: the report itself is the session's now.
  const record = (entry, at, result, why) => ({ id: entry.id, key: entry.key, name: entry.name, text: entry.kind === 'call' ? callTitle(entry.text) : entry.text, ...(entry.kind && { kind: entry.kind }), cron: entry.cron, due: entry.next, at, result, why })

  /** Not sent this time: try again on the next tick, or log it as missed once the wait is over. */
  function wait(entry, now, why) {
    // Only time spent trying counts: a gap (the board was off) is not waiting.
    const step = entry.tried ? Math.min(now - entry.tried, 2 * tickMs() + 5000) : 0
    const waited = (entry.waited ?? 0) + step
    if (waited < patience()) {
      updateEntry(entry.id, e => ({ ...e, pendingSince: e.pendingSince ?? now, tried: now, waited, why, claim: undefined }))
      return
    }
    const gone = why === 'gone' ? (entry.gone ?? 0) + 1 : 0
    const drop = !entry.cron || gone >= GONE_RUNS
    if (drop) removeEntry(entry.id)
    else updateEntry(entry.id, e => settle(e, now, { missed: (e.missed ?? 0) + 1, ...(gone && { gone }) }))
    logRun({ ...record(entry, now, entry.cron && drop ? 'dropped' : 'missed', why), ...(entry.cron && drop && { n: gone }) })
  }

  /** A cron entry after a run: its next time, the waiting fields cleared. */
  function settle(e, now, counts) {
    const { pendingSince, tried, waited, why, claim, gone, ...rest } = e
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
  let watcher = null
  let watchTimer = null
  try {
    mkdirSync(SCHEDULE_DIR, { recursive: true })
    watcher = watch(SCHEDULE_DIR, () => {
      clearTimeout(watchTimer)
      watchTimer = setTimeout(() => plan(0), 300)
    })
    // On Windows a watched folder that is deleted errors (EPERM); unhandled, that ends the
    // board. The ticks go on without it.
    watcher.on('error', () => {
      watcher.close()
      watcher = null
    })
  } catch {}
  plan(1000)

  return {
    tick,
    stop() {
      stopped = true
      clearTimeout(timer)
      clearTimeout(watchTimer)
      watcher?.close()
    },
  }
}
