import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { drivePermission, driveQuestions } from '../src/answer.mjs'
import { answerText, arrows, onQuestion, parseDialog, publicDialog, questionsOf, resolveAnswers, reviewMatches, sameText, screenIndex, typedOther } from '../src/questions.mjs'
import { FakeDialog } from './fixtures/fake-dialog.mjs'

// A checkout with core.autocrlf turns the screens into CRLF; herdr gives LF.
const screen = name => readFileSync(new URL(`./fixtures/screens/${name}.txt`, import.meta.url), 'utf8').replace(/\r\n/g, '\n')
const fast = { timeout: 200, every: 1 }

// The questions the screens in fixtures/screens were taken from.
const COLOR = questionsOf({ questions: [{ question: 'Which color should the test widget use?', header: 'Color', multiSelect: false, options: [
  { label: 'Red', description: 'A warm red, good for alerts' }, { label: 'Green', description: 'Calm green for success states' }, { label: 'Blue', description: 'Neutral blue, the default' }] }] })
const ORDER = questionsOf({ questions: [
  { question: 'Which size?', header: 'Size', multiSelect: false, options: [{ label: 'Small', description: 'Fits a phone' }, { label: 'Large', description: 'Fits a desktop' }] },
  { question: 'Which toppings?', header: 'Toppings', multiSelect: true, options: [{ label: 'Cheese', description: 'Melted on top' }, { label: 'Olives', description: 'Black, sliced' }, { label: 'Basil', description: 'Fresh leaves' }] },
  { question: 'Deliver when?', header: 'When', multiSelect: false, options: [{ label: 'Now' }, { label: 'Later' }] },
] })
const PLATFORMS = questionsOf({ questions: [{ question: 'Which platforms should the build target?', header: 'Platforms', multiSelect: true, options: [
  { label: 'Windows', description: 'x64 installer' }, { label: 'macOS', description: 'Universal binary' }, { label: 'Linux', description: 'AppImage and deb' }] }] })
const LAYOUT = questionsOf({ questions: [{ question: 'Which layout for the settings page?', header: 'Layout', multiSelect: false, options: [
  { label: 'Sidebar', description: 'Nav on the left', preview: '+--+\n|  |' }, { label: 'Tabs', description: 'Tabs on top', preview: '+----+' }] }] })

test('questionsOf keeps what the form needs and refuses what it cannot answer', () => {
  assert.equal(COLOR.length, 1)
  assert.deepEqual(COLOR[0].options[0], { label: 'Red', description: 'A warm red, good for alerts' })
  assert.equal(LAYOUT[0].preview, true)
  assert.equal(PLATFORMS[0].multiSelect, true)
  assert.equal(questionsOf(null), null)
  assert.equal(questionsOf({ questions: [] }), null)
  assert.equal(questionsOf({ questions: [{ question: 'No options?', options: [] }] }), null)
  assert.equal(questionsOf({ questions: [{ question: 'Fine', options: [{ label: 'A' }] }, { question: '', options: [{ label: 'B' }] }] }), null)
  const long = questionsOf({ questions: [{ question: 'x'.repeat(5000), options: [{ label: 'A', description: 3 }] }] })
  assert.equal(long[0].question.length, 1000)
  assert.equal(long[0].options[0].description, '')
})

test('resolveAnswers maps labels to option numbers and checks every question', () => {
  assert.deepEqual(resolveAnswers(ORDER, [{ options: ['Large'] }, { options: ['Basil', 'Cheese'] }, { other: ' Tomorrow\nat noon ' }]).picks, [
    { choose: [2], other: '' },
    { choose: [1, 3], other: '' },
    { choose: [], other: 'Tomorrow at noon' },
  ])
  const invalid = [
    [{ options: ['Large', 'Small'] }, { options: ['Cheese'] }, { options: ['Now'] }], // two for a single select
    [{ options: ['Large'] }, { options: [] }, { options: ['Now'] }], // nothing for a multiSelect
    [{ options: ['Large'] }, { options: ['Ham'] }, { options: ['Now'] }], // not an option
    [{ options: ['Large'] }, { options: ['Cheese'] }, { options: ['Now'], other: 'and later' }], // an option and an own answer
    [{ options: ['Large'] }, { options: ['Cheese'] }], // one missing
  ]
  for (const answers of invalid) assert.equal(resolveAnswers(ORDER, answers).error, 'err.qa.invalid')
  assert.equal(resolveAnswers(LAYOUT, [{ other: 'Both' }]).error, 'err.qa.invalid') // no own answer beside previews
  assert.equal(answerText(ORDER[1], { choose: [1, 3], other: 'Ham' }), 'Cheese, Basil, Ham')
})

