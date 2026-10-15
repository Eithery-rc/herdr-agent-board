import assert from 'node:assert/strict'
import http from 'node:http'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { sandbox, until } from './fixtures/sandbox.mjs'
import { updateLive } from '../web/live.js'

async function unusedPort() {
  const server = http.createServer()
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  await new Promise(resolve => server.close(resolve))
  return port
}

test('GET and SSE expose initial, failed, successful, stale and recovered snapshots', { timeout: 20_000 }, async t => {
  const box = sandbox(t)
  const gate = join(box.dir, 'first-refresh')
  box.state({ 'api snapshot': { error: 'offline', waitFor: gate } })
  const port = await unusedPort()
  const proc = box.run('server', { port, categories: [{ id: 'other', title: 'Other', color: 'gray' }], wakeUrl: null, refreshSec: 3600 })
  await until(() => proc.messages.some(m => m.ready))
  const url = `http://127.0.0.1:${port}`
  const get = async () => {
    const response = await fetch(`${url}/api/board`, { signal: AbortSignal.timeout(5000) })
    assert.equal(response.status, 200)
    return response.json()
  }
  const initial = await get()
  assert.equal(initial.stale, true)
  assert.equal(initial.lastSuccessfulRefreshAt, null)
  assert.deepEqual(initial.items, [])
  assert.ok(initial.categories.length)
  assert.equal(initial.columns.length, 5)

  const controller = new AbortController()
  t.after(() => controller.abort())
  const stream = await fetch(`${url}/api/events`, { signal: controller.signal })
  const reader = stream.body.getReader()
  const decoder = new TextDecoder()
  const events = []
  let text = ''
  let readingError
  const reading = (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) return
        text += decoder.decode(value, { stream: true })
        let end
        while ((end = text.indexOf('\n\n')) !== -1) {
          const event = text.slice(0, end)
          text = text.slice(end + 2)
          const line = event.split('\n').find(line => line.startsWith('data: '))
          if (line) events.push(JSON.parse(line.slice(6)))
        }
      }
    } catch (err) {
      if (!controller.signal.aborted) readingError = err
    }
  })()
  t.after(async () => { controller.abort(); await reading })
  await until(() => events.length > 0)
  assert.deepEqual(events[0], initial)
  writeFileSync(gate, '')
  // First failure must never make the initial empty snapshot look live.
  await until(() => proc.messages.some(m => m.log?.includes('offline')))
  assert.equal((await get()).lastSuccessfulRefreshAt, null)

  const snapshot = { panes: [{ pane_id: 'p1', agent: 'claude', agent_session: { value: 's1' }, agent_status: 'idle' }], tabs: [], workspaces: [] }
  box.state({ 'api snapshot': { result: { snapshot } } })
  proc.send('refresh')
  await until(() => events.some(e => !e.stale))
  const successful = await get()
  assert.equal(successful.stale, false)
  assert.equal(typeof successful.lastSuccessfulRefreshAt, 'number')
  assert.equal(successful.items[0].session, 's1')

  box.state({ 'api snapshot': { error: 'offline' } })
  const beforeFailure = events.length
  proc.send('refresh')
  await until(() => events.slice(beforeFailure).some(e => e.stale))
  const stale = await get()
  assert.equal(stale.stale, true)
  assert.equal(stale.lastSuccessfulRefreshAt, successful.lastSuccessfulRefreshAt)
  assert.deepEqual(stale.items, successful.items)
  await until(() => events.some(e => e.stale && e.lastSuccessfulRefreshAt === successful.lastSuccessfulRefreshAt))

  box.state({ 'api snapshot': { result: { snapshot } } })
  const beforeRecovery = events.length
  proc.send('refresh')
  await until(() => events.slice(beforeRecovery).some(e => !e.stale))
  const recovered = await get()
  assert.equal(recovered.stale, false)
  assert.ok(recovered.lastSuccessfulRefreshAt >= stale.lastSuccessfulRefreshAt)
  assert.deepEqual(recovered.items, stale.items)
  await until(() => events.some(e => !e.stale && e.lastSuccessfulRefreshAt === recovered.lastSuccessfulRefreshAt))
  assert.equal(readingError, undefined)
  controller.abort()
  await reading
})

test('live indicator distinguishes waiting, fresh and stale data and recovers with identical items', () => {
  const classes = new Set()
  const element = { classList: { toggle(name, enabled) { if (enabled) classes.add(name); else classes.delete(name) } }, title: '' }
  updateLive(element, { stale: true, lastSuccessfulRefreshAt: null })
  assert.equal(classes.has('on'), false)
  assert.match(element.title, /Ожидаю/)
  updateLive(element, { stale: false, lastSuccessfulRefreshAt: 1000 })
  assert.equal(classes.has('on'), true)
  updateLive(element, { stale: true, lastSuccessfulRefreshAt: 1000 })
  assert.equal(classes.has('on'), false)
  assert.equal(classes.has('stale'), true)
  assert.match(element.title, /устарели/)
  updateLive(element, { stale: false, lastSuccessfulRefreshAt: 1001 })
  assert.equal(classes.has('on'), true)
  assert.equal(classes.has('stale'), false)
})
