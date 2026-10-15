import assert from 'node:assert/strict'
import { test } from 'node:test'
import { brief, waitReminder } from '../src/brief.mjs'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { cleanPrompt, conversation, toolDetail, toolLabel, trailingQuestion, transcriptInfo } from '../src/claude.mjs'
import { categoryFor, categoryInfo, laneRank } from '../src/config.mjs'
import { attentionOf, columnOf, noteOf } from '../src/model.mjs'
import { markdown } from '../web/markdown.js'

const cfg = {
  categories: [
    { id: 'acme', title: 'Acme', paths: ['C:\\Clients'] },
    { id: 'beta', title: 'Бета', paths: ['C:\\Beta'] },
    { id: 'globex', title: 'Globex', paths: ['C:\\Clients\\Globex'] },
    { id: 'personal', title: 'Личные', paths: ['C:\\Home'] },
    { id: 'other', title: 'Прочее', paths: [] },
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
  const asked = { question: 'Отправить?', replied: false }
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
  assert.equal(noteOf({ name: 'A', column: 'me', attention: 'later', title: 'Импорт' }), 'отложено тобой · Импорт')
  assert.equal(noteOf({ name: 'A', column: 'ext', wait: '' }), 'отложено тобой')
})

test('card note: wait text, then what the agent said, then the ai title, then the last prompt', () => {
  const base = { name: 'Acme-Billing', title: 'Импорт чеков', prompt: 'ага' }
  assert.equal(noteOf({ ...base, column: 'ext', wait: 'ответ клиента' }), 'ответ клиента')
  assert.equal(noteOf({ ...base, column: 'work', doing: 'правка импорта' }), 'правка импорта')
  assert.equal(noteOf({ ...base, column: 'work' }), 'Импорт чеков')
  assert.equal(noteOf({ ...base, title: 'Acme-Billing', column: 'work' }), 'ага')
  assert.equal(noteOf({ ...base, column: 'done', result: 'залито' }), 'залито')
})

test('prompts are cleaned for one line', () => {
  assert.equal(cleanPrompt('[telegram message_id=5 ts=1] привет\nкак дела'), 'привет как дела')
  assert.equal(cleanPrompt('❯ можно тестировать'), 'можно тестировать')
  assert.equal(cleanPrompt('<command-name>/x</command-name> go'), '/x go')
})

test('brief names the guessed lane and the known ids; reminder quotes the wait', () => {
  const text = brief(cfg, null, 'C:\\Clients\\Globex')
  assert.match(text, /Now: globex \(guessed/)
  assert.match(text, /acme \(Acme\), beta \(Бета\)/)
  assert.match(brief(cfg, { category: 'beta', wait: 'CI' }, 'C:\\X'), /Now: beta\..*Card now: waiting "CI"/s)
  assert.match(brief(cfg, null, 'C:\\X'), /not set, set it now/)
  assert.match(waitReminder({ wait: 'ответ клиента' }), /"ответ клиента"/)
})

test('tool labels and details read like a sentence', () => {
  assert.equal(toolLabel('mcp__plugin_slack_slack__slack_read_channel'), 'slack · read_channel')
  assert.equal(toolLabel('mcp__claude_ai_Gmail__search_threads'), 'Gmail · search_threads')
  assert.equal(toolLabel('Bash'), 'Bash')
  assert.equal(toolDetail('Bash', { command: 'npm test', description: 'Run tests' }), 'Run tests')
  assert.equal(toolDetail('Bash', { command: '\n  git status\nmore' }), 'git status')
  assert.equal(toolDetail('Edit', { file_path: 'C:/Work/x/y/notes.md' }), 'notes.md')
  assert.equal(toolDetail('SendMessage', { to: 'uds:\\.\pipe\LOCAL\cc-msg-1' }), '→ другой сессии')
  assert.equal(toolDetail('mcp__x__y', { query: 'invoice 42' }), 'invoice 42')
})

test('transcript tail: title, last prompt, last words, pending tool; sidechains ignored', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-board-'))
  const file = join(dir, 's.jsonl')
  const line = o => JSON.stringify(o)
  writeFileSync(
    file,
    [
      line({ type: 'ai-title', aiTitle: 'Импорт чеков' }),
      line({ type: 'last-prompt', lastPrompt: '[telegram message_id=1] залей чеки' }),
      line({ type: 'user', message: { content: 'залей чеки' } }),
      line({ type: 'assistant', message: { content: [{ type: 'text', text: 'Проверяю файл.' }, { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: 'C:/a/checks.csv' } }] } }),
      line({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] } }),
      line({ type: 'assistant', message: { content: [{ type: 'text', text: 'Файл в порядке, спрашиваю.' }, { type: 'tool_use', id: 't2', name: 'AskUserQuestion', input: { questions: [{ question: 'Импортировать 10/23?' }] } }] } }),
      line({ type: 'assistant', isSidechain: true, message: { content: [{ type: 'text', text: 'subagent noise' }] } }),
    ].join('\n'),
  )
  const info = transcriptInfo(file)
  assert.equal(info.title, 'Импорт чеков')
  assert.equal(info.prompt, 'залей чеки')
  assert.equal(info.lastText, 'Файл в порядке, спрашиваю.')
  assert.deepEqual(info.tool, { name: 'AskUserQuestion', label: 'AskUserQuestion', detail: 'Импортировать 10/23?', pending: true })

  const conv = conversation(file)
  assert.deepEqual(conv.map(c => c.role), ['user', 'assistant', 'tool', 'assistant', 'tool'])
  assert.equal(conv[2].done, true)
  assert.equal(conv[4].done, false)
  assert.ok(!conv.some(c => c.text === 'subagent noise'))
})

