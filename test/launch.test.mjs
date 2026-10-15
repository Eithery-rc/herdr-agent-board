import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { useLanguage } from '../src/lang.mjs'
import { checkRequest, commandArgs, failureKind, launcherError, launcherLabel, parseLauncherOutput, usesPlaceholder } from '../src/launch.mjs'
import { baseName, categoryForDir, checkBranch, checkName, completions, defaultWorkspace, folderSuggestions, isAbsolutePath, sameDir, slugName, splitPathInput, suggestName, uniqueSlug, worktreePath } from '../web/launch-model.js'
import { sandbox, until } from './fixtures/sandbox.mjs'

useLanguage('en')

test('session names: what a name may be, and herdr’s name for it', () => {
  assert.equal(checkName('Acme invoices'), '')
  assert.equal(checkName('Ромашка 2'), '')
  assert.equal(checkName('  '), 'launch.err.nameEmpty')
  assert.equal(checkName('x'.repeat(61)), 'launch.err.nameLong')
  assert.equal(checkName('two\nlines'), 'launch.err.nameChars')
  assert.equal(checkName('-Workspace w1'), 'launch.err.nameStart') // would read as an option
  assert.equal(checkName('/clear'), 'launch.err.nameStart') // would read as a Claude command
  assert.equal(slugName('Acme-Invoices'), 'acme-invoices')
  assert.equal(slugName('Ромашка: счета'), 'romashka-scheta')
  assert.equal(slugName('2026 plan'), 's-2026-plan')
  assert.equal(slugName('!!!'), 'session')
  assert.match(slugName('a'.repeat(50)), /^[a-z][a-z0-9_-]{0,31}$/)
  assert.equal(uniqueSlug('job', new Set()), 'job')
  assert.equal(uniqueSlug('job', new Set(['job', 'job-2'])), 'job-3')
  assert.equal(uniqueSlug('a'.repeat(32), new Set(['a'.repeat(32)])).length, 32)
})

test('folders: absolute paths, completion, the lane a folder falls in', () => {
  assert.ok(isAbsolutePath('C:\\Work'))
  assert.ok(isAbsolutePath('/home/me'))
  assert.ok(isAbsolutePath('~/x'))
  assert.ok(isAbsolutePath('\\\\server\\share'))
  assert.ok(!isAbsolutePath('Work\\x'))
  assert.ok(sameDir('C:\\Work\\X\\', 'c:/work/x'))
  assert.equal(baseName('C:\\Work\\Acme\\'), 'Acme')
  assert.deepEqual(splitPathInput('C:\\Work\\Pe'), { dir: 'C:\\Work\\', prefix: 'Pe', sep: '\\' })
  assert.deepEqual(splitPathInput('/home/me/'), { dir: '/home/me/', prefix: '', sep: '/' })
  assert.deepEqual(splitPathInput('C:'), { dir: '', prefix: 'C:', sep: '\\' })
  // Names that start with it first, then names that contain it; dot folders only when asked for.
  assert.deepEqual(completions(['Personal', '.git', 'Apps', 'People', 'Shared-pe'], 'pe'), ['Personal', 'People', 'Shared-pe'])
  assert.deepEqual(completions(['.git', '.github', 'src'], '.g'), ['.git', '.github'])
  assert.deepEqual(completions(['b', 'a'], ''), ['b', 'a'])
  const cats = [{ id: 'acme', paths: ['C:\\Clients'] }, { id: 'globex', paths: ['C:\\Clients\\Globex'] }]
  assert.equal(categoryForDir(cats, 'c:/clients/globex/app'), 'globex')
  assert.equal(categoryForDir(cats, 'C:\\Clients\\Initech'), 'acme')
  assert.equal(categoryForDir(cats, 'C:\\ClientsX'), null)
})

