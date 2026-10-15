import assert from 'node:assert/strict'
import http from 'node:http'
import { test } from 'node:test'
import { sandbox } from './fixtures/sandbox.mjs'

for (const sleeping of [false, true]) {
  for (const identity of ['same', 'different', 'missing', 'no-agent', 'blocked']) {
    test(`send: sleeping=${sleeping}, identity=${identity}`, { timeout: 10_000 }, async t => {
      const box = sandbox(t)
      const reply = { 'agent get': { result: { agent: identity === 'no-agent' ? null : {
        agent_status: identity === 'blocked' ? 'blocked' : 'idle',
        ...(identity === 'missing' ? {} : { agent_session: { value: identity === 'different' ? 'replacement' : 'expected' } }),
      } } }, 'agent prompt': { result: {} } }
      box.state(sleeping ? { 'agent get': { error: 'must wake first' } } : reply)
      let wakes = 0
      const cfg = {}
      if (sleeping) {
        const server = http.createServer((req, res) => {
          assert.equal(req.url, '/wake')
          wakes++
          box.state(reply)
          res.setHeader('content-type', 'application/json')
          res.end('{"ok":true}')
        })
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
        t.after(() => new Promise(resolve => server.close(resolve)))
        cfg.wakeUrl = `http://127.0.0.1:${server.address().port}`
      }
      const out = await box.run('send', { item: { pane: 'pane1', session: 'expected', name: 'Test', sleeping }, cfg, text: '-hello' }).exited
      assert.equal(out.code, 0, out.stderr)
      assert.equal(JSON.parse(out.stdout).ok, identity === 'same')
      assert.equal(wakes, sleeping ? 1 : 0)
      assert.deepEqual(box.calls().filter(a => a[1] === 'prompt'), identity === 'same' ? [['agent', 'prompt', 'pane1', ' -hello']] : [])
    })
  }
}

test('send refuses when a previously unknown identity becomes a different known session', async t => {
  const box = sandbox(t)
  box.state({ 'agent get': { result: { agent: { agent_session: { value: 'new-session' }, agent_status: 'idle' } } } })
  const out = await box.run('send', { cfg: {}, item: { pane: 'p', session: null, name: 'Test' }, text: 'hello' }).exited
  assert.equal(out.code, 0, out.stderr)
  assert.equal(JSON.parse(out.stdout).ok, false)
  assert.equal(box.calls().length, 1)
})
