// Cards: what agents (and the user, from the board) said about a session that herdr cannot
// see: its category, what it works on, what it waits for. One small JSON file per session, so
// sessions writing at the same time never clobber each other. Keyed by the Claude session id,
// which survives sleep and resume; agents without one are keyed by their pane.
import { mkdirSync, readFileSync, readdirSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { CARDS_DIR } from './paths.mjs'

const safe = key => String(key).replace(/[^A-Za-z0-9_-]/g, '_')
const file = key => join(CARDS_DIR, `${safe(key)}.json`)

export function readCard(key) {
  try {
    return JSON.parse(readFileSync(file(key), 'utf8'))
  } catch {
    return null
  }
}

// An atomic mkdir serializes the whole read/merge/rename across processes. Do not steal
// old locks: a slow writer may still own one. Crashed writers leave a lock to remove manually.
const LOCK_TIMEOUT_MS = 2000
const pause = new Int32Array(new SharedArrayBuffer(4))

function lockCard(path) {
  const lock = `${path}.lock`
  const deadline = performance.now() + LOCK_TIMEOUT_MS
  for (;;) {
    try {
      mkdirSync(lock)
      return () => rmdirSync(lock)
    } catch (err) {
      if (err.code !== 'EEXIST') throw err
      if (performance.now() >= deadline) {
        throw new Error(`Timed out waiting for card lock: ${lock}`)
      }
      Atomics.wait(pause, 0, 0, 10)
    }
  }
}

/** Merge `patch` into the card and save it. Empty strings clear a field. */
export function writeCard(key, patch) {
  mkdirSync(CARDS_DIR, { recursive: true })
  const path = file(key)
  const unlock = lockCard(path)
  const tmp = `${path}.${process.pid}.tmp`
  try {
    const card = { ...(readCard(key) ?? { key }), ...patch, updatedAt: Date.now() }
    for (const [k, v] of Object.entries(card)) if (v === '' || v === null) delete card[k]
    writeFileSync(tmp, JSON.stringify(card))
    renameSync(tmp, path)
    return card
  } finally {
    try {
      try { unlinkSync(tmp) } catch (err) { if (err.code !== 'ENOENT') throw err }
    } finally {
      unlock()
    }
  }
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