test('the window’s defaults: folders by context, a free name, the lane’s workspace', () => {
  const categories = [{ id: 'acme', title: 'Acme', paths: ['C:\\Acme'] }, { id: 'other', title: 'Other', paths: [] }]
  const items = [
    { name: 'acme-api', cwd: 'C:\\Acme\\api', category: 'acme', workspace: 'Acme', activity: 2 },
    { name: 'acme-web', cwd: 'C:\\Acme\\web', category: 'acme', workspace: 'Acme', activity: 3 },
    { name: 'misc', cwd: 'D:\\misc', category: 'other', workspace: 'Work', activity: 9 },
    { name: 'probe', cwd: 'C:\\Users\\me\\AppData\\Local\\Temp\\scratch\\probe', category: 'other', workspace: 'Work', activity: 10 },
  ]
  const s = folderSuggestions({ context: { cwd: 'C:\\Acme\\api', category: 'acme' }, categories, items, recent: ['E:\\recent', 'c:/acme/web'] })
  assert.deepEqual(s.map(x => x.path), ['C:\\Acme\\api', 'C:\\Acme', 'C:\\Acme\\web', 'E:\\recent', 'D:\\misc'])
  assert.deepEqual(s.map(x => x.why), ['card', 'lane', 'session', 'recent', 'session'])
  assert.equal(suggestName('C:\\Acme\\api', items), 'api')
  assert.equal(suggestName('C:\\x\\acme-api', items), 'acme-api 2')
  const workspaces = [{ id: 'w1', label: 'Board' }, { id: 'w2', label: 'Acme' }, { id: 'w3', label: 'Work' }, { id: 'w4', label: 'Globex tools' }]
  assert.equal(defaultWorkspace({ category: 'acme', title: 'Acme', items, workspaces, board: 'Board' }), 'w2')
  assert.equal(defaultWorkspace({ category: 'globex', title: 'Globex', items, workspaces, board: 'Board' }), 'w4')
  assert.equal(defaultWorkspace({ category: 'new', title: 'New', items, workspaces, board: 'Board', fallback: 'w3' }), 'w3')
  // The board's own workspace is never the default, and no fit means a new one.
  assert.equal(defaultWorkspace({ category: 'new', title: 'New', items, workspaces, board: 'Board', fallback: 'w1' }), '')
})

test('worktrees: branch names git takes, and the sibling folder they go to', () => {
  assert.equal(checkBranch('feature/menu'), '')
  assert.equal(checkBranch(''), 'launch.err.branchEmpty')
  for (const bad of ['-x', 'a..b', 'a b', 'x.lock', 'a/', '.hidden', 'a@{1}']) assert.equal(checkBranch(bad), 'launch.err.branch', bad)
  assert.equal(worktreePath('C:\\Work\\agent-board', 'new-session'), 'C:\\Work\\agent-board-new-session')
  assert.equal(worktreePath('/src/app/', 'feature/menu'), '/src/app-feature-menu')
})

test('launch.command: one argument per element, optional groups, no values in the program', () => {
  const vars = { name: 'Acme "quoted" & co', cwd: 'C:\\Work\\My Folder', workspace: 'w2', message: '', messageFile: '', label: 'Acme', category: 'acme', workspaceLabel: '', sessionId: '' }
  const tpl = ['pwsh', '-File', 'C:\\bin\\spawn-agent.ps1', '-Name', '{name}', '-Cwd', '{cwd}', '-Workspace', '{workspace}', ['-BriefFile', '{messageFile}'], '--tag={category}']
  assert.deepEqual(commandArgs(tpl, vars), { file: 'pwsh', args: ['-File', 'C:\\bin\\spawn-agent.ps1', '-Name', 'Acme "quoted" & co', '-Cwd', 'C:\\Work\\My Folder', '-Workspace', 'w2', '--tag=acme'] })
  assert.deepEqual(commandArgs(tpl, { ...vars, messageFile: 'C:\\t\\m.txt' }).args.slice(8, 10), ['-BriefFile', 'C:\\t\\m.txt'])
  assert.throws(() => commandArgs(['run', '{shell}'], vars), /unknown placeholder \{shell\}/)
  assert.throws(() => commandArgs(['{cwd}\\evil.exe'], vars), /program itself/)
  assert.throws(() => commandArgs('pwsh -File x.ps1', vars), /must be a list/)
  assert.throws(() => commandArgs(['pwsh', 3], vars), /must be a list/)
  assert.ok(usesPlaceholder(tpl, 'messageFile'))
  assert.ok(!usesPlaceholder(tpl, 'sessionId'))
  assert.equal(launcherLabel(tpl), 'spawn-agent')
  assert.equal(launcherLabel(['/usr/local/bin/launch-claude', '{name}']), 'launch-claude')
})