test('parseDialog reads a lone question as Claude Code draws it', () => {
  const d = parseDialog(screen('question-single'))
  assert.equal(d.kind, 'question')
  assert.equal(d.question, 'Which color should the test widget use?')
  assert.deepEqual(d.options.map(o => o.label), ['Red', 'Green', 'Blue', 'Type something.'])
  assert.equal(d.options[0].text, 'Red A warm red, good for alerts')
  assert.equal(d.cursor, 1)
  assert.equal(d.editing, false)
  assert.ok(onQuestion(d, COLOR[0]))
  assert.equal(typedOther(d), '')
  assert.equal(publicDialog(d).kind, 'question')
})

test('parseDialog follows the tabs of several questions', () => {
  const first = parseDialog(screen('question-tabs-1'))
  assert.deepEqual(first.tabs, [{ header: 'Size', answered: false }, { header: 'Toppings', answered: false }, { header: 'When', answered: false }])
  assert.equal(screenIndex(first, ORDER), 0)
  const multi = parseDialog(screen('question-tabs-2-multi'))
  assert.equal(screenIndex(multi, ORDER), 1)
  assert.deepEqual(multi.options.map(o => o.checked), [false, false, false, false])
  assert.deepEqual(multi.next, { label: 'Next', cursor: false })
  const other = parseDialog(screen('question-tabs-3-other'))
  assert.equal(screenIndex(other, ORDER), 2)
  assert.equal(other.cursor, 3)
  assert.equal(other.editing, true)
  const typed = parseDialog(screen('question-tabs-3-typed'))
  assert.equal(typedOther(typed), 'Tomorrow at noon')
  const review = parseDialog(screen('question-review'))
  assert.equal(review.kind, 'review')
  assert.equal(screenIndex(review, ORDER), 3)
  assert.deepEqual(review.answers.map(a => a.answer), ['Large', 'Cheese, Basil', 'Tomorrow at noon'])
  assert.ok(reviewMatches(review, ORDER, [{ choose: [2], other: '' }, { choose: [1, 3], other: '' }, { choose: [], other: 'Tomorrow at noon' }]))
  assert.ok(!reviewMatches(review, ORDER, [{ choose: [1], other: '' }, { choose: [1, 3], other: '' }, { choose: [], other: 'Tomorrow at noon' }]))
})

test('parseDialog reads a lone multiSelect question and one with previews', () => {
  const multi = parseDialog(screen('question-lone-multi'))
  assert.ok(onQuestion(multi, PLATFORMS[0]))
  assert.deepEqual(multi.next, { label: 'Submit', cursor: false })
  const preview = parseDialog(screen('question-preview'))
  assert.equal(preview.preview, true)
  assert.deepEqual(preview.options.map(o => o.label), ['Sidebar', 'Tabs'])
  assert.ok(onQuestion(preview, LAYOUT[0]))
  assert.ok(!onQuestion(preview, COLOR[0]))
})

test('parseDialog reads permission prompts, with a fingerprint that changes with the prompt', () => {
  const bash = parseDialog(screen('permission-bash'))
  assert.equal(bash.kind, 'permission')
  assert.equal(bash.title, 'Bash command')
  assert.deepEqual(bash.body, ['Write hello into a probe note file', 'echo hello > probe-note.txt'])
  assert.equal(bash.prompt, 'Do you want to proceed?')
  assert.equal(bash.options.length, 4)
  // The wrapped line joined: broken mid-word at the full width (a long path), so without a space.
  assert.match(bash.options[1].text, /\\of\\probe from this project$/)
  assert.equal(bash.options[3].text, 'No')
  assert.equal(bash.cursor, 1)
  const write = parseDialog(screen('permission-write'))
  assert.equal(write.title, 'Create file')
  assert.equal(write.prompt, 'Do you want to create probe-two.txt?')
  assert.deepEqual(write.options.map(o => o.n), [1, 2, 3])
  assert.match(write.options[1].text, /for this session \(shift\+tab\)$/) // broken at a space
  assert.notEqual(write.fingerprint, bash.fingerprint)
  assert.equal(parseDialog(screen('permission-bash')).fingerprint, bash.fingerprint)
  const changed = parseDialog(screen('permission-bash').replace('\n echo hello > probe-note.txt\n', '\n echo bye > probe-note.txt\n'))
  assert.deepEqual(changed.body, ['Write hello into a probe note file', 'echo bye > probe-note.txt'])
  assert.notEqual(changed.fingerprint, bash.fingerprint)
  assert.deepEqual(Object.keys(publicDialog(bash)).sort(), ['body', 'fingerprint', 'kind', 'options', 'prompt', 'title'])
})

