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

test('a notification clicked: open pages are told the session in that pane; no session there, no news', async t => {
  const box = sandbox(t)
  const cwd = join(box.dir, 'work')
  mkdirSync(cwd)
  box.state({ 'api snapshot': { result: { snapshot: { panes: [{ pane_id: 'w1:p1', agent: 'claude', agent_session: { value: 's1' }, agent_status: 'idle', cwd }], tabs: [], workspaces: [] } } } })
  const port = await unusedPort()
  const proc = box.run('server', { port, categories: [{ id: 'other', title: 'Other', color: 'gray' }], wakeUrl: null, refreshSec: 3600, language: 'en' })
  await until(() => proc.messages.some(m => m.ready))
  const url = `http://127.0.0.1:${port}`
  let items = []
  for (let i = 0; i < 50 && !items.length; i++) {
    proc.send('refresh')
    await new Promise(resolve => setTimeout(resolve, 100))
    items = (await fetch(`${url}/api/board`).then(r => r.json())).items
  }
  const key = items[0].key
  const post = (body, headers = { 'x-board': '1' }) =>
    fetch(`${url}/api/reveal`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) }).then(async r => ({ status: r.status, body: await r.json() }))

  // A page of the board, listening.
  let heard = ''
  const page = http.get(`${url}/api/events`, res => {
    res.setEncoding('utf8')
    res.on('data', chunk => (heard += chunk))
  })
  // The board goes with the sandbox at the end: its stream breaks off then.
  page.on('error', () => {})
  t.after(() => page.destroy())
  await until(() => heard.includes('data:'))

  assert.equal((await post({ pane: 'w1:p1' }, {})).status, 403)
  const r = await post({ pane: 'w1:p1' })
  assert.equal(r.status, 200)
  assert.deepEqual([r.body.key, r.body.pages], [key, 1])
  await until(() => heard.includes('event: reveal'))
  assert.ok(heard.includes(`event: reveal\ndata: ${JSON.stringify({ key })}\n\n`))

  // A pane the board has no session in: the caller goes to herdr instead.
  const before = heard.split('event: reveal').length
  assert.equal((await post({ pane: 'w1:p2' })).status, 404)
  assert.equal((await post({})).status, 404)
  assert.equal(heard.split('event: reveal').length, before)
})
