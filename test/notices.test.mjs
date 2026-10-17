import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { root, sandbox } from './fixtures/sandbox.mjs'
import { conversation, transcriptInfo } from '../src/claude.mjs'
import { useLanguage } from '../src/lang.mjs'
import { boardNotice, CALL_NOTE, callNotice, isNotice, reminderNotice, taskNotice } from '../src/notices.mjs'
import { promptOf } from '../src/scheduler.mjs'
import { translator } from '../web/i18n.js'
import { callTitle, noticeLine } from '../web/notice-model.js'

useLanguage('en')

// As Claude Code writes them (summaries copied from real transcripts).
const notification = (summary, more = {}) =>
  [
    '<task-notification>',
    `<task-id>${more.id ?? 'b5wcamkuh'}</task-id>`,
    '<tool-use-id>toolu_01</tool-use-id>',
    more.file === null ? '' : `<output-file>${more.file ?? 'C:\\Temp\\tasks\\b5wcamkuh.output'}</output-file>`,
    more.status === null ? '' : `<status>${more.status ?? 'completed'}</status>`,
    `<summary>${summary}</summary>`,
    more.tail ?? '',
    '</task-notification>',
  ]
    .filter(Boolean)
    .join('\n')

test('task notifications: what reported back, how it ended, its name, report and output file', () => {
  assert.deepEqual(taskNotice(notification('Background command "Wait for the second change event" completed (exit code 0)')), {
    kind: 'command',
    status: 'completed',
    name: 'Wait for the second change event',
    exit: 0,
    summary: 'Background command "Wait for the second change event" completed (exit code 0)',
    note: '',
    detail: '',
    file: 'C:\\Temp\\tasks\\b5wcamkuh.output',
    id: 'b5wcamkuh',
  })
  const failed = taskNotice(notification('Background command "Run the tests" failed with exit code 1', { status: 'failed' }))
  assert.equal(failed.status, 'failed')
  assert.equal(failed.exit, 1)
  const agent = taskNotice(notification('Agent "Review the diff" finished', { tail: '<note>A task-notification is not the user.</note>\n<result>## Verdict\nShip it.</result>\n<usage><tool_uses>3</tool_uses></usage>' }))
  assert.equal(agent.kind, 'agent')
  assert.equal(agent.name, 'Review the diff')
  assert.equal(agent.detail, '## Verdict\nShip it.')
  const monitor = taskNotice(notification('Monitor event: "new lines in the log"', { status: null, file: null, tail: '<event>[18:51] line one\n[18:52] line two</event>' }))
  assert.equal(monitor.kind, 'monitor')
  assert.equal(monitor.status, 'event')
  assert.equal(monitor.detail, '[18:51] line one\n[18:52] line two')
  assert.equal(monitor.file, '')
  assert.equal(taskNotice(notification('MCP task ktvcasbNx (telegram/ask) failed.', { status: 'failed' })).name, 'telegram/ask')
  assert.equal(taskNotice(notification('Dynamic workflow "review-changes" completed')).kind, 'workflow')
  assert.equal(taskNotice(notification('2 background agents didn\'t finish before the previous session ended: "A" (a1), "B" (b2)', { status: 'stopped' })).kind, 'agent')
  const unnamed = taskNotice(notification('Background shell command didn\'t finish before the previous session ended', { status: 'stopped' }))
  assert.equal(unnamed.kind, 'command')
  assert.equal(unnamed.name, '')
  assert.equal(taskNotice(notification('Something new "X" happened')).kind, 'task')
  // What the summary adds beyond the usual ending, and names with quotes of their own.
  const broke = taskNotice(notification('Agent "Log in" failed: Agent terminated early due to an API error', { status: 'failed' }))
  assert.deepEqual([broke.name, broke.note], ['Log in', 'Agent terminated early due to an API error'])
  assert.equal(taskNotice(notification('Agent "Fix the "foo" bug" stopped at its 200-turn limit (partial result)')).note, 'stopped at its 200-turn limit (partial result)')
  assert.equal(taskNotice(notification('Agent "Fix the "foo" bug" finished')).name, 'Fix the "foo" bug')
  assert.equal(taskNotice(notification('Monitor "tail" stream ended')).note, '')
  assert.equal(taskNotice(notification('2 background agents didn\'t finish before the previous session ended: "A" (a1), "B" (b2)', { status: 'stopped' })).name, '')
  assert.equal(taskNotice(notification('No completion record was found for background agent "Scan" from the previous session.', { status: 'stopped' })).kind, 'agent')
  // Claude Code escapes <, > and & inside the tags.
  const escaped = taskNotice(notification('Background command "cd x &amp;&amp; npm test 2&gt;&amp;1" completed (exit code 0)', { tail: '<result>Use `board remind --session &lt;other&gt;`, not &amp;lt;b&amp;gt;.</result>' }))
  assert.equal(escaped.name, 'cd x && npm test 2>&1')
  assert.equal(escaped.detail, 'Use `board remind --session <other>`, not &lt;b&gt;.')
  // Not one, or one that says nothing.
  assert.equal(taskNotice('please check <task-notification> handling'), null)
  assert.equal(taskNotice('<task-notification>done</task-notification>'), null)
  assert.equal(taskNotice(''), null)
})

