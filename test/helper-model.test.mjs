import assert from 'node:assert/strict'
import { test } from 'node:test'
import { clock, findHelper, groupHelpers, helperTitle, liveCount, relatedKeys, sessionByName, toneOf, tokens, took } from '../web/helper-model.js'

test('a helper in words: its title, a stopwatch, tokens, the tone of its mark', () => {
  assert.equal(helperTitle({ description: 'Review the diff', name: 'r1', type: 'code-reviewer' }), 'Review the diff')
  assert.equal(helperTitle({ name: 'design-check', type: 'x' }), 'design-check')
  assert.equal(helperTitle({ id: 'a1' }), 'a1')
  assert.deepEqual([clock(0), clock(12_400), clock(245_000), clock(3_845_000)], ['0s', '12s', '4:05', '1:04:05'])
  assert.deepEqual([tokens(null), tokens(950), tokens(23_131), tokens(1_234_567), tokens(25_000_000)], ['', '950', '23k', '1.2M', '25M'])
  assert.deepEqual(['running', 'done', 'idle', 'failed', 'stopped'].map(toneOf), ['run', 'ok', 'idle', 'fail', 'stop'])
  assert.equal(took({ status: 'done', startedAt: 1000, endedAt: 61_000 }), 60_000)
  assert.equal(took({ status: 'running', startedAt: 1000 }, 31_000), 30_000)
  assert.equal(took({ status: 'done' }), null)
})

test('the list: at work first, workflow runs with their agents, teammates, then the finished', () => {
  const h = (id, status, startedAt, more = {}) => ({ id, status, startedAt, kind: 'agent', ...more })
  const g = groupHelpers(
    [h('a', 'done', 1), h('b', 'running', 5), h('c', 'running', 3), h('kid', 'running', 4, { parent: 'c' }), h('m', 'idle', 2, { kind: 'teammate' }), h('w1', 'done', 6, { kind: 'workflow', workflow: 'wf1' }), h('x', 'stopped', 7)],
    [{ id: 'wf0', status: 'done', startedAt: 9 }, { id: 'wf1', status: 'running', startedAt: 6 }],
  )
  assert.deepEqual(g.running.map(x => [x.id, x.depth]), [['b', 0], ['c', 0], ['kid', 1]])
  assert.deepEqual(g.teammates.map(x => x.id), ['m'])
  assert.deepEqual(g.runs.map(r => [r.id, r.agents.map(x => x.id)]), [['wf1', ['w1']], ['wf0', []]])
  assert.deepEqual(g.finished.map(x => x.id), ['x', 'a'])
})

test('which helper or session a line of the thread is about', () => {
  const helpers = [{ id: 'a1', toolUseId: 'toolu_1', kind: 'agent', name: '' }, { id: 'f2', kind: 'fork', name: 'audit', startedAt: 1 }, { id: 'm3', kind: 'teammate', name: 'audit', startedAt: 0 }]
  assert.equal(findHelper(helpers, { id: 'a1' }).id, 'a1')
  assert.equal(findHelper(helpers, { id: 'gone', tool: 'toolu_1' }).id, 'a1')
  assert.equal(findHelper(helpers, { name: 'audit' }).id, 'm3') // a teammate goes by its name first
  assert.equal(findHelper(helpers, { name: 'f2' }).id, 'f2') // SendMessage to an agent id
  assert.equal(findHelper(helpers, {}), null)
  const items = [{ key: 'k1', name: 'My case', autoName: 'case-42' }, { key: 'k2', name: 'Twin', autoName: 'Twin' }, { key: 'k3', name: 'Twin', autoName: 'Twin' }, { key: 'l', name: 'case-43', launchOnly: true }]
  assert.equal(sessionByName(items, 'Case 42').key, 'k1')
  assert.equal(sessionByName(items, 'my case').key, 'k1')
  assert.equal(sessionByName(items, 'Twin'), null) // two of them: no guess
  assert.equal(sessionByName(items, 'case-42', 'k1'), null) // never the session itself
  assert.equal(sessionByName(items, 'case-43'), null) // a launch still starting is not a session yet
  assert.equal(sessionByName(items, ''), null)
})

test('the card: helpers at work, sessions linked', () => {
  assert.equal(liveCount({ helpers: { running: 3, workflows: 1 } }), 3)
  assert.equal(liveCount({ helpers: { running: 0, workflows: 1 } }), 1) // a workflow between two agents
  assert.equal(liveCount({}), 0)
  assert.deepEqual([...relatedKeys({ links: { from: { key: 'm' }, started: [{ key: 'a' }], talks: [{ key: 'm' }, { key: 'b' }] } })].sort(), ['a', 'b', 'm'])
  assert.equal(relatedKeys({}).size, 0)
})
