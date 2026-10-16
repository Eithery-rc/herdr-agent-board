// Claude Code's dialogs in a terminal, read from a pane's screen (`herdr agent read --source
// visible`), and the keys that answer them. Pure functions; answer.mjs reads and types.
//
// The question dialog (AskUserQuestion), as Claude Code 2.1 draws and drives it:
// - One question: a header line (" ☐ Color"), the question, numbered options with their
//   descriptions indented under them, then "N+1. Type something." for an own answer. The cursor
//   (❯) starts on option 1.
// - Several questions, or one multiSelect question: a tab bar
//   ("←  ☒ Size  ☐ Toppings  ✔ Submit  →", ☒ answered), one question at a time, and at the end a
//   "Review your answers" screen that lists every answer above "1. Submit answers" and
//   "2. Cancel". Left and right arrows move between the tabs.
// - Single select: a digit picks that option and moves on at once (a lone question is submitted).
//   On the own-answer row a digit does the same with the text it holds, so that row is reached
//   with the arrow keys instead: there it takes text (the footer offers "ctrl+g to edit"), up
//   leaves it, ctrl+u clears it, Enter takes it.
// - Options with a preview (a mockup beside the list, no own-answer row): a digit only moves the
//   cursor; Enter picks.
// - multiSelect: options show "[ ]" or "[✔]" and a digit toggles one without moving the cursor.
//   Text typed on the own-answer row ticks it. A "Next" row ("Submit" for a lone question) under
//   the options goes on with Enter.
// A permission prompt: a title ("Bash command", "Create file"), what the tool will do between
// dashed rules, "Do you want to ...?" and numbered options; a digit picks one at once.

import { createHash } from 'node:crypto'
import { stripAnsi } from './screen.mjs'

const RULE = /^\s*─{8,}\s*$/
const DASHED = /^\s*╌{8,}\s*$/
const TABS = /^\s*(?:←\s+)?[☐☒]\s/
// An option row: "❯ " or two spaces, the number, a checkbox for multiSelect, the text.
const OPTION = /^(❯| ) (\d+)\. (?:\[( |✔)\] )?(.*)$/
const NEXT = /^(❯| )\s{3,}(Next|Submit)\s*$/
const BOX = /\s{2,}[┌│└].*$/
const PLACEHOLDER = /^Type something\.?$/
export const OTHER_LIMIT = 1000

