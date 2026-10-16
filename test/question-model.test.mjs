import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { conversation, transcriptInfo } from '../src/claude.mjs'
import { answered, choose, chooseOther, currentQuestion, digitTarget, emptyPicks, instant, payload, pendingQuestions, permissionTone, remaining, typeOther } from '../web/question-model.js'

const QS = [
  { question: 'Which size?', header: 'Size', multiSelect: false, preview: false, options: [{ label: 'Small' }, { label: 'Large' }] },
  { question: 'Which toppings?', header: 'Toppings', multiSelect: true, preview: false, options: [{ label: 'Cheese' }, { label: 'Olives' }, { label: 'Basil' }] },
  { question: 'Which layout?', header: 'Layout', multiSelect: false, preview: true, options: [{ label: 'Sidebar', preview: '|' }, { label: 'Tabs', preview: '-' }] },
]

test('picks follow the terminal: one for a single select, toggles for multiSelect', () => {
  let p = emptyPicks(QS)
  assert.equal(remaining(QS, p), 3)
  p = choose(p, QS, 0, 1)
  p = choose(p, QS, 0, 2)
  assert.deepEqual(p[0].options, ['Large'])
  p = choose(p, QS, 1, 3)
  p = choose(p, QS, 1, 1)
  p = choose(p, QS, 1, 2)
  p = choose(p, QS, 1, 2)
  assert.deepEqual(p[1].options, ['Cheese', 'Basil']) // in the order of the options
  p = choose(p, QS, 2, 2)
  assert.equal(remaining(QS, p), 0)
  assert.deepEqual(payload(QS, p), [{ options: ['Large'], other: '' }, { options: ['Cheese', 'Basil'], other: '' }, { options: ['Tabs'], other: '' }])
  assert.equal(choose(p, QS, 0, 9), p) // no such option
})

test('the own answer: typing picks it, an empty field drops it', () => {
  let p = choose(emptyPicks(QS), QS, 0, 1)
  p = typeOther(p, QS, 0, 'Medium')
  assert.deepEqual(p[0], { options: [], other: 'Medium', otherOn: true })
  assert.ok(answered(QS[0], p[0]))
  p = typeOther(p, QS, 0, '  ')
  assert.ok(!answered(QS[0], p[0]))
  p = choose(p, QS, 0, 2)
  assert.deepEqual(payload(QS, p)[0], { options: ['Large'], other: '' })
  p = chooseOther(p, QS, 0)
  assert.deepEqual(p[0].options, [])
  assert.ok(!answered(QS[0], p[0])) // picked, but nothing typed yet
  // multiSelect: the own answer comes along with the options.
  p = choose(p, QS, 1, 1)
  p = typeOther(p, QS, 1, 'Ham')
  assert.deepEqual(payload(QS, p)[1], { options: ['Cheese'], other: 'Ham' })
  p = chooseOther(p, QS, 1)
  assert.deepEqual(payload(QS, p)[1], { options: ['Cheese'], other: '' })
  // No own answer beside previews.
  assert.equal(chooseOther(p, QS, 2), p)
  assert.equal(typeOther(p, QS, 2, 'x'), p)
})

test('digits and the question they go to', () => {
  assert.equal(digitTarget(QS[0], 2), 2)
  assert.equal(digitTarget(QS[0], 3), 'other')
  assert.equal(digitTarget(QS[0], 4), null)
  assert.equal(digitTarget(QS[2], 3), null)
  assert.equal(digitTarget(QS[1], 4), 'other')
  let p = emptyPicks(QS)
  assert.equal(currentQuestion(QS, p, null), 0)
  p = choose(p, QS, 0, 1)
  assert.equal(currentQuestion(QS, p, null), 1)
  assert.equal(currentQuestion(QS, p, 2), 2)
  p = choose(choose(p, QS, 1, 1), QS, 2, 1)
  assert.equal(currentQuestion(QS, p, null), 2)
  assert.ok(instant([QS[0]]))
  assert.ok(!instant([QS[1]]))
  assert.ok(!instant(QS))
})

test('a pending question form, and permission choices by their words', () => {
  const it = { key: 'k', status: 'blocked', tool: { id: 't1', name: 'AskUserQuestion', pending: true, questions: QS } }
  assert.equal(pendingQuestions(it), QS)
  assert.equal(pendingQuestions({ ...it, status: 'working' }), null)
  assert.equal(pendingQuestions({ ...it, tool: { ...it.tool, pending: false } }), null)
  assert.equal(pendingQuestions({ ...it, tool: { ...it.tool, questions: null } }), null)
  assert.equal(permissionTone('Yes'), 'yes')
  assert.equal(permissionTone("Yes, and don't ask again for npm test"), 'always')
  assert.equal(permissionTone('No, and tell Claude what to do differently (esc)'), 'no')
  assert.equal(permissionTone('Switch to auto mode'), 'other')
})

test('the transcript gives the pending form and, once answered, the answers', t => {
  const dir = mkdtempSync(join(tmpdir(), 'board-questions-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const path = join(dir, 's.jsonl')
  const input = { questions: [{ question: 'Which color?', header: 'Color', multiSelect: false, options: [{ label: 'Red', description: 'Warm' }, { label: 'Blue' }] }] }
  const ask = { type: 'assistant', timestamp: '2026-10-16T09:00:00Z', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'AskUserQuestion', input }] } }
  writeFileSync(path, `${JSON.stringify(ask)}\n`)
  const tool = transcriptInfo(path).tool
  assert.equal(tool.id, 'toolu_1')
  assert.equal(tool.pending, true)
  assert.deepEqual(tool.questions[0].options.map(o => o.label), ['Red', 'Blue'])
  let turn = conversation(path).find(i => i.ask)
  assert.deepEqual(turn.ask, [{ question: 'Which color?', header: 'Color', multiSelect: false }])
  assert.equal(turn.answers, null)
  assert.equal(turn.done, false)
  const result = {
    type: 'user',
    timestamp: '2026-10-16T09:01:00Z',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'Your questions have been answered: "Which color?"="Blue".' }] },
    toolUseResult: { questions: input.questions, answers: { 'Which color?': 'Blue' } },
  }
  writeFileSync(path, `${JSON.stringify(ask)}\n${JSON.stringify(result)}\n`)
  assert.equal(transcriptInfo(path).tool.pending, false)
  turn = conversation(path).find(i => i.ask)
  assert.deepEqual(turn.answers, ['Blue'])
  assert.equal(turn.done, true)
})
