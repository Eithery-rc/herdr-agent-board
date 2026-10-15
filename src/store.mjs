// Cards: what agents (and the user, from the board) said about a session that herdr cannot
// see: its category, what it works on, what it waits for. One small JSON file per session, so
// sessions writing at the same time never clobber each other. Keyed by the Claude session id,
// which survives sleep and resume; agents without one are keyed by their pane.
import { mkdirSync, readFileSync, readdirSync, renameSync, rmdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { CARDS_DIR } from './paths.mjs'

const safe = key => String(key).replace(/[^A-Za-z0-9_-]/g, '_')
const file = key => join(CARDS_DIR, `${safe(key)}.json`)

export function readCard(key) {
  return readJson(file(key))
}

/** A JSON file's contents, or null when it is missing or unreadable. */
export function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}

// An atomic mkdir serializes the whole read/merge/rename across processes. A writer holds the
// lock for milliseconds, so one older than LOCK_STALE_MS was left by a process killed mid-write
// (a closed terminal, a hook cut off): it is taken over, or that file could never be written
// again. Two writers taking over the same dead lock at the same instant is the one race left.
const LOCK_TIMEOUT_MS = 2000
const LOCK_STALE_MS = 30_000
const pause = new Int32Array(new SharedArrayBuffer(4))

function lockAge(lock) {
  try {
    return Date.now() - statSync(lock).mtimeMs
  } catch {
    return 0 // gone already: the next mkdir tells
  }
}

function lockFile(path) {
  const lock = `${path}.lock`
  const deadline = performance.now() + LOCK_TIMEOUT_MS
  for (;;) {
    try {
      mkdirSync(lock)
      return () => rmdirSync(lock)
    } catch (err) {
      if (err.code !== 'EEXIST') throw err
      if (lockAge(lock) > LOCK_STALE_MS) {
        try {
          rmdirSync(lock)
        } catch {}
        continue
      }
      if (performance.now() >= deadline) {
        throw new Error(`Timed out waiting for lock: ${lock}`)
      }
      Atomics.wait(pause, 0, 0, 10)
    }
  }
}

/**
 * Read, change and save a JSON file under its lock, so writers in other processes never lose
 * each other's fields. `change(current)` gets the contents (null when there is no file) and
 * returns the new contents, null to delete the file, or undefined to leave it as it is.
 * Returns what `change` returned.
 */
export function updateJson(path, change) {
  const unlock = lockFile(path)
  const tmp = `${path}.${process.pid}.tmp`
  try {
    const next = change(readJson(path))
    if (next === null) {
      try { unlinkSync(path) } catch (err) { if (err.code !== 'ENOENT') throw err }
    } else if (next !== undefined) {
      writeFileSync(tmp, JSON.stringify(next))
      renameSync(tmp, path)
    }
    return next
  } finally {
    try {
      try { unlinkSync(tmp) } catch (err) { if (err.code !== 'ENOENT') throw err }
    } finally {
      unlock()
    }
  }
}

/** Merge `patch` into the card and save it. Empty strings clear a field. */
export function writeCard(key, patch) {
  mkdirSync(CARDS_DIR, { recursive: true })
  return updateJson(file(key), saved => {
    const card = { ...(saved ?? { key }), ...patch, updatedAt: Date.now() }
    for (const [k, v] of Object.entries(card)) if (v === '' || v === null) delete card[k]
    return card
  })
}

/** Every card by key. */
export function allCards() {
  const cards = new Map()
  let names = []
  try {
    names = readdirSync(CARDS_DIR)
  } catch {
    return cards
  }
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    try {
      const card = JSON.parse(readFileSync(join(CARDS_DIR, name), 'utf8'))
      if (card.key) cards.set(card.key, card)
    } catch {}
  }
  return cards
}