test('parseDialog finds nothing on a plain screen or another dialog', () => {
  assert.equal(parseDialog(''), null)
  assert.equal(parseDialog('❯ \n──────────\n  ⏵⏵ bypass permissions on'), null)
  const trust = ['─'.repeat(40), ' Accessing workspace:', '', ' Quick safety check: Is this a project you trust?', '', ' ❯ No, exit', '   Yes, I trust this folder', '', ' Enter to confirm · Esc to cancel'].join('\n')
  assert.equal(parseDialog(trust), null)
})

test('small helpers', () => {
  assert.deepEqual(arrows(1, 3), ['down', 'down'])
  assert.deepEqual(arrows(4, 2), ['up', 'up'])
  assert.deepEqual(arrows(2, 2), [])
  assert.ok(sameText('Tomorrow  at noon', 'Tomorrow at noon'))
  assert.ok(sameText('A very long own answer that the terminal cut sh…', 'A very long own answer that the terminal cut short at the edge'))
  assert.ok(!sameText('Short…', 'Shorter text entirely'))
})

// ---------------------------------------------------------------- driving the dialog

test('a lone single select: one digit, nothing else', async () => {
  for (const lag of [0, 2]) {
    const fake = new FakeDialog(COLOR, { lag })
    const r = await driveQuestions({ questions: COLOR, picks: resolveAnswers(COLOR, [{ options: ['Blue'] }]).picks, io: fake.io(), timing: fast })
    assert.deepEqual(r, { ok: true })
    assert.deepEqual(fake.keysLog, ['3'])
    assert.deepEqual(fake.submitted, ['Blue'])
  }
})

test('option 1 with a slow redraw is pressed once, never followed by Enter', async () => {
  const fake = new FakeDialog(COLOR, { lag: 3 })
  const r = await driveQuestions({ questions: COLOR, picks: resolveAnswers(COLOR, [{ options: ['Red'] }]).picks, io: fake.io(), timing: fast })
  assert.ok(r.ok)
  assert.deepEqual(fake.keysLog, ['1'])
})

test('an own answer is reached with arrows, cleared and typed, never by its digit', async () => {
  const fake = new FakeDialog(COLOR, { lag: 1 })
  fake.state[0].other = 'left from before' // a digit here would submit this text at once
  const r = await driveQuestions({ questions: COLOR, picks: resolveAnswers(COLOR, [{ other: 'Teal' }]).picks, io: fake.io(), timing: fast })
  assert.ok(r.ok, JSON.stringify(r))
  assert.deepEqual(fake.keysLog, ['down', 'down', 'down', 'ctrl+u', 'enter'])
  assert.deepEqual(fake.texts, ['Teal'])
  assert.deepEqual(fake.submitted, ['Teal'])
})

test('three questions: single, multiSelect, own answer, then the review and submit', async () => {
  const fake = new FakeDialog(ORDER, { lag: 1 })
  const picks = resolveAnswers(ORDER, [{ options: ['Large'] }, { options: ['Cheese', 'Basil'] }, { other: 'Tomorrow at noon' }]).picks
  const r = await driveQuestions({ questions: ORDER, picks, io: fake.io(), timing: fast })
  assert.ok(r.ok, JSON.stringify(r))
  assert.deepEqual(fake.submitted, ['Large', 'Cheese, Basil', 'Tomorrow at noon'])
  assert.equal(fake.keysLog.at(-1), '1')
})

