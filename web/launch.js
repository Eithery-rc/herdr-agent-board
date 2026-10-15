// New sessions from the board: the window that starts one, its folder picker, and the cards of
// sessions on their way. The window grows out of what opened it and, once the session is
// started, folds into the new card in its lane; Esc or Cancel folds it back where it came from.
//
// The folder picker: a path field with completion (folders only; the server lists them and
// says whether a path exists), suggestions from the context (the card's folder, the lane's
// folders, folders of sessions on the board and of recent Claude sessions), and a column view
// to browse, Finder style. The browser offers no picker that gives an absolute path, so this is ours.
import { baseName, categoryForDir, checkBranch, checkName, completions, defaultWorkspace, folderSuggestions, NAME_MAX, slugName, splitPathInput, suggestName, worktreePath } from './launch-model.js'
import { reducedMotion, Spring } from './spring.js'
import { launchContext, launchDraftBook } from './launch-drafts.js'

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
const svg = body => `<svg viewBox="0 0 20 20" aria-hidden="true">${body}</svg>`
const ICON = {
  folder: svg('<path d="M2.5 6a1.5 1.5 0 0 1 1.5-1.5h3.6l1.7 1.8H16A1.5 1.5 0 0 1 17.5 7.8v7.7A1.5 1.5 0 0 1 16 17H4a1.5 1.5 0 0 1-1.5-1.5Z"/>'),
  drive: svg('<rect x="3" y="6" width="14" height="8" rx="2"/><path d="M13.5 10h.01"/>'),
  home: svg('<path d="M3.5 9.5 10 4l6.5 5.5M5.5 8v8h9V8"/>'),
  ok: svg('<path d="m5 10.5 3.2 3.2L15 7"/>'),
  bad: svg('<circle cx="10" cy="10" r="7"/><path d="M10 6.5v4.2M10 13.4h.01"/>'),
  spin: svg('<path class="spin-path" d="M10 3a7 7 0 1 1-7 7"/>'),
  chev: svg('<path d="m8 5 5 5-5 5"/>'),
  close: svg('<path d="m5.5 5.5 9 9m0-9-9 9"/>'),
  warn: svg('<path d="M10 3.5 17.5 16h-15Z"/><path d="M10 8.5v3.2M10 13.8h.01"/>'),
  plus: svg('<path d="M10 4.5v11M4.5 10h11"/>'),
}

/**
 * deps: t() the translator, toast, canMutate(), data() the board payload, onDialogChange() for
 * the mobile Back stack, onStarted(launch) once a session is on its way (the page shows its
 * lane and draws the card), focusLaunch(id) to go to a launch's pane in herdr.
 */
