// Answers a dialog that holds a session in its terminal, from the board: a question form
// (AskUserQuestion) or a permission prompt. The choice becomes key presses in the pane through
// herdr, one step at a time, and every step waits until the screen shows what that key should
// have done (questions.mjs says how the dialog behaves). Nothing is pressed into a pane that
// shows another session, another dialog, or a question already answered; anything unexpected
// stops it and the user is told where it stopped.
import { herdr, herdrText } from './herdr.mjs'
import { transcriptInfo } from './claude.mjs'
import { t } from './lang.mjs'
import { inputDraft } from './screen.mjs'
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

/**
 * Reading and typing in one pane through herdr. `agent send-keys` takes the pane id as its
 * target (`pane send-keys` would do too). Text goes literally with `pane send-text`: `agent
 * prompt` refuses a pane that waits in a dialog. herdr 0.9 types even "-x" or "--help" as text,
 * but a leading dash gets a space before it all the same, as the board's other calls do, so a
 * herdr that reads it as an option cannot; typeOther() takes that space out of the field again.
 */
export function paneIO(pane) {
  return {
    read: () => herdrText(['agent', 'read', pane, '--source', 'visible'], 5000),
    keys: (...keys) => herdr(['agent', 'send-keys', pane, ...keys], 10_000),
    text: text => herdr(['pane', 'send-text', pane, /^-/.test(text) ? ` ${text}` : text], 10_000),
  }
}