test('what a launcher said: its pane when it worked, the reason when it did not', () => {
  assert.deepEqual(parseLauncherOutput('waiting…\npane=w2:p14 name=Acme agent=acme\n'), { pane: 'w2:p14', agent: 'acme' })
  assert.deepEqual(parseLauncherOutput('nothing'), {})
  // PowerShell 7 wraps the message over "| " lines under the code it points at, in color.
  const pwsh = '\x1b[31;1mException: \x1b[0mC:\\bin\\spawn-agent.ps1:46\x1b[0m\r\n\x1b[36;1mLine |\x1b[0m\r\n\x1b[36;1m  46 | \x1b[0m …   \x1b[36;1mthrow "Claude in $pane waits for a dialog"\x1b[0m\r\n\x1b[36;1m     | \x1b[31;1m     ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~\x1b[0m\r\n\x1b[36;1m     | \x1b[31;1mClaude in w2:p14 waits for a dialog (folder trust?). Answer it in that tab, then: herdr agent prompt w2:p14\x1b[0m\r\n\x1b[36;1m     | \x1b[31;1m"/rename x" and send the brief.\x1b[0m\r\n'
  const e = launcherError('', pwsh)
  assert.equal(e.message, 'Claude in w2:p14 waits for a dialog (folder trust?). Answer it in that tab, then: herdr agent prompt w2:p14 "/rename x" and send the brief.')
  assert.equal(e.pane, 'w2:p14')
  assert.equal(failureKind(e.message), 'dialog')
  // Windows PowerShell puts it first, cut at the console's width, then where it was thrown.
  const legacy = `${'Claude in w2:p14 waits for a dialog (folder trust?). Answer it in that tab, then: herdr agent prompt w2:p14 "/rename x" and send the brief.'.replace(/^(.{120})/, '$1\r\n')}\r\nAt C:\\bin\\spawn-agent.ps1:46 char:5\r\n+     throw "Claude in $pane waits for a dialog"\r\n+     ~~~~~~~~~~\r\n    + CategoryInfo          : OperationStopped: (Claude in w2:p1...send the brief.:String) [], RuntimeException\r\n    + FullyQualifiedErrorId : Claude in w2:p14 waits\r\n`
  assert.equal(launcherError('', legacy).message, e.message)
  assert.equal(launcherError('', '\x1b[31mError: No such folder: C:\\nope\x1b[0m\n').message, 'No such folder: C:\\nope')
  assert.equal(failureKind('Claude did not get ready in w2:p1 within 120 s'), 'timeout')
  assert.equal(failureKind('No such folder: C:\\x'), 'folder')
  assert.equal(failureKind('anything', 'ENOENT'), 'launcher')
})

