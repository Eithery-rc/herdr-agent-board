// The board's terminal: a session's own pane, or a shell the board opens in the session's folder,
// shown live on the web board and typed into from there. Everything goes through herdr: the
// shell is a herdr tab of its own in the session's workspace (so it can be opened in herdr too),
// the screen is read with `pane read`, keys go with `pane send-keys` and `pane send-text`.
//
// herdr has no output stream, so a pane on show is read again and again: fast right after a key
// or a change, slower while nothing moves. Each read goes out as a line diff (web/term-model.js).
//
// What it may type into: the shell this board opened for that session (its pane id in
// terminals.json; herdr never gives a closed pane's id to another), or the session's own pane
// once herdr says the same session still runs there, as for a message. Nothing it reads or types
// is logged.
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { herdr as realHerdr, herdrText as realHerdrText } from './herdr.mjs'
import { STATE_DIR } from './paths.mjs'
import { applyDiff, diffLines } from '../web/term-model.js'
import { herdrCalls } from '../web/term-keys.js'

export const TERMINALS_FILE = join(STATE_DIR, 'terminals.json')
// How much of a pane goes to the page: the visible screen and the scrollback above it.
export const READ_LINES = 400
// Panes that show up in the shell's tab this soon after the board made it came with the tab (a
// plugin's sidebar, say), not from the user: closing the shell closes them with the tab.
const FURNITURE_MS = 10_000

const notFound = err => /pane_not_found|not.?found|no such/i.test(`${err?.code} ${err?.message}`)

/** The pace of reading a pane: fast after a key or a change, slower while it stays the same. */
export function nextDelay({ now, pokedAt = 0, changedAt = 0 }) {
  if (now - pokedAt < 1500 || now - changedAt < 1500) return 120
  if (now - changedAt < 20_000) return 400
  return 1000
}

/** The columns of a pane from its place in herdr's layout (its frame takes two). */
export function paneCols(layout, pane) {
  const rect = layout?.panes?.find(p => p.pane_id === pane)?.rect
  return rect?.width > 4 ? rect.width - 2 : null
}

