import assert from 'node:assert/strict'
import { test } from 'node:test'
import { brief, waitReminder } from '../src/brief.mjs'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { cleanPrompt, conversation, toolDetail, toolLabel, trailingQuestion, transcriptInfo } from '../src/claude.mjs'
import { categoryFor, categoryInfo, laneRank } from '../src/config.mjs'
import { t, useLanguage } from '../src/lang.mjs'
import { attentionOf, columnOf, COLUMNS, noteOf } from '../src/model.mjs'
import { LANGUAGES, missingKeys, resolveLanguage, translator } from '../web/i18n.js'
import { markdown } from '../web/markdown.js'

// The board's texts follow the system language by default: the tests pin English.
useLanguage('en')

const cfg = {
  categories: [
    { id: 'acme', title: 'Acme', paths: ['C:\\Clients'] },
    { id: 'beta', title: 'Beta', paths: ['C:\\Beta'] },
    { id: 'globex', title: 'Globex', paths: ['C:\\Clients\\Globex'] },
    { id: 'personal', title: 'Personal', paths: ['C:\\Home'] },
    { id: 'other', title: 'Other', paths: [] },
  ],
}

test('category from the folder: longest match wins, case and slashes do not matter', () => {
  assert.equal(categoryFor(cfg, 'C:\\Clients\\Globex'), 'globex')
  assert.equal(categoryFor(cfg, 'c:/clients/globex/sub'), 'globex')
  assert.equal(categoryFor(cfg, 'C:\\Clients\\Initech'), 'acme')
  assert.equal(categoryFor(cfg, 'C:\\ClientsX'), null)
  assert.equal(categoryFor(cfg, 'C:\\'), null)
})

test('lanes agents made up sort before "other" and get their id as title', () => {
  assert.ok(laneRank(cfg, 'newclient') > laneRank(cfg, 'personal'))
  assert.ok(laneRank(cfg, 'newclient') < laneRank(cfg, 'other'))
  assert.equal(categoryInfo(cfg, 'newclient').title, 'newclient')
})

test('columns: herdr state first, then the wait note', () => {
  assert.equal(columnOf('working', { wait: 'x' }), 'work')
  assert.equal(columnOf('blocked', { wait: 'x' }), 'me')
  assert.equal(columnOf('done', { wait: 'x' }), 'ext')
  assert.equal(columnOf('sleeping', { wait: 'x' }), 'ext')
  assert.equal(columnOf('done', {}), 'done')
  assert.equal(columnOf('idle', null), 'idle')
  assert.equal(columnOf('sleeping', {}), 'idle')
})

test('a column the user dragged the card to wins, except while a turn is on', () => {
  const asked = { question: 'Send it?', replied: false }
  assert.equal(columnOf('done', { pin: 'me' }), 'me')
  assert.equal(attentionOf('done', { pin: 'me' }), 'later')
  assert.equal(attentionOf('done', { pin: 'me' }, asked), 'question') // its own question says more
  assert.equal(columnOf('idle', { pin: 'done' }, asked), 'done')
  assert.equal(attentionOf('idle', { pin: 'done' }, asked), '')
  assert.equal(columnOf('done', { pin: 'idle', wait: 'x' }), 'idle')
  assert.equal(columnOf('sleeping', { pin: 'ext' }), 'ext')
  assert.equal(columnOf('working', { pin: 'me' }), 'work')
  assert.equal(columnOf('blocked', { pin: 'done' }), 'me')
  assert.equal(columnOf('done', { pin: 'work' }), 'done') // not a column the user can pin
  assert.equal(noteOf({ name: 'A', column: 'me', attention: 'later', title: 'Import' }), 'parked by you · Import')
  assert.equal(noteOf({ name: 'A', column: 'ext', wait: '' }), 'parked by you')
})

test('card note: wait text, then what the agent said, then the ai title, then the last prompt', () => {
  const base = { name: 'Acme-Billing', title: 'Receipt import', prompt: 'go on' }
  assert.equal(noteOf({ ...base, column: 'ext', wait: 'client reply' }), 'client reply')
  assert.equal(noteOf({ ...base, column: 'work', doing: 'fixing the import' }), 'fixing the import')
  assert.equal(noteOf({ ...base, column: 'work' }), 'Receipt import')
  assert.equal(noteOf({ ...base, title: 'Acme-Billing', column: 'work' }), 'go on')
  assert.equal(noteOf({ ...base, column: 'done', result: 'uploaded' }), 'uploaded')
})