test('a launch request is checked before anything runs', t => {
  const box = sandbox(t)
  const dir = join(box.dir, 'Acme project')
  mkdirSync(dir)
  writeFileSync(join(box.dir, 'file.txt'), 'x')
  const ok = checkRequest({ name: ' Acme ', cwd: dir, category: 'acme', workspace: { id: 'w2' }, message: ' hi ' })
  assert.equal(ok.ok, true)
  assert.deepEqual({ ...ok.launch }, { name: 'Acme', label: 'Acme', cwd: dir, category: 'acme', workspaceId: 'w2', workspaceLabel: '', newWorkspace: false, message: 'hi', worktree: null })
  assert.equal(checkRequest({ name: 'A', cwd: dir, workspace: { create: 'Fresh' } }).launch.newWorkspace, true)
  assert.equal(checkRequest({ name: 'A', cwd: dir, category: 'Bad Id!', workspace: { id: 'w2' } }).launch.category, 'other')
  const fails = [
    [{ name: '', cwd: dir, workspace: { id: 'w2' } }, 'name'],
    [{ name: 'A', cwd: join(box.dir, 'missing'), workspace: { id: 'w2' } }, 'cwd'],
    [{ name: 'A', cwd: join(box.dir, 'file.txt'), workspace: { id: 'w2' } }, 'cwd'],
    [{ name: 'A', cwd: '', workspace: { id: 'w2' } }, 'cwd'],
    [{ name: 'A', cwd: dir, workspace: { id: 'w2; rm -rf' } }, 'workspace'],
    [{ name: 'A', cwd: dir, workspace: { create: '' } }, 'workspace'],
    [{ name: 'A', cwd: dir, workspace: { id: 'w2' }, worktree: { branch: 'a..b' } }, 'worktree'],
    [{ name: 'A', cwd: dir, workspace: { id: 'w2' }, message: 'x'.repeat(20_001) }, 'message'],
  ]
  for (const [body, field] of fails) assert.equal(checkRequest(body).field, field, JSON.stringify(body).slice(0, 80))
})

// ---------------------------------------------------------------- through the server
async function unusedPort() {
  const server = http.createServer()
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  await new Promise(resolve => server.close(resolve))
  return port
}

const SNAPSHOT = { panes: [{ pane_id: 'p1', agent: 'claude', agent_session: { value: 's1' }, agent_status: 'idle', cwd: 'C:\\old', terminal_title_stripped: 'work-10', workspace_id: 'wA' }], tabs: [], workspaces: [{ workspace_id: 'wA', label: 'Alpha' }] }
const HERDR = {
  'api snapshot': { result: { snapshot: SNAPSHOT } },
  'workspace list': { result: { workspaces: [{ workspace_id: 'wA', label: 'Alpha', focused: true }, { workspace_id: 'wB', label: 'Board' }] } },
  'workspace create': { result: { workspace: { workspace_id: 'wN' }, tab: { tab_id: 'wN:t1' }, root_pane: { pane_id: 'wN:p1' } } },
  'tab create': { result: { tab: { tab_id: 'wA:t9' }, root_pane: { pane_id: 'wA:p9' } } },
  'tab rename': { result: null },
  'agent list': { result: { agents: [{ name: 'alpha-job' }, { name: 'work-10' }] } },
  'agent start': { result: { type: 'ok' } },
  'agent prompt': { result: null },
  'agent get': { result: { agent: { agent_session: { value: 's1' }, agent_status: 'idle', name: 'work-10' } } },
  'agent rename': { result: null },
  'pane read': { text: 'Session renamed to: Alpha job' },
  'pane list': { result: { panes: [{ pane_id: 'wN:p1', agent: null, tab_id: 'wN:t1' }, { pane_id: 'wN:p2', agent: null, tab_id: 'wN:t1' }] } },
  'tab close': { result: null },
}

