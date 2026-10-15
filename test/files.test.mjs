import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { describe, kindOf, openCommand, parseCsv, preview, resolvePath } from '../src/files.mjs'
import { inline, looksLikePath, markdown } from '../web/markdown.js'
import { sandbox, until } from './fixtures/sandbox.mjs'

test('paths in the chat: links, code and running text become candidates; the rest stays text', () => {
  assert.match(inline('[notes](herdr-reveal:C:/Work/My%20Notes/a.md)'), /^<a class="fs" data-path="herdr-reveal:C:\/Work\/My%20Notes\/a\.md">notes<\/a>$/)
  assert.match(inline('see `src/server.mjs:42`'), /<code class="fs-cand" data-path="src\/server\.mjs:42">src\/server\.mjs:42<\/code>/)
  assert.match(inline('saved to C:\\Work\\out\\report_v2.csv.'), /<span class="fs-cand" data-path="C:\\Work\\out\\report_v2\.csv">C:\\Work\\out\\report_v2\.csv<\/span>\.$/)
  assert.match(inline('logs in /var/log/app/today.log'), /data-path="\/var\/log\/app\/today\.log"/)
  assert.match(inline('`~/notes/todo.md`'), /data-path="~\/notes\/todo\.md"/)
  // Not paths: commands, versions, fractions, words with a slash, web links.
  for (const text of ['`npm test`', '`v1.2.3`', '1/2 done', 'and/or', '`foo.bar()`', '`src/**/*.js`']) assert.ok(!/data-path/.test(inline(text)), text)
  assert.match(inline('see https://example.com/a/b and [docs](https://x.dev)'), /<a class="ext" href="https:\/\/example\.com\/a\/b"[^>]*>https:\/\/example\.com\/a\/b<\/a> and <a class="ext" href="https:\/\/x\.dev"/)
  assert.ok(!/fs-cand/.test(inline('see https://example.com/a/b')))
  // Emphasis rules leave paths alone; quotes cannot break out of the attribute.
  assert.match(inline('C:\\a_b\\c_d_e.txt and _this_'), /data-path="C:\\a_b\\c_d_e\.txt">C:\\a_b\\c_d_e\.txt<\/span> and <i>this<\/i>/)
  assert.ok(!/data-path="[^"]*"[^>]*onmouseover/.test(inline('`C:/x" onmouseover="alert(1)`')))
  assert.match(markdown('- see `README.md`'), /<li>see <code class="fs-cand" data-path="README\.md">/)
  // The chat keeps an agent's line breaks; a document in the quick look reads as Markdown does.
  assert.equal(markdown('one\ntwo'), '<p>one<br>two</p>')
  assert.equal(markdown('one\ntwo\n\n- a\n  b', { soft: true }), '<p>one two</p><ul><li>a b</li></ul>')
  assert.ok(looksLikePath('\\\\server\\share\\x.txt') && looksLikePath('file:///C:/x.txt') && !looksLikePath('https://x.dev/a'))
})

test('a path as written: prefixes, escapes, lines, home and the session folder', () => {
  assert.deepEqual(resolvePath('herdr-reveal:C:/Work/My%20Notes/a.md'), { path: resolve('C:/Work/My Notes/a.md'), line: null })
  assert.deepEqual(resolvePath('file:///C:/x/y.txt'), { path: resolve('C:/x/y.txt'), line: null })
  assert.deepEqual(resolvePath('src/app.js:42:7', 'C:\\proj'), { path: resolve('C:\\proj', 'src/app.js'), line: 42 })
  assert.deepEqual(resolvePath('C:\\x\\y.ts:10'), { path: resolve('C:\\x\\y.ts'), line: 10 })
  assert.equal(resolvePath('C:\\').path, resolve('C:\\'))
  assert.equal(resolvePath('~/notes.md').path, resolve(homedir(), 'notes.md'))
  assert.equal(resolvePath('relative.txt').path, '') // no session folder to resolve against
  assert.equal(kindOf('a/b/Dockerfile'), 'text')
  assert.equal(kindOf('x.PNG'), 'image')
  assert.equal(kindOf('x.bin'), 'file')
})