const str = v => (typeof v === 'string' ? v : '')
const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)
/** Text as it reads on a screen: no markdown marks, one space between words. */
export const norm = s =>
  String(s ?? '')
    .replace(/[*_`]+/g, '')
    .replace(/\s+/g, ' ')
    .trim()

/**
 * The text of a row and the line wrapped under it, as one. A line the terminal broke in the
 * middle of a word (a long path) fills the whole width, a rule's length; one broken at a space
 * stops short of it. `prev` is the line above, as drawn.
 */
const wrapJoin = (text, prev, line, width) => norm(`${text}${width && [...prev].length >= width ? '' : ' '}${line.trim()}`)
const widthOf = lines => Math.max(0, ...lines.filter(l => RULE.test(l)).map(l => [...l.trimEnd()].length))

/**
 * The questions of an AskUserQuestion call, cleaned and bounded: { question, header,
 * multiSelect, preview, options: [{ label, description, preview? }] }. null when the input is not
 * one the board can answer (no questions, or one without text or options).
 */
export function questionsOf(input) {
  const list = Array.isArray(input?.questions) ? input.questions.slice(0, 4) : []
  const out = list.map(q => {
    const options = (Array.isArray(q?.options) ? q.options.slice(0, 8) : []).map(o => ({
      label: clip(str(o?.label).trim(), 300),
      description: clip(str(o?.description).trim(), 600),
      ...(str(o?.preview).trim() ? { preview: clip(str(o.preview), 4000) } : {}),
    }))
    return {
      question: clip(str(q?.question).trim(), 1000),
      header: clip(str(q?.header).trim(), 60),
      multiSelect: q?.multiSelect === true,
      preview: options.some(o => o.preview),
      options,
    }
  })
  if (!out.length || out.some(q => !q.question || q.options.length < 1 || q.options.some(o => !o.label))) return null
  return out
}

/**
 * The answers the user picked, checked against the questions: per question { choose: [option
 * numbers, from 1], other: '' }. `answers` is one { options: [labels], other } per question.
 * Returns { picks } or { error } (a dictionary key).
 */
export function resolveAnswers(questions, answers) {
  if (!Array.isArray(questions) || !Array.isArray(answers) || answers.length !== questions.length) return { error: 'err.qa.invalid' }
  const picks = []
  for (const [i, q] of questions.entries()) {
    const a = answers[i] ?? {}
    const labels = Array.isArray(a.options) ? a.options.map(String) : []
    const choose = []
    for (const label of labels) {
      const n = q.options.findIndex(o => o.label === label) + 1
      if (!n || choose.includes(n)) return { error: 'err.qa.invalid' }
      choose.push(n)
    }
    choose.sort((x, y) => x - y)
    // An own answer is one line: the terminal's field takes no line breaks.
    const other = clip(String(a.other ?? '').replace(/[\x00-\x1f\x7f]+/g, ' ').replace(/\s+/g, ' ').trim(), OTHER_LIMIT)
    if (other && q.preview) return { error: 'err.qa.invalid' } // no own-answer row beside previews
    if (q.multiSelect ? !choose.length && !other : choose.length + (other ? 1 : 0) !== 1) return { error: 'err.qa.invalid' }
    picks.push({ choose, other })
  }
  return { picks }
}

/** The answer as the terminal's review screen and the transcript write it. */
export function answerText(question, pick) {
  return [...pick.choose.map(n => question.options[n - 1].label), ...(pick.other ? [pick.other] : [])].join(', ')
}

/**
 * What the screen shows, or null when it shows no dialog the board knows:
 *   { kind: 'question', tabs, question, options, next, cursor, editing, preview }
 *   { kind: 'review', tabs, answers: [{ question, answer }], options, cursor }
 *   { kind: 'permission', title, body, prompt, options, cursor, fingerprint }
 * options: [{ n, label, text, checked, cursor }]; text has the wrapped lines under the first;
 * checked is null outside multiSelect. cursor: the option number, 'next', or null.
 */
export function parseDialog(screen) {
  const lines = stripAnsi(String(screen ?? ''))
    .replace(/\r/g, '')
    .split('\n')
    .map(l => l.trimEnd())
  return questionDialog(lines) ?? permissionDialog(lines)
}

function questionDialog(lines) {
  let bar = -1
  for (let i = lines.length - 1; i > 0; i--) {
    if (TABS.test(lines[i]) && RULE.test(lines[i - 1])) {
      bar = i
      break
    }
  }
  if (bar < 0) return null
  const tabs = [...lines[bar].matchAll(/([☐☒])\s(.+?)(?=\s{2,}|\s*[✔→]|$)/g)].map(m => ({ header: m[2].trim(), answered: m[1] === '☒' }))
  let i = bar + 1
  while (i < lines.length && !lines[i].trim()) i++
  if (lines[i]?.trim() === 'Review your answers') return review(lines, i + 1, tabs)
  const text = []
  for (; i < lines.length && lines[i].trim() && !OPTION.test(lines[i]); i++) text.push(lines[i])
  if (!text.length) return null
  const block = optionBlock(lines, i)
  if (!block.options.length) return null
  const footer = lines.slice(block.end).find(l => /Esc to cancel/.test(l)) ?? ''
  return {
    kind: 'question',
    tabs,
    question: norm(text.join(' ')),
    options: block.options,
    next: block.next,
    cursor: block.next?.cursor ? 'next' : (block.options.find(o => o.cursor)?.n ?? null),
    editing: /ctrl\+g to edit/.test(footer),
    preview: block.preview,
  }
}

/** Numbered rows from `start`, each with the lines indented under it, until a rule or the footer. */
function optionBlock(lines, start) {
  const width = widthOf(lines)
  const options = []
  let next = null
  let preview = false
  let i = start
  for (; i < lines.length; i++) {
    const line = lines[i]
    if (RULE.test(line) || /Esc to cancel/.test(line) || /^\s*Ready to submit/.test(line)) break
    const m = OPTION.exec(line)
    if (m && Number(m[2]) === options.length + 1) {
      if (BOX.test(m[4])) preview = true
      const label = m[4].replace(BOX, '').trim()
      options.push({ n: Number(m[2]), label, text: norm(label), checked: m[3] === undefined ? null : m[3] === '✔', cursor: m[1] === '❯' })
      continue
    }
    const nx = NEXT.exec(line)
    if (nx && options.length) {
      next = { label: nx[2], cursor: nx[1] === '❯' }
      continue
    }
    // Under an option: its description or the rest of a long label. Beside previews: the mockup.
    if (line.trim() && options.length && !preview && !next && /^\s{3,}/.test(line)) {
      const last = options.at(-1)
      last.text = wrapJoin(last.text, lines[i - 1], line, width)
    }
  }
  return { options, next, preview, end: i }
}

function review(lines, start, tabs) {
  const width = widthOf(lines)
  const answers = []
  let i = start
  for (; i < lines.length; i++) {
    const line = lines[i]
    if (/^\s*Ready to submit/.test(line) || OPTION.test(line)) break
    const q = /^\s*●\s+(.*)$/.exec(line)
    const a = /^\s*→\s+(.*)$/.exec(line)
    if (q) answers.push({ question: q[1].trim(), answer: null })
    else if (a && answers.length) answers.at(-1).answer = a[1].trim()
    else if (line.trim() && answers.length) {
      const last = answers.at(-1)
      if (last.answer === null) last.question = wrapJoin(last.question, lines[i - 1], line, width)
      else last.answer = wrapJoin(last.answer, lines[i - 1], line, width)
    }
  }
  while (i < lines.length && !OPTION.test(lines[i])) i++
  const { options } = optionBlock(lines, i)
  if (!options.length) return null
  return { kind: 'review', tabs, answers: answers.map(a => ({ question: norm(a.question), answer: norm(a.answer ?? '') })), options, cursor: options.find(o => o.cursor)?.n ?? null }
}

const PERM_OPTION = /^\s{0,3}(?:(❯)\s+)?(\d+)\.\s+(.*)$/

function permissionDialog(lines) {
  const width = widthOf(lines)
  let foot = -1
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/^\s*Esc to cancel/.test(lines[i])) {
      foot = i
      break
    }
  }
  if (foot < 0) return null
  // The options are the numbered rows right above the footer; the prompt is the line above them.
  let first = -1
  for (let i = foot - 1; i >= 0 && foot - i < 40; i--) {
    const m = PERM_OPTION.exec(lines[i])
    if (m && m[2] === '1') {
      first = i
      break
    }
  }
  if (first < 1) return null
  const options = []
  for (let i = first; i < foot; i++) {
    const m = PERM_OPTION.exec(lines[i])
    if (m && Number(m[2]) === options.length + 1) options.push({ n: options.length + 1, label: m[3].trim(), text: norm(m[3]), checked: null, cursor: !!m[1] })
    else if (lines[i].trim() && options.length) options.at(-1).text = wrapJoin(options.at(-1).text, lines[i - 1], lines[i], width)
  }
  let p = first - 1
  while (p > 0 && !lines[p].trim()) p--
  const prompt = lines[p].trim()
  if (options.length < 2 || !prompt.endsWith('?') || !options.some(o => o.cursor)) return null
  let top = p - 1
  while (top > 0 && !RULE.test(lines[top]) && p - top < 120) top--
  const rest = lines.slice(RULE.test(lines[top]) ? top + 1 : top, p).filter(l => !DASHED.test(l))
  while (rest.length && !rest[0].trim()) rest.shift()
  const title = (rest.shift() ?? '').trim()
  const body = rest.filter(l => !/^\s*Tip:/.test(l))
  while (body.length && !body.at(-1).trim()) body.pop()
  // The dialog's own one-space margin off, the tool's indentation kept.
  const shown = body.every(l => !l.trim() || l.startsWith(' ')) ? body.map(l => l.slice(1)) : body
  const fingerprint = createHash('sha256')
    .update(JSON.stringify([title, shown.map(norm), prompt, options.map(o => o.text)]))
    .digest('hex')
    .slice(0, 24)
  return { kind: 'permission', title, body: shown, prompt, options, cursor: options.find(o => o.cursor)?.n ?? null, fingerprint }
}

/** The dialog for the page: what it needs to show it and answer it, nothing of the parse. */
export function publicDialog(d) {
  if (!d) return null
  if (d.kind === 'permission') return { kind: d.kind, title: clip(d.title, 200), body: d.body.slice(0, 60).map(l => clip(l, 400)), prompt: clip(d.prompt, 300), options: d.options.map(o => ({ n: o.n, label: clip(o.text, 300) })), fingerprint: d.fingerprint }
  if (d.kind === 'review') return { kind: d.kind }
  return { kind: d.kind, question: clip(d.question, 1000) }
}

/** The screen shows question `q` of the dialog: its text and its options in order. */
export function onQuestion(d, q) {
  if (d?.kind !== 'question' || d.question !== norm(q.question)) return false
  if (d.options.length !== q.options.length + (q.preview ? 0 : 1)) return false
  return q.options.every((o, j) => d.options[j].text.startsWith(norm(o.label)))
}

/** Which of `questions` the screen shows: its index, questions.length for the review, -1 for neither. */
export function screenIndex(d, questions) {
  if (d?.kind === 'review') return questions.length
  return questions.findIndex(q => onQuestion(d, q))
}

/** The own answer the screen's last row holds ('' for the placeholder). */
export function typedOther(d) {
  const row = d?.options?.at(-1)
  if (!row) return ''
  return PLACEHOLDER.test(row.text) ? '' : row.text
}

/** A long own answer may be cut short with an ellipsis on screen; the start must agree. */
export function sameText(shown, wanted) {
  const a = norm(shown)
  const b = norm(wanted)
  if (a === b) return true
  const cut = a.replace(/…$/, '')
  return a.endsWith('…') && cut.length >= 20 && b.startsWith(cut)
}

/** The review screen lists exactly these answers. */
export function reviewMatches(d, questions, picks) {
  if (d?.kind !== 'review' || d.answers.length !== questions.length) return false
  return questions.every((q, i) => d.answers[i].question === norm(q.question) && sameText(d.answers[i].answer, answerText(q, picks[i])))
}

/** The arrow keys from one row to another (the "Next" row counts as the one after the last option). */
export function arrows(from, to) {
  const n = to - from
  return Array(Math.abs(n)).fill(n > 0 ? 'down' : 'up')
}

/** Row number of the cursor, with "Next" after the options. */
export const cursorRow = d => (d.cursor === 'next' ? d.options.length + 1 : d.cursor)