async function boardServer(t, cfg = {}) {
  const box = sandbox(t)
  box.state(HERDR)
  const port = await unusedPort()
  const proc = box.run('server', { port, categories: [{ id: 'acme', title: 'Acme', color: 'blue', paths: [] }, { id: 'other', title: 'Other', color: 'gray' }], wakeUrl: null, refreshSec: 3600, ...cfg })
  await until(() => proc.messages.some(m => m.ready))
  const url = `http://127.0.0.1:${port}`
  const board = async () => (await fetch(`${url}/api/board`)).json()
  const deadline = Date.now() + 5000
  while ((await board()).stale) {
    if (Date.now() > deadline) throw new Error('not fresh')
    await new Promise(r => setTimeout(r, 10))
  }
  const post = (path, body, headers = {}) => fetch(url + path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-board': '1', ...headers }, body: JSON.stringify(body) })
  const launched = async id => {
    let l
    const end = Date.now() + 10_000
    while (Date.now() < end) {
      l = (await board()).launches.find(x => x.id === id)
      if (l && (l.state === 'done' || l.state === 'failed')) return l
      await new Promise(r => setTimeout(r, 25))
    }
    throw new Error(`launch ${id} did not finish: ${JSON.stringify(l)}`)
  }
  return { box, proc, url, board, post, launched }
}

test('a new session through herdr: a tab in the chosen workspace, Claude with its id, named, briefed, in its lane', { timeout: 30_000 }, async t => {
  const { box, post, launched, board, url } = await boardServer(t)
  const dir = join(box.dir, 'Alpha project')
  mkdirSync(dir)
  // The guards every change has, plus the page's own origin for this one.
  assert.equal((await fetch(`${url}/api/launch`, { method: 'POST', body: '{}' })).status, 403)
  assert.equal((await post('/api/launch', { name: 'x', cwd: dir, workspace: { id: 'wA' } }, { origin: 'http://evil.example' })).status, 403)
  const bad = await post('/api/launch', { name: 'x', cwd: join(dir, 'nope'), workspace: { id: 'wA' } })
  assert.equal(bad.status, 400)
  assert.equal((await bad.json()).field, 'cwd')
  assert.equal(box.calls().some(a => a[0] === 'tab'), false)

  const res = await post('/api/launch', { name: 'Alpha job', cwd: dir, category: 'acme', workspace: { id: 'wA', label: 'Alpha' }, message: '-dash first, then text' })
  assert.equal(res.status, 200)
  const { id } = await res.json()
  const l = await launched(id)
  assert.equal(l.state, 'done', l.error)
  assert.equal(l.pane, 'wA:p9')
  const calls = box.calls()
  assert.deepEqual(calls.find(a => a[0] === 'tab' && a[1] === 'create'), ['tab', 'create', '--workspace', 'wA', '--cwd', dir, '--label', 'Alpha job', '--no-focus'])
  const start = calls.find(a => a[0] === 'agent' && a[1] === 'start')
  assert.deepEqual(start.slice(0, 7), ['agent', 'start', 'alpha-job-2', '--kind', 'claude', '--pane', 'wA:p9'])
  const sid = start.at(-1)
  assert.deepEqual(start.slice(-3, -1), ['--', '--session-id'])
  assert.match(sid, /^[0-9a-f-]{36}$/)
  const prompts = calls.filter(a => a[0] === 'agent' && a[1] === 'prompt').map(a => a.slice(2))
  assert.deepEqual(prompts, [['wA:p9', '/rename Alpha job'], ['wA:p9', ' -dash first, then text']])
  // The card existed before Claude did, so its first brief already names the lane.
  assert.equal(JSON.parse(readFileSync(join(box.cards, `${sid}.json`), 'utf8')).category, 'acme')
  assert.equal((await board()).launches.length, 1)
})

test('a new session through the configured launcher: a new workspace, the values as arguments, its pane, and a failure with its reason', { timeout: 30_000 }, async t => {
  const launcher = fileURLToPath(new URL('./fixtures/fake-launcher.mjs', import.meta.url))
  const box0 = sandbox(t)
  const record = join(box0.dir, 'launcher.json')
  const { box, post, launched } = await boardServer(t, { launch: { command: [process.execPath, launcher, record, '-Name', '{name}', '-Cwd', '{cwd}', '-Workspace', '{workspace}', ['-BriefFile', '{messageFile}'], ['-Session', '{sessionId}']] } })
  const dir = join(box.dir, 'Beta')
  mkdirSync(dir)
  const { id } = await (await post('/api/launch', { name: 'Beta work', cwd: dir, category: 'acme', workspace: { create: 'Beta space' }, message: 'Line one\nline two' })).json()
  const l = await launched(id)
  assert.equal(l.state, 'done', l.error)
  assert.equal(l.pane, 'wT:p7')
  const seen = JSON.parse(readFileSync(record, 'utf8'))
  const session = seen.args[seen.args.indexOf('-Session') + 1]
  assert.deepEqual(seen.args.slice(0, 6), ['-Name', 'Beta work', '-Cwd', dir, '-Workspace', 'wN'])
  assert.equal(seen.brief, 'Line one\nline two')
  assert.match(session, /^[0-9a-f-]{36}$/)
  // It runs for that workspace, not for the board's own pane.
  assert.equal(seen.workspace, 'wN')
  assert.equal(seen.pane, null)
  const calls = box.calls()
  assert.deepEqual(calls.find(a => a[0] === 'workspace' && a[1] === 'create'), ['workspace', 'create', '--cwd', dir, '--label', 'Beta space', '--no-focus'])
  // The tab of shells the new workspace came with goes, the launcher made its own tab.
  assert.ok(calls.some(a => a.join(' ') === 'tab close wN:t1'))
  assert.equal(JSON.parse(readFileSync(join(box.cards, `${session}.json`), 'utf8')).category, 'acme')

  const failing = await (await post('/api/launch', { name: 'Will fail', cwd: dir, workspace: { id: 'wA' } })).json()
  const f = await launched(failing.id)
  assert.equal(f.state, 'failed')
  assert.equal(f.error, 'Claude in wT:p9 waits for a dialog (folder trust?). Answer it in that tab.')
  assert.equal(f.kind, 'dialog')
  assert.equal(f.pane, 'wT:p9')
  assert.equal((await post(`/api/launch/${failing.id}/dismiss`, {})).status, 200)
})

test('renaming: the board’s name on the card, back to the automatic one, and Claude only when asked', { timeout: 30_000 }, async t => {
  const { box, post, board, proc } = await boardServer(t)
  const named = async () => {
    proc.send('refresh')
    await new Promise(r => setTimeout(r, 150))
    return (await board()).items[0]
  }
  assert.equal((await post('/api/session/s1/rename', { name: 'Billing fixes' })).status, 200)
  let it = await named()
  assert.equal(it.name, 'Billing fixes')
  assert.equal(it.autoName, 'work-10')
  assert.equal(box.calls().some(a => a[0] === 'agent' && a[1] === 'prompt'), false) // nothing typed into the session
  assert.equal((await post('/api/session/s1/rename', { name: '/bad' })).status, 409)
  assert.equal((await post('/api/session/s1/rename', { name: '' })).status, 200)
  it = await named()
  assert.equal(it.name, 'work-10')

  assert.equal((await post('/api/session/s1/rename', { name: 'Billing fixes', claude: true })).status, 200)
  const calls = box.calls().map(a => a.join(' '))
  assert.ok(calls.includes('agent prompt p1 /rename Billing fixes'))
  assert.ok(calls.includes('agent rename p1 billing-fixes'))

  // A session in the middle of a turn is not typed into.
  box.state({ ...HERDR, 'agent get': { result: { agent: { agent_session: { value: 's1' }, agent_status: 'working', name: 'billing-fixes' } } } })
  const busy = await post('/api/session/s1/rename', { name: 'Other', claude: true })
  assert.equal(busy.status, 409)
  assert.match((await busy.json()).error, /working|работает/)
})

test('the folder picker lists folders only, and the drives to start from', { timeout: 20_000 }, async t => {
  const { box, post, url } = await boardServer(t)
  for (const d of ['b-dir', 'A-dir', '.hidden']) mkdirSync(join(box.dir, 'pick', d), { recursive: true })
  writeFileSync(join(box.dir, 'pick', 'file.txt'), 'x')
  const r = await (await post('/api/fs/dirs', { path: join(box.dir, 'pick') })).json()
  assert.deepEqual(r.entries, ['.hidden', 'A-dir', 'b-dir'])
  assert.equal(r.dir, true)
  assert.equal((await (await post('/api/fs/dirs', { path: join(box.dir, 'pick', 'file.txt') })).json()).dir, false)
  assert.equal((await (await post('/api/fs/dirs', { path: join(box.dir, 'nope') })).json()).exists, false)
  const roots = await (await post('/api/fs/dirs', { path: '' })).json()
  assert.ok(roots.roots.length >= 2)
  assert.equal((await fetch(`${url}/api/fs/dirs`, { method: 'POST', body: '{}' })).status, 403)
})
