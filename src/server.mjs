// The web board: a small HTTP server on 127.0.0.1 that serves web/, the board's data and live
// updates (Server-Sent Events), and takes the same actions as the terminal board.
// Runs inside the terminal board's process (tui.mjs); `node src/server.mjs` runs it alone.
//
// Only loopback, only the Host it was asked for, and every POST needs an X-Board header: a page
// on another site cannot send that without a CORS preflight, which this server never grants, so
// it cannot type into a session.
import { createReadStream, createWriteStream, mkdirSync, readdirSync, rmSync, statSync, unlinkSync, watch } from 'node:fs'
import { readFile } from 'node:fs/promises'
import http from 'node:http'
import { extname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'
import { focus, raiseTerminal, send, sleepSession, wake } from './actions.mjs'
import { answerPermission, answerQuestions } from './answer.mjs'
import { checkoutChanges, isCheckout } from './changes.mjs'
import { searchHistory } from './history.mjs'
import { localUsage } from './usage.mjs'
import { conversation } from './claude.mjs'
import { helperDetail, helpersOf, publicHelper } from './helpers.mjs'
import { createLinks } from './links.mjs'
import { describe, FILE_TOKEN, MEDIA_TYPES, openWith, preview, resolvePath } from './files.mjs'
import { categoryInfo, colorHex, editCategories, editSettings, laneRank, liveConfig, PALETTE } from './config.mjs'
import { lang, t } from './lang.mjs'
import { LANGUAGES } from '../web/i18n.js'
import { herdr, herdrText } from './herdr.mjs'
import { createLaunches, listDirs, renameSession } from './launch.mjs'
import { checkName } from '../web/launch-model.js'
import { messageGate } from './message-gate.mjs'
import { busy, COLUMNS, collect, forgetSleepers, PINS } from './model.mjs'
import { parseDialog, publicDialog } from './questions.mjs'
import { CARDS_DIR, ROOT, STATE_DIR } from './paths.mjs'
import { listEntries, readLog, removeEntry, SCHEDULE_DIR, updateEntry } from './schedule.mjs'
import { startScheduler } from './scheduler.mjs'
import { writeCard } from './store.mjs'
import { createTerminals } from './terminal.mjs'

const WEB = join(ROOT, 'web')
// Files and screenshots sent to sessions from the board; the message carries their paths.
export const UPLOADS_DIR = join(STATE_DIR, 'uploads')
const MAX_UPLOAD = 30 << 20
const IMAGE_TYPES = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' }
// The page's scripts and styles come from here only (inline style attributes are used for colors).
const PAGE_CSP = "default-src 'self'; img-src 'self' blob: data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'"

/** A file name that is safe on disk and in a URL: letters, digits, dot and dash. */
function safeName(name) {
  const clean = String(name ?? '')
    .split(/[\\/]/)
    .pop()
    .normalize('NFC')
    .replace(/[^\p{L}\p{N}.-]+/gu, '-')
    .replace(/-{2,}/g, '-')
    .replace(/-+\./g, '.')
    .replace(/^[-.]+|-+$/g, '')
    .slice(-120)
  return clean || 'file'
}

/** Day folders of uploads older than `days` go; the sessions have read them by then. */
function pruneUploads(days) {
  const cutoff = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10)
  let dirs = []
  try {
    dirs = readdirSync(UPLOADS_DIR)
  } catch {
    return
  }
  for (const d of dirs) if (/^\d{4}-\d{2}-\d{2}$/.test(d) && d < cutoff) rmSync(join(UPLOADS_DIR, d), { recursive: true, force: true })
}

function receiveUpload(req, name) {
  return new Promise(resolve => {
    const now = new Date()
    const day = now.toISOString().slice(0, 10)
    const stamp = now.toTimeString().slice(0, 8).replace(/:/g, '')
    const dir = join(UPLOADS_DIR, day)
    mkdirSync(dir, { recursive: true })
    const file = `${stamp}-${safeName(name)}`
    const path = join(dir, file)
    const out = createWriteStream(path)
    let size = 0
    let failed = false
    const fail = error => {
      if (failed) return
      failed = true
      out.destroy()
      try {
        unlinkSync(path)
      } catch {}
      resolve({ ok: false, error })
    }
    req.on('data', chunk => {
      size += chunk.length
      if (size > MAX_UPLOAD) {
        req.destroy()
        fail(t('err.upload.big', { mb: MAX_UPLOAD >> 20 }))
      }
    })
    req.on('error', () => fail(t('err.upload.broken')))
    req.pipe(out)
    out.on('finish', () => !failed && resolve({ ok: true, path, name: file, size, url: `/uploads/${day}/${encodeURIComponent(file)}` }))
    out.on('error', err => fail(err.message))
  })
}
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
}
// The colors the category editor offers (aliases left out).
const SWATCHES = Object.entries(PALETTE)
  .filter(([name]) => !['magenta', 'white'].includes(name))
  .map(([name, hex]) => ({ name, hex }))