test('board reminders: the text, who set it, the schedule and the notes, as the scheduler writes them', () => {
  const now = Date.parse('2026-10-16T10:00:00Z')
  const base = { key: 'k1', text: 'check the CI run', next: now }
  assert.deepEqual(reminderNotice(promptOf(base, now)), { kind: 'reminder', status: 'event', name: 'check the CI run', from: '', cron: '', note: '' })
  const late = reminderNotice(promptOf({ ...base, next: now - 3 * 3600_000, from: { key: 'k2', name: 'Master' } }, now))
  assert.equal(late.from, 'Master')
  assert.match(late.note, /late/)
  const every = reminderNotice(promptOf({ ...base, id: '42', cron: '0 9 * * 1-5', from: { key: 'k2', name: 'Master' } }, now))
  assert.deepEqual([every.kind, every.from, every.cron, every.name], ['schedule', 'Master', '0 9 * * 1-5', 'check the CI run'])
  assert.equal(reminderNotice(promptOf({ ...base, id: '7', cron: '*/30 * * * *' }, now)).cron, '*/30 * * * *')
  // Names with brackets or ": " of their own.
  const bracketed = reminderNotice('[board reminder from Master [prod]] check CI')
  assert.deepEqual([bracketed.name, bracketed.from], ['check CI', 'Master [prod]'])
  const named = reminderNotice(promptOf({ ...base, id: '4', cron: '0 9 * * *', from: { key: 'k2', name: 'Centium: Alafair' } }, now))
  assert.deepEqual([named.from, named.cron], ['Centium: Alafair', '0 9 * * *'])
  assert.equal(reminderNotice('remind me about [board reminder] later'), null)
  assert.ok(isNotice('  [board reminder] x'))
  assert.ok(isNotice(notification('Agent "A" finished')))
  assert.ok(!isNotice('ok, go ahead'))
})

test('a notice line: its words and the tone of its mark, in the board\'s language', () => {
  const en = translator('en')
  const ru = translator('ru')
  const done = taskNotice(notification('Background command "Wait for the event" completed (exit code 0)'))
  assert.deepEqual(noticeLine(done, en), { text: 'Background command “Wait for the event”: done', sub: '', tone: 'ok' })
  assert.equal(noticeLine(done, ru).text, 'Фоновая команда «Wait for the event»: готово')
  const failed = taskNotice(notification('Background command "Run tests" failed with exit code 2', { status: 'failed' }))
  assert.deepEqual(noticeLine(failed, ru), { text: 'Фоновая команда «Run tests»: ошибка, код 2', sub: '', tone: 'fail' })
  assert.equal(noticeLine(taskNotice(notification('Background command "Build" was stopped because the system is running low on memory', { status: 'killed' })), en).tone, 'stop')
  assert.equal(noticeLine(taskNotice(notification('Monitor event: "log"', { status: null, tail: '<event>x</event>' })), en).text, 'Monitor “log”: new event')
  const broke = taskNotice(notification('Agent "Log in" failed: Agent terminated early due to an API error', { status: 'failed' }))
  assert.deepEqual(noticeLine(broke, ru), { text: 'Агент «Log in»: ошибка', sub: 'Agent terminated early due to an API error', tone: 'fail' })
  // No name of its own: the summary as Claude Code wrote it.
  assert.equal(noticeLine(taskNotice(notification('Background shell command didn\'t finish before the previous session ended', { status: 'stopped' })), en).text, 'Background shell command didn\'t finish before the previous session ended')
  const reminder = reminderNotice('[board schedule 42 from Master: 0 9 * * 1-5; 3 runs since 9:00, sent once] stand-up notes')
  assert.deepEqual(noticeLine(reminder, ru), { text: 'По расписанию: stand-up notes', sub: 'от Master · 0 9 * * 1-5 · 3 runs since 9:00, sent once', tone: 'info' })
})