/** A tab name herdr takes as a value: no control characters, no leading dash, not too long. */
export function tabLabel(name) {
  const clean = String(name ?? '').replace(/[\x00-\x1f\x7f-\x9f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '').replace(/^[\s-]+/, '').trim()
  return [...clean].slice(0, 40).join('') || 'shell'
}

/**
 * The terminals of this board process. `herdr` and `herdrText` are the CLI (tests pass fakes),
 * `file` where the shells it opened are kept, so a board that restarts finds them again.
 */
export function createTerminals({ herdr = realHerdr, herdrText = realHerdrText, file = TERMINALS_FILE, now = () => Date.now(), sleep = ms => new Promise(r => setTimeout(r, ms)) } = {}) {
  let shells = load()
  const readers = new Map() // pane -> reader
  const queues = new Map() // pane -> the promise of the input typed last
  const opening = new Map() // session key -> the shell being opened

  function load() {
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8'))
      return raw && typeof raw === 'object' ? raw : {}
    } catch {
      return {}
    }
  }
  function save() {
    try {
      mkdirSync(join(file, '..'), { recursive: true })
      const tmp = `${file}.${process.pid}.tmp`
      writeFileSync(tmp, `${JSON.stringify(shells, null, 2)}\n`)
      renameSync(tmp, file)
    } catch {}
  }

  /** The panes of a tab: [{ pane_id, agent }]. */
  async function tabPanes(workspace, tab) {
    const list = (await herdr(['pane', 'list', '--workspace', workspace], 8000))?.panes ?? []
    return list.filter(p => p.tab_id === tab)
  }

  /** The panes in the shell's tab that came with it (looked at while it is still new). */
  async function noteFurniture(rec) {
    if (now() - rec.at > FURNITURE_MS) return
    try {
      const others = (await tabPanes(rec.workspace, rec.tab)).map(p => p.pane_id).filter(id => id !== rec.pane)
      const next = [...new Set([...(rec.others ?? []), ...others])]
      if (next.length !== (rec.others ?? []).length) {
        rec.others = next
        save()
      }
    } catch {}
  }

  /**
   * The shell's tab goes when nothing but what came with it is left there; a pane the user added
   * (a split, an agent) keeps it. Its pane is closed first when it still runs.
   */
  async function closeRec(rec) {
    try {
      await herdr(['pane', 'close', rec.pane], 8000)
    } catch (err) {
      if (!notFound(err)) throw err
    }
    try {
      const rest = await tabPanes(rec.workspace, rec.tab)
      if (rest.every(p => p.pane_id !== rec.pane && (rec.others ?? []).includes(p.pane_id) && !p.agent)) await herdr(['tab', 'close', rec.tab], 8000)
    } catch {}
  }

  function forget(key) {
    if (!shells[key]) return
    delete shells[key]
    save()
  }

  /** Whether the board's shell for `key` still runs where it was opened. */
  async function alive(rec) {
    try {
      const pane = (await herdr(['pane', 'get', rec.pane], 5000))?.pane
      return !!pane && pane.tab_id === rec.tab
    } catch (err) {
      if (notFound(err)) return false
      throw err
    }
  }

  /**
   * The shell for a session, opened when it has none: a tab in the session's workspace, in its
   * folder, named after it. { ok, pane, cwd, created } or { ok: false, error: <text key>, why }.
   * Asked twice at once (a double click), it opens one.
   */
  function openShell(item, label) {
    if (!opening.has(item.key)) opening.set(item.key, open(item, tabLabel(label)).finally(() => opening.delete(item.key)))
    return opening.get(item.key)
  }

  async function open(item, label) {
    const had = shells[item.key]
    if (had) {
      if (await alive(had)) return { ok: true, pane: had.pane, cwd: had.cwd, created: false }
      await closeRec(had).catch(() => {})
      forget(item.key)
    }
    const cwd = String(item.cwd ?? '')
    if (!cwd || !statSync(cwd, { throwIfNoEntry: false })?.isDirectory()) return { ok: false, error: 'term.err.cwd', why: cwd }
    if (!item.pane) return { ok: false, error: 'err.noPane' }
    const workspace = (await herdr(['pane', 'get', item.pane], 5000))?.pane?.workspace_id
    if (!workspace) return { ok: false, error: 'err.noPane' }
    const r = await herdr(['tab', 'create', '--workspace', workspace, '--cwd', cwd, '--label', label, '--no-focus'], 15_000)
    const rec = { pane: r.root_pane.pane_id, tab: r.tab?.tab_id ?? r.root_pane.tab_id, workspace, cwd, at: now(), others: [] }
    shells[item.key] = rec
    save()
    // A plugin may add its own pane to every new tab a moment later.
    await sleep(700)
    await noteFurniture(rec)
    return { ok: true, pane: rec.pane, cwd, created: true }
  }

  /** Close the board's shell for a session (its pane, and its tab when that is all that is left). */
  async function closeShell(key) {
    const rec = shells[key]
    if (!rec) return { ok: true }
    stopReader(rec.pane, { t: 'gone', closed: true })
    await closeRec(rec)
    forget(key)
    return { ok: true }
  }

  /** The tab of the board's shell for a session, to go to it in herdr. */
  const shellOf = key => (shells[key] ? { pane: shells[key].pane, tab: shells[key].tab, cwd: shells[key].cwd } : null)

  /**
   * The pane input for `target` may go to: the board's own shell for the session, or the
   * session's pane while the same session runs there. { pane } or { error: <text key> }.
   */
  async function inputPane(item, target, session) {
    if (target === 'shell') return shells[item.key] ? { pane: shells[item.key].pane } : { error: 'term.err.noShell' }
    if (target !== 'agent') return { error: 'term.err.target' }
    if (!item.pane) return { error: 'err.noPane' }
    if (item.sleeping) return { error: 'term.err.asleep' }
    if ((session ?? null) !== (item.session ?? null)) return { error: 'err.sessionChanged' }
    const agent = (await herdr(['agent', 'get', item.pane], 5000))?.agent
    if (!agent || (agent.agent_session?.value ?? null) !== (item.session ?? null)) return { error: 'err.sessionChanged' }
    return { pane: item.pane }
  }

  /**
   * Type steps into a pane: checked first (web/term-keys.js), then sent in order, one request
   * after the other for the same pane. { ok } or { ok: false, error: <text key>, why }.
   */
  function input(pane, steps) {
    const { calls, error } = herdrCalls(steps)
    if (error) return Promise.resolve({ ok: false, error: 'term.err.input', why: error })
    const run = async () => {
      for (const c of calls) {
        // `pane send-text` types its text as it is, a leading dash included (herdr 0.9).
        if (c.keys) await herdr(['pane', 'send-keys', pane, ...c.keys], 10_000)
        else await herdr(['pane', 'send-text', pane, c.text], 10_000)
      }
    }
    const next = (queues.get(pane) ?? Promise.resolve()).then(run, run)
    const done = next.then(
      () => ({ ok: true }),
      err => ({ ok: false, error: notFound(err) ? 'term.err.gone' : 'term.err.herdr', why: notFound(err) ? '' : String(err?.message ?? err) }),
    )
    queues.set(pane, done)
    done.then(() => {
      if (queues.get(pane) === done) queues.delete(pane)
      readers.get(pane)?.poke()
    })
    return done
  }

  // ------------------------------------------------------------ reading a pane for the page

  /**
   * Watch a pane for a page: `send(message)` gets the whole screen first, then line diffs as it
   * changes ({ t: 'frame', drop, keep, lines, cols }), { t: 'gone' } when the
   * pane closed, { t: 'error', why } while herdr does not answer. Returns the stop function.
   */
  function watch(pane, { shell = false, key = null } = {}, send) {
    let r = readers.get(pane)
    if (!r) {
      r = reader(pane, { shell, key })
      readers.set(pane, r)
    }
    return r.add(send)
  }

  function stopReader(pane, last) {
    const r = readers.get(pane)
    if (!r) return
    r.end(last)
  }

  function reader(pane, { shell, key }) {
    const subs = new Set()
    let lines = null
    let cols = null
    let colsAt = 0
    let changedAt = 0
    let pokedAt = 0
    let timer = null
    let reading = false
    let again = false
    let ended = false
    let failing = false
    let heartbeat = null
    let furnished = false

    const broadcast = msg => {
      for (const send of subs) {
        try {
          send(msg)
        } catch {}
      }
    }
    const frame = (d = { drop: 0, keep: 0, lines: lines ?? [] }) => ({ t: 'frame', ...d, cols })

    async function tick() {
      timer = null
      if (ended || reading) return
      reading = true
      try {
        const t = now()
        // The screen, and beside it now and then the pane's width (at once: each is a herdr
        // call of its own).
        const wantCols = !cols || t - colsAt > 10_000
        if (wantCols) colsAt = t
        const [text, layout] = await Promise.all([
          herdrText(['pane', 'read', pane, '--source', 'recent-unwrapped', '--lines', String(READ_LINES), '--ansi'], 5000),
          wantCols ? herdr(['pane', 'layout', '--pane', pane], 5000).catch(() => null) : null,
        ])
        if (wantCols) cols = paneCols(layout?.layout, pane) ?? cols
        // After a failed read the page is told it works again, even when nothing changed.
        const recovered = failing
        const next = text.replace(/\r/g, '').replace(/\n$/, '').split('\n')
        failing = false
        if (!lines) {
          lines = next
          changedAt = now()
          broadcast(frame())
        } else {
          const d = diffLines(lines, next)
          const same = d.drop === 0 && d.keep === lines.length && !d.lines.length
          if (!same || recovered) {
            lines = applyDiff(lines, d)
            if (!same) changedAt = now()
            broadcast(frame(d))
          }
        }
        // Once more while the tab is new: a plugin's pane may have come after the first look.
        if (shell && key && !furnished && now() - (shells[key]?.at ?? 0) > 2000) {
          furnished = true
          noteFurnitureOf(key)
        }
      } catch (err) {
        if (notFound(err)) {
          reading = false
          if (shell && key && shells[key]?.pane === pane) {
            const rec = shells[key]
            forget(key)
            // The shell exited (`exit`) or its pane was closed in herdr: its tab goes too when
            // only what came with it is left.
            closeRec(rec).catch(() => {})
          }
          return end({ t: 'gone' })
        }
        if (!failing) broadcast({ t: 'error', why: String(err?.message ?? err) })
        failing = true
      }
      reading = false
      schedule(again ? 0 : undefined)
      again = false
    }

    function schedule(delay) {
      if (ended || timer || !subs.size) return
      timer = setTimeout(tick, delay ?? nextDelay({ now: now(), pokedAt, changedAt }))
      timer.unref?.()
    }

    function end(last) {
      if (ended) return
      ended = true
      clearTimeout(timer)
      clearInterval(heartbeat)
      if (last) broadcast(last)
      subs.clear()
      if (readers.get(pane) === api) readers.delete(pane)
    }

    const api = {
      add(send) {
        subs.add(send)
        if (lines) send(frame())
        if (!heartbeat) {
          heartbeat = setInterval(() => broadcast({ t: 'ping' }), 15_000)
          heartbeat.unref?.()
        }
        if (subs.size === 1) schedule(0)
        return () => {
          subs.delete(send)
          if (!subs.size) end()
        }
      },
      // Keys went in: read again at once, or right after a read that began before they did.
      poke() {
        pokedAt = now()
        if (reading) return void (again = true)
        clearTimeout(timer)
        timer = null
        schedule(0)
      },
      end,
    }
    return api
  }

  function noteFurnitureOf(key) {
    const rec = shells[key]
    if (rec && now() - rec.at <= FURNITURE_MS) noteFurniture(rec)
  }

  /** The sessions that have a shell from the board, for the page. */
  const keys = () => Object.keys(shells)

  /** Shells whose session left the board stay; a shell whose pane is gone is forgotten. */
  async function prune() {
    for (const [key, rec] of Object.entries(shells)) {
      try {
        if (!(await alive(rec))) {
          forget(key)
          closeRec(rec).catch(() => {})
        }
      } catch {}
    }
  }

  return { openShell, closeShell, shellOf, inputPane, input, watch, keys, prune }
}
