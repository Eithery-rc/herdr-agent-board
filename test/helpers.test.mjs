import assert from 'node:assert/strict'
import { appendFileSync, rmSync } from 'node:fs'
import { test } from 'node:test'
import { line, jsonl, sessionDir, T0 } from './fixtures/helpers.mjs'
import { conversation, promptOf, spawnOf, spawnResult } from '../src/claude.mjs'
import { backgroundTasks, clearHelperCache, countTools, describe, headInfo, helperDetail, helpersOf, helperStatus, summarize, tailInfo } from '../src/helpers.mjs'
import { useLanguage } from '../src/lang.mjs'

useLanguage('en')

test('what a helper was asked: the prompt without the frames around it', () => {
  assert.deepEqual(promptOf('Review the diff.'), { prompt: 'Review the diff.', from: '' })
  // A prompt that only quotes the boilerplate's closing tag is not a fork's.
  assert.equal(promptOf('Explain what </fork-boilerplate> ends.').prompt, 'Explain what </fork-boilerplate> ends.')
  // A fork: the parent's history is inherited; its directive follows the boilerplate.
  assert.deepEqual(promptOf('<fork-boilerplate>\nYou are a worker fork.\n</fork-boilerplate>\n\nYour directive: Audit slice `a`.'), { prompt: 'Audit slice `a`.', from: '' })
  assert.deepEqual(promptOf('<teammate-message teammate_id="team-lead" summary="Check the design">\nIs the design sound?\n</teammate-message>'), { prompt: 'Is the design sound?', from: 'team-lead' })
  // A workflow agent: the relayed user request is not its task; the computed task is, dedented.
  assert.equal(promptOf('[Workflow harness — user request] The harness relays...:\n  polish it'), null)
  assert.deepEqual(promptOf('[Workflow harness — computed task] The task text below...:\n  \n  Audit the home screen.\n  Report back.'), { prompt: 'Audit the home screen.\nReport back.', from: '' })
})

test('the start of a helper transcript: when it started and its task, skipping what is not one', () => {
  const head = headInfo(jsonl([
    { type: 'fork-context-ref', agentId: 'a1' },
    line.call(0, 'parent-call', 'Agent', { subagent_type: 'fork' }),
    line.user(1, [{ type: 'tool_result', tool_use_id: 'parent-call', content: 'Fork started' }, { type: 'text', text: '<fork-boilerplate>x</fork-boilerplate>\nYour directive: Count the files.' }]),
  ]))
  assert.equal(head.startedAt, T0)
  assert.equal(head.prompt, 'Count the files.')
})

test('the end of a helper transcript: its last words, the call that runs, how it stopped', () => {
  const said = tailInfo(jsonl([line.user(0, 'Go.'), line.call(1, 't1', 'Read', { file_path: 'C:/x/notes.md' }), line.result(2, 't1', 'ok'), line.said(3, 'All fine.'), line.blob(4)]))
  assert.equal(said.last, 'end')
  assert.equal(said.result, 'All fine.')
  assert.equal(said.tokens, 2 + 1000 + 20000 + 300) // as Claude Code counts a subagent's tokens
  assert.equal(said.endedAt, T0 + 3000)
  assert.equal(said.now, null)

  const busy = tailInfo(jsonl([line.user(0, 'Go.'), line.call(1, 't1', 'Bash', { command: 'npm test', description: 'Run the tests' })]))
  assert.equal(busy.last, 'tool')
  assert.deepEqual(busy.now, { name: 'Bash', label: 'Bash', detail: 'Run the tests' })

  const thinking = tailInfo(jsonl([line.call(1, 't1', 'Grep', { pattern: 'x' }), line.result(2, 't1', 'none')]))
  assert.equal(thinking.last, 'waiting')
  assert.equal(thinking.after, 'Grep')

  assert.equal(tailInfo(jsonl([line.call(1, 't1', 'Bash', {}), line.result(2, 't1', 'x'), line.user(3, '[Request interrupted by user for tool use]')])).last, 'interrupted')
  const error = line.said(5, 'API Error', 'stop_sequence')
  error.message.model = '<synthetic>'
  assert.equal(tailInfo(jsonl([line.user(0, 'Go.'), error])).last, 'error')
  // A workflow agent ends by handing back its structured output.
  assert.equal(tailInfo(jsonl([line.call(1, 's1', 'StructuredOutput', { a: 1 }), line.result(2, 's1', 'ok')])).last, 'end')
})