export function initLaunch({ t, toast, canMutate, data, onDialogChange = () => {}, onStarted = () => {}, focusLaunch = () => {} }) {
  const tr = (k, v) => t()(k, v)
  const store = {
    get: k => { try { return localStorage.getItem(k) } catch { return null } },
    set: (k, v) => { try { localStorage.setItem(k, v) } catch {} },
  }
  async function post(url, body) {
    try {
      const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-board': '1' }, body: JSON.stringify(body) })
      const r = await res.json().catch(() => ({}))
      return res.ok && r.ok !== false ? { ok: true, ...r } : { ok: false, ...r, error: r.error || tr('err.status', { code: res.status }) }
    } catch (err) {
      return { ok: false, error: tr('err.offline', { why: err.message }) }
    }
  }

  // ------------------------------------------------------------ the window
  const root = document.createElement('div')
  root.className = 'launch'
  root.hidden = true
  root.innerHTML = `
    <div class="launch-scrim"></div>
    <section class="launch-win" role="dialog" aria-modal="true" aria-labelledby="launch-title" tabindex="-1">
      <header class="launch-head">
        <div class="launch-titles"><h3 id="launch-title"></h3><p class="launch-sub"></p></div>
        <button type="button" class="icon-button launch-close">${ICON.close}</button>
      </header>
      <form class="launch-body" novalidate autocomplete="off">
        <div class="group">
          <label class="row"><span class="row-label" data-t="launch.name"></span><input class="row-value" name="name" maxlength="${NAME_MAX}" spellcheck="false"></label>
          <p class="field-note" data-for="name" hidden></p>
          <div class="row folder-row">
            <span class="row-label" data-t="launch.folder"></span>
            <div class="row-value folder-field">
              <input name="cwd" spellcheck="false" role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="launch-pop">
              <span class="folder-state" aria-hidden="true"></span>
              <button type="button" class="folder-browse" aria-expanded="false"></button>
            </div>
            <div class="folder-pop" id="launch-pop" role="listbox" hidden></div>
          </div>
          <p class="field-note" data-for="cwd" hidden></p>
          <div class="folder-cols" hidden></div>
          <div class="row"><span class="row-label" data-t="row.category"></span><div class="row-value chips launch-cats"></div></div>
          <div class="row where-row">
            <span class="row-label" data-t="launch.where"></span>
            <div class="row-value where">
              <select name="workspace"></select>
              <input name="newWorkspace" maxlength="40" spellcheck="false" hidden>
            </div>
          </div>
          <p class="field-note" data-for="workspace" hidden></p>
          <div class="row wt-row" hidden>
            <span class="row-label" data-t="launch.worktree"></span>
            <div class="row-value wt">
              <label class="wt-toggle"><input type="checkbox" name="wt"><span data-t="launch.worktreeNew"></span></label>
              <input name="branch" maxlength="100" spellcheck="false" hidden>
            </div>
          </div>
          <p class="field-note wt-note" data-for="worktree" hidden></p>
        </div>
        <div class="group message-group">
          <textarea name="message" rows="3" spellcheck="true"></textarea>
        </div>
        <p class="launch-error" role="alert" hidden></p>
      </form>
      <footer class="launch-foot">
        <span class="launch-keys"></span>
        <button type="button" class="button launch-cancel"></button>
        <button type="button" class="button primary launch-go"></button>
      </footer>
    </section>`
  document.body.append(root)
  const $ = sel => root.querySelector(sel)
  const win = $('.launch-win')
  const scrim = $('.launch-scrim')
  const form = $('form')
  const f = {
    name: form.elements.name,
    cwd: form.elements.cwd,
    workspace: form.elements.workspace,
    newWorkspace: form.elements.newWorkspace,
    wt: form.elements.wt,
    branch: form.elements.branch,
    message: form.elements.message,
  }

  // What is being made: the values, and which of them the user set (those stop following the folder).
  let s = null
  let options = { launcher: { kind: 'herdr', agent: 'claude' }, workspaces: [], recent: [], board: '' }
  const local = new Map() // launch id -> launch, until the server's board has it
  const drafts = launchDraftBook()

  function labels() {
    for (const el of root.querySelectorAll('[data-t]')) el.textContent = tr(el.dataset.t)
    $('#launch-title').textContent = tr(s?.retry ? 'launch.retryTitle' : 'launch.title')
    $('.launch-close').title = tr('sheet.close')
    $('.launch-close').setAttribute('aria-label', tr('sheet.closeLabel'))
    $('.folder-browse').textContent = tr('launch.browse')
    f.name.placeholder = tr('launch.namePlaceholder')
    f.cwd.placeholder = tr('launch.folderPlaceholder')
    f.newWorkspace.placeholder = tr('launch.workspaceName')
    f.branch.placeholder = tr('launch.branch')
    f.message.placeholder = tr('launch.message')
    $('.launch-cancel').textContent = tr('cancel')
    $('.launch-go').textContent = tr('launch.start')
    $('.launch-keys').textContent = tr('launch.keys')
    const l = options.launcher
    $('.launch-sub').textContent = l.kind === 'command' ? tr('launch.viaCommand', { name: l.name }) : tr('launch.viaHerdr', { agent: l.agent === 'claude' ? 'Claude' : l.agent })
  }

  // ------------------------------------------------------------ motion: out of the origin and back
  const motion = new Spring({ value: 0, damping: 1, response: 0.34, precision: 0.002, onUpdate: v => paint(v), onRest: v => v === 0 && finishClose() })
  let from = { dx: 0, dy: 24, s: 0.94 }
  let origin = null

  function measure(rect) {
    const saved = win.style.transform
    win.style.transform = 'none'
    const w = win.getBoundingClientRect()
    win.style.transform = saved
    if (!rect || !rect.width || rect.bottom < 0 || rect.top > innerHeight) return { dx: 0, dy: 24, s: 0.94 }
    return { dx: rect.left + rect.width / 2 - (w.left + w.width / 2), dy: rect.top + rect.height / 2 - (w.top + w.height / 2), s: Math.max(0.08, Math.min(0.6, rect.width / w.width)) }
  }
  function paint(p) {
    const q = Math.max(0, p)
    if (reducedMotion.matches) {
      win.style.transform = ''
      win.style.opacity = String(Math.min(1, q))
    } else {
      const k = from.s + (1 - from.s) * q
      win.style.transform = `translate(${from.dx * (1 - q)}px, ${from.dy * (1 - q)}px) scale(${k})`
      win.style.opacity = String(Math.min(1, q * 1.8))
    }
    scrim.style.opacity = String(Math.min(1, q))
  }
  const rectOf = o => (o instanceof Element ? (o.isConnected ? o.getBoundingClientRect() : null) : o ?? null)

  /**
   * Open the window. ctx: { category, cwd, workspace (label), item (a card it is for), newWorkspace,
   * retry (a failed launch to start again) }. `from` is the element or rect it grows out of.
   */
  async function open(ctx = {}, fromEl = null) {
    if (!canMutate()) return toast(tr('mobile.readOnly'), true)
    origin = fromEl
    s = { ctx, draftKey: launchContext(ctx, d().filter), set: {}, check: null, git: null, cache: new Map(), retry: ctx.retry ?? null }
    root.hidden = false
    labels()
    fill(ctx)
    from = measure(rectOf(fromEl))
    if (motion.value <= 0.001) paint(0)
    motion.to(1, { damping: 1, response: 0.34 })
    setTimeout(() => {
      const first = ctx.newWorkspace ? f.newWorkspace : f.name
      first.focus({ preventScroll: true })
      first.select?.()
    }, 30)
    onDialogChange()
    // Workspaces and recent folders come from the server; the window is usable before they do.
    const opts = await fetch('/api/launch/options').then(r => r.json()).catch(() => null)
    if (!opts || !s || s.ctx !== ctx) return
    options = opts
    labels()
    renderWorkspaces()
    if (!s.set.cwd && !f.cwd.value) applyFolder(suggestions()[0]?.path ?? '', false)
  }

  /** Keep the whole form for this opening context, never just a prompt for another project. */
  function close(to = null, started = false) {
    if (root.hidden || motion.target === 0) return
    if (!started) drafts.write(s.draftKey, draftForm())
    closePop()
    from = measure(rectOf(to) ?? rectOf(origin))
    motion.to(0, { damping: 1, response: 0.28 })
    if (reducedMotion.matches) motion.set(0)
    onDialogChange()
  }
  function finishClose() {
    root.hidden = true
    s = null
    if (origin instanceof Element && origin.isConnected) origin.focus?.({ preventScroll: true })
    origin = null
  }

  // ------------------------------------------------------------ values
  const d = () => data()
  const catTitle = id => d().categories.find(c => c.id === id)?.title ?? id

  function draftForm() {
    return { name: f.name.value, cwd: f.cwd.value, category: s.category, message: f.message.value,
      workspace: f.workspace.value ? f.workspace.selectedOptions[0]?.textContent ?? '' : f.newWorkspace.value,
      newWorkspace: !f.workspace.value, worktree: f.wt.checked ? { branch: f.branch.value } : null }
  }

  function fill(ctx) {
    const r = ctx.retry ?? drafts.read(s.draftKey)
    const items = d().items ?? []
    const card = ctx.item
    s.category = r?.category ?? card?.category ?? ctx.category ?? (d().filter && d().filter !== 'all' ? d().filter : null)
    s.set.category = !!s.category
    if (!s.category) s.category = 'other'
    const cwd = r?.cwd ?? card?.cwd ?? ctx.cwd ?? ''
    f.cwd.value = cwd
    showEnd()
    s.set.cwd = !!cwd
    f.name.value = r?.name ?? (cwd ? suggestName(cwd, items) : '')
    s.set.name = !!r
    f.message.value = r?.message ?? ''
    f.wt.checked = !!r?.worktree
    f.branch.value = r?.worktree?.branch ?? ''
    s.set.branch = !!r?.worktree
    s.workspace = r ? (r.newWorkspace ? { create: r.workspace } : { label: r.workspace }) : ctx.newWorkspace ? { create: '' } : card?.workspace ? { label: card.workspace } : null
    s.set.workspace = !!s.workspace
    for (const el of root.querySelectorAll('.field-note, .launch-error')) el.hidden = true
    renderCats()
    renderWorkspaces()
    renderWorktree()
    if (cwd) checkFolder()
    else setState('')
  }

  function renderCats() {
    const box = $('.launch-cats')
    box.innerHTML = d()
      .categories.map(c => `<button type="button" data-cat="${esc(c.id)}" style="--lane:${esc(c.color)}" aria-pressed="${c.id === s.category}">${esc(c.title)}</button>`)
      .join('')
  }

  /** Workspaces herdr has, the board's own left out; the last choice is a new one. */
  function renderWorkspaces() {
    if (!s) return
    const list = options.workspaces.filter(w => w.label !== options.board)
    let want = s.workspace
    if (!s.set.workspace) {
      const id = defaultWorkspace({ category: s.category, title: catTitle(s.category), items: d().items ?? [], workspaces: list, board: options.board, fallback: store.get('board.launch.workspace') ?? options.focused })
      want = id ? { id } : { create: '' }
    }
    const selected = want?.id ?? (want?.label ? list.find(w => w.label === want.label)?.id : null)
    const create = !selected
    f.workspace.innerHTML =
      list.map(w => `<option value="${esc(w.id)}"${w.id === selected ? ' selected' : ''}>${esc(w.label)}</option>`).join('') +
      `<option value=""${create ? ' selected' : ''}>${esc(tr('launch.newWorkspace'))}</option>`
    f.newWorkspace.hidden = !create
    if (create && !f.newWorkspace.value) f.newWorkspace.value = want?.create || want?.label || defaultWorkspaceName()
  }
  const defaultWorkspaceName = () => (s.category && s.category !== 'other' ? catTitle(s.category) : baseName(f.cwd.value) || tr('launch.workspaceDefault'))

  // ------------------------------------------------------------ folder: state, completion, browsing
  let checkTimer = 0
  async function dirs(path, git = false) {
    const key = `${path}\n${git}`
    if (s?.cache.has(key)) return s.cache.get(key)
    const res = await fetch('/api/fs/dirs', { method: 'POST', headers: { 'content-type': 'application/json', 'x-board': '1' }, body: JSON.stringify({ path, git }) })
      .then(r => r.json())
      .catch(() => null)
    if (res && s) s.cache.set(key, res)
    return res
  }

  function setState(kind, note = '') {
    const el = $('.folder-state')
    el.dataset.state = kind
    el.innerHTML = kind === 'ok' ? ICON.ok : kind === 'bad' ? ICON.bad : kind === 'wait' ? ICON.spin : ''
    noteFor('cwd', note)
    syncGo()
  }
  function noteFor(field, text, error = true) {
    const el = root.querySelector(`.field-note[data-for="${field}"]`)
    if (!el) return
    el.hidden = !text
    el.textContent = text
    el.classList.toggle('error', !!text && error)
  }

  /** What the server says about the folder field, a moment after the typing stops. */
  function checkFolder() {
    clearTimeout(checkTimer)
    // What was checked before is about another folder now.
    s.check = null
    s.git = null
    const path = f.cwd.value.trim()
    if (!path) return setState('')
    setState('wait')
    checkTimer = setTimeout(() => runCheck(path), 160)
  }

  async function runCheck(path) {
    clearTimeout(checkTimer)
    const r = await dirs(path, true)
    if (!s || f.cwd.value.trim() !== path) return
    s.check = { ...r, input: path }
    if (r?.slow) setState('bad', tr('launch.err.cwdSlow', { path }))
    else if (!r || !r.exists) setState('bad', tr('launch.err.cwdMissing', { path }))
    else if (!r.dir) setState('bad', tr('launch.err.cwdFile', { path }))
    else setState('ok')
    s.git = r?.git ?? null
    renderWorktree()
    // The folder decides the category until the user picks one.
    if (r?.exists && r.dir && !s.set.category) {
      const cat = categoryForDir(d().categories, r.path)
      if (cat && cat !== s.category) {
        s.category = cat
        renderCats()
        renderWorkspaces()
      }
    }
  }

  // A long path shows its end, where the folder's own name is, unless it is being edited.
  const showEnd = () => requestAnimationFrame(() => document.activeElement !== f.cwd && (f.cwd.scrollLeft = f.cwd.scrollWidth))
  f.cwd.addEventListener('blur', showEnd)

  function applyFolder(path, byUser = true) {
    f.cwd.value = path
    showEnd()
    if (byUser) s.set.cwd = true
    if (!s.set.name) f.name.value = path ? suggestName(path, d().items ?? []) : ''
    if (!s.set.branch) f.branch.value = ''
    checkFolder()
    syncGo()
  }

  const suggestions = () => folderSuggestions({ context: { cwd: s.ctx.item?.cwd ?? s.ctx.cwd, category: s.category }, categories: d().categories, items: d().items ?? [], recent: options.recent ?? [] })

  // The list under the field: suggestions while it is untouched, folders that match once typing.
  let pop = { items: [], active: -1, open: false }
  let popSeq = 0
  async function showPop(typed) {
    const seq = ++popSeq
    let items
    if (!typed) {
      items = suggestions().map(x => ({ path: x.path, label: baseName(x.path), detail: x.path, why: tr(`launch.why.${x.why}`) }))
    } else {
      const { dir, prefix } = splitPathInput(f.cwd.value)
      if (!dir) {
        // Nothing but "C:" or "~" yet: the drives and home.
        const r = await dirs('')
        if (seq !== popSeq || !s) return
        const p = prefix.toLowerCase()
        items = (r?.roots ?? []).filter(x => x.name.toLowerCase().startsWith(p) || x.path.toLowerCase().startsWith(p)).map(x => ({ path: x.path, label: x.name === '~' ? tr('launch.home') : x.name, detail: x.path }))
      } else {
        const r = await dirs(dir)
        if (seq !== popSeq || !s) return
        const base = r?.path ? r.path.replace(/[\\/]?$/, r.sep ?? '\\') : dir
        items = r?.dir ? completions(r.entries ?? [], prefix).map(n => ({ path: base + n, label: n, detail: base + n, complete: true })) : []
      }
    }
    if (seq !== popSeq || !s) return
    pop = { items, active: -1, open: items.length > 0 }
    const el = $('.folder-pop')
    el.hidden = !pop.open
    f.cwd.setAttribute('aria-expanded', String(pop.open))
    el.innerHTML = items
      .map((x, i) => `<div class="pop-item" role="option" id="launch-opt-${i}" data-i="${i}" title="${esc(x.detail)}">${ICON.folder}<span class="pop-name">${esc(x.label)}</span><span class="pop-detail">${esc(x.why ?? x.detail)}</span></div>`)
      .join('')
  }
  function closePop() {
    pop = { items: [], active: -1, open: false }
    $('.folder-pop').hidden = true
    f.cwd.setAttribute('aria-expanded', 'false')
    f.cwd.removeAttribute('aria-activedescendant')
  }
  function lightPop(i) {
    pop.active = i
    for (const el of root.querySelectorAll('.pop-item')) el.classList.toggle('active', Number(el.dataset.i) === i)
    const el = root.querySelector(`#launch-opt-${i}`)
    if (el) {
      f.cwd.setAttribute('aria-activedescendant', el.id)
      el.scrollIntoView({ block: 'nearest' })
    }
  }
  function takePop(i) {
    const x = pop.items[i]
    if (!x) return
    if (x.complete) {
      // A completed folder name goes on with its separator, so its own folders come next.
      const sep = splitPathInput(f.cwd.value).sep
      applyFolder(x.path + sep)
      showPop(true)
    } else {
      applyFolder(x.path)
      closePop()
    }
    f.cwd.focus()
  }

  f.cwd.addEventListener('input', () => {
    applyFolder(f.cwd.value)
    showPop(true)
  })
  f.cwd.addEventListener('focus', () => showPop(false))
  f.cwd.addEventListener('blur', () => setTimeout(() => document.activeElement !== f.cwd && closePop(), 120))
  f.cwd.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !(pop.open && pop.active >= 0)) {
      e.preventDefault()
      closePop()
      return submit()
    }
    if (!pop.open) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        showPop(false)
      }
      return
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      const n = pop.items.length
      lightPop(pop.active < 0 ? (e.key === 'ArrowDown' ? 0 : n - 1) : (pop.active + (e.key === 'ArrowDown' ? 1 : -1) + n) % n)
    } else if ((e.key === 'Enter' || e.key === 'Tab') && pop.active >= 0) {
      e.preventDefault()
      e.stopPropagation()
      takePop(pop.active)
    } else if (e.key === 'Tab' && pop.items.length === 1) {
      e.preventDefault()
      takePop(0)
    }
  })
  $('.folder-pop').addEventListener('pointerdown', e => e.preventDefault())
  $('.folder-pop').addEventListener('click', e => {
    const el = e.target.closest('.pop-item')
    if (el) takePop(Number(el.dataset.i))
  })

  // Columns, Finder style: the drives (and home), then each folder down to the chosen one, then
  // its subfolders. A click picks a folder and opens it in the next column; arrows walk.
  const cols = $('.folder-cols')
  let browse = { open: false, chain: [], focus: null }

  function chainOf(path, sep) {
    const parts = String(path).split(/[\\/]+/).filter(Boolean)
    const out = []
    let acc = /^[\\/]/.test(path) ? sep : ''
    parts.forEach((p, i) => {
      acc = i === 0 ? (/^[A-Za-z]:$/.test(p) ? `${p}${sep}` : `${acc}${p}`) : `${acc.replace(/[\\/]$/, '')}${sep}${p}`
      out.push(acc)
    })
    return out
  }

  async function openBrowse() {
    browse.open = true
    cols.hidden = false
    $('.folder-browse').setAttribute('aria-expanded', 'true')
    closePop()
    const r = f.cwd.value.trim() ? await dirs(f.cwd.value.trim()) : null
    const at = r?.exists && r.dir ? r.path : ''
    await showChain(at ? ['', ...chainOf(at, r.sep ?? '\\')] : [''])
  }
  function closeBrowse() {
    browse.open = false
    cols.hidden = true
    $('.folder-browse').setAttribute('aria-expanded', 'false')
  }

  async function showChain(chain) {
    browse.chain = chain
    const lists = await Promise.all(chain.map(p => dirs(p)))
    if (!s || browse.chain !== chain) return
    cols.innerHTML = lists
      .map((r, i) => {
        const next = chain[i + 1]
        const rows = r?.roots
          ? r.roots.map(x => ({ path: x.path, name: x.name === '~' ? tr('launch.home') : x.name, icon: x.name === '~' ? ICON.home : ICON.drive }))
          : (r?.entries ?? []).filter(n => !n.startsWith('.')).map(n => ({ path: r.path.replace(/[\\/]?$/, r.sep ?? '\\') + n, name: n, icon: ICON.folder }))
        const body = rows.length
          ? rows.map(x => `<button type="button" class="col-row${next && sameish(next, x.path) ? ' on' : ''}" data-path="${esc(x.path)}" data-col="${i}" title="${esc(x.path)}">${x.icon}<span>${esc(x.name)}</span>${r?.roots ? '' : ICON.chev}</button>`).join('')
          : `<p class="col-empty">${esc(tr(r?.error === 'denied' ? 'ql.denied' : 'launch.noFolders'))}</p>`
        return `<div class="col-list" role="listbox" aria-label="${esc(r?.path || tr('launch.computer'))}">${body}</div>`
      })
      .join('')
    cols.scrollLeft = cols.scrollWidth
  }
  const sameish = (a, b) => a.replace(/[\\/]+$/, '').toLowerCase() === b.replace(/[\\/]+$/, '').toLowerCase()

  cols.addEventListener('click', e => {
    const row = e.target.closest('.col-row')
    if (!row) return
    const i = Number(row.dataset.col)
    applyFolder(row.dataset.path)
    showChain([...browse.chain.slice(0, i + 1), row.dataset.path]).then(() => cols.querySelector(`.col-row[data-path="${CSS.escape(row.dataset.path)}"]`)?.focus({ preventScroll: true }))
  })
  cols.addEventListener('dblclick', e => {
    if (e.target.closest('.col-row')) closeBrowse()
  })
  cols.addEventListener('keydown', e => {
    const row = e.target.closest('.col-row')
    if (!row) return
    const list = [...row.parentElement.querySelectorAll('.col-row')]
    const i = list.indexOf(row)
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      list[Math.max(0, Math.min(list.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))]?.click()
    } else if (e.key === 'ArrowRight') {
      e.preventDefault()
      row.parentElement.nextElementSibling?.querySelector('.col-row')?.click()
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault()
      row.parentElement.previousElementSibling?.querySelector('.col-row.on')?.click()
    } else if (e.key === 'Enter') {
      e.preventDefault()
      closeBrowse()
      f.cwd.focus()
    }
  })
  $('.folder-browse').addEventListener('click', () => (browse.open ? closeBrowse() : openBrowse()))

  // ------------------------------------------------------------ the rest of the form
  $('.launch-cats').addEventListener('click', e => {
    const b = e.target.closest('button[data-cat]')
    if (!b) return
    s.category = b.dataset.cat
    s.set.category = true
    renderCats()
    if (!s.set.workspace) renderWorkspaces()
  })
  f.name.addEventListener('input', () => {
    s.set.name = true
    noteFor('name', '')
    if (!s.set.branch) renderWorktree()
    syncGo()
  })
  f.workspace.addEventListener('change', () => {
    s.set.workspace = true
    const create = !f.workspace.value
    s.workspace = create ? { create: f.newWorkspace.value } : { id: f.workspace.value }
    f.newWorkspace.hidden = !create
    if (create) {
      if (!f.newWorkspace.value) f.newWorkspace.value = defaultWorkspaceName()
      f.newWorkspace.focus()
      f.newWorkspace.select()
    }
    noteFor('workspace', '')
  })
  f.newWorkspace.addEventListener('input', () => {
    s.set.workspace = true
    s.workspace = { create: f.newWorkspace.value }
  })
  f.wt.addEventListener('change', () => {
    renderWorktree()
    if (f.wt.checked) f.branch.focus()
  })
  f.branch.addEventListener('input', () => {
    s.set.branch = true
    renderWorktree()
  })

  /** The worktree choice shows for folders in a git checkout: a new branch in a sibling folder. */
  function renderWorktree() {
    if (!s) return
    const git = s.git
    $('.wt-row').hidden = !git
    if (!git) {
      noteFor('worktree', '')
      return syncGo()
    }
    f.branch.hidden = !f.wt.checked
    if (!s.set.branch) f.branch.value = slugName(f.name.value || baseName(f.cwd.value))
    const why = f.wt.checked ? checkBranch(f.branch.value) : ''
    noteFor('worktree', f.wt.checked ? (why ? tr(why) : tr('launch.worktreeAt', { path: worktreePath(git.root, f.branch.value.trim()), branch: git.branch })) : '', !!why)
    syncGo()
  }

  function problems() {
    const out = {}
    const bad = checkName(f.name.value)
    if (bad) out.name = tr(bad, { max: NAME_MAX })
    if (!f.cwd.value.trim()) out.cwd = tr('launch.err.cwdEmpty')
    else if (s.check && (!s.check.exists || !s.check.dir) && s.check.path) out.cwd = tr(s.check.slow ? 'launch.err.cwdSlow' : s.check.exists ? 'launch.err.cwdFile' : 'launch.err.cwdMissing', { path: s.check.path })
    if (!f.workspace.value && !f.newWorkspace.value.trim()) out.workspace = tr('launch.err.workspaceName')
    if (s.git && f.wt.checked && checkBranch(f.branch.value)) out.worktree = tr(checkBranch(f.branch.value))
    return out
  }
  function syncGo() {
    if (!s) return
    const go = $('.launch-go')
    go.disabled = !canMutate() || Object.keys(problems()).length > 0 || $('.folder-state').dataset.state === 'wait' || !!s.sending
    go.title = !canMutate() ? tr('mobile.readOnly') : Object.values(problems())[0] ?? ''
  }

  async function submit() {
    if (!s || s.sending) return
    // Enter can come before the folder was checked: check it now, then go on with that answer.
    const cwd = f.cwd.value.trim()
    if (cwd && s.check?.input !== cwd) {
      await runCheck(cwd)
      if (!s || f.cwd.value.trim() !== cwd) return
    }
    const bad = problems()
    if (Object.keys(bad).length) {
      for (const [k, v] of Object.entries(bad)) noteFor(k, v)
      root.querySelector(`[name="${Object.keys(bad)[0] === 'worktree' ? 'branch' : Object.keys(bad)[0]}"]`)?.focus()
      return
    }
    if (!canMutate()) return toast(tr('mobile.readOnly'), true)
    const ws = f.workspace.value ? { id: f.workspace.value, label: f.workspace.selectedOptions[0]?.textContent ?? '' } : { create: f.newWorkspace.value.trim() }
    const body = {
      name: f.name.value.trim(),
      cwd: (s.check?.exists && s.check.input === cwd && s.check.path) || cwd,
      category: s.category,
      workspace: ws,
      message: f.message.value.trim(),
      ...(s.git && f.wt.checked ? { worktree: { branch: f.branch.value.trim() } } : {}),
    }
    const st = s
    const draftVersion = drafts.write(st.draftKey, draftForm())
    st.sending = true
    syncGo()
    const r = await post('/api/launch', body)
    st.sending = false
    // Closed (or opened anew) while the request was out: the start still counts, the old form does not.
    const here = s === st
    if (!r.ok) {
      if (!here) return toast(r.error, true)
      syncGo()
      if (r.field) {
        noteFor(r.field, r.error)
        root.querySelector(`[name="${r.field === 'worktree' ? 'branch' : r.field}"]`)?.focus()
      } else {
        $('.launch-error').hidden = false
        $('.launch-error').textContent = r.error
      }
      return
    }
    if (ws.id) store.set('board.launch.workspace', ws.id)
    if (st.retry) post(`/api/launch/${encodeURIComponent(st.retry.id)}/dismiss`, {})
    drafts.clear(st.draftKey, draftVersion)
    const launch = { id: r.id, name: body.name, cwd: body.cwd, category: body.category, workspace: ws.label ?? ws.create, newWorkspace: !ws.id, message: body.message, worktree: body.worktree ?? null, state: 'starting', step: 'prepare', startedAt: Date.now(), pane: null, key: null }
    local.set(r.id, launch)
    onStarted(launch)
    // The window folds into the new card, where the session will be.
    if (here) requestAnimationFrame(() => close(document.querySelector(`.card[data-key="launch:${CSS.escape(r.id)}"]`), true))
  }

  $('.launch-go').addEventListener('click', submit)
  $('.launch-cancel').addEventListener('click', () => close())
  $('.launch-close').addEventListener('click', () => close())
  // A click beside the window closes it only while nothing was written in it yet.
  scrim.addEventListener('click', () => (f.message.value.trim() ? win.focus({ preventScroll: true }) : close()))
  form.addEventListener('submit', e => {
    e.preventDefault()
    submit()
  })

  // Keys before the page's own: Esc closes the innermost thing first, Ctrl+Enter starts, Tab
  // stays in the window.
  addEventListener(
    'keydown',
    e => {
      if (root.hidden || motion.target === 0) return
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopImmediatePropagation()
        if (pop.open) closePop()
        else if (browse.open) {
          closeBrowse()
          f.cwd.focus()
        } else close()
      } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault()
        e.stopImmediatePropagation()
        submit()
      } else if (e.key === 'Enter' && e.target.matches?.('input[name="name"], input[name="newWorkspace"], input[name="branch"]')) {
        e.preventDefault()
        submit()
      } else if (e.key === 'Tab' && !(e.target === f.cwd && pop.open)) {
        const all = [...win.querySelectorAll('button, input, select, textarea')].filter(el => !el.disabled && !el.hidden && el.offsetParent)
        const i = all.indexOf(document.activeElement)
        if (e.shiftKey && i <= 0) {
          e.preventDefault()
          all.at(-1)?.focus()
        } else if (!e.shiftKey && i === all.length - 1) {
          e.preventDefault()
          all[0]?.focus()
        }
      }
    },
    true,
  )

  // ------------------------------------------------------------ sessions on their way
  /** Launches of the board to draw as cards of their own: not yet a session on the board. */
  function pending() {
    const server = d().launches ?? []
    for (const id of local.keys()) if (server.some(l => l.id === id) || Date.now() - local.get(id).startedAt > 15_000) local.delete(id)
    const keys = new Set((d().items ?? []).map(i => i.key))
    // A launcher can finish before herdr shows the session: its card waits a little for it.
    return [...server, ...local.values()].filter(l => !(l.key && keys.has(l.key)) && (l.state !== 'done' || Date.now() - (l.doneAt ?? 0) < 30_000))
  }

  /** Board items for them, in their lane: "Working" while they start, "Needs me" once they failed or wait for a dialog. */
  function placeholders() {
    return pending().map(l => ({
      key: `launch:${l.id}`,
      launchOnly: true,
      launch: l,
      name: l.name,
      category: l.category,
      column: l.state === 'failed' || l.state === 'waiting' ? 'me' : 'work',
      cwd: l.cwd,
      workspace: l.workspace,
      activity: l.startedAt,
      status: 'starting',
    }))
  }

  const stepText = l => (l.state === 'waiting' ? tr('launch.step.dialog') : l.state === 'done' ? tr('launch.step.done') : tr(`launch.step.${l.step}`, { name: options.launcher.name ?? '' }))

  /** The lines a launch adds to a card: how it goes, or why it failed and what to do. */
  function note(l) {
    if (!l) return ''
    const go = l.pane ? `<button class="button" data-launch="focus" data-id="${esc(l.id)}">${esc(tr('card.focus'))}</button>` : ''
    if (l.state === 'failed') {
      return `<div class="launch-note failed"><div class="ln-why">${ICON.warn}<span>${esc(l.error || tr('launch.failed'))}</span></div><div class="ln-hint">${esc(tr(`launch.hint.${l.kind === 'dialog' ? 'dialogFailed' : l.kind || 'other'}`))}</div><div class="ln-actions"><button class="button" data-launch="retry" data-id="${esc(l.id)}">${esc(tr('launch.retry'))}</button>${go}<button class="button plain" data-launch="dismiss" data-id="${esc(l.id)}">${esc(tr('launch.dismiss'))}</button></div></div>`
    }
    if (l.state === 'waiting') {
      return `<div class="launch-note waiting"><div class="ln-why">${ICON.warn}<span>${esc(tr('launch.step.dialog'))}</span></div><div class="ln-hint">${esc(tr('launch.hint.dialog'))}</div><div class="ln-actions">${go}</div></div>`
    }
    return `<div class="launch-note"><span class="ln-spin">${ICON.spin}</span><span>${esc(stepText(l))}</span></div>`
  }

  /** The card of a session on its way that is not on the board yet. */
  function cardHTML(it) {
    const l = it.launch
    const icon = l.state === 'failed' || l.state === 'waiting' ? `<span class="dot" style="--c:var(--orange)"></span>` : `<span class="dot work launching" style="--c:var(--green)"></span>`
    const where = [baseName(l.cwd), l.workspace && tr('meta.workspace', { name: l.workspace })].filter(Boolean).join(' · ')
    return `<div class="card-top">${icon}<span class="name">${esc(l.name)}</span><span class="age">${esc(tr('launch.new'))}</span></div><div class="said" title="${esc(l.cwd)}">${esc(where)}</div>${note(l)}`
  }

  /** What the buttons in those lines do. Returns true when the click was one of them. */
  function onCardAction(e) {
    const b = e.target.closest('[data-launch]')
    if (!b) return false
    const id = b.dataset.id
    const l = (d().launches ?? []).find(x => x.id === id) ?? local.get(id)
    if (b.dataset.launch === 'dismiss') dismiss(id)
    else if (b.dataset.launch === 'retry' && l) open({ retry: l }, b)
    else if (b.dataset.launch === 'focus') focusLaunch(id)
    return true
  }

  async function dismiss(id) {
    local.delete(id)
    const r = await post(`/api/launch/${encodeURIComponent(id)}/dismiss`, {})
    if (!r.ok && r.error) toast(r.error, true)
  }

  return {
    open,
    close: () => close(),
    isOpen: () => !root.hidden && motion.target === 1,
    relabel: () => !root.hidden && labels(),
    placeholders,
    cardHTML,
    note,
    onCardAction,
    dismiss,
    retry: (l, el) => open({ retry: l }, el),
    syncAvailability: () => syncGo(),
  }
}
