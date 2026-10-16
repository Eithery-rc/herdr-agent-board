// A stand-in for Claude Code's question dialog in a terminal, for answer.mjs: it draws the screen
// as Claude Code 2.1 does (the files in screens/ were read from it) and takes keys the way that
// dialog was seen to take them, traps included: a digit on an own-answer row that holds text
// submits that text. `lag` keeps the old screen for that many reads after each key, as a slow
// redraw would.
const RULE = '─'.repeat(60)

export class FakeDialog {
  constructor(questions, { lag = 0, ignore = false } = {}) {
    this.questions = questions
    this.lag = lag
    this.ignore = ignore // a terminal that takes no keys at all
    this.tab = 0
    this.state = questions.map(() => ({ cursor: 1, checked: new Set(), other: '', answer: null }))
    this.submitted = null
    this.keysLog = []
    this.texts = []
    this.stale = 0
    this.shown = this.render()
  }

  get total() { return this.questions.length }
  get tabbed() { return this.total > 1 || this.questions[0].multiSelect }
  get q() { return this.questions[this.tab] }
  get s() { return this.state[this.tab] }
  rows(q = this.q) { return q.options.length + (q.preview ? 0 : 1) + (q.multiSelect ? 1 : 0) }
  editing() { return this.tab < this.total && !this.q.preview && this.s.cursor === this.q.options.length + 1 }

  io() {
    return {
      read: async () => {
        if (this.stale > 0) {
          this.stale--
          return this.shown
        }
        this.shown = this.render()
        return this.shown
      },
      keys: async (...keys) => {
        for (const k of keys) {
          this.keysLog.push(k)
          if (!this.ignore && !this.submitted) this.key(k)
        }
        this.stale = this.lag
      },
      text: async text => {
        this.texts.push(text)
        if (!this.ignore && !this.submitted && this.editing()) {
          this.insert(text)
          if (this.q.multiSelect) this.s.checked.add(this.q.options.length + 1)
        }
        this.stale = this.lag
      },
    }
  }

  advance() {
    const s = this.s
    const q = this.q
    if (!q.multiSelect) s.answer = s.cursor <= q.options.length ? q.options[s.cursor - 1].label : s.other
    else s.answer = [...s.checked].sort((a, b) => a - b).map(n => (n <= q.options.length ? q.options[n - 1].label : s.other)).join(', ')
    if (!this.tabbed) return this.submit()
    this.tab++
  }

  /** Text at the caret of the own answer's field (its end unless moved). */
  insert(text) {
    const s = this.s
    const at = s.caret ?? s.other.length
    s.other = s.other.slice(0, at) + text + s.other.slice(at)
    if (s.caret !== null && s.caret !== undefined) s.caret = at + text.length
  }

  submit() {
    this.submitted = this.state.map(s => s.answer)
  }

  key(k) {
    if (this.tab === this.total) {
      // The review: 1 submits, 2 cancels, left goes back.
      if (k === '1') return this.submit()
      if (k === 'left') this.tab--
      return
    }
    const q = this.q
    const s = this.s
    const n = q.options.length
    if (/^[1-9]$/.test(k)) {
      if (this.editing()) return void this.insert(k)
      const d = Number(k)
      if (q.multiSelect) {
        if (d <= n + 1) s.checked.has(d) ? s.checked.delete(d) : s.checked.add(d)
        return
      }
      if (q.preview) {
        if (d <= n) s.cursor = d
        return
      }
      if (d <= n) {
        s.cursor = d
        return this.advance()
      }
      if (d === n + 1) {
        s.cursor = d
        if (s.other) this.advance()
      }
      return
    }
    switch (k) {
      case 'up':
        s.cursor = Math.max(1, s.cursor - 1)
        return
      case 'down':
        s.cursor = Math.min(this.rows(), s.cursor + 1)
        return
      case 'left':
        if (this.editing() || !this.tabbed) return
        this.tab = Math.max(0, this.tab - 1)
        return
      case 'right':
        if (this.editing()) return void (s.caret = Math.min(s.other.length, (s.caret ?? s.other.length) + 1))
      // falls through
      case 'tab':
        if (this.editing() || !this.tabbed) return
        this.tab = Math.min(this.total, this.tab + 1)
        return
      case 'ctrl+a':
        if (this.editing()) s.caret = 0
        return
      case 'backspace': {
        if (!this.editing()) return
        const at = s.caret ?? s.other.length
        if (!at) return
        s.other = s.other.slice(0, at - 1) + s.other.slice(at)
        if (s.caret !== null && s.caret !== undefined) s.caret = at - 1
        return
      }
      case 'ctrl+u':
        if (!this.editing()) return
        s.caret = null
        s.other = ''
        if (q.multiSelect) s.checked.delete(n + 1)
        return
      case 'enter':
        if (q.multiSelect) return void (s.cursor === n + 2 && this.advance())
        if (s.cursor === n + 1 && !s.other) return
        return this.advance()
    }
  }

  render() {
    const top = ['❯ an earlier prompt that mentions 1. Red and Review your answers', '', '● Sure.', '']
    if (this.submitted) return [...top, '● User answered Claude\'s questions:', RULE, '❯ ', RULE, '  ⏵⏵ bypass permissions on'].join('\n')
    const bar = this.tabbed
      ? `←  ${this.questions.map((q, i) => `${this.state[i].answer !== null ? '☒' : '☐'} ${q.header}`).join('  ')}  ✔ Submit  →`
      : ` ☐ ${this.questions[0].header}`
    const out = [...top, RULE, bar, '']
    if (this.tab === this.total) {
      out.push('Review your answers', '')
      for (const [i, q] of this.questions.entries()) out.push(` ● ${q.question}`, `   → ${this.state[i].answer ?? ''}`)
      out.push('', 'Ready to submit your answers?', '', '❯ 1. Submit answers', '  2. Cancel')
      return out.join('\n')
    }
    const q = this.q
    const s = this.s
    out.push(q.question, '')
    const n = q.options.length
    const mark = i => (q.multiSelect ? `[${s.checked.has(i) ? '✔' : ' '}] ` : '')
    const pad = q.multiSelect ? '         ' : '     '
    for (const [j, o] of q.options.entries()) {
      const row = `${s.cursor === j + 1 ? '❯' : ' '} ${j + 1}. ${mark(j + 1)}${o.label}`
      out.push(q.preview ? `${row.padEnd(34)}│ preview │` : row)
      if (o.description && !q.preview) out.push(pad + o.description)
    }
    if (!q.preview) out.push(`${s.cursor === n + 1 ? '❯' : ' '} ${n + 1}. ${mark(n + 1)}${s.other || (q.multiSelect ? 'Type something' : 'Type something.')}`)
    if (q.multiSelect) out.push(`${s.cursor === n + 2 ? '❯' : ' '}    ${this.tabbed && this.total > 1 ? 'Next' : 'Submit'}`)
    out.push(RULE, `  ${q.preview ? '' : `${n + 2}. `}Chat about this`, '')
    out.push(`Enter to select · ↑/↓ to navigate${this.editing() ? ' · ctrl+g to edit in Notepad' : ''} · Esc to cancel`)
    return out.join('\n')
  }
}