test('previews: folders first, text cut to size, JSON pretty, CSV rows, binary and missing files', () => {
  const dir = mkdtempSync(join(tmpdir(), 'board-files-'))
  mkdirSync(join(dir, 'zeta'))
  writeFileSync(join(dir, 'a.md'), '# Title\n\nText')
  writeFileSync(join(dir, 'data.json'), '{"a":1,"b":[1,2]}')
  writeFileSync(join(dir, 't.csv'), 'name,note\n"Smith, J","said ""hi""\nthen left"\nB,2\n')
  writeFileSync(join(dir, 'blob.bin'), Buffer.from([0, 1, 2, 3, 0, 255]))
  writeFileSync(join(dir, 'long.log'), Array.from({ length: 6000 }, (_, i) => `line ${i + 1}`).join('\n'))
  writeFileSync(join(dir, 'utf16.txt'), Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('привет', 'utf16le')]))

  const folder = preview(dir)
  assert.equal(folder.dir, true)
  assert.equal(folder.entries[0].name, 'zeta')
  assert.equal(folder.entries[0].dir, true)
  assert.deepEqual(folder.entries.slice(1).map(e => e.name), ['a.md', 'blob.bin', 'data.json', 'long.log', 't.csv', 'utf16.txt'])
  assert.equal(folder.total, 7)

  assert.equal(preview(join(dir, 'a.md')).kind, 'markdown')
  assert.equal(preview(join(dir, 'data.json')).text, '{\n  "a": 1,\n  "b": [\n    1,\n    2\n  ]\n}')
  assert.deepEqual(preview(join(dir, 't.csv')).rows, [['name', 'note'], ['Smith, J', 'said "hi"\nthen left'], ['B', '2']])
  assert.equal(preview(join(dir, 'blob.bin')).kind, 'file')
  assert.equal(preview(join(dir, 'blob.bin')).text, undefined)
  const long = preview(join(dir, 'long.log'))
  assert.equal(long.truncated, true)
  assert.equal(long.lines, 5000)
  assert.equal(preview(join(dir, 'utf16.txt')).text, 'привет')
  assert.equal(preview(join(dir, 'nope.txt')).error, 'missing')
  assert.equal(describe(join(dir, 'zeta')).kind, 'dir')
  assert.deepEqual(parseCsv('a\tb\n1\t2', '\t'), [['a', 'b'], ['1', '2']])
})

test('opening with the system: the right command on each platform, no shell in between', () => {
  assert.deepEqual(openCommand('C:\\a b\\x.pdf', 'open', 'win32'), ['explorer.exe', ['C:\\a b\\x.pdf']])
  assert.deepEqual(openCommand('C:\\a b\\x.pdf', 'reveal', 'win32'), ['explorer.exe', ['/select,C:\\a b\\x.pdf']])
  assert.deepEqual(openCommand('/u/x.pdf', 'reveal', 'darwin'), ['open', ['-R', '/u/x.pdf']])
  assert.deepEqual(openCommand('https://x.dev', 'open', 'darwin'), ['open', ['https://x.dev']])
  assert.deepEqual(openCommand('/u/a/x.pdf', 'reveal', 'linux'), ['xdg-open', ['/u/a']])
})

async function unusedPort() {
  const server = http.createServer()
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  const port = server.address().port
  await new Promise(r => server.close(r))
  return port
}

test('file API: stat, preview, raw bytes behind the token with ranges, and refusals', { timeout: 20_000 }, async t => {
  const box = sandbox(t)
  box.state({ 'api snapshot': { error: 'offline' } })
  const files = join(box.dir, 'files')
  mkdirSync(files)
  writeFileSync(join(files, 'pic.png'), Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex'))
  writeFileSync(join(files, 'note.txt'), 'hello')
  const port = await unusedPort()
  const proc = box.run('server', { port, categories: [{ id: 'other', title: 'Other', color: 'gray' }], wakeUrl: null, refreshSec: 3600 })
  await until(() => proc.messages.some(m => m.ready))
  const url = `http://127.0.0.1:${port}`
  const post = (path, body, headers = { 'x-board': '1' }) => fetch(`${url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) })

  const stat = await (await post('/api/fs/stat', { cwd: files, paths: ['note.txt:3', 'pic.png', 'missing.md', files] })).json()
  assert.deepEqual(stat.items.map(i => [i.exists, i.dir ?? null, i.kind ?? null, i.line]), [[true, false, 'text', 3], [true, false, 'image', null], [false, null, null, null], [true, true, 'dir', null]])
  assert.equal((await post('/api/fs/stat', { paths: [] }, {})).status, 403)

  const note = await (await post('/api/fs/preview', { path: join(files, 'note.txt') })).json()
  assert.equal(note.text, 'hello')

  const board = await (await fetch(`${url}/api/board`)).json()
  assert.ok(board.fsToken)
  const raw = token => fetch(`${url}/api/fs/raw?path=${encodeURIComponent(join(files, 'pic.png'))}&t=${token}`)
  assert.equal((await raw('wrong')).status, 403)
  const ok = await raw(board.fsToken)
  assert.equal(ok.status, 200)
  assert.equal(ok.headers.get('content-type'), 'image/png')
  assert.match(ok.headers.get('content-security-policy'), /sandbox/)
  assert.equal(Buffer.from(await ok.arrayBuffer()).length, 16)
  const part = await fetch(`${url}/api/fs/raw?path=${encodeURIComponent(join(files, 'pic.png'))}&t=${board.fsToken}`, { headers: { range: 'bytes=4-7' } })
  assert.equal(part.status, 206)
  assert.equal(part.headers.get('content-range'), 'bytes 4-7/16')
  assert.deepEqual([...Buffer.from(await part.arrayBuffer())], [0x0d, 0x0a, 0x1a, 0x0a])
  // Text files never come raw: no page of theirs runs on this origin.
  assert.equal((await fetch(`${url}/api/fs/raw?path=${encodeURIComponent(join(files, 'note.txt'))}&t=${board.fsToken}`)).status, 404)

  assert.equal((await post('/api/open-url', { url: 'javascript:alert(1)' })).status, 400)
  assert.equal((await post('/api/fs/open', { path: join(files, 'nope.txt') })).status, 404)
})
