import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { jsonl, line } from './fixtures/helpers.mjs'
import { sandbox, until } from './fixtures/sandbox.mjs'

async function unusedPort() {
  const server = http.createServer()
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  await new Promise(resolve => server.close(resolve))
  return port
}

test('the board shows helpers and links; a helper is served only from its own session', { timeout: 20_000 }, async t => {
  const box = sandbox(t)
  const claude = join(box.env.HOME, '.claude')
  const project = join(claude, 'projects', 'C--w-case')
  mkdirSync(join(project, 's1', 'subagents'), { recursive: true })
  mkdirSync(join(claude, 'sessions'), { recursive: true })
  // Both sessions run (their registry names this test's own process, which is alive).
  writeFileSync(join(claude, 'sessions', 'a.json'), JSON.stringify({ pid: process.pid, sessionId: 's1', kind: 'interactive', name: 'Master', startedAt: 0, messagingSocketPath: '\\\\.\\pipe\\LOCAL\\cc-msg-1' }))
  writeFileSync(join(claude, 'sessions', 'b.json'), JSON.stringify({ pid: process.pid, sessionId: 's2', kind: 'interactive', name: 'case-42', startedAt: 0, messagingSocketPath: '\\\\.\\pipe\\LOCAL\\cc-msg-2' }))
  const main = o => ({ ...o, isSidechain: false })
  writeFileSync(join(project, 's1.jsonl'), jsonl([
    main(line.user(0, 'Hand out the case.')),
    main(line.call(1, 'sp', 'Bash', { command: 'spawn-agent -Name case-42 -Cwd C:\\w\\case' })),
    main(line.result(2, 'sp', 'pane=p2 name=case-42 agent=case-42')),
    main(line.call(3, 'ag', 'Agent', { description: 'Check the logs', subagent_type: 'general-purpose' })),
    main(line.result(4, 'ag', 'Async agent launched successfully.', { toolUseResult: { agentId: 'arun1' } })),
    main(line.call(5, 'sm', 'SendMessage', { to: 'uds:\\\\.\\pipe\\LOCAL\\cc-msg-2', message: 'How far?' })),
  ]))
  writeFileSync(join(project, 's1', 'subagents', 'agent-arun1.meta.json'), JSON.stringify({ agentType: 'general-purpose', description: 'Check the logs', toolUseId: 'ag', requestShape: 'background' }))
  writeFileSync(join(project, 's1', 'subagents', 'agent-arun1.jsonl'), jsonl([line.user(0, 'Read the logs.'), line.call(1, 'r1', 'Read', { file_path: 'C:/w/case/app.log' })]))
  writeFileSync(join(project, 's2.jsonl'), jsonl([main(line.user(0, 'Work the case.'))]))

  const panes = [
    { pane_id: 'p1', agent: 'claude', agent_session: { value: 's1' }, agent_status: 'idle', cwd: 'C:\\w\\case' },
    { pane_id: 'p2', agent: 'claude', agent_session: { value: 's2' }, agent_status: 'working', cwd: 'C:\\w\\case' },
  ]
  box.state({ 'api snapshot': { result: { snapshot: { panes, tabs: [], workspaces: [] } } } })
  const port = await unusedPort()
  const proc = box.run('server', { port, categories: [{ id: 'other', title: 'Other', color: 'gray' }], wakeUrl: null, refreshSec: 3600 })
  await until(() => proc.messages.some(m => m.ready))
  const url = `http://127.0.0.1:${port}`
  const get = async path => {
    const res = await fetch(`${url}${path}`, { signal: AbortSignal.timeout(5000) })
    return { status: res.status, body: await res.json() }
  }
  // The links come from a read in the background, which refreshes the board when it finds some.
  let board
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    board = (await get('/api/board')).body
    if (board.items.find(i => i.key === 's2')?.links?.from) break
    await new Promise(r => setTimeout(r, 50))
  }
  const s1 = board.items.find(i => i.key === 's1')
  const s2 = board.items.find(i => i.key === 's2')
  assert.deepEqual(s1.helpers.live, [{ id: 'arun1', kind: 'agent', label: 'Check the logs', color: '' }])
  assert.equal(s1.helpers.running, 1)
  assert.deepEqual(s2.links.from, { key: 's1', name: 'Master', at: s2.links.from.at })
  assert.deepEqual(s1.links.started.map(x => x.key), ['s2'])
  assert.deepEqual(s1.links.talks.map(x => [x.key, x.out]), [['s2', 1]])
  // What stays on the server: transcripts, the Claude process and its message pipe.
  for (const key of ['transcript', 'pipe', 'since', 'alive']) assert.ok(!(key in s1), key)

  const detail = (await get('/api/session/s1')).body
  assert.deepEqual(detail.helpers.map(h => [h.id, h.status, h.now?.label]), [['arun1', 'running', 'Read']])
  assert.ok(!('path' in detail.helpers[0]))
  const sent = detail.conversation.find(m => m.send)
  assert.deepEqual(sent.send, { to: 'case-42', summary: '', text: 'How far?', name: '', key: 's2' }) // a pipe becomes the session
  assert.equal(detail.conversation.find(m => m.spawn).spawn.pane, 'p2')

  const one = await get('/api/session/s1/helper/arun1')
  assert.equal(one.status, 200)
  assert.equal(one.body.helper.tools, 1)
  assert.deepEqual(one.body.conversation.map(m => m.role), ['user', 'tool'])
  assert.equal((await get('/api/session/s2/helper/arun1')).status, 404) // not that session's helper
  assert.equal((await get('/api/session/s1/helper/nope')).status, 404)
  assert.equal((await get('/api/session/s1/helper/..%2F..%2Fs2')).status, 404)
})