test('prompts are cleaned for one line', () => {
  assert.equal(cleanPrompt('[telegram message_id=5 ts=1] hi\nhow is it going'), 'hi how is it going')
  assert.equal(cleanPrompt('❯ ready to test'), 'ready to test')
  assert.equal(cleanPrompt('<command-name>/x</command-name> go'), '/x go')
})

test('brief names the guessed lane and the known ids; reminder quotes the wait', () => {
  const text = brief(cfg, null, 'C:\\Clients\\Globex')
  assert.match(text, /Now: globex \(guessed/)
  assert.match(text, /acme \(Acme\), beta \(Beta\)/)
  assert.match(text, /Card texts in English/)
  assert.match(brief(cfg, { category: 'beta', wait: 'CI' }, 'C:\\X'), /Now: beta\..*Card now: waiting "CI"/s)
  assert.match(brief(cfg, null, 'C:\\X'), /not set, set it now/)
  assert.match(waitReminder({ wait: 'client reply' }), /"client reply"/)
})

test('tool labels and details read like a sentence', () => {
  assert.equal(toolLabel('mcp__plugin_slack_slack__slack_read_channel'), 'slack · read_channel')
  assert.equal(toolLabel('mcp__claude_ai_Gmail__search_threads'), 'Gmail · search_threads')
  assert.equal(toolLabel('Bash'), 'Bash')
  assert.equal(toolDetail('Bash', { command: 'npm test', description: 'Run tests' }), 'Run tests')
  assert.equal(toolDetail('Bash', { command: '\n  git status\nmore' }), 'git status')
  assert.equal(toolDetail('Edit', { file_path: 'C:/Work/x/y/notes.md' }), 'notes.md')
  assert.equal(toolDetail('SendMessage', { to: 'uds:\\.\pipe\LOCAL\cc-msg-1' }), '→ another session')
  assert.equal(toolDetail('mcp__x__y', { query: 'invoice 42' }), 'invoice 42')
})

test('transcript tail: title, last prompt, last words, pending tool; sidechains ignored', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-board-'))
  const file = join(dir, 's.jsonl')
  const line = o => JSON.stringify(o)
  writeFileSync(
    file,
    [
      line({ type: 'ai-title', aiTitle: 'Receipt import' }),
      line({ type: 'last-prompt', lastPrompt: '[telegram message_id=1] load the receipts' }),
      line({ type: 'user', message: { content: 'load the receipts' } }),
      line({ type: 'assistant', message: { content: [{ type: 'text', text: 'Checking the file.' }, { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: 'C:/a/checks.csv' } }] } }),
      line({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] } }),
      line({ type: 'assistant', message: { content: [{ type: 'text', text: 'The file is fine, asking.' }, { type: 'tool_use', id: 't2', name: 'AskUserQuestion', input: { questions: [{ question: 'Import 10/23?' }] } }] } }),
      line({ type: 'assistant', isSidechain: true, message: { content: [{ type: 'text', text: 'subagent noise' }] } }),
    ].join('\n'),
  )
  const info = transcriptInfo(file)
  assert.equal(info.title, 'Receipt import')
  assert.equal(info.prompt, 'load the receipts')
  assert.equal(info.lastText, 'The file is fine, asking.')
  assert.deepEqual(info.tool, { name: 'AskUserQuestion', label: 'AskUserQuestion', detail: 'Import 10/23?', pending: true })

  const conv = conversation(file)
  assert.deepEqual(conv.map(c => c.role), ['user', 'assistant', 'tool', 'assistant', 'tool'])
  assert.equal(conv[2].done, true)
  assert.equal(conv[4].done, false)
  assert.ok(!conv.some(c => c.text === 'subagent noise'))
})

test('a message ending in a question: its last sentence or two, markup ignored', () => {
  assert.equal(trailingQuestion('The draft is ready. Send it?'), 'The draft is ready. Send it?')
  assert.equal(trailingQuestion('Done.\n\n**OK or edit?**'), 'OK or edit?')
  assert.equal(trailingQuestion('Done. Nothing needed.'), '')
  assert.equal(trailingQuestion('Code:\n```js\nif (a?) b\n```\nThat is all.'), '')
  assert.equal(trailingQuestion('Options:\n1. A\n2. B\n\nWhich one?'), 'Which one?')
  assert.equal(trailingQuestion('Готово. Отправлять?'), 'Готово. Отправлять?') // any script
})