test('a message ending in a question: its last sentence or two, markup ignored', () => {
  assert.equal(trailingQuestion('Письмо готово. Отправлять?'), 'Письмо готово. Отправлять?')
  assert.equal(trailingQuestion('Готово.\n\n**Ок или правим?**'), 'Ок или правим?')
  assert.equal(trailingQuestion('Сделал. Ничего не нужно.'), '')
  assert.equal(trailingQuestion('Код:\n```js\nif (a?) b\n```\nВсё.'), '')
  assert.equal(trailingQuestion('Варианты:\n1. A\n2. B\n\nКакой берём?'), 'Какой берём?')
})

test('"needs me": dialogs, the agent\'s ask, then an unanswered last question', () => {
  const q = { question: 'Отправлять?', replied: false }
  assert.equal(attentionOf('working', { ask: 'x' }, q), '')
  assert.equal(attentionOf('blocked', {}, {}), 'decision')
  assert.equal(attentionOf('done', { ask: 'Ок?' }, {}), 'ask')
  assert.equal(attentionOf('idle', {}, q), 'question')
  assert.equal(attentionOf('sleeping', {}, q), 'question')
  assert.equal(attentionOf('idle', {}, { ...q, replied: true }), '')
  assert.equal(attentionOf('idle', { wait: 'клиент' }, q), '')
  assert.equal(attentionOf('idle', { dismissed: 'Отправлять?' }, q), '')
  assert.equal(attentionOf('idle', { dismissed: 'другой' }, q), 'question')
  assert.equal(columnOf('done', { ask: 'Ок?' }, {}), 'me')
  assert.equal(columnOf('done', { ask: 'Ок?', wait: 'x' }, {}), 'me')
  assert.equal(columnOf('idle', {}, q), 'me')
})

test('markdown: blocks and inline markup, nothing executable gets through', () => {
  const html = markdown('## Итог\n\n**Готово**, см. `x`.\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n- раз\n  - два\n\n```\n<b>x</b>\n```')
  assert.match(html, /<h4>Итог<\/h4>/)
  assert.match(html, /<b>Готово<\/b>, см\. <code>x<\/code>\./)
  assert.match(html, /<table><thead><tr><th>a<\/th><th>b<\/th><\/tr><\/thead><tbody><tr><td>1<\/td><td>2<\/td><\/tr><\/tbody><\/table>/)
  assert.match(html, /<ul><li>раз<ul><li>два<\/li><\/ul><\/li><\/ul>/)
  assert.match(html, /<pre><code>&lt;b&gt;x&lt;\/b&gt;<\/code><\/pre>/)
  const evil = markdown('<img src=x onerror=alert(1)> [a](javascript:alert(1)) [b](https://ok.example/p)')
  assert.ok(!/<img|href="javascript/i.test(evil))
  assert.match(evil, /<a href="https:\/\/ok\.example\/p" target="_blank" rel="noopener noreferrer">b<\/a>/)
  assert.equal(markdown('snake_case_name и путь C:\a_b\c_d.txt'), '<p>snake_case_name и путь C:\a_b\c_d.txt</p>')
})
