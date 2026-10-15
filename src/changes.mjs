// A bounded, read-only view of the checkout containing the session's cwd.
import { execFile } from 'node:child_process'
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
    const root = (await git(cwd, ['rev-parse', '--show-toplevel'])).text.trim()
    if (!root) return { available: false }
    const [branch, status, diff] = await Promise.all([
      git(root, ['rev-parse', '--abbrev-ref', 'HEAD']),
      git(root, ['status', '--porcelain=v1', '--untracked-files=normal']),
      git(root, ['diff', '--no-ext-diff', '--no-textconv', '--no-color', 'HEAD', '--']),
    ])
    return { available: true, root, branch: branch.text.trim(), status: status.text, diff: diff.text, truncated: status.truncated || diff.truncated, collectedAt: Date.now() }
  } catch { return { available: false } }
}
