// What the user picks in a question form on the board before it goes to the terminal, and the
// small rules around it. No DOM; questions.js draws the form. A question is the shape
// src/questions.mjs gives the page: { question, header, multiSelect, preview, options: [{ label,
// description, preview? }] }.

/** The questions a session waits on in its terminal, or null. */
export function pendingQuestions(it) {
  const tool = it?.tool
  return it?.status === 'blocked' && tool?.name === 'AskUserQuestion' && tool.pending && Array.isArray(tool.questions) && tool.questions.length ? tool.questions : null
}

/** One form per question call: a new call starts a new form. */
export const formKey = it => `${it.key}|${it.tool?.id ?? ''}`

/** Nothing picked yet. `other` is the own answer's text, `otherOn` whether it is the choice. */
export const emptyPicks = questions => questions.map(() => ({ options: [], other: '', otherOn: false }))

const update = (picks, i, next) => picks.map((p, j) => (j === i ? { ...p, ...next } : p))

/** Option `n` (from 1) of question `i` picked: the only one for a single select, toggled for multiSelect. */
export function choose(picks, questions, i, n) {
  const q = questions[i]
  const label = q?.options[n - 1]?.label
  if (label === undefined) return picks
  if (!q.multiSelect) return update(picks, i, { options: [label], otherOn: false })
  const on = new Set(picks[i].options)
  on.has(label) ? on.delete(label) : on.add(label)
  // In the order of the options, as the terminal lists them.
  return update(picks, i, { options: q.options.map(o => o.label).filter(l => on.has(l)) })
}

/** The own answer picked (single select) or toggled (multiSelect). */
export function chooseOther(picks, questions, i) {
  const q = questions[i]
  if (!q || q.preview) return picks
  return q.multiSelect ? update(picks, i, { otherOn: !picks[i].otherOn }) : update(picks, i, { options: [], otherOn: true })
}

/** Text typed into the own answer: like the terminal, typing picks it and an empty field drops it. */
export function typeOther(picks, questions, i, text) {
  const q = questions[i]
  if (!q || q.preview) return picks
  const has = !!String(text).trim()
  if (q.multiSelect) return update(picks, i, { other: text, otherOn: has })
  return update(picks, i, has ? { other: text, options: [], otherOn: true } : { other: text, otherOn: picks[i].otherOn && !picks[i].options.length })
}

/** The question has an answer the terminal will take. */
export function answered(question, pick) {
  const own = pick.otherOn && !!pick.other.trim()
  return question.multiSelect ? pick.options.length > 0 || own : pick.options.length === 1 ? !pick.otherOn : own
}

/** How many questions still need an answer. */
export const remaining = (questions, picks) => questions.filter((q, i) => !answered(q, picks[i])).length

/** The body for POST .../answer: labels picked and the own answer, per question. */
export function payload(questions, picks) {
  return questions.map((q, i) => ({ options: picks[i].options, other: picks[i].otherOn ? picks[i].other.trim() : '' }))
}

/** A lone single-select question is answered by one click or key, as a digit does in the terminal. */
export const instant = questions => questions.length === 1 && !questions[0].multiSelect

/** What digit `d` means on a question: an option number, 'other' for the row after them, or null. */
export function digitTarget(question, d) {
  if (!question || !Number.isInteger(d) || d < 1) return null
  if (d <= question.options.length) return d
  return d === question.options.length + 1 && !question.preview ? 'other' : null
}

/** The question the keys go to: the one with the focus, else the first without an answer. */
export function currentQuestion(questions, picks, focused) {
  if (Number.isInteger(focused) && questions[focused]) return focused
  const open = questions.findIndex((q, i) => !answered(q, picks[i]))
  return open < 0 ? questions.length - 1 : open
}

/** A permission option by its words: allow, allow for good (or switch modes), or refuse. */
export function permissionTone(label) {
  const l = String(label).trim().toLowerCase()
  if (/^no\b/.test(l)) return 'no'
  if (/^yes\b/.test(l)) return l === 'yes' ? 'yes' : 'always'
  return 'other'
}