test('a helper whose turn ended with a background command still out is not done', () => {
  const started = line.result(2, 'b1', 'Command running in background with ID: bg42. Output is being written to: C:\\Temp\\bg42.output')
  const text = jsonl([line.call(1, 'b1', 'Bash', { command: 'sleep 60', run_in_background: true }), started, line.said(3, 'Waiting for the sleep.')])
  assert.equal(backgroundTasks(text), 1)
  assert.deepEqual([tailInfo(text).last, tailInfo(text).waiting], ['background', 1])
  // The same words in a file it read are no background command.
  const read = jsonl([line.call(1, 'r1', 'Read', { file_path: 'test.mjs' }), line.result(2, 'r1', "assert(x, 'Command running in background with ID: bg42')"), line.said(3, 'Read it.')])
  assert.deepEqual([backgroundTasks(read), tailInfo(read).last], [0, 'end'])
  // One it stopped itself never reports back: no longer out.
  const stopped = text + jsonl([line.call(4, 'ts', 'TaskStop', { task_id: 'bg42' }), line.result(5, 'ts', 'Stopped'), line.said(6, 'Stopped the wait.')])
  assert.deepEqual([backgroundTasks(stopped), tailInfo(stopped).last], [0, 'end'])
  // In a helper's transcript the notification is a meta line, a banner before its tag.
  const banner = line.user(4, '[SYSTEM NOTIFICATION - NOT USER INPUT]\nThis is an automated background-task event.\n\n<task-notification>\n<task-id>bg42</task-id>\n<status>completed</status>\n<summary>Background command "sleep" completed (exit code 0)</summary>\n</task-notification>', { isMeta: true, origin: { kind: 'task-notification' } })
  const woke = text + jsonl([banner, line.said(5, 'ok')])
  assert.deepEqual([backgroundTasks(woke), tailInfo(woke).last], [0, 'end'])
  // ...and the helper's conversation shows it as a notice.
  const s = sessionDir()
  try {
    const path = s.helper('abg', { agentType: 'general-purpose' }, [line.user(0, 'Wait.'), ...JSON.parse(`[${woke.trim().split('\n').join(',')}]`)])
    assert.deepEqual(conversation(path, 40, { sidechain: true }).filter(m => m.role === 'notice').map(m => [m.kind, m.id]), [['command', 'bg42']])
  } finally {
    rmSync(s.root, { recursive: true, force: true })
  }
  // Its notification came back: done once it has said its last word.
  const back = text + jsonl([line.user(4, '<task-notification>\n<task-id>bg42</task-id>\n<status>completed</status>\n</task-notification>'), line.said(5, 'ok')])
  assert.equal(tailInfo(back).last, 'end')
})

test('how a helper stands: at work only while its session runs and wrote to it', () => {
  const s = (tail, more = {}) => helperStatus({ tail: { last: tail }, kind: 'agent', alive: true, since: 1000, mtimeMs: 5000, now: 6000, ...more })
  assert.equal(s('tool'), 'running')
  assert.equal(s('waiting'), 'running')
  assert.equal(s('end'), 'done')
  assert.equal(s('end', { kind: 'teammate' }), 'idle') // a teammate waits for its next message
  assert.equal(s('end', { kind: 'teammate', alive: false }), 'done')
  assert.equal(s('interrupted'), 'stopped')
  assert.equal(s('error'), 'failed')
  assert.equal(s('tool', { meta: { stoppedByUser: true } }), 'stopped')
  assert.equal(s('tool', { meta: { finished: true } }), 'done')
  // The session slept or restarted: what the old process left half done does not run.
  assert.equal(s('tool', { alive: false }), 'stopped')
  assert.equal(s('tool', { since: 9000 }), 'stopped')
  assert.equal(s('background'), 'running')
  assert.equal(s('background', { meta: { finished: true } }), 'running')
  assert.equal(s('background', { now: 5000 + 3_600_001 }), 'done') // the notification went elsewhere
  assert.equal(s('tool', { now: 5000 + 6 * 3_600_001 }), 'stopped') // hung for six hours
})

