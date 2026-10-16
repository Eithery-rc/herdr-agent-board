import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { sandbox, until } from './fixtures/sandbox.mjs'

async function unusedPort() {
  const server = http.createServer()
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  await new Promise(resolve => server.close(resolve))
  return port
}

/** herdr as the board sees it: one Claude session in w1:p1; a tab create gives w1:p9 in w1:t9. */
function herdrState(cwd, { session = 's1', snapshot = true } = {}) {
  return {
    'api snapshot': snapshot ? { result: { snapshot: { panes: [{ pane_id: 'w1:p1', agent: 'claude', agent_session: { value: 's1' }, agent_status: 'idle', cwd }], tabs: [], workspaces: [] } } } : { error: 'offline' },
    'pane get w1:p1': { result: { pane: { pane_id: 'w1:p1', workspace_id: 'w1', tab_id: 'w1:t1' } } },
    'pane get w1:p9': { result: { pane: { pane_id: 'w1:p9', workspace_id: 'w1', tab_id: 'w1:t9' } } },
    'tab create': { result: { root_pane: { pane_id: 'w1:p9', tab_id: 'w1:t9' }, tab: { tab_id: 'w1:t9' } } },
    'pane list': { result: { panes: [{ pane_id: 'w1:p9', tab_id: 'w1:t9' }] } },
    'pane send-text': { result: null },
    'pane send-keys': { result: null },
    'pane read': { text: 'PS> \n' },
    'pane layout': { result: { layout: { panes: [{ pane_id: 'w1:p9', rect: { width: 82, height: 30 } }] } } },
    'agent get': { result: { agent: { agent_session: { value: session } } } },
    'pane close': { result: null },
    'tab close': { result: null },
    'tab focus': { result: null },
  }
}

async function board(t, cfg = {}) {
  const box = sandbox(t)
  const cwd = join(box.dir, 'work')
  mkdirSync(cwd)
  box.state(herdrState(cwd))
  const port = await unusedPort()
  const proc = box.run('server', { port, categories: [{ id: 'other', title: 'Other', color: 'gray' }], wakeUrl: null, refreshSec: 3600, language: 'en', raiseTerminal: false, ...cfg })
  await until(() => proc.messages.some(m => m.ready))
  const url = `http://127.0.0.1:${port}`
  // The session on the board (the first refresh may still be under way).
  for (let i = 0; i < 50 && !(await fetch(`${url}/api/board`).then(r => r.json())).items.length; i++) {
    proc.send('refresh')
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  const post = (path, body = {}, headers = { 'x-board': '1' }) =>
    fetch(url + path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) }).then(async r => ({ status: r.status, body: await r.json() }))
  const payload = () => fetch(`${url}/api/board`).then(r => r.json())
  const typed = () => box.calls().filter(a => a[0] === 'pane' && /^send-/.test(a[1])).map(a => a.slice(1))
  return { box, proc, cwd, url, post, payload, typed }
}

/** The first event of a terminal stream. */
async function firstEvent(url) {
  const controller = new AbortController()
  const res = await fetch(url, { signal: controller.signal })
  const reader = res.body.getReader()
  let text = ''
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) return null
      text += new TextDecoder().decode(value)
      const m = /data: (.*)\n\n/.exec(text)
      if (m) return JSON.parse(m[1])
    }
  } finally {
    controller.abort()
  }
}

