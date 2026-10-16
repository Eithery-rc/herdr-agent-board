import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { conversation, transcriptInfo } from '../src/claude.mjs'
import { useLanguage } from '../src/lang.mjs'
import { isNotice, reminderNotice, taskNotice } from '../src/notices.mjs'
import { promptOf } from '../src/scheduler.mjs'
import { translator } from '../web/i18n.js'
import { noticeLine } from '../web/notice-model.js'

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
