// New sessions from the board, the logic without a page: what a name may be, herdr's name for
// it, folders as typed, and what the "new session" window offers by default in each context.
// Shared by the browser (launch.js) and the server (src/launch.mjs), so both check the same way.

export const NAME_MAX = 60

/** Why a session name is refused (a key of the texts), or '' when it is fine. */
export function checkName(name) {
  const s = String(name ?? '').trim()
  if (!s) return 'launch.err.nameEmpty'
  if (s.length > NAME_MAX) return 'launch.err.nameLong'
  if (/[\u0000-\u001f\u007f]/.test(s)) return 'launch.err.nameChars'
  // A leading dash reads as an option to a launcher, a slash as a Claude command.
  if (/^[-/]/.test(s)) return 'launch.err.nameStart'
  return ''
}

const TRANSLIT = { а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'c', ч: 'ch', ш: 'sh', щ: 'sch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya' }

/** herdr's name for addressing an agent: [a-z][a-z0-9_-]{0,31}, Cyrillic spelled in latin. */
export function slugName(name) {
  let s = [...String(name ?? '').toLowerCase()]
    .map(c => TRANSLIT[c] ?? c)
    .join('')
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
  if (!s) s = 'session'
  if (!/^[a-z]/.test(s)) s = `s-${s}`
  return s.slice(0, 32).replace(/-+$/, '')
}

/** `slug`, or slug-2, slug-3… when a live agent has that name already. */
export function uniqueSlug(slug, taken) {
  if (!taken.has(slug)) return slug
  for (let n = 2; ; n++) {
    const tail = `-${n}`
    const next = slug.slice(0, 32 - tail.length) + tail
    if (!taken.has(next)) return next
  }
}

/** A git branch name a worktree may take (a conservative subset of git's rules). */
export function checkBranch(name) {
  const s = String(name ?? '').trim()
  if (!s) return 'launch.err.branchEmpty'
  if (!/^[A-Za-z0-9._/-]+$/.test(s) || /^[-./]|[./]$|\.\.|\/\/|@\{|\.lock$/.test(s) || s.length > 100) return 'launch.err.branch'
  return ''
}

/** Where a new worktree of `root` goes: a sibling folder named after the branch, like repo-feature. */
export function worktreePath(root, branch) {
  const clean = String(root ?? '').replace(/[\\/]+$/, '')
  const sep = clean.includes('\\') ? '\\' : '/'
  const cut = clean.lastIndexOf(sep)
  const base = clean.slice(cut + 1)
  const tail = String(branch).replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '')
  return `${clean.slice(0, cut + 1)}${base}-${tail}`
}

export const isAbsolutePath = p => /^([A-Za-z]:[\\/]|\\\\|\/|~([\\/]|$))/.test(String(p ?? '').trim())

/** A folder for comparing: slashes one way, no trailing one, case folded (Windows paths). */
export const normDir = p => String(p ?? '').trim().replace(/[\\/]+/g, '/').replace(/(.)\/$/, '$1').toLowerCase()
export const sameDir = (a, b) => !!a && !!b && normDir(a) === normDir(b)

/** Last folder name of a path. */
export const baseName = p => String(p ?? '').replace(/[\\/]+$/, '').split(/[\\/]/).pop() || String(p ?? '')

/**
 * A path being typed, split for completion: the folder to list and the start of the name in it.
 * "C:\Work\Pe" -> { dir: "C:\Work\", prefix: "Pe", sep: "\" }.
 */
