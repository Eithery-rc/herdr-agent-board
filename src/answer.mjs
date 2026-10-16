// Answers a dialog that holds a session in its terminal, from the board: a question form
// (AskUserQuestion) or a permission prompt. The choice becomes key presses in the pane through
// herdr, one step at a time, and every step waits until the screen shows what that key should
// have done (questions.mjs says how the dialog behaves). Nothing is pressed into a pane that
// shows another session, another dialog, or a question already answered; anything unexpected
// stops it and the user is told where it stopped.
import { herdr, herdrText } from './herdr.mjs'
import { transcriptInfo } from './claude.mjs'
import { t } from './lang.mjs'
import {
  answerText,
  arrows,
  cursorRow,
  onQuestion,
  parseDialog,
  resolveAnswers,
  reviewMatches,
  sameText,
  screenIndex,
  typedOther,
} from './questions.mjs'

/** A step that did not end as expected: why, the step ({ q, what, n }), and the screen it ended on. */
class Stop extends Error {
  constructor(reason, step, screen = '') {
    super(reason)
    this.reason = reason
    this.step = step
    this.screen = screen
  }
}

/** Reading and typing in one pane through herdr. */
export function paneIO(pane) {
  return {
    read: () => herdrText(['agent', 'read', pane, '--source', 'visible'], 5000),
    keys: (...keys) => herdr(['agent', 'send-keys', pane, ...keys], 10_000),
    // Literal text, not a prompt: `agent prompt` refuses a pane that waits in a dialog.
    text: text => herdr(['pane', 'send-text', pane, text], 10_000),
  }
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

/**
 * Reads the screen until `ok(dialog)` holds; throws Stop('stuck') after `timeout` ms. Returns the
 * dialog. Claude Code redraws within tens of milliseconds; herdr's read takes about a tenth of a second.
 */
async function until(io, ok, step, { timeout = 3000, every = 100 } = {}) {
  const end = Date.now() + timeout
  let screen = ''
  for (;;) {
    screen = await io.read()
    const d = parseDialog(screen)
    if (ok(d)) return d
    if (Date.now() > end) throw new Stop('stuck', step, screen)
    await sleep(every)
  }
}

/**
 * Drives the question dialog to these answers and submits it. `picks` from resolveAnswers.
 * Resolves { ok: true } once the dialog is gone, or { ok: false, reason, step, screen }:
 *   changed  the screen does not show these questions (nothing was pressed in that state)
 *   stuck    a key did not do what it should have
 *   review   the review screen lists other answers than these (not submitted)
 */
export async function driveQuestions({ questions, picks, io, timing }) {
  const wait = (ok, step) => until(io, ok, step, timing)
  const read = async () => {
    const screen = await io.read()
    return { screen, d: parseDialog(screen) }
  }
  const leaveText = async (d, i, step) => {
    // On the own-answer row keys are text: up puts the cursor back on the options.
    if (!d.editing) return d
    await io.keys('up')
    return wait(x => onQuestion(x, questions[i]) && !x.editing, step)
  }
  try {
    let { screen, d } = await read()
    let at = screenIndex(d, questions)
    if (at < 0) throw new Stop('changed', { what: 'start' }, screen)
    // Begun in the terminal: back to the first question (left moves one tab back).
    while (at > 0) {
      if (d.kind === 'question') d = await leaveText(d, at, { what: 'back' })
      const from = at
      await io.keys('left')
      d = await wait(x => screenIndex(x, questions) === from - 1, { what: 'back' })
      at = from - 1
    }
    for (const [i, q] of questions.entries()) {
      const pick = picks[i]
      d = await wait(x => onQuestion(x, q), { q: i + 1, what: 'question' })
      d = await leaveText(d, i, { q: i + 1, what: 'question' })
      const moved = x => !onQuestion(x, q)
      if (!q.multiSelect) {
        if (pick.other) {
          const row = q.options.length + 1
          const step = { q: i + 1, what: 'other' }
          const keys = arrows(cursorRow(d), row)
          if (keys.length) await io.keys(...keys)
          await wait(x => onQuestion(x, q) && x.cursor === row && x.editing, step)
          await io.keys('ctrl+u')
          await wait(x => onQuestion(x, q) && x.cursor === row && typedOther(x) === '', step)
          await io.text(pick.other)
          await wait(x => onQuestion(x, q) && x.cursor === row && sameText(typedOther(x), pick.other), step)
          await io.keys('enter')
          await wait(moved, step)
        } else if (q.preview) {
          const [n] = pick.choose
          await io.keys(String(n))
          await wait(x => onQuestion(x, q) && x.cursor === n, { q: i + 1, what: 'option', n })
          await io.keys('enter')
          await wait(moved, { q: i + 1, what: 'option', n })
        } else {
          const [n] = pick.choose
          await io.keys(String(n))
          await wait(moved, { q: i + 1, what: 'option', n })
        }
        continue
      }
      // multiSelect: tick what differs, one key at a time.
      for (const [j] of q.options.entries()) {
        const n = j + 1
        const want = pick.choose.includes(n)
        if (d.options[j].checked === want) continue
        await io.keys(String(n))
        d = await wait(x => onQuestion(x, q) && x.options[j].checked === want, { q: i + 1, what: 'option', n })
      }
      const row = q.options.length + 1
      const step = { q: i + 1, what: 'other' }
      if (pick.other) {
        const keys = arrows(cursorRow(d), row)
        if (keys.length) await io.keys(...keys)
        await wait(x => onQuestion(x, q) && x.cursor === row && x.editing, step)
        await io.keys('ctrl+u')
        await wait(x => onQuestion(x, q) && typedOther(x) === '', step)
        await io.text(pick.other)
        d = await wait(x => onQuestion(x, q) && sameText(typedOther(x), pick.other) && x.options[row - 1].checked, step)
      } else if (d.options[row - 1].checked) {
        await io.keys(String(row))
        d = await wait(x => onQuestion(x, q) && !x.options[row - 1].checked, step)
      }
      // On to the next tab by the row under the options.
      const keys = arrows(cursorRow(d), row + 1)
      if (keys.length) await io.keys(...keys)
      await wait(x => onQuestion(x, q) && x.cursor === 'next', { q: i + 1, what: 'next' })
      await io.keys('enter')
      await wait(moved, { q: i + 1, what: 'next' })
    }
    const gone = x => screenIndex(x, questions) < 0
    if (questions.length === 1 && !questions[0].multiSelect) {
      await wait(gone, { what: 'submit' })
      return { ok: true }
    }
    d = await wait(x => x?.kind === 'review' || gone(x), { what: 'review' })
    if (d?.kind !== 'review') return { ok: true }
    if (!reviewMatches(d, questions, picks)) throw new Stop('review', { what: 'review' }, (await read()).screen)
    await io.keys('1') // "1. Submit answers"
    await wait(gone, { what: 'submit' })
    return { ok: true }
  } catch (err) {
    if (err instanceof Stop) return { ok: false, reason: err.reason, step: err.step, screen: err.screen }
    throw err
  }
}

/** Picks option `n` of the permission prompt whose fingerprint the user saw. */
export async function drivePermission({ fingerprint, n, io, timing }) {
  const screen = await io.read()
  const d = parseDialog(screen)
  if (d?.kind !== 'permission' || d.fingerprint !== fingerprint || !d.options.some(o => o.n === n)) return { ok: false, reason: 'changed', step: { what: 'start' }, screen }
  await io.keys(String(n))
  try {
    await until(io, x => x?.kind !== 'permission' || x.fingerprint !== fingerprint, { what: 'option', n }, timing)
    return { ok: true }
  } catch (err) {
    if (err instanceof Stop) return { ok: false, reason: err.reason, step: err.step, screen: err.screen }
    throw err
  }
}

/** The last lines of a screen, for the user to see where it stopped. */
const tail = screen =>
  String(screen ?? '')
    .split('\n')
    .map(l => l.trimEnd())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .split('\n')
    .slice(-24)
    .join('\n')

/** The pane still holds this session, waiting in a dialog. Returns an error result or null. */
async function checkPane(item) {
  if (!item?.pane) return { ok: false, error: t('err.noPane') }
  if (item.sleeping) return { ok: false, error: t('err.qa.notWaiting', { name: item.name }) }
  try {
    const agent = (await herdr(['agent', 'get', item.pane]))?.agent
    if (!agent || (agent.agent_session?.value ?? null) !== (item.session ?? null)) return { ok: false, error: t('err.sessionChanged', { name: item.name }) }
    if (agent.agent_status !== 'blocked') return { ok: false, gone: true, error: t('err.qa.notWaiting', { name: item.name }) }
  } catch (err) {
    return { ok: false, error: t('err.qa.herdr', { why: err.message }) }
  }
  return null
}

/** Where a run stopped, in words: "question 2, option 3". */
function stepText(step = {}) {
  const what = t(`qa.step.${step.what}`, { n: step.n ?? '' })
  return step.q ? t('qa.step.inQuestion', { q: step.q, what }) : what
}

function failure(item, r) {
  const error =
    r.reason === 'changed' ? t('err.qa.changed', { name: item.name })
    : r.reason === 'review' ? t('err.qa.review', { name: item.name })
    : t('err.qa.stuck', { name: item.name, step: stepText(r.step) })
  return { ok: false, error, stopped: r.reason !== 'changed', screen: tail(r.screen) }
}

/**
 * Answer the question form the session waits in. `body`: { toolUseId, answers } where answers
 * holds one { options: [labels], other } per question. The questions come from the transcript,
 * not from the page: the page only says which labels it picked.
 */
export async function answerQuestions(item, body, io = paneIO(item?.pane)) {
  const bad = await checkPane(item)
  if (bad) return bad
  const tool = transcriptInfo(item.transcript)?.tool
  if (tool?.name !== 'AskUserQuestion' || !tool.pending || tool.id !== body?.toolUseId) return { ok: false, gone: true, error: t('err.qa.answered', { name: item.name }) }
  if (!tool.questions) return { ok: false, error: t('err.qa.unknown', { name: item.name }) }
  const { picks, error } = resolveAnswers(tool.questions, body.answers)
  if (error) return { ok: false, error: t(error) }
  let r
  try {
    r = await driveQuestions({ questions: tool.questions, picks, io })
  } catch (err) {
    return { ok: false, stopped: true, error: t('err.qa.herdr', { why: err.message }) }
  }
  if (!r.ok) return failure(item, r)
  return { ok: true, answers: tool.questions.map((q, i) => ({ question: q.question, answer: answerText(q, picks[i]) })) }
}

/** Pick option `n` of the permission prompt the user saw (its fingerprint, from the screen). */
export async function answerPermission(item, body, io = paneIO(item?.pane)) {
  const bad = await checkPane(item)
  if (bad) return bad
  const n = Number(body?.option)
  if (!Number.isInteger(n) || n < 1 || n > 9 || typeof body?.fingerprint !== 'string') return { ok: false, error: t('err.qa.invalid') }
  let r
  try {
    r = await drivePermission({ fingerprint: body.fingerprint, n, io })
  } catch (err) {
    return { ok: false, stopped: true, error: t('err.qa.herdr', { why: err.message }) }
  }
  return r.ok ? { ok: true } : failure(item, r)
}
