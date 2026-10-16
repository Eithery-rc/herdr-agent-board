import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { clipLine, createTerminals, MAX_LINE, nextDelay, paneCols, tabLabel } from '../src/terminal.mjs'

class FakeError extends Error {
  constructor(code, message) {
    super(message)
    this.code = code
  }
}

/**
 * A herdr that keeps panes and tabs: `tab create` opens a tab with its shell and, as a plugin
 * would, a sidebar pane beside it; reads give `screens[pane]`.
 */
function fakeHerdr({ dir }) {
  const calls = []
  let n = 0
  const panes = new Map([['w1:p1', { pane_id: 'w1:p1', tab_id: 'w1:t1', workspace_id: 'w1', agent: 'claude', session: 's1' }]])
  const screens = { 'w1:p1': 'agent screen\n' }
  const tabs = new Set(['w1:t1'])
  let failReads = 0
  let failReadsWith = 'herdr did not answer'
  let failSend = false
  let hold = null
  const gone = pane => new FakeError('pane_not_found', `pane ${pane} not found`)
  async function herdr(args) {
    calls.push(args)
    const [a, b, c] = args
    if (hold && a === 'pane' && /^send-/.test(b)) await hold
    if (failSend && a === 'pane' && /^send-/.test(b)) {
      failSend = false
      throw new FakeError('timeout', 'Command failed: herdr pane send-text w1:p11 secret')
    }
    if (a === 'pane' && b === 'get') {
      const p = panes.get(c)
      if (!p) throw gone(c)
      return { pane: p }
    }
    if (a === 'tab' && b === 'create') {
      const tab = `w1:t${++n + 10}`
      const pane = `w1:p${n + 10}`
      tabs.add(tab)
      panes.set(pane, { pane_id: pane, tab_id: tab, workspace_id: args[3], terminal_id: `term-${n}` })
      panes.set(`${pane}s`, { pane_id: `${pane}s`, tab_id: tab, workspace_id: args[3], label: 'Sidebar', terminal_id: `term-${n}s` })
      screens[pane] = 'PS> \n'
      return { root_pane: { pane_id: pane, tab_id: tab, terminal_id: `term-${n}` }, tab: { tab_id: tab } }
    }
    if (a === 'pane' && b === 'list') return { panes: [...panes.values()].filter(p => p.workspace_id === args[3]) }
    if (a === 'pane' && b === 'close') {
      if (!panes.delete(c)) throw gone(c)
      return null
    }
    if (a === 'tab' && b === 'close') {
      tabs.delete(c)
      for (const [id, p] of panes) if (p.tab_id === c) panes.delete(id)
      return null
    }
    if (a === 'agent' && b === 'get') {
      const p = panes.get(c)
      if (!p) throw gone(c)
      return { agent: { agent_session: p.session ? { value: p.session } : null } }
    }
    if (a === 'pane' && (b === 'send-text' || b === 'send-keys')) {
      if (!panes.has(c)) throw gone(c)
      return null
    }
    if (a === 'pane' && b === 'layout') return { layout: { panes: [{ pane_id: args[3], rect: { width: 109, height: 40 } }] } }
    throw new Error(`unexpected ${args.join(' ')}`)
  }
  async function herdrText(args) {
    calls.push(args)
    const pane = args[2]
    if (failReads) {
      failReads--
      throw new FakeError(undefined, failReadsWith)
    }
    if (!panes.has(pane)) throw gone(pane)
    return screens[pane]
  }
  return {
    herdr, herdrText, calls, panes, tabs, screens, dir,
    failNextReads: (n, message = 'herdr did not answer') => ((failReads = n), (failReadsWith = message)),
    failNextSend: () => (failSend = true),
    holdSends: () => {
      let release
      hold = new Promise(r => (release = r))
      return () => ((hold = null), release())
    },
  }
}

