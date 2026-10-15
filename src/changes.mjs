// A bounded, read-only view of the checkout containing the session's cwd.
import { execFile } from 'node:child_process'
import { resolve } from 'node:path'
const LIMIT = 256 * 1024
function git(cwd, args) {
  return new Promise((resolve, reject) => {
    execFile('git', ['--no-pager', '--no-optional-locks', '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', '-C', cwd, ...args], {
      encoding: 'utf8', timeout: 5000, maxBuffer: LIMIT,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_EXTERNAL_DIFF: '', GIT_PAGER: '' },
    }, (err, stdout) => {
      if (err && err.code !== 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return reject(new Error('Git checkout unavailable'))
      resolve({ text: String(stdout).slice(0, LIMIT), truncated: !!err })
    })
  })
}
export async function checkoutChanges(cwd) {
  if (!cwd || typeof cwd !== 'string') return { available: false }
  try {
    const top = (await git(cwd, ['rev-parse', '--show-toplevel'])).text.trim()
    if (!top) return { available: false }
    const root = resolve(top) // git says C:/x on Windows; the rest of the board writes C:\x
    // allSettled: every git run is over before this returns, even when one failed early (a repo
    // with no commit yet), so none is left working in the folder.
    const runs = await Promise.allSettled([
      git(root, ['rev-parse', '--abbrev-ref', 'HEAD']),
      git(root, ['status', '--porcelain=v1', '--untracked-files=normal']),
      git(root, ['diff', '--no-ext-diff', '--no-textconv', '--no-color', 'HEAD', '--']),
    ])
    if (runs.some(r => r.status === 'rejected')) return { available: false }
    const [branch, status, diff] = runs.map(r => r.value)
    return { available: true, root, branch: branch.text.trim(), status: status.text, diff: diff.text, truncated: status.truncated || diff.truncated, collectedAt: Date.now() }
  } catch { return { available: false } }
}

const known = new Map() // folder -> { at, yes }

/** Whether a folder sits in a git checkout; a minute per folder, since the session sheet asks on every open. */
export async function isCheckout(cwd) {
  if (!cwd || typeof cwd !== 'string') return false
  const hit = known.get(cwd)
  if (hit && Date.now() - hit.at < 60_000) return hit.yes
  let yes = false
  try {
    yes = !!(await git(cwd, ['rev-parse', '--show-toplevel'])).text.trim()
  } catch {}
  known.set(cwd, { at: Date.now(), yes })
  return yes
}