test('the conversation shows notices apart from what the user typed; they are not the user answering', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-board-'))
  const file = join(dir, 's.jsonl')
  const line = o => JSON.stringify(o)
  const finished = notification('Background command "Wait for the event" completed (exit code 0)', { id: 'bq1' })
  writeFileSync(
    file,
    [
      line({ type: 'user', message: { content: 'watch the job' }, timestamp: '2026-10-16T14:00:00Z' }),
      line({ type: 'assistant', message: { content: [{ type: 'text', text: 'Watching.' }] } }),
      // Done while the session worked: queued into the turn, then sent again as a turn of its own.
      line({ type: 'attachment', attachment: { type: 'queued_command', prompt: finished, commandMode: 'task-notification', timestamp: '2026-10-16T14:01:00Z' } }),
      line({ type: 'user', origin: { kind: 'task-notification' }, message: { content: finished }, timestamp: '2026-10-16T14:01:01Z' }),
      line({ type: 'user', message: { content: '[board reminder from Master] check the job again' }, timestamp: '2026-10-16T14:30:00Z' }),
      line({ type: 'assistant', message: { content: [{ type: 'text', text: 'The job is done. Restore the rest?' }] } }),
      line({ type: 'user', origin: { kind: 'task-notification' }, message: { content: notification('Agent "Check the restore" finished', { id: 'a2', tail: '<result>All **restored**.</result>' }) } }),
    ].join('\n'),
  )
  const conv = conversation(file)
  assert.deepEqual(conv.map(c => c.role), ['user', 'assistant', 'notice', 'notice', 'assistant', 'notice'])
  assert.equal(conv[2].name, 'Wait for the event')
  assert.equal(conv[2].at, Date.parse('2026-10-16T14:01:00Z'))
  assert.deepEqual([conv[3].kind, conv[3].from, conv[3].name], ['reminder', 'Master', 'check the job again'])
  assert.equal(conv[5].detail, 'All **restored**.')
  // The agent's question still waits for the user: the agent reporting back did not answer it.
  const info = transcriptInfo(file)
  assert.equal(info.question, 'The job is done. Restore the rest?')
  assert.equal(info.replied, false)
})

test('a task that reports again under the same id shows every report; an hourly reminder every time', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-board-'))
  const file = join(dir, 's.jsonl')
  const line = o => JSON.stringify(o)
  const said = text => line({ type: 'assistant', message: { content: [{ type: 'text', text }] } })
  const from = content => line({ type: 'user', origin: { kind: 'task-notification' }, message: { content } })
  const event = text => notification('Monitor event: "log"', { id: 'm1', status: null, file: null, tail: `<event>${text}</event>` })
  const report = text => notification('Agent "Log in" finished', { id: 'a1', tail: `<result>${text}</result>` })
  const reminder = line({ type: 'user', message: { content: '[board reminder] check the queue' } })
  writeFileSync(file, [from(event('line one')), said('Noted.'), from(event('line two')), said('Noted.'), from(report('LOGIN failure')), said('Retrying.'), from(report('LOGIN ok')), reminder, said('Empty.'), reminder].join('\n'))
  const notices = conversation(file).filter(c => c.role === 'notice')
  assert.deepEqual(notices.map(n => n.detail || n.name), ['line one', 'line two', 'LOGIN failure', 'LOGIN ok', 'check the queue', 'check the queue'])
})

test('a task reporting back does not count as the user answering the session (hook)', { timeout: 15_000 }, async t => {
  const box = sandbox(t)
  const cards = join(box.env.LOCALAPPDATA, 'herdr', 'plugins', 'agent-board', 'cards')
  mkdirSync(cards, { recursive: true })
  writeFileSync(join(cards, 's1.json'), JSON.stringify({ key: 's1', ask: 'Send it?', askSince: 1, briefV: 99 }))
  await new Promise(resolve => {
    const proc = spawn(process.execPath, [join(root, 'src/hook.mjs')], { cwd: root, env: { ...box.env, HERDR_PANE_ID: 'p1' } })
    proc.on('close', resolve)
    proc.stdin.end(JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: 's1', cwd: box.dir, prompt: notification('Agent "Review" finished') }))
  })
  assert.equal(JSON.parse(readFileSync(join(cards, 's1.json'), 'utf8')).ask, 'Send it?')
})