test('the terminal: only the page’s own requests, its own shell, the same session, fresh data; nothing typed in the log', { timeout: 60_000 }, async t => {
  const { box, proc, cwd, url, post, payload, typed } = await board(t)
  const before = await payload()
  assert.equal(before.terminal, true)
  assert.deepEqual(before.shells, [])

  // Without the header, from another site: nothing reaches herdr.
  assert.equal((await post('/api/term/s1/shell/open', {}, {})).status, 403)
  assert.equal((await post('/api/term/s1/shell/open', {}, { 'x-board': '1', origin: 'http://evil.example' })).status, 403)
  assert.equal((await post('/api/term/s1/shell/input', { session: 's1', steps: [{ text: 'x' }] }, { 'x-board': '1', origin: 'http://evil.example' })).status, 403)
  assert.ok(!box.calls().some(a => a[1] === 'create'))
  // The stream needs the page's token; the session must be on the board; there is no shell yet.
  assert.equal((await fetch(`${url}/api/term/s1/shell/stream`)).status, 403)
  assert.equal((await fetch(`${url}/api/term/s1/shell/stream?t=${before.fsToken}`)).status, 404)
  assert.equal((await post('/api/term/nobody/shell/open')).status, 404)
  const none = await post('/api/term/s1/shell/input', { session: 's1', steps: [{ text: 'echo hi' }] })
  assert.equal(none.status, 409)
  assert.match(none.body.error, /no shell open/)

  // The shell: a tab in the session's workspace and folder.
  const opened = await post('/api/term/s1/shell/open')
  assert.equal(opened.status, 200, JSON.stringify(opened.body))
  assert.equal(opened.body.pane, 'w1:p9')
  const create = box.calls().find(a => a[0] === 'tab' && a[1] === 'create')
  assert.deepEqual(create.slice(2), ['--workspace', 'w1', '--cwd', cwd, '--label', 'w1:p1 · shell', '--no-focus'])
  assert.deepEqual((await payload()).shells, ['s1'])
  const first = await firstEvent(`${url}/api/term/s1/shell/stream?t=${before.fsToken}`)
  assert.deepEqual(first, { t: 'frame', drop: 0, keep: 0, lines: ['PS> '], cols: 80 })

  // Typing: the text as typed, then the key; a key the board does not send stops the whole request.
  const ok = await post('/api/term/s1/shell/input', { session: 's1', steps: [{ text: 'echo secret-typed' }, { key: 'enter' }] })
  assert.equal(ok.status, 200, JSON.stringify(ok.body))
  assert.deepEqual(typed(), [['send-text', 'w1:p9', 'echo secret-typed'], ['send-keys', 'w1:p9', 'enter']])
  const bad = await post('/api/term/s1/shell/input', { session: 's1', steps: [{ text: 'ls' }, { key: 'enter; rm' }] })
  assert.equal(bad.status, 409)
  assert.equal(typed().length, 2)

  // The session's own pane: only while the same session runs there.
  const other = await post('/api/term/s1/agent/input', { session: 's2', steps: [{ key: 'esc' }] })
  assert.equal(other.status, 409)
  assert.match(other.body.error, /another session/)
  box.state({ ...herdrState(cwd, { session: 's9' }) })
  const swapped = await post('/api/term/s1/agent/input', { session: 's1', steps: [{ key: 'esc' }] })
  assert.equal(swapped.status, 409)
  assert.equal(typed().length, 2)
  box.state(herdrState(cwd))
  const agent = await post('/api/term/s1/agent/input', { session: 's1', steps: [{ text: '/login' }, { key: 'enter' }] })
  assert.equal(agent.status, 200, JSON.stringify(agent.body))
  assert.deepEqual(typed().slice(2), [['send-text', 'w1:p1', '/login'], ['send-keys', 'w1:p1', 'enter']])

  // "Open in herdr": the shell's own tab.
  assert.equal((await post('/api/term/s1/shell/focus')).status, 200)
  assert.ok(box.calls().some(a => a[0] === 'tab' && a[1] === 'focus' && a[2] === 'w1:t9'))

  // Closing: its pane, then its tab, where nothing else is left.
  box.state({ ...herdrState(cwd), 'pane list': { result: { panes: [] } } })
  const closed = await post('/api/term/s1/shell/close')
  assert.equal(closed.status, 200)
  assert.ok(box.calls().some(a => a[0] === 'pane' && a[1] === 'close' && a[2] === 'w1:p9'))
  assert.ok(box.calls().some(a => a[0] === 'tab' && a[1] === 'close' && a[2] === 'w1:t9'))
  assert.deepEqual((await payload()).shells, [])

  // No fresh herdr data: read only.
  box.state(herdrState(cwd, { snapshot: false }))
  for (let i = 0; i < 50 && !(await payload()).stale; i++) {
    proc.send('refresh')
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  const stale = await post('/api/term/s1/agent/input', { session: 's1', steps: [{ key: 'enter' }] })
  assert.equal(stale.status, 409)
  assert.match(stale.body.error, /No fresh data/)
  assert.equal(typed().length, 4)

  // Nothing typed or read went to the log.
  assert.ok(!JSON.stringify(proc.messages).includes('secret-typed'))
  assert.ok(!JSON.stringify(proc.messages).includes('/login'))
})

test('terminal: false in config.json turns the terminal off', { timeout: 30_000 }, async t => {
  const { box, url, post, payload } = await board(t, { terminal: false })
  const data = await payload()
  assert.equal(data.terminal, false)
  assert.deepEqual(data.shells, [])
  assert.equal((await post('/api/term/s1/shell/open')).status, 404)
  assert.equal((await post('/api/term/s1/agent/input', { session: 's1', steps: [{ key: 'enter' }] })).status, 404)
  assert.equal((await fetch(`${url}/api/term/s1/agent/stream?t=${data.fsToken}`)).status, 404)
  assert.ok(!box.calls().some(a => a[0] !== 'api'))
})
