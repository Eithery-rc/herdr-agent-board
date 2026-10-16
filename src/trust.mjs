// Claude Code's folder-trust dialog, read off a pane's screen. A launch in a folder Claude has
// not seen stops there ("Accessing workspace: <folder>", "❯ No, exit", "Yes, I trust this
// folder"); the board shows it on the launch's card and, when asked, moves the cursor to "Yes"
// and confirms. Nothing is assumed: the folder and where the cursor is come from the screen.
import { homedir } from 'node:os'

const ESCAPES = /\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b./g
const OPTION = /^\s*(❯\s*)?(?:\d+\.\s*)?(.*\S)\s*$/

/**
 * The trust dialog at the bottom of `screen` (plain or ANSI): { folder, options, selected }, or
 * null when the screen does not end in one. options: ['no', 'yes'] in their order on screen;
 * selected: which one the ❯ is on, or null. The folder is the one the dialog names, its lines
 * (Claude wraps a long path) joined.
 */
export function trustDialog(screen) {
  const lines = String(screen ?? '').replace(ESCAPES, '').split(/\r?\n/).map(l => l.replace(/\s+$/, ''))
  const head = lines.findLastIndex(l => /^\s*Accessing workspace:\s*$/i.test(l))
  if (head < 0) return null
  const rest = lines.slice(head + 1)
  const ask = rest.findIndex(l => /quick safety check|do you trust|trust the files/i.test(l))
  if (ask <= 0) return null
  const folder = rest.slice(0, ask).map(l => l.trim()).join('')
  const options = []
  let selected = null
  let last = -1
  rest.slice(ask + 1).forEach((line, i) => {
    const m = OPTION.exec(line)
    if (!m) return
    const which = /^yes\b.*\b(trust|proceed)\b/i.test(m[2]) ? 'yes' : /^no\b.*\bexit\b/i.test(m[2]) ? 'no' : null
    if (!which) return
    options.push(which)
    last = ask + 1 + i
    if (m[1]) selected = which
  })
  if (!options.includes('yes') || !options.includes('no')) return null
  // Only the dialog Claude shows now: under its options nothing but its own footer.
  const below = rest.slice(last + 1).filter(l => l.trim())
  if (below.length > 2 || below.some(l => !/enter to confirm|esc to cancel|to select/i.test(l))) return null
  return { folder, options, selected }
}

/**
 * Whether the folder a dialog names is `cwd`. Claude may break a path where it had a space, and
 * shows home as ~ on some systems: both are compared without spaces, slashes one way, case folded.
 */
export function sameFolder(onScreen, cwd) {
  const norm = p =>
    String(p ?? '')
      .replace(/^~(?=$|[\\/])/, homedir())
      .replace(/\s+/g, '')
      .replace(/[\\/]+/g, '/')
      .replace(/\/$/, '')
      .toLowerCase()
  return !!onScreen && norm(onScreen) === norm(cwd)
}

/** The key that moves the cursor one step toward "Yes", '' when it is there, null when unknown. */
export function keyTowardYes(dialog) {
  if (!dialog?.selected) return null
  const at = dialog.options.indexOf(dialog.selected)
  const yes = dialog.options.indexOf('yes')
  return at === yes ? '' : at < yes ? 'down' : 'up'
}
