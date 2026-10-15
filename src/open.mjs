// The "open" action (bind it to a key) toggles the board: opens it, or focuses it when it is
// open elsewhere, or goes back to where you were when it is the focused pane.
// Placement (config.json): "workspace" (default) keeps the board in a workspace of its own that
// stays open, so it is instant and jumping to a session leaves it in place; "tab" opens it as a
// tab of the current workspace; "overlay" lays it over the current pane and closes it on leave.
// --background (the startup hook): make sure the workspace board runs, without focusing it.
import { readFileSync } from 'node:fs'
import { loadConfig } from './config.mjs'
import { herdr, snapshot } from './herdr.mjs'
import { goBack, rememberReturn } from './nav.mjs'
import { BOARD_FILE, PLUGIN_ID, ROOT } from './paths.mjs'

const cfg = loadConfig()
const background = process.argv.includes('--background')
let board = null
try {
  board = JSON.parse(readFileSync(BOARD_FILE, 'utf8')).pane
} catch {}

const snap = await snapshot()
const placement = ['tab', 'overlay'].includes(cfg.placement) ? cfg.placement : 'workspace'
if (background && placement !== 'workspace') process.exit(0)
if (board && snap.panes.some(p => p.pane_id === board)) {
  if (background) process.exit(0)
  if (snap.focused_pane_id === board) {
    if (!(await goBack())) await herdr(['plugin', 'pane', 'close', board])
  } else {
    rememberReturn(snap, board)
    await herdr(['plugin', 'pane', 'focus', board])
    if (placement === 'workspace') await zoom(board)
  }
} else {
  if (!background) rememberReturn(snap, null)
  const open = ['plugin', 'pane', 'open', '--plugin', PLUGIN_ID, '--entrypoint', 'board', '--cwd', ROOT, '--env', `AGENT_BOARD_PLACEMENT=${placement}`, background ? '--no-focus' : '--focus']
  if (placement !== 'workspace') {
    await herdr([...open, '--placement', placement])
  } else {
    // Its own workspace; a new one comes with a shell tab, closed once the board tab is in.
    const label = cfg.workspace || 'Board'
    let ws = snap.workspaces.find(w => w.label === label)
    let initialTab = null
    if (!ws) {
      const created = await herdr(['workspace', 'create', '--label', label, '--cwd', ROOT, '--no-focus'])
      ws = created.workspace
      initialTab = created.tab?.tab_id
    }
    // A reused workspace keeps its tabs, except the ones an earlier board left behind: when the
    // board pane ends, its tab keeps only the herdr-sidebar pane that plugin adds to every tab.
    const leftovers = initialTab ? [] : orphanTabs(ws.workspace_id)
    const opened = await herdr([...open, '--placement', 'tab', '--workspace', ws.workspace_id])
    if (opened?.plugin_pane?.pane?.pane_id) {
      for (const tab of initialTab ? [initialTab] : leftovers) await herdr(['tab', 'close', tab]).catch(() => {})
    }
    await zoom(opened?.plugin_pane?.pane?.pane_id)
  }
}

/** Tabs of the workspace with panes, all of them herdr-sidebar panes: nothing of the user's in there. */
function orphanTabs(workspace) {
  const sidebar = p => !p.agent && Object.keys(p.tokens ?? {}).some(k => k.startsWith('herdr-sidebar'))
  return snap.tabs
    .filter(tab => tab.workspace_id === workspace)
    .map(tab => tab.tab_id)
    .filter(id => {
      const panes = snap.panes.filter(p => p.tab_id === id)
      return panes.length > 0 && panes.every(sidebar)
    })
}

// Other plugins (herdr-sidebar) add their panes to every new tab; zoomed, the board keeps the
// whole tab. Zooming focuses the pane, so a background open leaves it to the first real open.
async function zoom(pane) {
  if (background) return
  if (pane) await herdr(['pane', 'zoom', pane, '--on']).catch(() => {})
}