test('"needs me": dialogs, the agent\'s ask, then an unanswered last question', () => {
  const q = { question: 'Send it?', replied: false }
  assert.equal(attentionOf('working', { ask: 'x' }, q), '')
  assert.equal(attentionOf('blocked', {}, {}), 'decision')
  assert.equal(attentionOf('done', { ask: 'OK?' }, {}), 'ask')
  assert.equal(attentionOf('idle', {}, q), 'question')
  assert.equal(attentionOf('sleeping', {}, q), 'question')
  assert.equal(attentionOf('idle', {}, { ...q, replied: true }), '')
  assert.equal(attentionOf('idle', { wait: 'client' }, q), '')
  assert.equal(attentionOf('idle', { dismissed: 'Send it?' }, q), '')
  assert.equal(attentionOf('idle', { dismissed: 'another' }, q), 'question')
  assert.equal(columnOf('done', { ask: 'OK?' }, {}), 'me')
  assert.equal(columnOf('done', { ask: 'OK?', wait: 'x' }, {}), 'me')
  assert.equal(columnOf('idle', {}, q), 'me')
})

test('markdown: blocks and inline markup, nothing executable gets through', () => {
  const html = markdown('## Summary\n\n**Done**, see `x`.\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n- one\n  - two\n\n```\n<b>x</b>\n```')
  assert.match(html, /<h4>Summary<\/h4>/)
  assert.match(html, /<b>Done<\/b>, see <code>x<\/code>\./)
  assert.match(html, /<table><thead><tr><th>a<\/th><th>b<\/th><\/tr><\/thead><tbody><tr><td>1<\/td><td>2<\/td><\/tr><\/tbody><\/table>/)
  assert.match(html, /<ul><li>one<ul><li>two<\/li><\/ul><\/li><\/ul>/)
  assert.match(html, /<pre><code>&lt;b&gt;x&lt;\/b&gt;<\/code><\/pre>/)
  const evil = markdown('<img src=x onerror=alert(1)> [a](javascript:alert(1)) [b](https://ok.example/p)')
  assert.ok(!/<img|href="javascript/i.test(evil))
  assert.match(evil, /<a class="ext" href="https:\/\/ok\.example\/p" target="_blank" rel="noopener noreferrer">b<\/a>/)
  assert.equal(markdown('snake_case_name and the path C:\a_b\c_d.txt'), '<p>snake_case_name and the path C:\a_b\c_d.txt</p>')
})

test('languages: every one has every text, plural forms, English as the fallback', () => {
  for (const lang of Object.keys(LANGUAGES)) assert.deepEqual(missingKeys(lang), [], `missing in ${lang}`)
  const en = translator('en')
  const ru = translator('ru')
  assert.equal(en('cat.sessions', { n: 1 }), '1 session')
  assert.equal(en('cat.sessions', { n: 5 }), '5 sessions')
  assert.deepEqual([1, 2, 5, 11, 21, 22, 25].map(n => ru('cat.sessions', { n })), ['1 сессия', '2 сессии', '5 сессий', '11 сессий', '21 сессия', '22 сессии', '25 сессий'])
  assert.equal(ru('sent.to', { name: 'X' }), 'Отправлено в X')
  assert.equal(translator('xx')('col.me'), 'Needs me')
  assert.equal(en('no.such.key'), 'no.such.key')
  assert.equal(resolveLanguage('auto', 'ru-RU'), 'ru')
  assert.equal(resolveLanguage('auto', 'de-DE'), 'en')
  assert.equal(resolveLanguage('ru', 'en-US'), 'ru')
})

test('the board switches language in place: columns, notes and the brief follow', () => {
  try {
    useLanguage('ru')
    assert.equal(COLUMNS.find(c => c.id === 'me').title, 'Ждёт меня')
    assert.equal(noteOf({ name: 'A', column: 'ext', wait: '' }), 'отложено тобой')
    assert.match(brief(cfg, null, 'C:\\X'), /Card texts in Russian/)
    assert.equal(t('lane.other'), 'Прочее')
  } finally {
    useLanguage('en')
  }
  assert.equal(COLUMNS.find(c => c.id === 'me').title, 'Needs me')
})
