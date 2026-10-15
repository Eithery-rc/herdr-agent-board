import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { digest, statusText } from '../src/statusline.mjs'
import { localUsage } from '../src/usage.mjs'

// The status line input as Claude Code documents it (trimmed to what the board reads).
const input = {
  session_id: 'abc-123',
  context_window: { context_window_size: 200000, used_percentage: 8, current_usage: { input_tokens: 8500, output_tokens: 1200, cache_creation_input_tokens: 5000, cache_read_input_tokens: 2000 } },
  rate_limits: { five_hour: { used_percentage: 23.5, resets_at: 1738425600 }, seven_day: { used_percentage: 41.2, resets_at: 1738857600 } },
}
const plain = s => s.replace(/\x1b\[[0-9;]*m/g, '')

test('status line input: usage windows, context fill and the session', () => {
  const d = digest(input, 1000)
  assert.deepEqual(d.usage, { fetchedAtMs: 1000, fiveHour: { usedPercentage: 23.5, resetsAt: 1738425600 }, sevenDay: { usedPercentage: 41.2, resetsAt: 1738857600 } })
  assert.deepEqual(d.context, { usedPercentage: 8, size: 200000, tokens: 15500, at: 1000 }) // output tokens left out
  assert.equal(d.session, 'abc-123')
  assert.equal(plain(statusText(d)), 'ctx 8% · 5h 24% · 7d 41%')
  // Before the first reply, or on a plan without windows: nothing to keep, nothing to show.
  assert.deepEqual(digest({ session_id: 'x', context_window: { used_percentage: null, current_usage: null } }), { usage: null, context: null, session: 'x' })
  assert.equal(statusText(digest({})), '')
  assert.equal(digest({ rate_limits: { five_hour: { used_percentage: 120 } } }).usage, null)
})

test('as the command Claude runs: files for the board, the line on stdout, old windows kept on an empty input', t => {
  const dir = mkdtempSync(join(tmpdir(), 'board-statusline-'))
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }))
  const script = fileURLToPath(new URL('../src/statusline.mjs', import.meta.url))
  const run = stdin => spawnSync(process.execPath, [script], { input: JSON.stringify(stdin), encoding: 'utf8', env: { ...process.env, LOCALAPPDATA: dir, APPDATA: dir } })
  const out = run(input)
  assert.equal(out.status, 0)
  assert.equal(plain(out.stdout), 'ctx 8% · 5h 24% · 7d 41%')
  const state = join(dir, 'herdr', 'plugins', 'agent-board')
  const usage = JSON.parse(readFileSync(join(state, 'claude-limits-latest.json'), 'utf8'))
  assert.equal(usage.fiveHour.usedPercentage, 23.5)
  assert.equal(JSON.parse(readFileSync(join(state, 'context', 'abc-123.json'), 'utf8')).usedPercentage, 8)
  assert.equal(run({}).status, 0)
  assert.equal(JSON.parse(readFileSync(join(state, 'claude-limits-latest.json'), 'utf8')).fiveHour.usedPercentage, 23.5)
  assert.equal(run('not json').stdout, '') // a bad input leaves the line blank, no error
  // The board reads it with the usagebar reader: resets in seconds become milliseconds.
  const read = localUsage(state, usage.fetchedAtMs + 1000).limits
  assert.equal(read.available, true)
  assert.deepEqual(read.windows.map(w => [w.minutes, w.usedPercentage, w.resetsAt]), [[300, 23.5, 1738425600000], [10080, 41.2, 1738857600000]])
})
