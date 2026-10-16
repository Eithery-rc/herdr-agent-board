// The "web" action (and o on the terminal board): shows the web board in an app window of its
// own (Edge --app), or brings that window to the front when it is open. The server lives in the
// terminal board's process, so that board is started in the background first when needed.
import { execFile, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { raiseWindow } from './actions.mjs'
import { loadConfig } from './config.mjs'
import { t } from './lang.mjs'
import { ROOT } from './paths.mjs'

const sleep = ms => new Promise(r => setTimeout(r, ms))

const BROWSERS = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
]

async function up(url) {
  try {
    return (await fetch(`${url}api/board`, { signal: AbortSignal.timeout(1500) })).ok
  } catch {
    return false
  }
}

/** Ask the running board to show the session in a herdr pane: { ok, key, pages } or null. */
async function reveal(url, pane) {
  try {
    const res = await fetch(`${url}api/reveal`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-board': '1' }, body: JSON.stringify({ pane }), signal: AbortSignal.timeout(3000) })
    return await res.json()
  } catch {
    return null
  }
}

/**
 * With `pane`, the session in that herdr pane, its sheet open (a notification clicked). The board
 * is not started for it: { ok: false, missing: true } when it does not run or has no session
 * there, and the caller goes to herdr instead.
 */
export async function openWeb(cfg = loadConfig(), { pane } = {}) {
  const url = `http://127.0.0.1:${cfg.port ?? 12422}/`
  let page = url
  if (pane) {
    const r = await reveal(url, pane)
    if (!r?.ok) return { ok: false, missing: true, error: r?.error || t('err.notRunning') }
    // Open pages show the session now: their window only has to come up.
    if (r.pages && (await raiseWindow('*Agent board*'))) return { ok: true, url, key: r.key }
    page = `${url}#session=${encodeURIComponent(r.key)}`
  } else {
    if (!(await up(url))) {
      await new Promise(r => execFile(process.execPath, [join(ROOT, 'src', 'open.mjs'), '--background'], { windowsHide: true }, r))
      for (let i = 0; i < 40 && !(await up(url)); i++) await sleep(250)
      if (!(await up(url))) return { ok: false, error: t('err.notRunning') }
    }
    if (await raiseWindow('*Agent board*')) return { ok: true, url }
  }
  const browser = cfg.browser || BROWSERS.find(p => existsSync(p))
  if (browser) {
    spawn(browser, [`--app=${page}`, '--window-size=1600,1000'], { detached: true, stdio: 'ignore', windowsHide: false }).unref()
  } else if (process.platform === 'win32') {
    spawn('cmd', ['/c', 'start', '', page], { detached: true, stdio: 'ignore', windowsHide: true }).unref()
  } else {
    spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [page], { detached: true, stdio: 'ignore' }).unref()
  }
  return { ok: true, url }
}

// `node src/web-open.mjs [--pane <herdr pane id>]`: exit code 3 when the board cannot show that
// session (not running, or no session there), for a caller that then goes to herdr.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const at = process.argv.indexOf('--pane')
  const pane = at > 0 ? process.argv[at + 1] : undefined
  const r = await openWeb(loadConfig(), { pane })
  console.log(r.ok ? `web board: ${r.url}${r.key ? ` (${r.key})` : ''}` : r.error)
  process.exitCode = r.ok ? 0 : r.missing ? 3 : 1
}
