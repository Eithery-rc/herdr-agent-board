// Questions a session asks in its terminal, answered from the board. A question form
// (AskUserQuestion) shows its questions, headers, options with their descriptions and an own
// answer; a permission prompt shows what the tool will do and the terminal's own choices. The
// answer goes to the server, which types it into the pane and checks the screen after every key
// (src/answer.mjs); here it is picked, sent once, and its outcome shown in place.
import {
  chooseOther,
  choose,
  currentQuestion,
  digitTarget,
  emptyPicks,
  formKey,
  instant,
  payload,
  pendingQuestions,
  permissionTone,
  remaining,
  typeOther,
} from './question-model.js'

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
const SPIN = '<svg class="spin" viewBox="0 0 20 20" aria-hidden="true"><path d="M10 3a7 7 0 1 1-7 7"/></svg>'
const CHECK = '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="m4.5 10.5 3.5 3.5 7.5-8"/></svg>'
const FOCUS = '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M7 4.5h8.5V13M15 5 5 15"/></svg>'

/**
 * box: the sheet's question area. item(): the session in the sheet. act(key, action, body) posts
 * an action and resolves the server's answer. canMutate(): fresh herdr data (else read only).
 */
export function initQuestions({ box, t, item, act, toast, canMutate, focusSession }) {
  const forms = new Map() // form key -> { picks, status: idle | sending | sent | error, error, screen, chosen }
  let shown = null // { kind: 'question' | 'permission', key, it, questions | dialog }
  let answered = null // { shown, at }: the last answer that went through, until herdr sees the session move on

  const formOf = (key, questions) => {
    let f = forms.get(key)
    if (!f) {
      f = { picks: questions ? emptyPicks(questions) : [], status: 'idle', error: '', screen: '', chosen: null }
      forms.set(key, f)
      // Only the forms of the sessions on show are worth keeping.
      for (const k of forms.keys()) if (forms.size > 12 && k !== key) forms.delete(k)
    }
    return f
  }

  // ------------------------------------------------------------ the card and the thread
  /** The question on a card under "Needs me": header, question, the options in one line. */
  function cardAsk(it, plain) {
    const qs = pendingQuestions(it)
    if (!qs) return ''
    const q = qs[0]
    const tag = q.header ? `<span class="qa-tag">${esc(q.header)}</span>` : ''
    const opts = q.options.map(o => o.label).join(' · ') + (q.multiSelect ? ` · ${t()('qa.any')}` : '')
    const more = qs.length > 1 ? `<span class="qa-more">${esc(t()('qa.more', { n: qs.length - 1 }))}</span>` : ''
    return `<div class="ask qa-card"><div class="qa-card-q"><b>${esc(t()('att.ask'))}:</b> ${tag}${esc(plain(q.question))}</div><div class="qa-card-opts">${esc(opts)}${more}</div></div>`
  }

  /** A question form in the conversation: what was asked and what was answered. */
  function threadHTML(m, live, when) {
    const rows = m.ask
      .map((q, i) => {
        const a = m.answers?.[i]
        const tag = q.header ? `<span class="qa-tag">${esc(q.header)}</span>` : ''
        return `<div class="qa-line">${tag}<span class="qa-line-q">${esc(q.question)}</span>${a ? `<span class="qa-ans">${esc(a)}</span>` : ''}</div>`
      })
      .join('')
    const state = m.answers ? '' : !m.done ? (live ? `<div class="qa-wait">${esc(t()('qa.thread.waiting'))}</div>` : '') : `<div class="qa-wait">${esc(t()('qa.thread.closed'))}</div>`
    return `<div class="msg assistant qa-msg"><div class="qa-asked">${esc(t()('qa.thread.asked'))}</div>${rows}${state}<span class="when">${esc(when)}</span></div>`
  }

  // ------------------------------------------------------------ the sheet
  /** What the sheet should show for this session: a question form, a permission prompt, or null. */
  function wants(it, detail) {
    if (!it) return null
    const qs = pendingQuestions(it)
    if (qs) return { kind: 'question', key: formKey(it), it, questions: qs }
    const dialog = detail?.item?.key === it.key ? detail.dialog : null
    // Answered: the transcript knows at once, herdr's status follows a refresh later. Until then
    // the form stays, saying it went through, rather than "answer in the terminal"; a new
    // permission prompt on the screen takes over.
    if (answered?.shown.it.key === it.key) {
      if (it.status !== 'blocked' || Date.now() - answered.at > 10_000) answered = null
      else if (!(dialog?.kind === 'permission' && dialog.fingerprint !== answered.shown.dialog?.fingerprint)) return { ...answered.shown, it }
    }
    if (it.status === 'blocked' && dialog?.kind === 'permission') return { kind: 'permission', key: `${it.key}|${dialog.fingerprint}`, it, dialog }
    return null
  }

  /** Draws the form into the box when the session has one; false leaves the box to the caller. */
  function mount(it, detail) {
    shown = wants(it, detail)
    if (!shown) {
      if (box._qa) box._qa = box._html = ''
      return false
    }
    const f = formOf(shown.key, shown.questions)
    const tr = t()
    // Built again only when its shape changes; picks and availability are set in place (sync),
    // so a click or a keystroke never loses the focus or the own answer being typed.
    const shape = JSON.stringify([tr.lang, shown.key, f.status, f.error, f.screen, f.chosen])
    if (box._qa !== shape) {
      const focused = box.contains(document.activeElement) ? document.activeElement.dataset.focusId : null
      box.innerHTML = shown.kind === 'question' ? questionHTML(shown, f, tr) : permissionHTML(shown, f, tr)
      box._qa = box._html = shape
      if (focused) box.querySelector(`[data-focus-id="${CSS.escape(focused)}"]`)?.focus()
      for (const input of box.querySelectorAll('.qa-input')) input.value = f.picks[Number(input.dataset.q)]?.other ?? ''
    }
    sync()
    return true
  }

  function questionHTML(s, f, tr) {
    const many = s.questions.length > 1
    const busy = f.status === 'sending' || f.status === 'sent'
    const sections = s.questions
      .map((q, i) => {
        const id = `qa-q-${i}`
        const kind = q.multiSelect ? tr('qa.any') : tr('qa.one')
        const head = `<div class="qa-head">${q.header ? `<span class="qa-tag">${esc(q.header)}</span>` : ''}<span class="qa-kind">${esc(kind)}</span>${many ? `<span class="qa-step">${i + 1}/${s.questions.length}</span>` : ''}</div>`
        const role = q.multiSelect ? 'checkbox' : 'radio'
        const opts = q.options
          .map(
            (o, j) =>
              `<button type="button" class="qa-opt" role="${role}" aria-checked="false" data-q="${i}" data-n="${j + 1}" data-focus-id="${i}.${j + 1}"><span class="qa-n" aria-hidden="true">${j + 1}</span><span class="qa-body"><span class="qa-label">${esc(o.label)}</span>${o.description ? `<span class="qa-desc">${esc(o.description)}</span>` : ''}</span><span class="qa-mark" aria-hidden="true"></span></button>`,
          )
          .join('')
        const other = q.preview
          ? ''
          : `<div class="qa-opt qa-other" data-q="${i}" data-n="other"><span class="qa-n" aria-hidden="true">${q.options.length + 1}</span><input class="qa-input" data-q="${i}" data-focus-id="${i}.other" maxlength="1000" placeholder="${esc(tr('qa.otherHint'))}" aria-label="${esc(tr('qa.other'))}" autocomplete="off"><span class="qa-mark" aria-hidden="true"></span></div>`
        const preview = q.preview ? `<pre class="qa-preview" data-q="${i}" hidden></pre>` : ''
        return `<section class="qa-q" data-q="${i}">${head}<p class="qa-text" id="${id}">${esc(q.question)}</p><div class="qa-opts" role="${q.multiSelect ? 'group' : 'radiogroup'}" aria-labelledby="${id}">${opts}${other}</div>${preview}</section>`
      })
      .join('')
    const send = `<button type="button" class="button primary qa-send" data-qa-send>${busy ? SPIN : ''}<span></span></button>`
    const foot = `<div class="qa-foot"><span class="qa-hint" aria-live="polite"></span>${send}</div>`
    return `<div class="asked qa${busy ? ' busy' : ''}" aria-busy="${f.status === 'sending'}"><b>${esc(tr('why.choice', { n: s.questions.length }))}</b>${sections}${foot}${statusHTML(f, tr)}</div>`
  }

  function permissionHTML(s, f, tr) {
    const d = s.dialog
    const body = d.body.join('\n').trim()
    const opts = d.options
      .map(o => {
        const chosen = f.chosen === o.n
        return `<button type="button" class="qa-opt perm-opt ${permissionTone(o.label)}${chosen ? ' chosen' : ''}" data-perm="${o.n}" data-focus-id="p.${o.n}"><span class="qa-n" aria-hidden="true">${o.n}</span><span class="qa-body"><span class="qa-label">${esc(o.label)}</span></span>${chosen && f.status === 'sending' ? SPIN : ''}</button>`
      })
      .join('')
    return `<div class="asked qa perm${f.status === 'sending' || f.status === 'sent' ? ' busy' : ''}" aria-busy="${f.status === 'sending'}"><b>${esc(tr('why.permission'))}</b>${d.title ? `<div class="perm-title">${esc(d.title)}</div>` : ''}${body ? `<pre class="perm-body">${esc(body)}</pre>` : ''}<p class="qa-text">${esc(d.prompt)}</p><div class="qa-opts">${opts}</div>${statusHTML(f, tr)}</div>`
  }

  /** How it went: on its way, done, or why not, with a way to the terminal. */
  function statusHTML(f, tr) {
    if (f.status === 'sending') return `<div class="qa-status" role="status">${SPIN}<span>${esc(tr('qa.sending'))}</span></div>`
    if (f.status === 'sent') return `<div class="qa-status ok" role="status">${CHECK}<span>${esc(tr('qa.sent'))}</span></div>`
    if (f.status !== 'error') return '<div class="qa-status" role="status" hidden></div>'
    const screen = f.screen ? `<details class="qa-screen"><summary>${esc(tr('qa.screen'))}</summary><pre class="screen">${esc(f.screen)}</pre></details>` : ''
    return `<div class="qa-status error" role="alert"><span>${esc(f.error)}</span><button type="button" class="button" data-qa-focus>${FOCUS}<span>${esc(tr('sheet.focus'))}</span></button>${screen}</div>`
  }

  /** Picks, the send button and the read-only state, set on the drawn form. */
  function sync() {
    if (!shown || !box._qa) return
    const tr = t()
    const f = forms.get(shown.key)
    if (!f) return
    const locked = !canMutate() || f.status === 'sending' || f.status === 'sent'
    for (const el of box.querySelectorAll('button.qa-opt, .qa-input')) el.disabled = locked
    box.firstElementChild?.classList.toggle('read-only', !canMutate())
    for (const el of box.querySelectorAll('[data-qa-focus]')) el.disabled = !canMutate()
    if (shown.kind !== 'question') return
    const qs = shown.questions
    for (const el of box.querySelectorAll('.qa-opt[data-q]')) {
      const i = Number(el.dataset.q)
      const p = f.picks[i]
      const on = el.dataset.n === 'other' ? p.otherOn : p.options.includes(qs[i].options[Number(el.dataset.n) - 1]?.label)
      el.classList.toggle('on', on)
      if (el.tagName === 'BUTTON') el.setAttribute('aria-checked', String(on))
    }
    for (const pre of box.querySelectorAll('.qa-preview')) {
      // The option under the pointer or the focus, as the terminal shows the one under its cursor;
      // else the one picked, else the first.
      const i = Number(pre.dataset.q)
      const label = f.picks[i].options[0]
      const o = (peek?.q === i ? qs[i].options[peek.n - 1] : null) ?? qs[i].options.find(x => x.label === label) ?? qs[i].options[0]
      pre.textContent = o?.preview ?? ''
      pre.hidden = !o?.preview
    }
    const left = remaining(qs, f.picks)
    const send = box.querySelector('[data-qa-send]')
    send.lastChild.textContent = f.status === 'error' ? tr('qa.retry') : tr('qa.send', { n: qs.length })
    send.disabled = locked || left > 0
    send.title = !canMutate() ? tr('mobile.readOnly') : left ? tr('qa.left', { n: left }) : ''
    // One question picked with a click needs no button, unless it is an own answer.
    send.hidden = instant(qs) && !f.picks[0].otherOn && f.status !== 'error'
    const hint = box.querySelector('.qa-hint')
    // The keys only where there is a keyboard to press them on.
    const keys = matchMedia('(pointer: fine)').matches ? tr('qa.keys', { n: Math.min(9, Math.max(...qs.map(q => q.options.length + (q.preview ? 0 : 1)))) }) : ''
    const text = !canMutate() ? tr('mobile.readOnly') : left && qs.length > 1 ? tr('qa.left', { n: left }) : keys
    if (hint.textContent !== text) hint.textContent = text
  }

  // ------------------------------------------------------------ answering
  async function sendQuestions() {
    const s = shown
    if (s?.kind !== 'question' || !canMutate()) return
    const f = forms.get(s.key)
    if (!f || f.status === 'sending' || f.status === 'sent' || remaining(s.questions, f.picks)) return
    Object.assign(f, { status: 'sending', error: '', screen: '' })
    mount(item(), null)
    const r = await act(s.it.key, 'answer', { session: s.it.session ?? null, toolUseId: s.it.tool.id, answers: payload(s.questions, f.picks) })
    finish(s, f, r, () => t()('qa.done', { name: s.it.name }))
  }

  async function sendPermission(n) {
    const s = shown
    if (s?.kind !== 'permission' || !canMutate()) return
    const f = forms.get(s.key)
    const o = s.dialog.options.find(x => x.n === n)
    if (!f || !o || f.status === 'sending' || f.status === 'sent') return
    Object.assign(f, { status: 'sending', error: '', screen: '', chosen: n })
    mount(item(), lastDetail)
    const r = await act(s.it.key, 'permit', { session: s.it.session ?? null, fingerprint: s.dialog.fingerprint, option: n })
    finish(s, f, r, () => t()('qa.permDone', { name: s.it.name, choice: o.label }))
  }

  function finish(s, f, r, done) {
    if (r.ok) {
      f.status = 'sent'
      answered = { shown: s, at: Date.now() }
      toast(done())
    } else Object.assign(f, { status: 'error', error: r.error || t()('qa.failed'), screen: r.screen || '' })
    if (shown?.key === s.key) mount(item(), lastDetail)
    // The form went with the dialog (answered in the terminal meanwhile): the reason in a toast.
    else if (!r.ok) toast(f.error, true)
  }

  // ------------------------------------------------------------ input
  let lastDetail = null
  let peek = null // { q, n }: the preview option under the pointer or the focus
  const questionOf = el => (el?.closest?.('[data-q]') ? Number(el.closest('[data-q]').dataset.q) : null)

  function pick(i, n, { viaKey = false } = {}) {
    const s = shown
    const f = s && forms.get(s.key)
    if (!f || s.kind !== 'question' || f.status === 'sending' || f.status === 'sent' || !canMutate()) return
    if (f.status === 'error') f.status = 'idle'
    if (n === 'other') {
      f.picks = chooseOther(f.picks, s.questions, i)
      sync()
      if (f.picks[i].otherOn || !s.questions[i].multiSelect) box.querySelector(`.qa-input[data-q="${i}"]`)?.focus()
      return
    }
    f.picks = choose(f.picks, s.questions, i, n)
    if (box._qa !== JSON.stringify([t().lang, s.key, f.status, f.error, f.screen, f.chosen])) mount(item(), lastDetail)
    else sync()
    if (instant(s.questions)) return void sendQuestions()
    // A key moves on to the next question, as the terminal does after a single select.
    if (viaKey) {
      const next = !s.questions[i].multiSelect && s.questions[i + 1] ? i + 1 : i
      box.querySelector(`.qa-opt[data-q="${next}"][data-n="${next === i ? n : 1}"]`)?.focus()
    }
  }

  box.addEventListener('click', e => {
    if (e.target.closest('[data-qa-focus]')) return void (shown && focusSession(shown.it.key))
    if (e.target.closest('[data-qa-send]')) return void sendQuestions()
    const perm = e.target.closest('[data-perm]')
    if (perm) return void sendPermission(Number(perm.dataset.perm))
    const opt = e.target.closest('.qa-opt[data-q]')
    if (!opt || opt.disabled) return
    // A click into the own answer's field types; a click beside it picks it.
    if (opt.dataset.n === 'other' && e.target.closest('.qa-input')) {
      const i = Number(opt.dataset.q)
      const f = forms.get(shown?.key)
      if (f && !f.picks[i].otherOn && f.picks[i].other.trim()) pick(i, 'other')
      return
    }
    pick(Number(opt.dataset.q), opt.dataset.n === 'other' ? 'other' : Number(opt.dataset.n))
  })
  const peekAt = e => {
    const opt = e.target.closest?.('button.qa-opt[data-q]')
    const next = opt && shown?.kind === 'question' && shown.questions[Number(opt.dataset.q)]?.preview ? { q: Number(opt.dataset.q), n: Number(opt.dataset.n) } : null
    if (JSON.stringify(next) === JSON.stringify(peek)) return
    peek = next
    sync()
  }
  box.addEventListener('pointerover', peekAt)
  box.addEventListener('focusin', peekAt)
  box.addEventListener('pointerleave', () => peek && ((peek = null), sync()))
  box.addEventListener('input', e => {
    const input = e.target.closest('.qa-input')
    const f = shown && forms.get(shown.key)
    if (!input || !f) return
    if (f.status === 'error') f.status = 'idle'
    f.picks = typeOther(f.picks, shown.questions, Number(input.dataset.q), input.value)
    sync()
  })
  box.addEventListener('keydown', e => {
    const input = e.target.closest('.qa-input')
    if (!input || e.key !== 'Enter' || e.shiftKey || e.isComposing) return
    e.preventDefault()
    const f = shown && forms.get(shown.key)
    if (f && !remaining(shown.questions, f.picks)) sendQuestions()
  })

  /**
   * Digits 1 to 9 while the focus is in the sheet: an option of the question in focus (else the
   * first without an answer), the own answer on the row after them, a permission choice. Returns
   * true when it took the key.
   */
  function onKey(e) {
    if (!shown || e.ctrlKey || e.metaKey || e.altKey || !/^[1-9]$/.test(e.key)) return false
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName) || document.activeElement?.isContentEditable) return false
    if (!canMutate()) return false
    const d = Number(e.key)
    if (shown.kind === 'permission') {
      if (!shown.dialog.options.some(o => o.n === d)) return false
      sendPermission(d)
      return true
    }
    const f = forms.get(shown.key)
    if (!f) return false
    const i = currentQuestion(shown.questions, f.picks, questionOf(document.activeElement))
    const target = digitTarget(shown.questions[i], d)
    if (target === null) return false
    pick(i, target, { viaKey: true })
    return true
  }

  return {
    cardAsk,
    threadHTML,
    wants,
    mount(it, detail) {
      lastDetail = detail
      return mount(it, detail)
    },
    sync,
    onKey,
  }
}