test('what a helper is, from its meta file', () => {
  assert.deepEqual(describe('a1', { agentType: 'code-reviewer', description: 'Review the diff', toolUseId: 'toolu_1', requestShape: 'background', model: 'inherit' }), {
    id: 'a1', kind: 'agent', type: 'code-reviewer', name: '', description: 'Review the diff', color: '', model: '', background: true, parent: null, toolUseId: 'toolu_1', workflow: null, phase: '',
  })
  assert.equal(describe('a2', { agentType: 'fork', isFork: true, name: 'audit-a' }).kind, 'fork')
  const mate = describe('amate-1', { agentType: 'design-check', name: 'design-check', taskKind: 'in_process_teammate', color: 'blue', customAgentType: 'code-reviewer', spawnedAgentType: 'general-purpose' })
  assert.deepEqual([mate.kind, mate.type, mate.name, mate.color], ['teammate', 'code-reviewer', 'design-check', 'blue'])
  assert.equal(describe('a3', { color: 'url(x)' }).color, '') // only a plain color name reaches the page
  const wf = describe('a4', { agentType: 'workflow-subagent', description: 'audit:home', workflowPhase: 'Audit' }, { run: 'wf_1' })
  assert.deepEqual([wf.kind, wf.type, wf.workflow, wf.phase], ['workflow', '', 'wf_1', 'Audit'])
  assert.equal(describe('a5', { parentAgentId: 'a1', spawnDepth: 2 }).parent, 'a1')
})

