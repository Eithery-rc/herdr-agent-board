// Files, folders and links in the chat. Paths the agents mention become chips once the server
// finds them on disk; a chip opens a quick look over the board: images, PDF, video and audio,
// Markdown (rendered or source), code and text with line numbers (a :line is shown and lit),
// JSON, CSV as a table, folders as a list to walk through. From there: open with the system,
// show in its folder, copy the path. Web links open in the default browser.
//
// The quick look grows out of the chip it was opened from and shrinks back into it, on a spring
// that can be caught midway; it dims the board, Esc closes it, Backspace walks back.
import { markdown } from './markdown.js'
import { reducedMotion, Spring } from './spring.js'

const $ = (root, sel) => root.querySelector(sel)
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
const svg = body => `<svg viewBox="0 0 20 20" aria-hidden="true">${body}</svg>`
const DOC = '<path d="M5.5 2.5h6l3.5 3.5v11.5h-9.5Z"/><path d="M11.5 2.5V6H15"/>'
export const ICONS = {
  dir: svg('<path d="M2.5 6a1.5 1.5 0 0 1 1.5-1.5h3.6l1.7 1.8H16A1.5 1.5 0 0 1 17.5 7.8v7.7A1.5 1.5 0 0 1 16 17H4a1.5 1.5 0 0 1-1.5-1.5Z"/>'),
  file: svg(DOC),
  text: svg(`${DOC}<path d="M8 10h4.5M8 12.5h4.5M8 15h3"/>`),
  markdown: svg(`${DOC}<path d="M7.6 15v-3.6l1.3 1.6 1.3-1.6V15m2-1.4 1 1.2 1-1.2m-1 1.2v-3.4"/>`),
  json: svg(`${DOC}<path d="m8.6 10.2-1.6 1.6 1.6 1.6m2.8-3.2 1.6 1.6-1.6 1.6"/>`),
  csv: svg('<rect x="3" y="4" width="14" height="12" rx="1.6"/><path d="M3 8h14M3 12h14M8 4v12"/>'),
  image: svg('<rect x="3" y="4" width="14" height="12" rx="2"/><circle cx="7.5" cy="8.5" r="1.3"/><path d="m4 15 4.5-4.5 3 3 2-2 3.5 3.5"/>'),
  pdf: svg(`${DOC}<path d="M7.5 11h5M7.5 13.5h5M7.5 16h3"/>`),
  video: svg('<rect x="2.5" y="5" width="11" height="10" rx="2"/><path d="m13.5 9 4-2.5v7l-4-2.5"/>'),
  audio: svg('<path d="M8 14.5V5l8-1.5V13"/><circle cx="6" cy="14.5" r="2"/><circle cx="14" cy="13" r="2"/>'),
  missing: svg(`${DOC}<path d="m8 10.5 4 4m0-4-4 4"/>`),
  link: svg('<path d="M7 4.5h8.5V13M15 5 5 15"/>'),
  reveal: svg('<path d="M2.5 6a1.5 1.5 0 0 1 1.5-1.5h3.6l1.7 1.8H16A1.5 1.5 0 0 1 17.5 7.8v7.7A1.5 1.5 0 0 1 16 17H4a1.5 1.5 0 0 1-1.5-1.5Z"/><path d="M10 9v5m-2.2-2.2L10 14l2.2-2.2"/>'),
  copy: svg('<rect x="7" y="7" width="9.5" height="9.5" rx="2"/><path d="M13 7V5a1.5 1.5 0 0 0-1.5-1.5h-6A1.5 1.5 0 0 0 4 5v6a1.5 1.5 0 0 0 1.5 1.5H7"/>'),
  back: svg('<path d="m12 4.5-5.5 5.5 5.5 5.5"/>'),
  close: svg('<path d="m5.5 5.5 9 9m0-9-9 9"/>'),
}
const iconOf = kind => ICONS[kind] ?? (kind === 'binary' ? ICONS.file : ICONS.text)

/**
 * The chat's files: `t` is a getter for the page's translator, `token` for the raw-bytes token,
 * `toast(text, error)` shows a message.
 */