/** Changes whenever a file of the page changes, so open pages know to reload themselves. */
function assetsVersion() {
  let v = 0
  try {
    for (const name of readdirSync(WEB)) v = Math.max(v, statSync(join(WEB, name)).mtimeMs)
  } catch {}
  return String(Math.round(v))
}

/**
 * `cfg` is the live config object (liveConfig); pass it when the process already watches it and
 * call the returned `refresh` from its onChange. Without one the server watches config itself.
 */
export function startServer({ cfg, log = () => {} } = {}) {
  cfg ??= liveConfig(() => refresh())
  const port = cfg.port ?? 12422
  pruneUploads(cfg.keepUploadsDays ?? 14)
  let items = []
  let stale = true
  let lastSuccessfulRefreshAt = null
  let payload
  let version = assetsVersion()
  const clients = new Set()
  // Sessions started from the board (launch.mjs): their progress goes out with the board.
  const launches = createLaunches({ cfg, log, onChange: () => publish() })
  // The terminal (terminal.mjs): shells the board opened in sessions' folders, and live panes.
  const terminals = createTerminals({ onChange: () => publish() })
  // On unless config.json says otherwise: only a missing setting or true turns it on.
  const terminalOn = () => cfg.terminal === undefined || cfg.terminal === true

  /** The board as clients see it, without the time of the last successful refresh. */
  function board() {
    const ids = [...new Set([...cfg.categories.map(c => c.id), ...items.map(i => i.category)])]
    const categories = ids
      .sort((a, b) => laneRank(cfg, a) - laneRank(cfg, b) || a.localeCompare(b))
      .map(id => {
        const c = categoryInfo(cfg, id)
        const configured = cfg.categories.some(x => x.id === id)
        return { id, title: c.title, color: colorHex(c.color), colorName: c.color, paths: c.paths ?? [], configured, fallback: id === 'other' }
      })
    // What the page has no use for stays here: file paths, the Claude process and its pipe.
    const list = items.map(({ transcript, alive, since, pipe, ...rest }) => launches.decorate(rest))
    // The schedule without the scheduler's bookkeeping; the log is what was sent or missed lately.
    const schedules = listEntries().map(({ claim, tried, waited, ...entry }) => entry)
    // terminal: whether the board offers one (config `terminal`); shells: sessions it opened one for.
    return { version, lang: lang(), language: cfg.language ?? 'auto', languages: LANGUAGES, fsToken: FILE_TOKEN, stale, limits: claudeLimits(), items: list, launches: launches.list(), categories, swatches: SWATCHES, columns: COLUMNS.map(({ id, title }) => ({ id, title })), schedules, scheduleLog: readLog(20), terminal: terminalOn(), shells: terminalOn() ? terminals.keys() : [] }
  }

  /**
   * Claude's usage windows (usage.mjs): from the board's own status line when Claude Code runs it,
   * else from the usagebar cache, else null. Windows past their reset are left out: Claude starts
   * them over. No age in it, so data that does not change does not make the board go out again.
   */
  function claudeLimits() {
    for (const [source, l] of [['statusline', localUsage(STATE_DIR).limits], ['usagebar', localUsage().limits]]) {
      const windows = l.available ? l.windows.filter(w => !w.expired) : []
      if (windows.length) return { source, observedAt: l.observedAt, stale: Date.now() - l.observedAt > 30 * 60_000, windows }
    }
    return null
  }

  // GET always answers with the latest payload. Live clients get it again only when the board
  // changed (stale included): a refresh time that moves every few seconds alone is no news.
  let sent = ''
  function publish() {
    // Turned off in config.json: no pane stays on show.
    if (!terminalOn()) terminals.stopAll()
    const next = board()
    const key = JSON.stringify(next)
    payload = JSON.stringify({ ...next, lastSuccessfulRefreshAt })
    if (key === sent) return
    sent = key
    for (const res of clients) res.write(`data: ${payload}\n\n`)
  }
  publish()

  // Who started whom and who wrote to whom, read from the transcripts in the background
  // (links.mjs); a read that found something new refreshes the board.
  const links = createLinks({ onChange: () => refresh() })

  let refreshing = false
  let again = false
  async function refresh() {
    if (refreshing) return void (again = true)
    refreshing = true
    try {
      items = await collect(cfg, { helpers: true, links })
      launches.observe(items)
      stale = false
      lastSuccessfulRefreshAt = Date.now()
      publish()
    } catch (err) {
      stale = true
      publish()
      log(`refresh: ${err.message}`)
    } finally {
      refreshing = false
    }
    if (again) {
      again = false
      refresh()
    }
  }

  const guardedMessage = messageGate()
  const answering = new Set() // sessions with an answer being typed into their dialog
  const find = key => items.find(i => i.key === key)

  /**
   * Messages between sessions in a thread: the other session's card key, found by the pipe it
   * writes from (exact while it runs), and no pipes for the page.
   */
  function withSessions(conv) {
    const byPipe = new Map(items.filter(i => i.pipe).map(i => [i.pipe, i]))
    const at = pipe => byPipe.get(String(pipe ?? '').replace(/^uds:/, ''))
    return conv.map(m => {
      if (m.role === 'peer') {
        const { pipe, ...rest } = m
        const other = at(pipe)
        return other ? { ...rest, key: other.key } : rest
      }
      if (!m.send?.to.startsWith('uds:')) return m
      const other = at(m.send.to)
      return { ...m, send: { ...m.send, to: other?.autoName || other?.name || m.send.name || '', key: other?.key ?? null } }
    })
  }

  async function detail(item) {
    // checkout: whether its folder is in git, for the sheet's Changes button.
    const { transcript, alive, since, pipe, ...shown } = item
    // helpers: every subagent, fork, workflow agent and teammate, newest first (helpers.mjs).
    const own = helpersOf(transcript, { alive, since })
    const out = { item: shown, conversation: withSessions(conversation(transcript, 60)), helpers: own.helpers.map(publicHelper), workflows: own.workflows, screen: '', dialog: null, checkout: await isCheckout(item.cwd) }
    if (item.status === 'blocked' && item.pane) {
      try {
        const text = await herdrText(['agent', 'read', item.pane, '--source', 'visible'], 5000)
        out.screen = text.split('\n').map(l => l.trimEnd()).join('\n').replace(/\n{3,}/g, '\n\n').trim().split('\n').slice(-30).join('\n')
        // The dialog on it, for the sheet to answer: a permission prompt goes by its fingerprint.
        out.dialog = publicDialog(parseDialog(text))
      } catch {}
    }
    return out
  }

  async function act(item, action, body) {
    switch (action) {
      case 'focus':
        return focus(cfg, item, { raise: cfg.raiseTerminal !== false })
      case 'wake':
        return item.sleeping ? wake(cfg, item).finally(forgetSleepers) : { ok: true }
      case 'sleep':
        return sleepSession(cfg, item).finally(forgetSleepers)
      case 'message': {
        // Attached files go as their paths: Claude reads them, and picks up image paths as images.
        const files = (Array.isArray(body.files) ? body.files : []).filter(p => typeof p === 'string' && p.startsWith(UPLOADS_DIR))
        const list = files.length ? `${t('msg.files', { n: files.length })}:\n${files.join('\n')}` : ''
        // The card is for one session: a pane that holds another one now gets nothing. Panes with
        // no Claude session id (other agents) are matched by the card alone.
        if ((body.session ?? null) !== (item.session ?? null)) return { ok: false, error: t('err.sessionChanged', { name: item.name }) }
        return guardedMessage(item.key, body.requestId ?? randomUUID(), [body.session ?? null, body.text, files], async () => {
          // Always collect a new snapshot before accepting a message, even if SSE is connected: a
          // board that cannot reach herdr fails here rather than send on old data.
          const fresh = (await collect(cfg)).find(next => next.key === item.key)
          if (!fresh || fresh.session !== item.session || fresh.pane !== item.pane) return { ok: false, error: t('err.sessionChanged', { name: item.name }) }
          return send(cfg, fresh, [String(body.text ?? '').trim(), list].filter(Boolean).join('\n\n'))
        })
      }
      case 'answer':
      case 'permit': {
        // A question form or a permission prompt, answered with keys in the pane (answer.mjs).
        if ((body.session ?? null) !== (item.session ?? null)) return { ok: false, error: t('err.sessionChanged', { name: item.name }) }
        if (answering.has(item.key)) return { ok: false, error: t('err.qa.busy', { name: item.name }) }
        answering.add(item.key)
        try {
          // A new snapshot first, as for a message: the board must not answer on old data.
          let fresh
          try {
            fresh = (await collect(cfg)).find(next => next.key === item.key)
          } catch (err) {
            return { ok: false, error: t('err.qa.herdr', { why: err.message }) }
          }
          if (!fresh || fresh.session !== item.session || fresh.pane !== item.pane) return { ok: false, error: t('err.sessionChanged', { name: item.name }) }
          const r = action === 'answer' ? await answerQuestions(fresh, body) : await answerPermission(fresh, body)
          log(`${action} ${item.name}: ${r.ok ? 'ok' : r.error}`)
          return r
        } finally {
          answering.delete(item.key)
        }
      }
      case 'rename': {
        // The board's own name for it, kept on the card; empty gives the automatic one back.
        const name = String(body.name ?? '').trim()
        const bad = name && checkName(name)
        if (bad) return { ok: false, error: t(bad) }
        // Claude and herdr only when the user asked for it: /rename is typed into the session.
        // The board keeps the name only once that went through, so a refusal changes nothing.
        const claude = body.claude && name ? await renameSession(item, name) : { ok: true }
        if (claude.ok) writeCard(item.key, { name })
        return claude
      }
      case 'card': {
        const patch = {}
        if (typeof body.category === 'string') patch.category = body.category.toLowerCase().replace(/[^a-z0-9_-]/g, '')
        if (typeof body.wait === 'string') Object.assign(patch, body.wait.trim() ? { wait: body.wait.trim(), waitSince: Date.now() } : { wait: '', waitSince: '' }, { by: 'user' })
        if (typeof body.doing === 'string') patch.doing = body.doing.trim()
        // A card dragged to another column stays there until the session works again; dropped
        // back where the board would put it by itself, it is unpinned.
        if (typeof body.column === 'string') {
          if (body.column === item.auto) Object.assign(patch, { pin: '', pinAt: '', pinBusy: '' })
          else if (PINS.has(body.column)) Object.assign(patch, { pin: body.column, pinAt: Date.now(), pinBusy: busy(item.status) ? 1 : '' })
          else return { ok: false, error: t('err.pinWork', { col: t('q', { s: t('col.work') }) }) }
        }
        const unpin = { pin: '', pinAt: '', pinBusy: '' }
        if (body.clear) Object.assign(patch, { doing: '', wait: '', waitSince: '', ask: '', askSince: '', result: '' }, unpin)
        // "No reply needed": drop the agent's ask, and stop reading its last question as one.
        if (body.dismiss) Object.assign(patch, { ask: '', askSince: '', dismissed: item.attention === 'question' ? item.question : '' }, unpin)
        writeCard(item.key, patch)
        return { ok: true }
      }
      default:
        return { ok: false, error: `unknown action ${action}` }
    }
  }

  /**
   * A pane on show in the page's terminal, over Server-Sent Events: the screen, then line diffs.
   * EventSource sends no headers, so the per-run token (only the board's page reads it) stands in
   * for X-Board, as for raw files; the stream only reads.
   */
  function termStream(req, res, url, item, target) {
    const json = (code, body) => {
      res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      res.end(JSON.stringify(body))
    }
    if (url.searchParams.get('t') !== FILE_TOKEN) return json(403, { error: 'token' })
    if (target === 'agent' && item.sleeping) return json(409, { error: t('term.err.asleep') })
    const pane = target === 'shell' ? terminals.shellOf(item.key)?.pane : item.pane
    if (!pane) return json(404, { error: t(target === 'shell' ? 'term.err.noShell' : 'err.noPane') })
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive', 'x-content-type-options': 'nosniff' })
    res.write('retry: 3000\n\n')
    let stop = () => {}
    stop = terminals.watch(pane, { shell: target === 'shell', key: item.key }, msg => {
      // A page that stopped reading (asleep, half gone) does not pile the screen up here.
      if (res.writableLength > 2 << 20) {
        stop()
        return res.destroy()
      }
      res.write(msg.t === 'ping' ? ': ping\n\n' : `data: ${JSON.stringify(msg)}\n\n`)
      if (msg.t === 'gone') res.end()
    })
    req.on('close', () => stop())
  }

  /** What the terminal's buttons and keys do. Errors come back as text keys (lang.mjs). */
  async function termAction(item, target, op, body) {
    const fail = (key, vars) => ({ ok: false, error: t(key, { name: item.name, ...vars }) })
    try {
      if (op === 'input') {
        const p = await terminals.inputPane(item, target, body.session)
        if (p.error) return fail(p.error)
        const r = await terminals.input(p.pane, body.steps)
        return r.ok ? r : fail(r.error, { why: r.why })
      }
      if (target !== 'shell') return fail('term.err.target')
      if (op === 'open') {
        const r = await terminals.openShell(item, t('term.tabLabel', { name: item.name }))
        publish()
        return r.ok ? r : fail(r.error, { path: r.why })
      }
      if (op === 'close') {
        const r = await terminals.closeShell(item.key)
        publish()
        return r
      }
      if (op !== 'focus') return fail('term.err.target')
      // focus: the shell's tab in herdr, and the terminal window up.
      const shell = terminals.shellOf(item.key)
      if (!shell) return fail('term.err.noShell')
      await herdr(['tab', 'focus', shell.tab])
      if (cfg.raiseTerminal !== false) raiseTerminal(cfg)
      return { ok: true }
    } catch (err) {
      // herdr's message only: nothing typed or read goes to the log or back.
      return fail('term.err.herdr', { why: err.code || err.message })
    }
  }

  const server = http.createServer(async (req, res) => {
    const json = (code, body) => {
      res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      res.end(JSON.stringify(body))
    }
    try {
      if (!new RegExp(`^(127\\.0\\.0\\.1|localhost):${port}$`).test(req.headers.host ?? '')) return json(403, { error: 'host' })
      const url = new URL(req.url, `http://127.0.0.1:${port}`)
      const path = decodeURIComponent(url.pathname)
      const refuseStale = () => stale || !lastSuccessfulRefreshAt || Date.now()-lastSuccessfulRefreshAt > Math.max(10000,(cfg.refreshSec ?? 2)*3000)

      if (req.method === 'GET' && path === '/api/board') {
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
        return res.end(payload)
      }
      if (req.method === 'GET' && path === '/api/events') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' })
        res.write(`retry: 2000\ndata: ${payload}\n\n`)
        clients.add(res)
        req.on('close', () => clients.delete(res))
        return
      }
      // Files and folders the chat mentions: what they are, a preview, opening them (files.mjs).
      if (req.method === 'POST' && path.startsWith('/api/fs/')) {
        if (req.headers['x-board'] !== '1') return json(403, { error: 'header' })
        const body = await readBody(req)
        // Folders only, for the new-session window's folder picker (launch.mjs).
        if (path === '/api/fs/dirs') return json(200, await listDirs(body.path, { git: !!body.git }))
        if (path === '/api/fs/stat') {
          const raws = Array.isArray(body.paths) ? body.paths.slice(0, 300).map(String) : []
          const items = raws.map(raw => {
            const { path: target, line } = resolvePath(raw, body.cwd)
            return { raw, line, ...(target ? describe(target) : { path: '', exists: false }) }
          })
          return json(200, { items })
        }
        const { path: target } = resolvePath(body.path, body.cwd)
        if (!target) return json(400, { error: t('err.fs.missing', { path: String(body.path ?? '') }) })
        if (path === '/api/fs/preview') return json(200, preview(target))
        if (path === '/api/fs/open') {
          if (!describe(target).exists) return json(404, { error: t('err.fs.missing', { path: target }) })
          const r = await openWith(target, body.how === 'reveal' ? 'reveal' : 'open')
          return json(r.ok ? 200 : 500, r.ok ? r : { error: t('err.fs.open', { why: r.error }) })
        }
        return json(404, { error: 'not found' })
      }
      if (req.method === 'POST' && path === '/api/open-url') {
        if (req.headers['x-board'] !== '1') return json(403, { error: 'header' })
        const body = await readBody(req)
        let link = null
        try {
          link = new URL(String(body.url ?? ''))
        } catch {}
        if (!link || !/^https?:$/.test(link.protocol)) return json(400, { error: t('err.fs.open', { why: String(body.url ?? '') }) })
        const r = await openWith(link.href)
        return json(r.ok ? 200 : 500, r.ok ? r : { error: t('err.fs.open', { why: r.error }) })
      }
      // Bytes of an image, PDF, video or audio file for the quick look: the per-run token stands
      // for the X-Board header, which <img>, <video> and the PDF viewer cannot send.
      if (req.method === 'GET' && path === '/api/fs/raw') {
        if (url.searchParams.get('t') !== FILE_TOKEN) return json(403, { error: 'token' })
        const { path: target } = resolvePath(url.searchParams.get('path'))
        const type = MEDIA_TYPES[extname(target).slice(1).toLowerCase()]
        const st = target ? statSync(target, { throwIfNoEntry: false }) : null
        if (!type || !st?.isFile()) return json(404, { error: 'not found' })
        const head = {
          'content-type': type,
          'cache-control': 'no-cache',
          'accept-ranges': 'bytes',
          'x-content-type-options': 'nosniff',
          // An SVG opened on its own runs no script here; the PDF viewer needs no sandbox.
          'content-security-policy': type === 'application/pdf' ? "default-src 'none'; frame-ancestors 'self'" : "default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'; frame-ancestors 'self'; sandbox",
        }
        let start = 0
        let end = st.size - 1
        const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '')
        if (range && (range[1] || range[2])) {
          if (range[1]) {
            start = Number(range[1])
            if (range[2]) end = Math.min(Number(range[2]), end)
          } else start = Math.max(0, st.size - Number(range[2]))
          if (start > end) {
            res.writeHead(416, { 'content-range': `bytes */${st.size}` })
            return res.end()
          }
          res.writeHead(206, { ...head, 'content-range': `bytes ${start}-${end}/${st.size}`, 'content-length': end - start + 1 })
        } else res.writeHead(200, { ...head, 'content-length': st.size })
        if (st.size === 0) return res.end()
        return createReadStream(target, { start, end }).on('error', () => res.destroy()).pipe(res)
      }
      if (req.method === 'POST' && path === '/api/upload') {
        if (req.headers['x-board'] !== '1') return json(403, { error: 'header' })
        const r = await receiveUpload(req, decodeURIComponent(req.headers['x-filename'] ?? 'file'))
        return json(r.ok ? 200 : 413, r)
      }
      const up = /^\/uploads\/(\d{4}-\d{2}-\d{2})\/([^/]+)$/.exec(path)
      if (req.method === 'GET' && up) {
        // Raster images show inline; anything else only downloads, so no uploaded page can run here.
        if (safeName(up[2]) !== up[2]) return json(404, { error: 'not found' })
        const body = await readFile(join(UPLOADS_DIR, up[1], up[2])).catch(() => null)
        if (!body) return json(404, { error: 'not found' })
        const type = IMAGE_TYPES[extname(up[2]).toLowerCase()]
        res.writeHead(200, {
          'content-type': type ?? 'application/octet-stream',
          'content-disposition': type ? 'inline' : `attachment; filename*=UTF-8''${encodeURIComponent(up[2])}`,
          'content-security-policy': "default-src 'none'",
          'x-content-type-options': 'nosniff',
          'cache-control': 'private, max-age=86400',
        })
        return res.end(body)
      }
      if (req.method === 'POST' && path === '/api/settings') {
        if (req.headers['x-board'] !== '1') return json(403, { error: 'header' })
        // Written to config.json; the config watcher switches the language and pushes the new board.
        const r = editSettings(await readBody(req))
        return json(r.ok ? 200 : 409, r)
      }
      if (req.method === 'POST' && path === '/api/schedule') {
        if (req.headers['x-board'] !== '1') return json(403, { error: 'header' })
        const body = await readBody(req)
        const id = String(body.id ?? '')
        // cancel: remove the entry; mode: on time (idle false) or when the session is free.
        const done =
          body.op === 'cancel' ? removeEntry(id)
          : body.op === 'mode' ? updateEntry(id, e => ({ ...e, idle: body.idle ? true : undefined }))
          : undefined
        if (body.op !== 'cancel' && body.op !== 'mode') return json(400, { error: `unknown op ${body.op}` })
        refresh()
        return json(done ? 200 : 404, done ? { ok: true } : { ok: false, error: t('sched.err.gone') })
      }
      if (req.method === 'POST' && path === '/api/categories') {
        if (req.headers['x-board'] !== '1') return json(403, { error: 'header' })
        // Written to config.json; the config watcher reloads it and pushes the new board.
        const r = editCategories(await readBody(req))
        return json(r.ok ? 200 : 409, r)
      }
      // New sessions: what the window offers, starting one, and waving a failed one off.
      if (req.method === 'GET' && path === '/api/launch/options') return json(200, await launches.options())
      if (req.method === 'POST' && path.startsWith('/api/launch')) {
        if (req.headers['x-board'] !== '1') return json(403, { error: 'header' })
        // It starts programs: a browser must also say the request comes from this page.
        const origin = req.headers.origin
        if (origin && origin !== `http://127.0.0.1:${port}` && origin !== `http://localhost:${port}`) return json(403, { error: 'origin' })
        const body = await readBody(req)
        if (path === '/api/launch') {
          if (refuseStale()) return json(409, { ok: false, error: t('mobile.readOnly') })
          const r = await launches.start(body, items)
          return json(r.ok ? 200 : 400, r)
        }
        const d = /^\/api\/launch\/([\w-]+)\/(dismiss|focus|trust|close)$/.exec(path)
        if (d?.[2] === 'dismiss') {
          const r = launches.dismiss(d[1])
          return json(r.ok ? 200 : 404, r)
        }
        // Going to its tab, trusting its folder, closing its tab: all through herdr.
        if (d) {
          if (refuseStale()) return json(409, { ok: false, error: t('mobile.readOnly') })
          const r = await { focus: launches.focus, trust: launches.trust, close: launches.closeTab }[d[2]](d[1])
          return json(r.ok ? 200 : 409, r)
        }
        return json(404, { error: 'not found' })
      }
      // The terminal: a session's pane or the board's shell in its folder, live, and typed into.
      if (path.startsWith('/api/term/')) {
        if (!terminalOn()) return json(404, { error: t('term.off') })
        const tm = /^\/api\/term\/([^/]+)\/(agent|shell)\/(stream|open|close|focus|input)$/.exec(path)
        if (!tm) return json(404, { error: 'not found' })
        const item = find(tm[1])
        if (!item) return json(404, { error: t('err.gone') })
        const [, , target, op] = tm
        if (req.method === 'GET' && op === 'stream') return termStream(req, res, url, item, target)
        if (req.method !== 'POST') return json(405, { error: 'method' })
        if (req.headers['x-board'] !== '1') return json(403, { error: 'header' })
        // It runs commands on this computer: only from the board's own page, on fresh herdr data.
        const origin = req.headers.origin
        if (origin && origin !== `http://127.0.0.1:${port}` && origin !== `http://localhost:${port}`) return json(403, { error: 'origin' })
        if (refuseStale()) return json(409, { ok: false, error: t('mobile.readOnly') })
        const body = await readBody(req)
        const r = await termAction(item, target, op, body)
        return json(r.ok ? 200 : 409, r)
      }
      // One helper of a session, for its window: the id only picks among the session's own.
      const hm = /^\/api\/session\/([^/]+)\/helper\/([A-Za-z0-9-]{1,120})$/.exec(path)
      if (hm && req.method === 'GET') {
        const item = find(hm[1])
        if (!item) return json(404, { error: t('err.gone') })
        let d
        try {
          d = await helperDetail(item.transcript, hm[2], { alive: item.alive, since: item.since })
        } catch {
          // Its files could not be read: no paths in the answer.
          return json(500, { error: t('helpers.unreadable') })
        }
        return d ? json(200, { ...d, conversation: withSessions(d.conversation) }) : json(404, { error: t('helpers.gone') })
      }
      const m = /^\/api\/session\/([^/]+)(?:\/(\w+))?$/.exec(path)
      if (m) {
        const item = find(m[1])
        if (!item) return json(404, { error: t('err.gone') })
        if (req.method === 'GET' && m[2] === 'changes') return json(200, await checkoutChanges(item.cwd))
        if (req.method === 'GET' && m[2] === 'history') return json(200, await searchHistory(item.cwd, url.searchParams.get('q'), undefined, item.session))
        if (req.method === 'GET' && !m[2]) return json(200, await detail(item))
        if (req.method === 'POST' && m[2]) {
          if (req.headers['x-board'] !== '1') return json(403, { error: 'header' })
          // Answering a dialog presses keys in a session: like a launch, only from this page.
          const origin = req.headers.origin
          if (['answer', 'permit'].includes(m[2]) && origin && origin !== `http://127.0.0.1:${port}` && origin !== `http://localhost:${port}`) return json(403, { error: 'origin' })
          // Actions that go through herdr wait for a board that can reach it; card edits and the rest do not.
          if (['focus', 'wake', 'sleep', 'message', 'answer', 'permit'].includes(m[2]) && refuseStale()) return json(409, { ok: false, error: t('mobile.readOnly') })
          const body = await readBody(req)
          if (m[2] === 'rename' && body.claude && refuseStale()) return json(409, { ok: false, error: t('mobile.readOnly') })
          const r = await act(item, m[2], body)
          refresh()
          return json(r.ok ? 200 : 409, r)
        }
      }
      if (req.method === 'GET') {
        const name = path === '/' ? 'index.html' : path.slice(1)
        if (!/^[\w.-]+$/.test(name) || !TYPES[extname(name)]) return json(404, { error: 'not found' })
        const body = await readFile(join(WEB, name)).catch(() => null)
        if (!body) return json(404, { error: 'not found' })
        res.writeHead(200, {
          'content-type': TYPES[extname(name)],
          'cache-control': 'no-cache',
          'x-content-type-options': 'nosniff',
          ...(name.endsWith('.html') ? { 'content-security-policy': PAGE_CSP } : {}),
        })
        return res.end(body)
      }
      json(405, { error: 'method' })
    } catch (err) {
      // The path only: a query can carry the page's token.
      log(`${req.method} ${req.url.split('?')[0]}: ${err.message}`)
      if (!res.headersSent) json(500, { error: err.message })
    }
  })

  // Comments keep idle connections from being dropped.
  const ping = setInterval(() => {
    for (const res of clients) res.write(': ping\n\n')
  }, 20_000)
  const poll = setInterval(refresh, Math.max(1, cfg.refreshSec ?? 2) * 1000)
  let timer = null
  try {
    mkdirSync(CARDS_DIR, { recursive: true })
    watch(CARDS_DIR, () => {
      clearTimeout(timer)
      timer = setTimeout(refresh, 150)
    })
  } catch {}
  // Entries added or cancelled by agents (`board remind`), and runs the scheduler made.
  let scheduleTimer = null
  try {
    mkdirSync(SCHEDULE_DIR, { recursive: true })
    const watcher = watch(SCHEDULE_DIR, () => {
      clearTimeout(scheduleTimer)
      scheduleTimer = setTimeout(refresh, 150)
    })
    // A deleted folder errors on Windows (EPERM), which unhandled ends the board; the poll goes on.
    watcher.on('error', () => watcher.close())
  } catch {}
  let webTimer = null
  try {
    watch(WEB, () => {
      clearTimeout(webTimer)
      webTimer = setTimeout(() => {
        version = assetsVersion()
        refresh()
      }, 200)
    })
  } catch {}

  return new Promise((resolve, reject) => {
    server.once('error', err => {
      clearInterval(ping)
      clearInterval(poll)
      reject(err)
    })
    server.listen(port, '127.0.0.1', () => {
      refresh()
      // The port makes it one board per machine, so one scheduler; claims cover an overlap.
      const scheduler = startScheduler({ cfg, log, onChange: refresh })
      // Shells a board before this one opened and that are gone by now are forgotten.
      if (terminalOn()) terminals.prune()
      resolve({ port, url: `http://127.0.0.1:${port}/`, refresh, scheduler })
    })
  })
}

// The bytes are put together before they are read as text: a character split between two chunks
// would come apart otherwise (and the terminal types what it gets).
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', chunk => {
      size += chunk.length
      if (size > 192 << 10) return reject(new Error('body too large'))
      chunks.push(chunk)
    })
    req.on('end', () => {
      const data = Buffer.concat(chunks).toString('utf8')
      try {
        resolve(data ? JSON.parse(data) : {})
      } catch {
        reject(new Error('bad json'))
      }
    })
  })
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startServer({ log: msg => console.error(msg) })
    .then(s => console.log(`agent board: ${s.url}`))
    .catch(err => {
      console.error(err.code === 'EADDRINUSE' ? 'agent board: the port is taken, another board already serves it' : err.message)
      process.exit(1)
    })
}