test('every helper of a session: subagents, forks, teammates, workflow runs, nested agents', t => {
  const s = sessionDir()
  t.after(() => rmSync(s.root, { recursive: true, force: true }))
  clearHelperCache()
  s.helper('adone1', { agentType: 'general-purpose', description: 'Find the owner', toolUseId: 'toolu_a', requestShape: 'background' }, [line.user(0, 'Find the owner of case 1.'), line.said(5, 'It is Dana.')])
  s.helper('afork2', { agentType: 'fork', isFork: true, name: 'audit-a', description: 'Audit slice a', toolUseId: 'toolu_b', requestShape: 'background' }, [
    line.call(10, 'toolu_b', 'Agent', { subagent_type: 'fork' }),
    line.user(11, [{ type: 'tool_result', tool_use_id: 'toolu_b', content: 'Fork started' }, { type: 'text', text: '<fork-boilerplate>x</fork-boilerplate>\nYour directive: Audit slice a.' }]),
    line.call(12, 'g1', 'Glob', { pattern: '*' }),
  ])
  s.helper('amate-3', { agentType: 'design-check', name: 'design-check', taskKind: 'in_process_teammate', color: 'green', description: 'Check the design' }, [
    line.user(20, '<teammate-message teammate_id="team-lead" summary="Check it">Is it sound?</teammate-message>'),
    line.said(21, 'Sound.'),
  ])
  // A helper that started one of its own: the parent's turn is over, its child still works.
  s.helper('aparent4', { agentType: 'general-purpose', description: 'Nested parent', toolUseId: 'toolu_c' }, [line.user(30, 'Start a child.'), line.said(31, 'Started; waiting.')])
  s.helper('achild5', { agentType: 'general-purpose', description: 'Nested child', toolUseId: 'toolu_d', parentAgentId: 'aparent4', spawnDepth: 2 }, [line.user(32, 'Start one more.'), line.said(33, 'Started; waiting.')])
  // ...and a grandchild: whatever order the folder lists them in, the whole line stays at work.
  s.helper('a0grand6', { agentType: 'general-purpose', description: 'Nested grandchild', parentAgentId: 'achild5', spawnDepth: 3 }, [line.user(34, 'Sleep.'), line.call(35, 's1', 'Bash', { command: 'sleep 90' })])
  // A finished workflow run with two agents, and one that runs (its name from its script file).
  s.helper('aw1', { agentType: 'workflow-subagent', description: 'audit:home', workflowPhase: 'Audit' }, [line.user(40, '[Workflow harness — computed task] x:\n  Audit home.'), line.call(41, 'o1', 'StructuredOutput', {}), line.result(42, 'o1', 'ok')], 'subagents/workflows/wf_done-1')
  s.write('subagents/workflows/wf_done-1/journal.jsonl', [{ type: 'launched' }])
  s.write('workflows/wf_done-1.json', { runId: 'wf_done-1', taskId: 'wtask1', workflowName: 'polish-audit', status: 'completed', summary: 'Audit of every screen', startTime: T0 + 40000, durationMs: 9000, totalTokens: 52000, totalToolCalls: 7, agentCount: 1 })
  s.helper('aw2', { agentType: 'workflow-subagent', description: 'probe:a', workflowPhase: 'Probe' }, [line.user(50, 'x'), line.call(51, 'q', 'Bash', { command: 'sleep 40' })], 'subagents/workflows/wf_live-2')
  s.write('workflows/scripts/probe-parallel-wf_live-2.js', [])

  const live = helpersOf(s.transcript, { alive: true, since: 0 })
  const by = id => live.helpers.find(h => h.id === id)
  assert.deepEqual(live.helpers.map(h => h.id), ['aw2', 'aw1', 'a0grand6', 'achild5', 'aparent4', 'amate-3', 'afork2', 'adone1']) // newest first
  assert.deepEqual([by('adone1').status, by('adone1').result, by('adone1').prompt], ['done', 'It is Dana.', 'Find the owner of case 1.'])
  assert.deepEqual([by('afork2').kind, by('afork2').status, by('afork2').prompt, by('afork2').now?.label], ['fork', 'running', 'Audit slice a.', 'Glob'])
  assert.deepEqual([by('amate-3').kind, by('amate-3').status, by('amate-3').from, by('amate-3').color], ['teammate', 'idle', 'team-lead', 'green'])
  assert.deepEqual([by('aparent4').status, by('aparent4').waiting], ['running', 1])
  assert.equal(by('achild5').parent, 'aparent4')
  assert.deepEqual([by('achild5').status, by('a0grand6').status], ['running', 'running'])
  assert.deepEqual([by('aw1').kind, by('aw1').workflow, by('aw1').status, by('aw1').prompt], ['workflow', 'wf_done-1', 'done', 'Audit home.'])
  assert.deepEqual(live.workflows.map(w => [w.id, w.name, w.status, w.agents]), [['wf_live-2', 'probe-parallel', 'running', 1], ['wf_done-1', 'polish-audit', 'done', 1]])
  assert.deepEqual([live.workflows[1].tokens, live.workflows[1].taskId, live.workflows[1].endedAt], [52000, 'wtask1', T0 + 49000])

  const card = summarize(live)
  assert.deepEqual([card.running, card.total, card.workflows], [5, 8, 1])
  assert.deepEqual(card.live.map(h => h.label), ['probe:a', 'Nested grandchild', 'Nested child', 'Nested parent'])
  assert.ok(card.at > 0)

  // The session's process is gone (it sleeps): nothing of it works any more.
  const asleep = helpersOf(s.transcript, { alive: false })
  assert.deepEqual(asleep.helpers.filter(h => h.status === 'running'), [])
  assert.equal(asleep.workflows[0].status, 'stopped')
  assert.equal(summarize(asleep).running, 0)
  assert.equal(summarize({ helpers: [], workflows: [] }), null)
  assert.deepEqual(helpersOf(null), { helpers: [], workflows: [] })

  // It finishes: read again because the file changed.
  s.append('subagents/agent-afork2.jsonl', [line.result(13, 'g1', 'a.txt'), line.said(14, 'Slice a is clean.')])
  const after = helpersOf(s.transcript, { alive: true, since: 0 }).helpers.find(h => h.id === 'afork2')
  assert.deepEqual([after.status, after.result], ['done', 'Slice a is clean.'])
})

