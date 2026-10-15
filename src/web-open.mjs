// The "web" action (and o on the terminal board): shows the web board in an app window of its
// own (Edge --app), or brings that window to the front when it is open. The server lives in the
// terminal board's process, so that board is started in the background first when needed.
import { execFile, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { raiseWindow } from './actions.mjs'
import { loadConfig } from './config.mjs'
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

export async function openWeb(cfg = loadConfig()) {
  const url = `http://127.0.0.1:${cfg.port ?? 12422}/`
  if (!(await up(url))) {
    await new Promise(r => execFile(process.execPath, [join(ROOT, 'src', 'open.mjs'), '--background'], { windowsHide: true }, r))
    for (let i = 0; i < 40 && !(await up(url)); i++) await sleep(250)
    if (!(await up(url))) return { ok: false, error: 'Доска не запущена: открой её один раз через Ctrl+B, A' }
  }
  if (await raiseWindow('*Agent board*')) return { ok: true, url }
  const browser = cfg.browser || BROWSERS.find(p => existsSync(p))
  if (browser) {
    spawn(browser, [`--app=${url}`, '--window-size=1600,1000'], { detached: true, stdio: 'ignore', windowsHide: false }).unref()
  } else if (process.platform === 'win32') {
    spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref()
  } else {
    spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], { detached: true, stdio: 'ignore' }).unref()
  }
  return { ok: true, url }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const r = await openWeb()
  console.log(r.ok ? `web board: ${r.url}` : r.error)
  process.exitCode = r.ok ? 0 : 1
}