export function initFiles({ t, token, toast }) {
  const tr = (key, vars) => t()(key, vars)

  // ------------------------------------------------------------ server
  async function post(url, body) {
    try {
      const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-board': '1' }, body: JSON.stringify(body) })
      const r = await res.json().catch(() => ({}))
      return res.ok ? r : { ...r, error: r.error || tr('err.status', { code: res.status }) }
    } catch (err) {
      return { error: tr('err.offline', { why: err.message }) }
    }
  }
  const rawUrl = path => `/api/fs/raw?path=${encodeURIComponent(path)}&t=${encodeURIComponent(token() ?? '')}`

  async function openUrl(href) {
    const r = await post('/api/open-url', { url: href })
    if (r.error) window.open(href, '_blank', 'noopener')
  }
  async function system(path, how) {
    const r = await post('/api/fs/open', { path, how })
    if (r.error) toast(r.error, true)
  }
  async function copy(path) {
    try {
      await navigator.clipboard.writeText(path)
      toast(tr('ql.copied'))
    } catch (err) {
      toast(err.message, true)
    }
  }

  // ------------------------------------------------------------ chips
  // What the server said about a path, by the session folder it was written in. Paths that were
  // not there are asked again after a while: the agent may create them a moment later.
  const known = new Map()
  const key = (cwd, raw) => `${cwd}\n${raw}`
  function cached(cwd, raw) {
    const hit = known.get(key(cwd, raw))
    if (!hit) return null
    const age = Date.now() - hit.at
    return age > (hit.info.exists ? 300_000 : 15_000) ? null : hit.info
  }

  /** Turn the path candidates under `root` into chips; `cwd` resolves relative ones. */
  async function upgrade(root, cwd = '') {
    const els = [...root.querySelectorAll('[data-path]:not([data-fs])')]
    const ask = []
    for (const el of els) {
      const info = cached(cwd, el.dataset.path)
      if (info) apply(el, info)
      else ask.push(el)
    }
    const paths = [...new Set(ask.map(el => el.dataset.path))]
    if (!paths.length) return
    const r = await post('/api/fs/stat', { cwd, paths })
    for (const info of r.items ?? []) known.set(key(cwd, info.raw), { at: Date.now(), info })
    for (const el of ask) {
      const info = el.isConnected && cached(cwd, el.dataset.path)
      if (info) apply(el, info)
    }
  }

  function apply(el, info) {
    if (!info.exists) {
      el.dataset.fs = 'missing'
      if (el.matches('a.fs')) el.title = tr('ql.missing', { path: info.path || el.dataset.path })
      return
    }
    el.dataset.fs = info.dir ? 'dir' : 'file'
    el.dataset.abs = info.path
    el.dataset.kind = info.kind
    if (info.line) el.dataset.line = info.line
    el.title = info.line ? `${info.path}:${info.line}` : info.path
    el.tabIndex = 0
    el.setAttribute('role', 'button')
    // Thumbnails and tool lines keep their look; everything else becomes a chip.
    if (el.classList.contains('fs-inline')) return
    const label = el.matches('a') ? el.innerHTML : esc(info.name + (info.line ? `:${info.line}` : ''))
    el.classList.add('fs-chip')
    el.innerHTML = `${iconOf(info.kind)}<span class="fs-chip-label">${label}</span>`
  }

  document.addEventListener('click', e => {
    const chip = e.target.closest('[data-fs="file"], [data-fs="dir"]')
    if (chip) {
      e.preventDefault()
      return look({ path: chip.dataset.abs, line: Number(chip.dataset.line) || null }, chip)
    }
    const ext = e.target.closest('a.ext[href]')
    if (ext) {
      e.preventDefault()
      openUrl(ext.href)
    }
  })
  document.addEventListener('keydown', e => {
    if ((e.key === 'Enter' || e.key === ' ') && e.target.matches?.('[data-fs="file"], [data-fs="dir"]')) {
      e.preventDefault()
      look({ path: e.target.dataset.abs, line: Number(e.target.dataset.line) || null }, e.target)
    }
  })

  // ------------------------------------------------------------ the quick look
  const root = document.createElement('div')
  root.className = 'ql'
  root.hidden = true
  root.innerHTML = `
    <div class="ql-scrim"></div>
    <section class="ql-win" role="dialog" aria-modal="true" aria-labelledby="ql-name" tabindex="-1">
      <header class="ql-head">
        <button class="icon-button ql-back" hidden>${ICONS.back}</button>
        <span class="ql-icon"></span>
        <div class="ql-titles"><h3 id="ql-name"></h3><nav class="ql-path"></nav></div>
        <div class="ql-tools">
          <div class="ql-mode" hidden><button data-mode="view"></button><button data-mode="source"></button></div>
          <button class="button primary ql-open"></button>
          <button class="icon-button ql-reveal">${ICONS.reveal}</button>
          <button class="icon-button ql-copy">${ICONS.copy}</button>
          <button class="icon-button ql-close">${ICONS.close}</button>
        </div>
      </header>
      <div class="ql-body"></div>
      <footer class="ql-foot"></footer>
    </section>`
  document.body.append(root)
  const win = $(root, '.ql-win')
  const scrim = $(root, '.ql-scrim')
  const body = $(root, '.ql-body')

  const ql = { stack: [], origin: null, seq: 0, mode: 'view', data: null }
  // p: 0 = folded into the chip it came from, 1 = open. Interruptible: a close while opening
  // turns around from wherever the window is.
  const motion = new Spring({ value: 0, damping: 1, response: 0.34, precision: 0.002, onUpdate: v => paint(v), onRest: v => v === 0 && finishClose() })
  let from = { dx: 0, dy: 0, s: 0.2 }

  /** Where the window starts from: the chip's centre and width, or a small drop when it is gone. */
  function measureFrom(el) {
    const saved = win.style.transform
    win.style.transform = 'none'
    const w = win.getBoundingClientRect()
    win.style.transform = saved
    const r = el?.isConnected ? el.getBoundingClientRect() : null
    if (!r || !r.width || r.bottom < 0 || r.top > innerHeight) return { dx: 0, dy: 24, s: 0.94 }
    return { dx: r.left + r.width / 2 - (w.left + w.width / 2), dy: r.top + r.height / 2 - (w.top + w.height / 2), s: Math.max(0.06, Math.min(0.5, r.width / w.width)) }
  }
  function paint(p) {
    const q = Math.max(0, p)
    if (reducedMotion.matches) {
      win.style.transform = ''
      win.style.opacity = String(Math.min(1, q))
    } else {
      const s = from.s + (1 - from.s) * q
      win.style.transform = `translate(${from.dx * (1 - q)}px, ${from.dy * (1 - q)}px) scale(${s})`
      win.style.opacity = String(Math.min(1, q * 1.8))
    }
    scrim.style.opacity = String(Math.min(1, q))
  }

  function labels() {
    $(root, '.ql-back').title = tr('ql.back')
    $(root, '.ql-back').setAttribute('aria-label', tr('ql.back'))
    $(root, '.ql-open').textContent = tr('ql.open')
    for (const [sel, k] of [['.ql-reveal', 'ql.reveal'], ['.ql-copy', 'ql.copy'], ['.ql-close', 'sheet.close']]) {
      $(root, sel).title = tr(k)
      $(root, sel).setAttribute('aria-label', tr(k))
    }
    $(root, '[data-mode="view"]').textContent = tr('ql.view')
    $(root, '[data-mode="source"]').textContent = tr('ql.source')
  }

  /** Open the quick look on { path, line }, grown from element `el`. */
  function look(target, el) {
    if (!target?.path) return
    if (!root.hidden && motion.target === 1) {
      ql.stack.push(target)
      return show()
    }
    ql.stack = [target]
    ql.origin = el ?? null
    root.hidden = false
    labels()
    show()
    from = measureFrom(el)
    if (motion.value <= 0.001) paint(0)
    motion.to(1, { damping: 1, response: 0.34 })
    win.focus({ preventScroll: true })
  }

  function close() {
    if (root.hidden || motion.target === 0) return
    from = measureFrom(ql.origin)
    motion.to(0, { damping: 1, response: 0.26 })
    if (reducedMotion.matches) motion.set(0)
  }
  function finishClose() {
    root.hidden = true
    body.innerHTML = ''
    ql.data = null
    if (ql.origin?.isConnected) ql.origin.focus({ preventScroll: true })
  }
  const back = () => {
    if (ql.stack.length < 2) return close()
    ql.stack.pop()
    show()
  }

  async function show() {
    const target = ql.stack.at(-1)
    const seq = ++ql.seq
    $(root, '.ql-back').hidden = ql.stack.length < 2
    head({ path: target.path, name: target.path.split(/[\\/]/).filter(Boolean).pop() ?? target.path, kind: 'file' })
    body.className = 'ql-body loading'
    body.innerHTML = `<div class="ql-wait">${esc(tr('loading'))}</div>`
    $(root, '.ql-foot').textContent = ''
    const d = await post('/api/fs/preview', { path: target.path })
    if (seq !== ql.seq) return
    ql.data = { ...d, line: target.line }
    if (!['markdown'].includes(d.kind)) ql.mode = 'view'
    head(d)
    render()
  }

  function head(d) {
    $(root, '.ql-icon').innerHTML = iconOf(d.error === 'missing' ? 'missing' : d.dir ? 'dir' : d.kind)
    $(root, '#ql-name').textContent = d.name ?? ''
    // The folders above it, each one a step to walk to.
    const parts = String(d.path ?? '').split(/[\\/]/)
    const sep = d.path?.includes('\\') ? '\\' : '/'
    const crumbs = parts.slice(0, -1).map((name, i) => ({ name: name || sep, path: parts.slice(0, i + 1).join(sep) + (i === 0 ? sep : '') }))
    const nav = $(root, '.ql-path')
    nav.innerHTML = crumbs.map(c => `<button data-go="${esc(c.path)}">${esc(c.name)}</button>`).join('<span>›</span>')
    nav.scrollLeft = nav.scrollWidth
    const exists = !d.error || d.error === 'denied'
    for (const sel of ['.ql-open', '.ql-reveal']) $(root, sel).disabled = !exists
  }

  function render() {
    const d = ql.data
    const foot = []
    body.className = `ql-body k-${d.dir ? 'dir' : d.kind}`
    $(root, '.ql-mode').hidden = d.kind !== 'markdown'
    for (const b of root.querySelectorAll('.ql-mode button')) b.setAttribute('aria-pressed', String(b.dataset.mode === ql.mode))
    if (d.error === 'missing') {
      body.innerHTML = empty('missing', tr('ql.missing', { path: d.path }))
    } else if (d.error) {
      body.innerHTML = empty('file', d.error === 'denied' ? tr('ql.denied') : d.error)
    } else if (d.dir) {
      body.innerHTML = folder(d)
      foot.push(tr('ql.items', { n: d.total }))
      if (d.total > d.entries.length) foot.push(tr('ql.firstItems', { n: d.entries.length }))
    } else {
      foot.push(size(d.size))
      if (d.kind === 'image') body.innerHTML = `<div class="ql-media checker"><img src="${rawUrl(d.path)}" alt=""></div>`
      else if (d.kind === 'pdf') body.innerHTML = `<iframe class="ql-frame" src="${rawUrl(d.path)}" title="${esc(d.name)}"></iframe>`
      else if (d.kind === 'video') body.innerHTML = `<div class="ql-media"><video controls preload="metadata" src="${rawUrl(d.path)}"></video></div>`
      else if (d.kind === 'audio') body.innerHTML = `<div class="ql-media audio">${ICONS.audio}<audio controls preload="metadata" src="${rawUrl(d.path)}"></audio></div>`
      else if (typeof d.text === 'string') {
        if (d.kind === 'markdown' && ql.mode === 'view') {
          body.innerHTML = `<article class="md ql-md">${markdown(d.text, { soft: true })}</article>`
          upgrade(body, d.path.replace(/[\\/][^\\/]*$/, ''))
        } else if (d.kind === 'csv' && d.rows?.length) body.innerHTML = table(d.rows)
        else body.innerHTML = code(d.text, d.line)
        foot.push(d.kind === 'csv' && d.rows?.length ? tr('ql.rows', { n: d.rows.length - 1 }) : tr('ql.lines', { n: d.lines }))
        if (d.truncated) foot.push(tr('ql.truncated'))
      } else body.innerHTML = empty(d.kind === 'binary' ? 'file' : d.kind, tr('ql.noPreview'), true)
      if (d.mtime) foot.push(tr('ql.modified', { date: date(d.mtime) }))
    }
    if (d.dir && d.mtime) foot.push(tr('ql.modified', { date: date(d.mtime) }))
    $(root, '.ql-foot').textContent = foot.filter(Boolean).join(' · ')
    const img = $(body, 'img')
    img?.addEventListener('load', () => ($(root, '.ql-foot').textContent = [`${img.naturalWidth} × ${img.naturalHeight}`, ...foot].join(' · ')), { once: true })
    const hit = $(body, '.ql-ln.hit')
    if (hit) requestAnimationFrame(() => (body.scrollTop = hit.offsetTop - body.clientHeight / 3))
    else body.scrollTop = 0
  }

  const date = ms => new Date(ms).toLocaleString(t().lang, { dateStyle: 'medium', timeStyle: 'short' })
  function size(n) {
    if (n == null) return ''
    return n < 1024 ? tr('size.b', { n }) : n < 1 << 20 ? tr('size.kb', { n: Math.round(n / 1024) }) : tr('size.mb', { n: (n / (1 << 20)).toFixed(1) })
  }
  function empty(kind, text, open = false) {
    return `<div class="ql-empty">${iconOf(kind)}<p>${esc(text)}</p>${open ? `<button class="button primary" data-ql="open">${esc(tr('ql.open'))}</button>` : ''}</div>`
  }
  function code(text, line) {
    const lines = text.split('\n')
    if (lines.length > 1 && lines.at(-1) === '') lines.pop()
    return `<div class="ql-code">${lines.map((l, i) => `<div class="ql-ln${i + 1 === line ? ' hit' : ''}" data-n="${i + 1}">${esc(l) || '​'}</div>`).join('')}</div>`
  }
  function table(rows) {
    const [first, ...rest] = rows
    const cell = (tag, c) => `<${tag}>${esc(c)}</${tag}>`
    return `<div class="ql-table"><table><thead><tr>${first.map(c => cell('th', c)).join('')}</tr></thead><tbody>${rest.map(r => `<tr>${r.map(c => cell('td', c)).join('')}</tr>`).join('')}</tbody></table></div>`
  }
  function folder(d) {
    if (!d.entries.length) return empty('dir', tr('ql.emptyFolder'))
    const sep = d.path.includes('\\') ? '\\' : '/'
    return `<div class="ql-list" role="list">${d.entries
      .map(
        e => `<button class="ql-row${e.dir ? ' dir' : ''}" role="listitem" data-go="${esc(d.path.replace(/[\\/]$/, '') + sep + e.name)}">
          ${iconOf(e.dir ? 'dir' : e.kind)}<span class="n">${esc(e.name)}</span><span class="m">${e.mtime ? esc(date(e.mtime)) : ''}</span><span class="s">${e.dir ? '' : esc(size(e.size))}</span>
        </button>`,
      )
      .join('')}</div>`
  }

  root.addEventListener('click', e => {
    if (e.target === scrim) return close()
    const go = e.target.closest('[data-go]')
    if (go) {
      ql.stack.push({ path: go.dataset.go, line: null })
      return show()
    }
    const mode = e.target.closest('[data-mode]')
    if (mode && ql.data) {
      ql.mode = mode.dataset.mode
      return render()
    }
    const d = ql.data ?? { path: ql.stack.at(-1)?.path }
    if (e.target.closest('.ql-close')) return close()
    if (e.target.closest('.ql-back')) return back()
    if (e.target.closest('.ql-open, [data-ql="open"]')) return system(d.path, 'open')
    if (e.target.closest('.ql-reveal')) return system(d.path, 'reveal')
    if (e.target.closest('.ql-copy')) return copy(d.line ? `${d.path}:${d.line}` : d.path)
  })
  // Before the page's own keys: Esc here must not close the session sheet as well.
  addEventListener(
    'keydown',
    e => {
      if (root.hidden || motion.target === 0) return
      const typing = /^(INPUT|TEXTAREA)$/.test(document.activeElement?.tagName)
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopImmediatePropagation()
        close()
      } else if ((e.key === 'Backspace' && !typing) || (e.key === 'ArrowLeft' && e.altKey)) {
        e.preventDefault()
        e.stopImmediatePropagation()
        back()
      }
    },
    true,
  )

  return { upgrade, look, close, isOpen: () => !root.hidden && motion.target === 1, relabel: () => !root.hidden && (labels(), ql.data && render()) }
}