test('one helper for its window: its conversation and its own tool calls only', async t => {
  const s = sessionDir()
  t.after(() => rmSync(s.root, { recursive: true, force: true }))
  clearHelperCache()
  const path = s.helper('afork2', { agentType: 'fork', isFork: true, toolUseId: 'toolu_b' }, [
    line.call(10, 'toolu_b', 'Agent', { subagent_type: 'fork', description: 'the parent\'s call' }),
    line.user(11, [{ type: 'tool_result', tool_use_id: 'toolu_b', content: 'Fork started' }, { type: 'text', text: '<fork-boilerplate>x</fork-boilerplate>\nYour directive: Count.' }]),
    line.call(12, 'g1', 'Glob', { pattern: '*' }),
    line.result(13, 'g1', 'a.txt'),
  ])
  const d = await helperDetail(s.transcript, 'afork2', { alive: true, since: 0 })
  assert.equal(d.helper.tools, 1) // the parent's call that made it is not the fork's
  assert.equal(d.helper.path, undefined) // no file paths for the page
  assert.deepEqual(d.conversation.map(m => m.role), ['user', 'tool'])
  assert.equal(d.conversation[0].text, 'Count.')
  assert.equal(await helperDetail(s.transcript, 'nope', {}), null)
  assert.equal(await helperDetail(s.transcript, '../../x', {}), null)
  // Counted on from where it stopped, each call once.
  s.append('subagents/agent-afork2.jsonl', [line.call(14, 'g2', 'Read', { file_path: 'a.txt' }), line.blob(15)])
  // Two at once count each call once; a line still being written waits for its end.
  assert.deepEqual(await Promise.all([countTools(path, 'toolu_b'), countTools(path, 'toolu_b')]), [2, 2])
  const half = JSON.stringify(line.call(16, 'g3', 'Grep', { pattern: 'x' }))
  appendFileSync(path, half.slice(0, 30))
  assert.equal(await countTools(path, 'toolu_b'), 2)
  appendFileSync(path, `${half.slice(30)}\n`)
  assert.equal(await countTools(path, 'toolu_b'), 3)
})