function setup(t) {
  const dir = mkdtempSync(join(tmpdir(), 'board-term-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const h = fakeHerdr({ dir })
  const file = join(dir, 'terminals.json')
  const clock = { t: 1_000_000 }
  const changes = []
  const make = () => createTerminals({ herdr: h.herdr, herdrText: h.herdrText, file, sleep: async () => {}, now: () => clock.t, onChange: () => changes.push(clock.t) })
  const item = { key: 's1', session: 's1', pane: 'w1:p1', cwd: dir, name: 'probe', agent: 'claude' }
  return { h, file, make, item, dir, clock, changes }
}

test('a shell opens once per session, in a tab of its own in the session’s workspace and folder', async t => {
  const { h, file, make, item, dir } = setup(t)
  const terms = make()
  const [a, b] = await Promise.all([terms.openShell(item, 'probe · shell'), terms.openShell(item, 'probe · shell')])
  assert.equal(a.ok, true)
  assert.equal(a.pane, b.pane) // a double click opens one
  assert.equal(h.calls.filter(c => c[0] === 'tab' && c[1] === 'create').length, 1)
  assert.deepEqual(h.calls.find(c => c[1] === 'create'), ['tab', 'create', '--workspace', 'w1', '--cwd', dir, '--label', 'probe · shell', '--no-focus'])
  const saved = JSON.parse(readFileSync(file, 'utf8')).s1
  assert.equal(saved.pane, a.pane)
  assert.deepEqual(saved.others, [{ pane: `${a.pane}s`, terminal: 'term-1s' }]) // the sidebar that came with the tab
  assert.equal(saved.terminal, 'term-1')
  assert.deepEqual(terms.keys(), ['s1'])
  // Asked again, it is the same shell; a board that restarts finds it in the file.
  assert.equal((await make().openShell(item, 'x')).created, false)
})

test('a shell is not opened where there is no folder, and its label cannot pass for an option', async t => {
  const { make, item } = setup(t)
  const r = await make().openShell({ ...item, cwd: join(item.cwd, 'missing') }, 'x')
  assert.deepEqual([r.ok, r.error], [false, 'term.err.cwd'])
  assert.equal(tabLabel('--help me'), 'help me')
  assert.equal(tabLabel('a\x1b[31mb‮'), 'a[31mb')
  assert.equal(tabLabel('  '), 'shell')
  assert.equal([...tabLabel('я'.repeat(80))].length, 40)
})

test('closing the shell closes its tab, unless the user put something else in it', async t => {
  const { h, make, item } = setup(t)
  const terms = make()
  const { pane } = await terms.openShell(item, 'x')
  const tab = h.panes.get(pane).tab_id
  await terms.closeShell('s1')
  assert.ok(!h.tabs.has(tab) && !h.panes.has(`${pane}s`))
  assert.deepEqual(terms.keys(), [])
  // A split the user added later keeps the tab; only the shell goes.
  const again = await terms.openShell(item, 'x')
  const tab2 = h.panes.get(again.pane).tab_id
  h.panes.set('w1:p99', { pane_id: 'w1:p99', tab_id: tab2, workspace_id: 'w1' })
  await terms.closeShell('s1')
  assert.ok(h.tabs.has(tab2) && !h.panes.has(again.pane) && h.panes.has('w1:p99'))
})

test('a shell closed in herdr is opened anew, and its old tab tidied away', async t => {
  const { h, make, item } = setup(t)
  const terms = make()
  const first = await terms.openShell(item, 'x')
  h.panes.delete(first.pane) // `exit` in the shell
  const second = await terms.openShell(item, 'x')
  assert.equal(second.created, true)
  assert.notEqual(second.pane, first.pane)
  assert.ok(!h.tabs.has(`w1:t11`))
})

test('input goes only to the board’s own shell, or to the session’s pane while the same session runs there', async t => {
  const { h, make, item } = setup(t)
  const terms = make()
  assert.deepEqual(await terms.inputPane(item, 'shell', 's1'), { error: 'term.err.noShell' })
  const { pane } = await terms.openShell(item, 'x')
  assert.deepEqual(await terms.inputPane(item, 'shell', 's1'), { pane })
  assert.deepEqual(await terms.inputPane(item, 'agent', 's1'), { pane: 'w1:p1' })
  assert.deepEqual(await terms.inputPane(item, 'agent', 'other'), { error: 'err.sessionChanged' })
  assert.deepEqual(await terms.inputPane({ ...item, sleeping: true }, 'agent', 's1'), { error: 'term.err.asleep' })
  assert.deepEqual(await terms.inputPane(item, 'nope', 's1'), { error: 'term.err.target' })
  // /clear: the same pane holds another session now.
  h.panes.get('w1:p1').session = 's2'
  assert.deepEqual(await terms.inputPane(item, 'agent', 's1'), { error: 'err.sessionChanged' })
})

test('input is checked first and typed in order; a refused request types nothing', async t => {
  const { h, make, item } = setup(t)
  const terms = make()
  const { pane } = await terms.openShell(item, 'x')
  const before = h.calls.length
  assert.deepEqual(await terms.input(pane, [{ text: 'echo hi' }, { key: 'rm -rf /' }]), { ok: false, error: 'term.err.input', why: 'key' })
  assert.equal(h.calls.length, before)
  const [r1, r2] = await Promise.all([terms.input(pane, [{ text: '-x' }, { key: 'home' }, { key: 'enter' }]), terms.input(pane, [{ key: 'ctrl+c' }])])
  assert.ok(r1.ok && r2.ok)
  assert.deepEqual(h.calls.slice(before), [
    ['pane', 'send-keys', pane, '-'],
    ['pane', 'send-text', pane, 'x\x1b[H'],
    ['pane', 'send-keys', pane, 'enter'],
    ['pane', 'send-keys', pane, 'ctrl+c'],
  ])
  h.panes.delete(pane)
  assert.deepEqual(await terms.input(pane, [{ key: 'enter' }]), { ok: false, error: 'term.err.gone', why: '' })
})

test('a watched pane sends its screen, then diffs; a closed shell says so and is forgotten', async t => {
  const { h, make, item } = setup(t)
  const terms = make()
  const { pane } = await terms.openShell(item, 'x')
  const got = []
  const stop = terms.watch(pane, { shell: true, key: 's1' }, m => got.push(m))
  t.after(stop)
  const until = async fn => {
    for (let i = 0; i < 200 && !fn(); i++) await new Promise(r => setTimeout(r, 10))
    assert.ok(fn())
  }
  await until(() => got.length === 1)
  assert.deepEqual(got[0], { t: 'frame', drop: 0, keep: 0, lines: ['PS> '], cols: 107 })
  h.screens[pane] = 'PS> ls\n'
  await terms.input(pane, [{ text: 'ls' }])
  await until(() => got.length === 2)
  assert.deepEqual(got[1], { t: 'frame', drop: 1, keep: 0, lines: ['PS> ls'], cols: 107 })
  h.screens[pane] = 'PS> ls\na.txt\nPS> \n'
  await terms.input(pane, [{ key: 'enter' }])
  await until(() => got.length === 3)
  assert.deepEqual(got[2], { t: 'frame', drop: 0, keep: 1, lines: ['a.txt', 'PS> '], cols: 107 })
  // A second page watching the same pane gets the whole screen at once.
  const other = []
  const stopOther = terms.watch(pane, { shell: true, key: 's1' }, m => other.push(m))
  assert.deepEqual(other[0].lines, ['PS> ls', 'a.txt', 'PS> '])
  stopOther()
  // The shell exits: the pages hear it, the board forgets it and tidies its tab away.
  const tab = h.panes.get(pane).tab_id
  h.panes.delete(pane)
  await terms.input(pane, [{ key: 'enter' }]).catch(() => {})
  await until(() => got.at(-1)?.t === 'gone')
  await until(() => !h.tabs.has(tab))
  assert.deepEqual(terms.keys(), [])
})

test('the pace of reading, and a pane’s columns', () => {
  assert.equal(nextDelay({ now: 10_000, pokedAt: 9_500, changedAt: 0 }), 120)
  assert.equal(nextDelay({ now: 10_000, pokedAt: 0, changedAt: 9_000 }), 120)
  assert.equal(nextDelay({ now: 20_000, pokedAt: 0, changedAt: 10_000 }), 400)
  assert.equal(nextDelay({ now: 60_000, pokedAt: 0, changedAt: 10_000 }), 1000)
  assert.equal(paneCols({ panes: [{ pane_id: 'a', rect: { width: 109 } }] }, 'a'), 107)
  assert.equal(paneCols({ panes: [] }, 'a'), null)
  assert.equal(paneCols(null, 'a'), null)
})

test('a shell is typed into only while it is the one the board opened: same pane, same tab, same terminal', async t => {
  const { h, make, item, clock, changes } = setup(t)
  const terms = make()
  const { pane } = await terms.openShell(item, 'x')
  assert.deepEqual(await terms.inputPane(item, 'shell', 's1'), { pane })
  // herdr started over and gave that id to a pane with another terminal: not the board's.
  h.panes.get(pane).terminal_id = 'term-other'
  assert.deepEqual(await terms.inputPane(item, 'shell', 's1'), { pane }) // a burst of keys checks once
  clock.t += 5000
  assert.deepEqual(await terms.inputPane(item, 'shell', 's1'), { error: 'term.err.noShell' })
  assert.deepEqual(terms.keys(), [])
  assert.ok(h.panes.has(pane), 'a pane that is not the board’s is never closed')
  assert.equal(changes.length, 1)
})

test('a shell the user moved to another tab is theirs: opening again leaves it be', async t => {
  const { h, make, item } = setup(t)
  const terms = make()
  const first = await terms.openShell(item, 'x')
  h.panes.get(first.pane).tab_id = 'w1:t1'
  const second = await terms.openShell(item, 'x')
  assert.notEqual(second.pane, first.pane)
  assert.ok(h.panes.has(first.pane))
})

test('a read that fails is said once; the next one that works says so too', async t => {
  const { h, make, item } = setup(t)
  const terms = make()
  const { pane } = await terms.openShell(item, 'x')
  h.failNextReads(2)
  const got = []
  t.after(terms.watch(pane, { shell: true, key: 's1' }, m => got.push(m)))
  for (let i = 0; i < 300 && !got.some(m => m.t === 'frame'); i++) await new Promise(r => setTimeout(r, 10))
  assert.deepEqual(got.map(m => m.t), ['error', 'frame'])
  assert.match(got[0].why, /did not answer/)
})

test('a board that starts again forgets shells that went, and tidies their tabs', async t => {
  const { h, make, item, changes } = setup(t)
  const { pane } = await make().openShell(item, 'x')
  const tab = h.panes.get(pane).tab_id
  h.panes.delete(pane)
  const again = make()
  assert.deepEqual(again.keys(), ['s1'])
  await again.prune()
  assert.deepEqual(again.keys(), [])
  for (let i = 0; i < 100 && h.tabs.has(tab); i++) await new Promise(r => setTimeout(r, 10))
  assert.ok(!h.tabs.has(tab))
  assert.ok(changes.length >= 1)
})

test('closing: a shell moved elsewhere, or a pane of its id with another terminal, is left alone', async t => {
  const { h, make, item } = setup(t)
  const terms = make()
  const moved = await terms.openShell(item, 'x')
  const boardTab = h.panes.get(moved.pane).tab_id
  h.panes.get(moved.pane).tab_id = 'w1:t1' // dragged into the user's own tab
  assert.deepEqual(await terms.closeShell('s1'), { ok: true })
  assert.ok(h.panes.has(moved.pane) && h.tabs.has('w1:t1'))
  // The tab the board made held only its sidebar by then: that one goes.
  assert.ok(!h.tabs.has(boardTab))
  assert.deepEqual(terms.keys(), [])
  const reused = await terms.openShell(item, 'x')
  h.panes.get(reused.pane).terminal_id = 'term-someone-else' // herdr started over
  await terms.closeShell('s1')
  assert.ok(h.panes.has(reused.pane))
  assert.ok(!h.calls.some(c => c[0] === 'pane' && c[1] === 'close'))
})

test('only herdr’s pane_not_found means the shell is gone: other errors close nothing', async t => {
  const { h, make, item } = setup(t)
  const terms = make()
  const { pane } = await terms.openShell(item, 'x')
  h.failNextReads(1, 'open C:/x: No such file or directory (not found)')
  const got = []
  t.after(terms.watch(pane, { shell: true, key: 's1' }, m => got.push(m)))
  for (let i = 0; i < 300 && !got.some(m => m.t === 'frame'); i++) await new Promise(r => setTimeout(r, 10))
  assert.deepEqual(got.map(m => m.t), ['error', 'frame'])
  assert.deepEqual(terms.keys(), ['s1'])
  assert.ok(h.panes.has(pane))
  assert.ok(!h.calls.some(c => c[1] === 'close'))
  // An identity check herdr does not answer leaves the shell be, and says so.
  const get = h.herdr
  const failing = async args => { if (args[1] === 'get') throw new FakeError(undefined, 'pane w1:p11 not found in cache'); return get(args) }
  const terms2 = createTerminals({ herdr: failing, herdrText: h.herdrText, file: join(h.dir, 'terminals.json'), sleep: async () => {} })
  await assert.rejects(terms2.closeShell('s1'))
  assert.ok(h.panes.has(pane))
})

test('a page that comes while reads fail hears it at once', async t => {
  const { h, make, item } = setup(t)
  const terms = make()
  const { pane } = await terms.openShell(item, 'x')
  h.failNextReads(1000)
  const first = []
  t.after(terms.watch(pane, { shell: true, key: 's1' }, m => first.push(m)))
  for (let i = 0; i < 200 && !first.length; i++) await new Promise(r => setTimeout(r, 10))
  const second = []
  t.after(terms.watch(pane, { shell: true, key: 's1' }, m => second.push(m)))
  assert.deepEqual(second.map(m => m.t), ['error'])
  h.failNextReads(0)
})

test('a failed key stops the rest of its request; keys that waited too long are not typed', async t => {
  const { h, make, item, clock } = setup(t)
  const terms = make()
  const { pane } = await terms.openShell(item, 'x')
  let before = h.calls.length
  h.failNextSend()
  const r = await terms.input(pane, [{ text: 'secret' }, { key: 'enter' }])
  assert.deepEqual(r, { ok: false, error: 'term.err.herdr', why: 'timeout' })
  assert.ok(!JSON.stringify(r).includes('secret'))
  assert.deepEqual(h.calls.slice(before).map(c => c[1]), ['send-text'])
  // herdr hangs on one request; the next waits behind it, and once it is free it is too late.
  const release = h.holdSends()
  const first = terms.input(pane, [{ key: 'up' }])
  const second = terms.input(pane, [{ text: 'rm' }, { key: 'enter' }])
  for (let i = 0; i < 100 && !h.calls.some(c => c[3] === 'up'); i++) await new Promise(r => setTimeout(r, 5))
  clock.t += 5000
  release()
  assert.deepEqual(await first, { ok: true })
  assert.deepEqual(await second, { ok: false, error: 'term.err.late', why: 'late' })
  before = h.calls.findLastIndex(c => c[3] === 'up')
  assert.ok(!h.calls.slice(before + 1).some(c => /^send-/.test(c[1])))
})

test('the shells file: an array or entries that are not the board’s are left out', async t => {
  const { file, make } = setup(t)
  const { writeFileSync } = await import('node:fs')
  writeFileSync(file, JSON.stringify([{ pane: 'w1:p1' }]))
  assert.deepEqual(make().keys(), [])
  writeFileSync(file, JSON.stringify({ a: { pane: 'w1:p9', tab: 'w1:t9', workspace: 'w1' }, b: { pane: 5 }, c: null, d: 'x' }))
  assert.deepEqual(make().keys(), ['a'])
})

test('a tab is tidied away only when what is left is what came with it, terminals included', async t => {
  const { h, make, item } = setup(t)
  const terms = make()
  const { pane } = await terms.openShell(item, 'x')
  const tab = h.panes.get(pane).tab_id
  h.panes.get(`${pane}s`).terminal_id = 'term-users-own' // the sidebar id now holds another terminal
  await terms.closeShell('s1')
  assert.ok(!h.panes.has(pane) && h.tabs.has(tab))
})

test('long lines are cut, without half an escape', () => {
  assert.equal(clipLine('abc'), 'abc')
  const cut = clipLine('x'.repeat(3995) + '[38;2;10;20' + 'y'.repeat(10))
  assert.ok(cut.startsWith('x'.repeat(3995)))
  assert.ok(!cut.includes('[38'))
  assert.ok(cut.endsWith('[0m…'))
  assert.equal(clipLine('z'.repeat(MAX_LINE + 50)).length, MAX_LINE + 5)
})