test('a lone multiSelect with an own answer goes through its Submit row and the review', async () => {
  const fake = new FakeDialog(PLATFORMS)
  const picks = resolveAnswers(PLATFORMS, [{ options: ['macOS'], other: 'FreeBSD' }]).picks
  const r = await driveQuestions({ questions: PLATFORMS, picks, io: fake.io(), timing: fast })
  assert.ok(r.ok, JSON.stringify(r))
  assert.deepEqual(fake.submitted, ['macOS, FreeBSD'])
})

test('options with previews: the digit moves the cursor, Enter picks', async () => {
  const fake = new FakeDialog(LAYOUT)
  const r = await driveQuestions({ questions: LAYOUT, picks: resolveAnswers(LAYOUT, [{ options: ['Tabs'] }]).picks, io: fake.io(), timing: fast })
  assert.ok(r.ok)
  assert.deepEqual(fake.keysLog, ['2', 'enter'])
  assert.deepEqual(fake.submitted, ['Tabs'])
})

test('begun in the terminal: back to the first question, ticks set to what was picked', async () => {
  const fake = new FakeDialog(ORDER)
  fake.state[0].answer = 'Small'
  fake.state[1].checked = new Set([2, 3])
  fake.tab = 2
  fake.state[2].cursor = 3 // in the own answer's field
  const picks = resolveAnswers(ORDER, [{ options: ['Large'] }, { options: ['Cheese', 'Basil'] }, { options: ['Now'] }]).picks
  const r = await driveQuestions({ questions: ORDER, picks, io: fake.io(), timing: fast })
  assert.ok(r.ok, JSON.stringify(r))
  assert.deepEqual(fake.keysLog.slice(0, 3), ['up', 'left', 'left'])
  assert.deepEqual(fake.submitted, ['Large', 'Cheese, Basil', 'Now'])
})

test('another question on the screen: nothing is pressed', async () => {
  const fake = new FakeDialog(ORDER)
  const r = await driveQuestions({ questions: COLOR, picks: resolveAnswers(COLOR, [{ options: ['Red'] }]).picks, io: fake.io(), timing: fast })
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'changed')
  assert.deepEqual(fake.keysLog, [])
})

test('a terminal that does not respond: it stops after the first key', async () => {
  const fake = new FakeDialog(ORDER, { ignore: true })
  const picks = resolveAnswers(ORDER, [{ options: ['Large'] }, { options: ['Cheese'] }, { options: ['Now'] }]).picks
  const r = await driveQuestions({ questions: ORDER, picks, io: fake.io(), timing: fast })
  assert.equal(r.reason, 'stuck')
  assert.deepEqual(r.step, { q: 1, what: 'option', n: 2 })
  assert.deepEqual(fake.keysLog, ['2'])
  assert.match(r.screen, /Which size\?/)
})

test('a review that lists other answers is not submitted', async () => {
  const fake = new FakeDialog(ORDER)
  const io = fake.io()
  const read = io.read
  io.read = async () => (await read()).replace('→ Large', '→ Small')
  const picks = resolveAnswers(ORDER, [{ options: ['Large'] }, { options: ['Cheese'] }, { options: ['Now'] }]).picks
  const r = await driveQuestions({ questions: ORDER, picks, io, timing: fast })
  assert.equal(r.reason, 'review')
  assert.equal(fake.submitted, null)
  assert.equal(fake.tab, ORDER.length) // left on the review screen
  // "1" ticked Cheese and picked Now; no third one went to "1. Submit answers".
  assert.equal(fake.keysLog.filter(k => k === '1').length, 2)
})

test('a permission prompt is answered only while the screen shows the prompt the user saw', async () => {
  const bash = screen('permission-bash')
  const { fingerprint } = parseDialog(bash)
  const keys = []
  let shown = bash
  const io = { read: async () => shown, keys: async (...k) => { keys.push(...k); shown = '❯ \n' }, text: async () => {} }
  assert.deepEqual(await drivePermission({ fingerprint, n: 1, io, timing: fast }), { ok: true })
  assert.deepEqual(keys, ['1'])
  shown = screen('permission-write')
  keys.length = 0
  const r = await drivePermission({ fingerprint, n: 1, io, timing: fast })
  assert.equal(r.reason, 'changed')
  assert.deepEqual(keys, [])
  shown = bash
  assert.equal((await drivePermission({ fingerprint, n: 7, io, timing: fast })).reason, 'changed')
  assert.deepEqual(keys, [])
})