/** The same io, counting what it sent and keeping the last screen it read: where a failure leaves the dialog. */
function counted(io) {
  const seen = { sent: 0, screen: '' }
  return {
    seen,
    io: {
      ...io,
      read: async () => (seen.screen = await io.read()),
      keys: (...keys) => {
        seen.sent += keys.length
        return io.keys(...keys)
      },
      text: text => {
        seen.sent++
        return io.text(text)
      },
    },
  }
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

/**
 * Reads the screen until `ok(dialog)` holds; throws Stop('stuck') after `timeout` ms. Returns the
 * dialog. Claude Code redraws within tens of milliseconds; herdr's read takes about a tenth of a second.
 */
async function until(io, ok, step, { timeout = 3000, every = 100 } = {}) {
  const end = Date.now() + timeout
  for (;;) {
    const screen = await io.read()
    const d = parseDialog(screen)
    if (ok(d)) return d
    if (Date.now() > end) throw new Stop('stuck', step, screen)
    await sleep(every)
  }
}

/**
 * Waits until the dialog is surely gone, which a blank or half-drawn screen does not prove: the
 * transcript has the answer (io.answered, when the caller can tell), or two reads in a row show
 * Claude's input box with no dialog, or a whole other dialog. `ours(dialog)`: the dialog is still
 * the one answered. Throws Stop('unconfirmed') after `timeout` ms.
 */
async function settled(io, ours, step, { timeout = 5000, every = 100 } = {}) {
  const end = Date.now() + timeout
  let streak = 0
  for (;;) {
    if (io.answered && (await io.answered())) return
    const screen = await io.read()
    const d = parseDialog(screen)
    streak = !ours(d) && (d || inputDraft(screen) !== null) ? streak + 1 : 0
    if (streak >= 2) return
    if (Date.now() > end) throw new Stop('unconfirmed', step, screen)
    await sleep(every)
  }
}

/**
 * Types an own answer into the field the cursor is on and waits until the field holds it. The
 * space paneIO puts before a leading dash is taken out again (start of the line, one right, one
 * back), so the answer is the text as written, which the screen then shows with nothing before it.
 */
async function typeOther(io, wait, q, text, step) {
  const row = q.options.length + 1
  await io.text(text)
  const d = await wait(x => onQuestion(x, q) && x.cursor === row && sameText(typedOther(x), text), step)
  if (!d.options[row - 1].spaced) return d
  await io.keys('ctrl+a', 'right', 'backspace')
  return wait(x => onQuestion(x, q) && x.cursor === row && sameText(typedOther(x), text) && !x.options[row - 1].spaced, step)
}

/** A failure of herdr itself, with what was sent before it. */
const broken = (err, seen) => ({ ok: false, reason: 'herdr', why: err.message, sent: seen.sent, screen: seen.screen })

/**
 * Drives the question dialog to these answers and submits it. `picks` from resolveAnswers.
 * Resolves { ok: true } once the dialog is surely gone, or { ok: false, reason, step, screen, sent }:
 *   changed      the screen does not show these questions (nothing was pressed in that state)
 *   stuck        a key did not do what it should have
 *   review       the review screen lists other answers than these, or no "Submit answers" (not submitted)
 *   unconfirmed  submitted, but the screen never showed the dialog gone
 *   herdr        herdr failed (why); `sent` says whether keys went in before
 */
export async function driveQuestions({ questions, picks, io: raw, timing }) {
  const { io, seen } = counted(raw)
  const wait = (ok, step) => until(io, ok, step, timing)
  const leaveText = async (d, i, step) => {
    // On the own-answer row keys are text: up puts the cursor back on the options.
    if (!d.editing) return d
    await io.keys('up')
    return wait(x => onQuestion(x, questions[i]) && !x.editing, step)
  }
  const ours = x => screenIndex(x, questions) >= 0
  try {
    let d = parseDialog(await io.read())
    let at = screenIndex(d, questions)
    if (at < 0) throw new Stop('changed', { what: 'start' }, seen.screen)
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
      // A lone single-choice question is submitted by its answer: settled() below waits for that,
      // the transcript included, rather than for the screen to move on.
      const lone = questions.length === 1 && !q.multiSelect
      const moved = x => lone || !onQuestion(x, q)
      if (!q.multiSelect) {
        if (pick.other) {
          const row = q.options.length + 1
          const step = { q: i + 1, what: 'other' }
          const keys = arrows(cursorRow(d), row)
          if (keys.length) await io.keys(...keys)
          await wait(x => onQuestion(x, q) && x.cursor === row && x.editing, step)
          await io.keys('ctrl+u')
          await wait(x => onQuestion(x, q) && x.cursor === row && typedOther(x) === '', step)
          await typeOther(io, wait, q, pick.other, step)
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
        await typeOther(io, wait, q, pick.other, step)
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
    // A lone single-choice question is submitted by its answer; the others end on the review.
    if (questions.length > 1 || questions[0].multiSelect) {
      d = await wait(x => x?.kind === 'review', { what: 'review' })
      if (!reviewMatches(d, questions, picks) || d.options[0]?.text !== 'Submit answers') throw new Stop('review', { what: 'review' }, seen.screen)
      await io.keys('1')
    }
    await settled(io, ours, { what: 'submit' }, timing)
    return { ok: true }
  } catch (err) {
    if (err instanceof Stop) return { ok: false, reason: err.reason, step: err.step, screen: err.screen, sent: seen.sent }
    return broken(err, seen)
  }
}

/** Picks option `n` of the permission prompt whose fingerprint the user saw. Results as driveQuestions. */
export async function drivePermission({ fingerprint, n, io: raw, timing }) {
  const { io, seen } = counted(raw)
  const ours = x => x?.kind === 'permission' && x.fingerprint === fingerprint
  try {
    const d = parseDialog(await io.read())
    if (!ours(d) || !d.options.some(o => o.n === n)) return { ok: false, reason: 'changed', step: { what: 'start' }, screen: seen.screen, sent: 0 }
    await io.keys(String(n))
    await settled(io, ours, { what: 'option', n }, timing)
    return { ok: true }
  } catch (err) {
    if (err instanceof Stop) return { ok: false, reason: err.reason, step: err.step, screen: err.screen, sent: seen.sent }
    return broken(err, seen)
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

/**
 * The pane still holds this Claude session, waiting in a dialog. Returns an error result or null.
 * gone: the dialog is no longer there to answer.
 */
export async function checkPane(item) {
  if (!item?.pane) return { ok: false, error: t('err.noPane') }
  if (item.agent !== 'claude' || !item.session) return { ok: false, error: t('err.qa.notClaude', { name: item.name }) }
  if (item.sleeping) return { ok: false, gone: true, error: t('err.qa.notWaiting', { name: item.name }) }
  try {
    const agent = (await herdr(['agent', 'get', item.pane]))?.agent
    if (!agent || (agent.agent_session?.value ?? null) !== item.session) return { ok: false, error: t('err.sessionChanged', { name: item.name }) }
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

/**
 * A run that did not go through, for the page. stopped: keys went in, so the dialog may be partly
 * filled in; the screen shows where it was left.
 */
function failure(item, r) {
  const name = item.name
  if (r.reason === 'herdr' && !r.sent) return { ok: false, error: t('err.qa.herdr', { why: r.why }) }
  const error =
    r.reason === 'herdr' ? t('err.qa.herdrMidway', { name, why: r.why })
    : r.reason === 'changed' ? t('err.qa.changed', { name })
    : r.reason === 'review' ? t('err.qa.review', { name })
    : r.reason === 'unconfirmed' ? t('err.qa.unconfirmed', { name })
    : t('err.qa.stuck', { name, step: stepText(r.step) })
  return { ok: false, error, stopped: r.sent > 0, screen: tail(r.screen) }
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
  // The transcript holds the answer once Claude Code took it: proof the form is done.
  const answered = () => {
    const now = transcriptInfo(item.transcript)?.tool
    return !!now && (now.id !== tool.id || !now.pending)
  }
  const r = await driveQuestions({ questions: tool.questions, picks, io: { ...io, answered } })
  if (!r.ok) return failure(item, r)
  return { ok: true, answers: tool.questions.map((q, i) => ({ question: q.question, answer: answerText(q, picks[i]) })) }
}

/** Pick option `n` of the permission prompt the user saw (its fingerprint, from the screen). */
export async function answerPermission(item, body, io = paneIO(item?.pane)) {
  const n = Number(body?.option)
  if (!Number.isInteger(n) || n < 1 || n > 9 || typeof body?.fingerprint !== 'string') return { ok: false, error: t('err.qa.invalid') }
  const bad = await checkPane(item)
  if (bad) return bad
  const r = await drivePermission({ fingerprint: body.fingerprint, n, io })
  return r.ok ? { ok: true } : failure(item, r)
}