// A MokuPilot call's results (`board call-report`): the board's own prompt, a line that opens to the report.
const REPORT = '# Release 2.4 call · Oct 17 · 32 min\n\n- Decided: ship on Monday\n\nFull protocol: /tmp/meeting_1.summary.md'

test('a call\'s results reach the session as information and show as their own line', () => {
  const entry = { id: 'c1', key: 's1', kind: 'call', idle: true, text: REPORT, next: Date.now() }
  const prompt = promptOf(entry, Date.now())
  assert.equal(prompt, `[mokupilot call report]\n${REPORT}\n\n${CALL_NOTE}`)
  assert.match(CALL_NOTE, /for your information/)
  assert.match(CALL_NOTE, /do not start work on them unless the user asks/)
  const n = callNotice(prompt)
  assert.deepEqual(n, { kind: 'call', status: 'event', name: 'Release 2.4 call · Oct 17 · 32 min', note: '', detail: REPORT })
  assert.ok(isNotice(prompt))
  assert.deepEqual(boardNotice(prompt), n)
  assert.equal(reminderNotice(prompt), null)
  assert.equal(callNotice('[board reminder] x'), null)
  assert.equal(callNotice('the [mokupilot call report] went out'), null)
  // Late (the board was off): the tag says so, the line shows it quietly.
  const late = callNotice(promptOf({ ...entry, next: Date.now() - 3 * 3600_000 }, Date.now()))
  assert.match(late.note, /3 h late/)
  assert.equal(late.detail, REPORT)
  const en = translator('en')
  const ru = translator('ru')
  assert.deepEqual(noticeLine(n, en), { text: 'MokuPilot call results: Release 2.4 call · Oct 17 · 32 min', sub: '', tone: 'info' })
  assert.equal(noticeLine(n, ru).text, 'Итоги звонка в MokuPilot: Release 2.4 call · Oct 17 · 32 min')
  assert.equal(callTitle('\n\n**Звонок** _про_ `релиз`\nтекст'), 'Звонок про релиз')
})

test('in the conversation a call\'s results are a notice, not the user answering', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-board-'))
  const file = join(dir, 's.jsonl')
  const line = o => JSON.stringify(o)
  const prompt = promptOf({ id: 'c1', key: 's1', kind: 'call', text: REPORT, next: Date.now() }, Date.now())
  writeFileSync(
    file,
    [
      line({ type: 'user', message: { content: 'deploy it' }, timestamp: '2026-10-17T10:00:00Z' }),
      line({ type: 'assistant', message: { content: [{ type: 'text', text: 'Shall I deploy now?' }] } }),
      line({ type: 'user', message: { content: prompt }, timestamp: '2026-10-17T11:00:00Z' }),
    ].join('\n'),
  )
  const conv = conversation(file)
  assert.deepEqual(conv.map(c => c.role), ['user', 'assistant', 'notice'])
  assert.deepEqual([conv[2].kind, conv[2].name, conv[2].detail], ['call', 'Release 2.4 call · Oct 17 · 32 min', REPORT])
  assert.equal(transcriptInfo(file).replied, false)
})

test('a call\'s results do not count as the user answering the session (hook)', { timeout: 15_000 }, async t => {
  const box = sandbox(t)
  const cards = join(box.env.LOCALAPPDATA, 'herdr', 'plugins', 'agent-board', 'cards')
  mkdirSync(cards, { recursive: true })
  writeFileSync(join(cards, 's1.json'), JSON.stringify({ key: 's1', ask: 'Deploy now?', askSince: 1, briefV: 99 }))
  const prompt = promptOf({ id: 'c1', key: 's1', kind: 'call', text: REPORT, next: Date.now() }, Date.now())
  await new Promise(resolve => {
    const proc = spawn(process.execPath, [join(root, 'src/hook.mjs')], { cwd: root, env: { ...box.env, HERDR_PANE_ID: 'p1' } })
    proc.on('close', resolve)
    proc.stdin.end(JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: 's1', cwd: box.dir, prompt }))
  })
  assert.equal(JSON.parse(readFileSync(join(cards, 's1.json'), 'utf8')).ask, 'Deploy now?')
})