export function splitPathInput(text) {
  const s = String(text ?? '').replace(/^["']|["']$/g, '')
  const cut = Math.max(s.lastIndexOf('\\'), s.lastIndexOf('/'))
  const sep = s.includes('\\') || /^[A-Za-z]:/.test(s) ? '\\' : '/'
  if (cut < 0) return { dir: '', prefix: s, sep }
  return { dir: s.slice(0, cut + 1), prefix: s.slice(cut + 1), sep }
}

/** Folder names that match what is typed: names starting with it first, then names containing it. */
export function completions(names, prefix, limit = 8) {
  const p = String(prefix ?? '').toLowerCase()
  const shown = names.filter(n => !n.startsWith('.') || p.startsWith('.'))
  if (!p) return shown.slice(0, limit)
  const starts = shown.filter(n => n.toLowerCase().startsWith(p))
  const has = shown.filter(n => !n.toLowerCase().startsWith(p) && n.toLowerCase().includes(p))
  return [...starts, ...has].slice(0, limit)
}

/** The category a folder falls in by the lanes' folders, longest match first (config.mjs categoryFor). */
export function categoryForDir(categories, dir) {
  const d = normDir(dir)
  let best = null
  let len = -1
  for (const c of categories ?? []) {
    for (const p of c.paths ?? []) {
      const n = normDir(p)
      if (n && (d === n || d.startsWith(`${n}/`)) && n.length > len) {
        best = c.id
        len = n.length
      }
    }
  }
  return best
}

/**
 * Folders to offer, most useful first and each once: the card's own folder, the lane's folders,
 * then folders of sessions on the board and of recent Claude sessions on this machine.
 */
export function folderSuggestions({ context = {}, categories = [], items = [], recent = [] }, limit = 10) {
  const out = []
  // Scratch folders under the system's temp are where sessions try things, not where work starts.
  const temp = p => /[\\/](appdata[\\/]local[\\/]temp|tmp)([\\/]|$)/i.test(p)
  const add = (path, why) => {
    if (path && isAbsolutePath(path) && (why === 'card' || !temp(path)) && !out.some(o => sameDir(o.path, path))) out.push({ path, why })
  }
  add(context.cwd, 'card')
  const lane = categories.find(c => c.id === context.category)
  for (const p of lane?.paths ?? []) add(p, 'lane')
  const live = [...items].sort((a, b) => (b.activity ?? 0) - (a.activity ?? 0))
  for (const it of live) if (!context.category || it.category === context.category) add(it.cwd, 'session')
  for (const p of recent) add(p, 'recent')
  for (const it of live) add(it.cwd, 'session')
  for (const c of categories) for (const p of c.paths ?? []) add(p, 'lane')
  return out.slice(0, limit)
}

/** A name for a session in `cwd` that no session on the board has: the folder's name, then "name 2"… */
export function suggestName(cwd, items = []) {
  const base = baseName(cwd).slice(0, NAME_MAX - 3).replace(/^[-/]+/, '') || 'session'
  const taken = new Set(items.map(i => String(i.name ?? '').toLowerCase()))
  if (!taken.has(base.toLowerCase())) return base
  for (let n = 2; ; n++) if (!taken.has(`${base} ${n}`.toLowerCase())) return `${base} ${n}`
}

/**
 * Where a session for `category` opens by default: the workspace most of that lane's sessions
 * are in, else one named like the lane, else `fallback` (the last one used). The board's own
 * workspace is never a default. Returns a workspace id, or '' for a new one.
 */
export function defaultWorkspace({ category, title = '', items = [], workspaces = [], board = '', fallback = '' }) {
  const usable = workspaces.filter(w => w.label !== board || !board)
  const byLabel = label => usable.find(w => w.label === label)
  const counts = new Map()
  for (const it of items) if (it.category === category && it.workspace && byLabel(it.workspace)) counts.set(it.workspace, (counts.get(it.workspace) ?? 0) + 1)
  const top = [...counts].sort((a, b) => b[1] - a[1])[0]
  if (top) return byLabel(top[0]).id
  const t = String(title).toLowerCase()
  const named = t && usable.find(w => w.label.toLowerCase() === t || w.label.toLowerCase().startsWith(`${t} `))
  if (named) return named.id
  return usable.some(w => w.id === fallback) ? fallback : ''
}
