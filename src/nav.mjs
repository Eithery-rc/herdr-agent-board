// Going to the board and back. Opening it remembers where the user was (return.json); leaving
// the board (q, or the board key again) goes back there.
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { herdr } from './herdr.mjs'
import { STATE_DIR } from './paths.mjs'

const RETURN_FILE = join(STATE_DIR, 'return.json')

export function rememberReturn(snap, boardPane) {
  const pane = snap.panes.find(p => p.pane_id === snap.focused_pane_id)
  if (!pane || pane.pane_id === boardPane) return
  try {
    writeFileSync(RETURN_FILE, JSON.stringify({ pane: pane.pane_id, tab: pane.tab_id, agent: !!pane.agent }))
  } catch {}
}

/** Focus the pane the user came from. False when there is nowhere to go back to. */
export async function goBack() {
  let ret = null
  try {
    ret = JSON.parse(readFileSync(RETURN_FILE, 'utf8'))
  } catch {
    return false
  }
  if (ret.agent) {
    try {
      await herdr(['agent', 'focus', ret.pane])
      return true
    } catch {}
  }
  try {
    await herdr(['tab', 'focus', ret.tab])
    return true
  } catch {
    return false
  }
}