test('the session thread: a call that works with others is a line of its own', t => {
  const s = sessionDir()
  t.after(() => rmSync(s.root, { recursive: true, force: true }))
  const main = (o, sc = false) => ({ ...o, isSidechain: sc })
  s.write('../' + s.transcript.split(/[\\/]/).pop(), [
    main(line.user(0, 'Go.')),
    main(line.call(1, 'ag', 'Agent', { description: 'Review the diff', subagent_type: 'code-reviewer', run_in_background: true })),
    main(line.result(2, 'ag', 'Async agent launched successfully.\nagentId: a7f3 (internal ID - do not mention to user.)', { toolUseResult: { isAsync: true, status: 'async_launched', agentId: 'a7f3' } })),
    main(line.call(3, 'fk', 'Agent', { description: 'Audit a', subagent_type: 'fork', name: 'audit-a' })),
    main(line.call(4, 'wf', 'Workflow', { script: "export const meta = {\n  name: 'polish-audit',\n  description: 'x' }" })),
    main(line.result(5, 'wf', 'Workflow launched in background.', { toolUseResult: { runId: 'wf_9', taskId: 'w9' } })),
    main(line.call(6, 'sm', 'SendMessage', { to: 'Billing-master [3fa9c1]', summary: 'Hours for today', message: 'All in.' })),
    main(line.call(7, 'sp', 'Bash', { command: "spawn-agent -Name 'case-42' -Cwd C:\\work\\x -Brief 'go'" })),
    main(line.result(8, 'sp', 'pane=wP:p3D name=case-42 agent=case-42')),
    main(line.call(9, 'sp2', 'PowerShell', { command: 'spawn-agent -Name broken -Cwd nowhere' })),
    main(line.result(10, 'sp2', 'No such folder: nowhere', { message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'sp2', content: 'No such folder', is_error: true }] } })),
    // Another session's message: a meta line with the sender in its origin; then a reply to its pipe.
    main(line.user(11, 'Another Claude session sent a message:\n<cross-session-message from="uds:\\\\.\\pipe\\x1" from-name="Billing-master">Thanks.</cross-session-message>', { isMeta: true, origin: { kind: 'peer', from: 'uds:\\\\.\\pipe\\x1', name: 'Billing-master', msg_id: 'm1', body: 'Thanks.' } })),
    main({ type: 'attachment', timestamp: new Date(T0 + 12000).toISOString(), attachment: { type: 'queued_command', commandMode: 'prompt', prompt: 'dup', origin: { kind: 'peer', from: 'uds:\\\\.\\pipe\\x1', name: 'Billing-master', msg_id: 'm1', body: 'Thanks.' } } }),
    main(line.call(13, 'rp', 'SendMessage', { to: 'uds:\\\\.\\pipe\\x1', summary: 'Reply', message: 'You are welcome.' })),
    main(line.user(14, '<teammate-message teammate_id="design-check" summary="Done">It is sound.</teammate-message>')),
    // The user asking about the tag is the user, not a teammate.
    main(line.user(14.5, 'Why does <teammate-message teammate_id="x">hi</teammate-message> render as a bubble?')),
    main(line.said(15, 'subagent noise'), true),
  ])
  const conv = conversation(s.transcript)
  const tool = id => conv.find(m => m.id === id)
  assert.deepEqual(tool('ag').helper, { kind: 'agent', type: 'code-reviewer', name: '', background: true, id: 'a7f3' })
  assert.deepEqual(tool('fk').helper, { kind: 'fork', type: '', name: 'audit-a', background: false, id: '' })
  assert.deepEqual(tool('wf').workflow, { name: 'polish-audit', run: 'wf_9' })
  assert.deepEqual(tool('sm').send, { to: 'Billing-master', summary: 'Hours for today', text: 'All in.' })
  assert.deepEqual(tool('sp').spawn, { name: 'case-42', pane: 'wP:p3D' })
  assert.equal(tool('sp2').spawn.failed, true)
  const peers = conv.filter(m => m.role === 'peer')
  assert.deepEqual(peers.map(p => [p.from, p.text]), [['Billing-master', 'Thanks.'], ['design-check', 'It is sound.']]) // once, not twice
  assert.equal(peers[0].pipe, 'uds:\\\\.\\pipe\\x1') // the server turns it into the session's key
  assert.equal(peers[1].team, true)
  assert.equal(tool('rp').send.name, 'Billing-master') // a reply to a pipe: whoever wrote from it
  assert.ok(conv.some(m => m.role === 'user' && m.text.startsWith('Why does <teammate-message')))
  assert.ok(!conv.some(m => m.text === 'subagent noise'))
})

test('spawn-agent calls and what they print', () => {
  assert.deepEqual(spawnOf('Bash', { command: 'spawn-agent -Name board-x -Cwd C:\\w' }), { name: 'board-x' })
  assert.deepEqual(spawnOf('PowerShell', { command: '$r = spawn-agent -Name "Case 7" -Cwd .' }), { name: 'Case 7' })
  assert.deepEqual(spawnOf('Bash', { command: 'spawn-agent -Name $Name -Cwd .' }), { name: '' }) // a variable: the output names it
  assert.equal(spawnOf('Bash', { command: 'cat ~/.local/bin/spawn-agent.ps1' }), null)
  assert.equal(spawnOf('Bash', { command: 'grep -n spawn-agent notes.md' }), null) // no -Name: not a start
  assert.equal(spawnOf('Read', { command: 'spawn-agent -Name x' }), null)
  assert.deepEqual(spawnResult('result: pane=wP:pF name=spawn test agent=spawn-test\ntook: 8 s'), { pane: 'wP:pF', name: 'spawn test' })
  assert.equal(spawnResult('Claude did not get ready'), null)
})
