// Claude Code's status line (settings.json statusLine; the install action sets it when there is
// none). Claude runs it after every reply with the session's state on stdin. The board keeps:
//   the account's usage windows (rate_limits: 5 hours, 7 days) in USAGE_FILE, the same shape as
//   the usagebar cache, so one reader serves both (usage.mjs)
//   each session's context fill (context_window) in CONTEXT_DIR/<session id>.json
// and it prints one short line under the prompt, e.g. "ctx 34% · 5h 23% · 7d 41%".
// It never fails loudly: a bad input leaves the line blank and the files as they were.
import { mkdirSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { CONTEXT_DIR, USAGE_FILE } from './paths.mjs'

const num = v => typeof v === 'number' && Number.isFinite(v)
const pct = v => num(v) && v >= 0 && v <= 100
const safe = key => String(key).replace(/[^A-Za-z0-9_-]/g, '_')

/** What the board keeps from one status line input: { usage, context, session }; pure. */
export function digest(input, now = Date.now()) {
  const usage = { fetchedAtMs: now }
  for (const [from, to] of [['five_hour', 'fiveHour'], ['seven_day', 'sevenDay']]) {
    const w = input?.rate_limits?.[from]
    if (w && pct(w.used_percentage)) usage[to] = { usedPercentage: w.used_percentage, resetsAt: num(w.resets_at) ? w.resets_at : null }
  }
  const c = input?.context_window
  const u = c?.current_usage
  const tokens = u ? (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) : null
  const context =
    c && (pct(c.used_percentage) || tokens)
      ? { usedPercentage: pct(c.used_percentage) ? c.used_percentage : null, size: num(c.context_window_size) ? c.context_window_size : null, tokens, at: now }
      : null
  return {
    usage: usage.fiveHour || usage.sevenDay ? usage : null,
    context,
    session: typeof input?.session_id === 'string' && input.session_id ? input.session_id : null,
  }
}

/** The line under the prompt: dim labels, the numbers yellow from 70% and red from 90%. */
export function statusText(d) {
  const tone = p => (p >= 90 ? '\x1b[31m' : p >= 70 ? '\x1b[33m' : '\x1b[0m')
  const part = (label, p) => `\x1b[2m${label}\x1b[0m ${tone(p)}${Math.round(p)}%\x1b[0m`
  const parts = []
  if (d.context?.usedPercentage != null) parts.push(part('ctx', d.context.usedPercentage))
  else if (d.context?.tokens) parts.push(`\x1b[2mctx\x1b[0m ${Math.round(d.context.tokens / 1000)}k`)
  if (d.usage?.fiveHour) parts.push(part('5h', d.usage.fiveHour.usedPercentage))
  if (d.usage?.sevenDay) parts.push(part('7d', d.usage.sevenDay.usedPercentage))
  return parts.join('\x1b[2m · \x1b[0m')
}

function save(file, data) {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(data))
  renameSync(tmp, file)
}

/** Context files of sessions gone a week: dropped now and then. */
function prune(now) {
  for (const name of readdirSync(CONTEXT_DIR)) {
    const file = join(CONTEXT_DIR, name)
    try {
      if (now - statSync(file).mtimeMs > 7 * 86_400_000) unlinkSync(file)
    } catch {}
  }
}

async function main() {
  let raw = ''
  for await (const chunk of process.stdin) raw += chunk
  const now = Date.now()
  const d = digest(JSON.parse(raw || '{}'), now)
  // An input without windows (before the first reply, other plans) keeps the last good ones.
  if (d.usage) save(USAGE_FILE, d.usage)
  if (d.context && d.session) {
    save(join(CONTEXT_DIR, `${safe(d.session)}.json`), d.context)
    if (Math.random() < 0.02) prune(now)
  }
  process.stdout.write(statusText(d))
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(() => {})
