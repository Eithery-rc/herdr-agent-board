// Renaming in place: a field laid exactly over the name, in its own font, the text selected,
// as Finder does. Enter or a click elsewhere keeps it, Esc puts it back; an empty name gives
// the automatic one back. Under it, for a Claude session, the choice to rename it in Claude
// and herdr too: that types /rename into the session, so it is never done without asking.
import { NAME_MAX } from './launch-model.js'
import { reducedMotion, Spring } from './spring.js'

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])

let current = null

/**
 * Edit the name shown in `target`. opts: value (the name now), auto (what an empty name gives),
 * claude: null when it is no Claude session, else { why: '' or why it cannot be renamed there
 * now }, t, onCommit(name, { claude }) -> promise, onClose().
 */
export function renameInPlace(target, { value, auto, claude = null, t, onCommit, onClose = () => {} }) {
  current?.cancel()
  const r = target.getBoundingClientRect()
  const cs = getComputedStyle(target)
  const box = document.createElement('div')
  box.className = 'rename'
  box.innerHTML = `
    <input class="rename-field" maxlength="${NAME_MAX}" spellcheck="false" autocomplete="off" aria-label="${esc(t('rename.label'))}">
    <div class="rename-more">
      <span class="rename-auto">${esc(t('rename.auto', { name: auto }))}</span>
      ${claude ? `<label class="rename-claude${claude.why ? ' off' : ''}"><input type="checkbox"${claude.why ? ' disabled' : ''}><span>${esc(t('rename.alsoClaude'))}<small>${esc(claude.why || t('rename.alsoClaudeHint'))}</small></span></label>` : ''}
    </div>`
  const field = box.querySelector('.rename-field')
  const check = box.querySelector('.rename-claude input')
  // The field sits on the name: same place, same type, so nothing jumps.
  Object.assign(field.style, { font: cs.font, letterSpacing: cs.letterSpacing, color: cs.color })
  const width = Math.max(r.width + 24, 200)
  // The options under the field are wider than a short name: keep both on screen.
  box.style.left = `${Math.max(8, Math.min(r.left - 5, innerWidth - Math.max(width + 10, 290) - 8))}px`
  box.style.top = `${r.top - 3}px`
  box.style.width = `${width + 10}px`
  field.style.height = `${r.height + 6}px`
  field.value = value
  document.body.append(box)
  const more = box.querySelector('.rename-more')
  const s = new Spring({ value: 0, damping: 1, response: 0.22, precision: 0.003, onUpdate: v => {
    more.style.opacity = String(v)
    more.style.transform = reducedMotion.matches ? '' : `translateY(${(1 - v) * -4}px)`
  } })
  s.to(1)
  target.classList.add('renaming')
  field.focus()
  field.select()

  let done = false
  let held = false // a press on the checkbox's label is under way
  let saving = false // a field that goes disabled loses the focus: that is no second commit
  const finish = () => {
    if (done) return
    done = true
    current = null
    target.classList.remove('renaming')
    box.remove()
    onClose()
  }
  const commit = async () => {
    if (done || saving) return
    const name = field.value.trim()
    const claudeToo = !!check?.checked
    if (name === value && !claudeToo) return finish()
    saving = true
    field.disabled = true
    const r = await onCommit(name, { claude: claudeToo })
    saving = false
    if (r?.ok === false) {
      field.disabled = false
      field.focus()
      return
    }
    finish()
  }
  field.addEventListener('keydown', e => {
    e.stopPropagation()
    if (e.isComposing || e.keyCode === 229) return // an input method's own Enter and Esc
    if (e.key === 'Enter') {
      e.preventDefault()
      commit()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      finish()
    }
  })
  // Leaving the field keeps the name, unless the focus only went to the checkbox under it.
  box.addEventListener('focusout', e => {
    if (!box.contains(e.relatedTarget)) setTimeout(() => !held && !box.contains(document.activeElement) && commit(), 0)
  })
  check?.addEventListener('keydown', e => {
    e.stopPropagation()
    if (e.key === 'Enter') commit()
    if (e.key === 'Escape') finish()
  })
  box.addEventListener('pointerdown', e => e.stopPropagation())
  // A press on the options must not count as leaving the field. A press on the checkbox's label
  // is let through (preventing it stops the label from ticking the box) and holds the commit
  // until its click has landed; any other press keeps the focus in the field.
  box.addEventListener('mousedown', e => {
    if (e.target === field) return
    if (!e.target.closest('label')) return e.preventDefault()
    held = true
    addEventListener('pointerup', () => setTimeout(() => (held = false), 0), { once: true })
  })
  box.addEventListener('click', e => {
    if (e.target.closest('label')) setTimeout(() => !done && field.focus(), 0)
  })
  current = { cancel: finish }
  return current
}

export const renaming = () => !!current
