// The board's settings, %APPDATA%\herdr\plugins\config\agent-board\config.json. Written with
// the defaults on first use; edited by hand or from the web board, and picked up live by the
// running board (liveConfig). Categories are the board's lanes, in this order; `paths` guess the
// category of a session from its folder (the longest match wins) until the agent sets one
// itself. Agents may use ids that are not listed: they get a lane too.
import { existsSync, mkdirSync, readFileSync, renameSync, watch, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { LANGUAGES } from '../web/i18n.js'
import { t, useLanguage } from './lang.mjs'
import { CONFIG_DIR } from './paths.mjs'
import { allCards, writeCard } from './store.mjs'

export const CONFIG_FILE = join(CONFIG_DIR, 'config.json')

// Apple's system colors; a category's color is one of these names or a #hex.
export const PALETTE = {
  blue: '#007AFF', cyan: '#32ADE6', teal: '#30B0C7', mint: '#00C7BE', green: '#34C759', yellow: '#FFCC00',
  orange: '#FF9500', red: '#FF3B30', pink: '#FF2D55', magenta: '#FF2D55', purple: '#AF52DE', indigo: '#5856D6',
  brown: '#A2845E', gray: '#8E8E93', white: '#8E8E93',
}
const validColor = c => !!PALETTE[c] || /^#[0-9a-f]{3,8}$/i.test(String(c))
export const colorHex = c => PALETTE[c] ?? (validColor(c) ? c : PALETTE.gray)

const DEFAULTS = {
  // "auto" (the system's language), "en" or "ru": the board's texts and the language agents
  // write their cards in.
  language: 'auto',
  // A start; lanes for clients come from the agents (`board cat <id> "<Title>"`) or the web
  // board's category editor, which also sets the folders that guess a session's lane. These
  // three have no title of their own: they read in the board's language until one is given.
  categories: [
    { id: 'work', color: 'cyan', paths: [] },
    { id: 'personal', color: 'green', paths: [] },
    { id: 'other', color: 'gray', paths: [] },
  ],
  // workspace: a workspace of its own that stays open (default); tab: a tab in the current
  // workspace; overlay: over the current pane, closed when you leave it
  placement: 'workspace',
  workspace: 'Board',
  refreshSec: 2,
  // herdr-wake router, for sleeping sessions; the board works without it
  wakeUrl: 'http://127.0.0.1:12421',
  // A reminder due while its session works or waits on a dialog is tried this long, then missed.
  scheduleWaitMin: 240,
  // The web board's terminal (a shell in a session's folder, the session's own pane): false
  // turns it off, say for a board opened from elsewhere through a tunnel.
  terminal: true,
}

function readRaw() {
  try {
    return JSON.parse(readFileSync(CONFIG_FILE, 'utf8'))
  } catch {
    return null
  }
}

function writeRaw(raw) {
  mkdirSync(CONFIG_DIR, { recursive: true })
  const tmp = `${CONFIG_FILE}.${process.pid}.tmp`
  writeFileSync(tmp, `${JSON.stringify(raw, null, 2)}\n`)
  renameSync(tmp, CONFIG_FILE)
}

export function loadConfig() {
  const raw = readRaw()
  if (!raw && !existsSync(CONFIG_FILE)) {
    try {
      writeRaw(DEFAULTS)
    } catch {}
  }
  const cfg = raw ?? {}
  useLanguage(cfg.language ?? DEFAULTS.language)
  const cats = cfg.categories?.length ? cfg.categories : structuredClone(DEFAULTS.categories)
  return { ...DEFAULTS, ...cfg, categories: cats.map(c => (c.title ? c : { ...c, title: builtinTitle(c.id) })) }
}

/** Title of a lane that has none: the built-in ones in the board's language, else the id. */
function builtinTitle(id) {
  const key = `lane.${id}`
  const title = t(key)
  return title === key ? id : title
}

/** Change settings in config.json from the web board: { language }. */
export function editSettings(body) {
  const raw = readRaw() ?? structuredClone(DEFAULTS)
  if (body?.language !== undefined) {
    const l = String(body.language)
    if (l !== 'auto' && !LANGUAGES[l]) return { ok: false, error: t('err.language', { lang: l }) }
    raw.language = l
  }
  writeRaw(raw)
  return { ok: true }
}

/**
 * The config, kept current: the returned object is updated in place whenever config.json
 * changes (by hand or from the web board), then `onChange` runs. One watcher per process.
 */
export function liveConfig(onChange = () => {}) {
  const cfg = loadConfig()
  let timer = null
  let last = JSON.stringify(cfg)
  try {
    mkdirSync(CONFIG_DIR, { recursive: true })
    watch(CONFIG_DIR, (_, name) => {
      if (name && name !== 'config.json') return
      clearTimeout(timer)
      timer = setTimeout(() => {
        // A half-written file by an editor reads as invalid: keep the last good config then.
        if (!readRaw()) return
        const next = loadConfig()
        const text = JSON.stringify(next)
        if (text === last) return
        last = text
        for (const k of Object.keys(cfg)) delete cfg[k]
        Object.assign(cfg, next)
        onChange(cfg)
      }, 120)
    })
  } catch {}
  return cfg
}

const ID = /^[a-z0-9_-]{1,32}$/

function cleanPaths(paths) {
  if (!Array.isArray(paths)) return null
  return [...new Set(paths.map(p => String(p ?? '').trim().replace(/[\\/]+$/, '')).filter(Boolean))]
}

/**
 * Change the categories in config.json: { op: 'create' | 'update' | 'delete' | 'order', ... }.
 * Ids are fixed once created (cards point at them). Deleting one drops it from the cards that
 * named it, so those sessions fall back to the folder guess. "other" is the fallback lane and stays.
 */
export function editCategories(body) {
  const raw = readRaw() ?? structuredClone(DEFAULTS)
  const cats = raw.categories?.length ? raw.categories : structuredClone(DEFAULTS.categories)
  const find = id => cats.find(c => c.id === id)
  const title = t => String(t ?? '').trim().slice(0, 40)
  switch (body?.op) {
    case 'create': {
      const id = String(body.id ?? '').trim().toLowerCase()
      if (!ID.test(id)) return { ok: false, error: t('err.cat.id') }
      if (find(id)) return { ok: false, error: t('err.cat.exists', { id }) }
      const cat = { id, title: title(body.title) || id, color: validColor(body.color) ? body.color : 'blue', paths: cleanPaths(body.paths) ?? [] }
      const other = cats.findIndex(c => c.id === 'other')
      cats.splice(other >= 0 ? other : cats.length, 0, cat)
      break
    }
    case 'update': {
      const cat = find(body.id)
      if (!cat) return { ok: false, error: t('err.cat.missing', { id: body.id }) }
      if (body.title !== undefined) {
        if (!title(body.title)) return { ok: false, error: t('err.cat.emptyTitle') }
        cat.title = title(body.title)
      }
      if (body.color !== undefined && validColor(body.color)) cat.color = body.color
      if (body.paths !== undefined) cat.paths = cleanPaths(body.paths) ?? cat.paths
      break
    }
    case 'delete': {
      if (body.id === 'other') return { ok: false, error: t('err.cat.other', { title: t('q', { s: find('other')?.title || builtinTitle('other') }) }) }
      const i = cats.findIndex(c => c.id === body.id)
      if (i < 0) return { ok: false, error: t('err.cat.missing', { id: body.id }) }
      cats.splice(i, 1)
      for (const card of allCards().values()) if (card.category === body.id) writeCard(card.key, { category: '' })
      break
    }
    case 'order': {
      const ids = Array.isArray(body.ids) ? body.ids : []
      const rank = id => (ids.includes(id) ? ids.indexOf(id) : ids.length + cats.findIndex(c => c.id === id))
      cats.sort((a, b) => rank(a.id) - rank(b.id))
      break
    }
    default:
      return { ok: false, error: `unknown op ${body?.op}` }
  }
  raw.categories = cats
  writeRaw(raw)
  return { ok: true }
}

const norm = p => String(p ?? '').replace(/[\\/]+/g, '/').replace(/\/$/, '').toLowerCase()

/** The category id configured for a folder, or null. */
export function categoryFor(cfg, cwd) {
  const dir = norm(cwd)
  let best = null
  let bestLen = -1
  for (const c of cfg.categories) {
    for (const p of c.paths ?? []) {
      const n = norm(p)
      if (n && (dir === n || dir.startsWith(`${n}/`)) && n.length > bestLen) {
        best = c.id
        bestLen = n.length
      }
    }
  }
  return best
}

/** Sort key of a lane: config order, with lanes agents made up just before "other". */
export function laneRank(cfg, id) {
  const order = cfg.categories.map(c => c.id)
  const i = order.indexOf(id)
  if (i >= 0) return i
  const other = order.indexOf('other')
  return other >= 0 ? other - 0.5 : order.length
}

/** Category record for an id, including ids agents made up. */
export function categoryInfo(cfg, id) {
  return cfg.categories.find(c => c.id === id) ?? { id, title: builtinTitle(id), color: 'gray', paths: [] }
}
