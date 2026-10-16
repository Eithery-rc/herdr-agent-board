import assert from 'node:assert/strict'
import { test } from 'node:test'
import { applyDiff, caretSpot, color256, diffLines, findLinks, fitFont, parseLine, plainText, withLinks } from '../web/term-model.js'
import { cleanText, herdrCalls, keyCall, keyStep, mergeSteps, splitKey, textSteps } from '../web/term-keys.js'

const ESC = '\x1b'
const style = (line, i = 0) => parseLine(line)[i].style

test('a pane line read with --ansi becomes styled runs', () => {
  const runs = parseLine(`${ESC}[0m${ESC}[38;5;11mecho${ESC}[0m ${ESC}[1;38;2;255;107;128mred${ESC}[0m`)
  assert.deepEqual(runs.map(r => r.text), ['echo', ' ', 'red'])
  assert.equal(runs[0].style.fg, 11)
  assert.equal(runs[1].style.fg, null)
  assert.equal(runs[2].style.fg, '#ff6b80')
  assert.equal(runs[2].style.bold, true)
  // 16 colors, bright ones, backgrounds, and resets of each attribute.
  assert.equal(style(`${ESC}[31mx`).fg, 1)
  assert.equal(style(`${ESC}[97mx`).fg, 15)
  assert.equal(style(`${ESC}[44mx`).bg, 4)
  assert.equal(style(`${ESC}[105mx`).bg, 13)
  assert.equal(style(`${ESC}[48;5;196mx`).bg, '#ff0000')
  assert.equal(style(`${ESC}[2;3;4;7;9mx`).dim, true)
  const all = style(`${ESC}[2;3;4;7;9mx`)
  assert.ok(all.italic && all.underline && all.inverse && all.strike)
  const off = style(`${ESC}[1;2;3;4;7;9m${ESC}[22;23;24;27;29mx`)
  assert.ok(!off.bold && !off.dim && !off.italic && !off.underline && !off.inverse && !off.strike)
  assert.equal(style(`${ESC}[31m${ESC}[39mx`).fg, null)
  // The colon form of a true color, with its empty color-space slot.
  assert.equal(style(`${ESC}[38:2::10:20:30mx`).fg, '#0a141e')
  // A color without its arguments takes no more parameters than it has.
  assert.equal(style(`${ESC}[38;5mx`).fg, null)
})

test('escapes other than colors and control characters are dropped, tabs expand to stops of 8', () => {
  assert.equal(plainText(`a${ESC}]9;9;C:\\x${ESC}\\b${ESC}[2Kc${ESC}[?25ld\x07e\x00`), 'abcde')
  assert.equal(plainText('ab\tc'), 'ab      c')
  assert.equal(plainText(`${ESC}[31mab${ESC}[0m\tc`), 'ab      c')
  assert.equal(plainText(''), '')
  assert.equal(plainText(undefined), '')
})

test('the 256-color palette: the cube and the grays', () => {
  assert.equal(color256(16), '#000000')
  assert.equal(color256(21), '#0000ff')
  assert.equal(color256(231), '#ffffff')
  assert.equal(color256(232), '#080808')
  assert.equal(color256(255), '#eeeeee')
})

test('web links in the output, without the sentence around them', () => {
  assert.deepEqual(findLinks('open https://github.com/login/device.').map(l => l.url), ['https://github.com/login/device'])
  assert.deepEqual(findLinks('(see https://example.com/a_(b))').map(l => l.url), ['https://example.com/a_(b)'])
  assert.deepEqual(findLinks('(https://example.com/x)').map(l => l.url), ['https://example.com/x'])
  assert.deepEqual(findLinks('"https://a.example/q?x=1&y=2", and http://b.example/').map(l => l.url), ['https://a.example/q?x=1&y=2', 'http://b.example/'])
  assert.deepEqual(findLinks('ftp://example.com file:///c:/x javascript:alert(1)'), [])
  // A link split over styled runs keeps the runs' styles and gets its whole address on each part.
  const runs = withLinks(parseLine(`go to ${ESC}[4mhttps://claude.ai/${ESC}[0moauth?code=1 now`))
  const linked = runs.filter(r => r.href)
  assert.deepEqual(linked.map(r => r.text), ['https://claude.ai/', 'oauth?code=1'])
  assert.ok(linked.every(r => r.href === 'https://claude.ai/oauth?code=1'))
  assert.equal(runs.map(r => r.text).join(''), 'go to https://claude.ai/oauth?code=1 now')
})

test('line diffs: typing changes one line, output scrolls, a redraw starts over', () => {
  const typed = diffLines(['a', 'b', 'PS> '], ['a', 'b', 'PS> ls'])
  assert.deepEqual(typed, { drop: 0, keep: 2, lines: ['PS> ls'] })
  const scrolled = diffLines(['1', '2', '3', '4'], ['3', '4', '5'])
  assert.deepEqual(scrolled, { drop: 2, keep: 2, lines: ['5'] })
  assert.deepEqual(diffLines(['x', 'y'], ['p', 'q']), { drop: 2, keep: 0, lines: ['p', 'q'] })
  assert.deepEqual(diffLines([], ['a']), { drop: 0, keep: 0, lines: ['a'] })
  assert.deepEqual(diffLines(['a', 'b'], ['a', 'b']), { drop: 0, keep: 2, lines: [] })
  // Blank lines repeat: the longest run that matches wins.
  assert.deepEqual(diffLines(['', '', 'a', ''], ['', 'a', '', 'b']), { drop: 1, keep: 3, lines: ['b'] })
})

test('any diff applied to the old lines gives the new ones', () => {
  let seed = 7
  const rand = n => ((seed = (seed * 1103515245 + 12345) % 2147483648) % n)
  const make = () => Array.from({ length: rand(12) }, () => ['', 'a', 'b', 'c', 'PS> '][rand(5)])
  for (let i = 0; i < 500; i++) {
    const prev = make()
    const next = rand(2) ? make() : prev.slice(rand(prev.length + 1)).concat(make())
    assert.deepEqual(applyDiff(prev, diffLines(prev, next)), next)
  }
})

test('the text size fits the pane columns, and wraps at the window below the smallest size', () => {
  assert.deepEqual(fitFont({ width: 1000, cols: 100, ratio: 0.6 }), { size: 14, wrap: false })
  assert.deepEqual(fitFont({ width: 760, cols: 107, ratio: 0.6 }), { size: 11.75, wrap: false })
  assert.deepEqual(fitFont({ width: 340, cols: 107, ratio: 0.6, min: 9.5 }), { size: 9.5, wrap: true })
  assert.deepEqual(fitFont({ width: 0, cols: 107 }), { size: 14, wrap: false })
})

test('where the caret goes: after a shell prompt, in Claude Code’s input box', () => {
  assert.deepEqual(caretSpot(['out', 'PS C:\\x> ', '', ''], 'shell'), { line: 1, col: 9 })
  assert.deepEqual(caretSpot(['PS C:\\x> git st'], 'shell'), { line: 0, col: 15 })
  // Spaces a prediction left behind count as the one after the prompt.
  assert.deepEqual(caretSpot(['PS C:\\x>        '], 'shell'), { line: 0, col: 9 })
  assert.equal(caretSpot(['', ''], 'shell'), null)
  const rule = '─'.repeat(40)
  const box = text => ['● ok', rule, `❯ ${text}\u00a0`, rule, '  ctx 6%']
  assert.deepEqual(caretSpot(box(''), 'claude'), { line: 2, col: 2 })
  assert.deepEqual(caretSpot(box('hello board'), 'claude'), { line: 2, col: 13 })
  // Several lines typed (Shift+Enter): the end of the last one.
  assert.deepEqual(caretSpot(['x', rule, '❯ first', '  second line', rule], 'claude'), { line: 3, col: 13 })
  // A dialog in place of the box, a box Claude draws its own cursor in, another agent.
  assert.equal(caretSpot(['  Do you want to proceed?', ' ❯ 1. Yes', '   2. No'], 'claude'), null)
  assert.equal(caretSpot(['x', rule, `❯ hi${ESC}[7m ${ESC}[0m`, rule], 'claude'), null)
  assert.equal(caretSpot(box('x'), 'codex'), null)
})

const ev = (key, extra = {}) => ({ key, code: '', ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, isComposing: false, ...extra })

test('browser keys become herdr keys; typing, pasting and the browser’s own keys pass by', () => {
  assert.deepEqual(keyStep(ev('Enter')), { key: 'enter' })
  assert.deepEqual(keyStep(ev('Escape')), { key: 'esc' })
  assert.deepEqual(keyStep(ev('Tab', { shiftKey: true })), { key: 'shift+tab' })
  assert.deepEqual(keyStep(ev('ArrowLeft', { ctrlKey: true })), { key: 'ctrl+left' })
  assert.deepEqual(keyStep(ev('ArrowUp', { ctrlKey: true, shiftKey: true })), { key: 'ctrl+shift+up' })
  assert.deepEqual(keyStep(ev('Backspace')), { key: 'backspace' })
  assert.deepEqual(keyStep(ev('Home')), { key: 'home' })
  assert.deepEqual(keyStep(ev('Delete')), { key: 'delete' })
  assert.deepEqual(keyStep(ev('F5')), { key: 'f5' })
  assert.equal(keyStep(ev('F12')), null)
  // Ctrl with a letter goes by the key's place: Ctrl+C on a Russian layout too.
  assert.deepEqual(keyStep(ev('с', { code: 'KeyC', ctrlKey: true })), { key: 'ctrl+c' })
  assert.deepEqual(keyStep(ev('R', { code: 'KeyR', ctrlKey: true, shiftKey: true })), { key: 'ctrl+r' })
  assert.deepEqual(keyStep(ev('b', { code: 'KeyB', altKey: true })), { key: 'alt+b' })
  assert.deepEqual(keyStep(ev('.', { code: 'Period', altKey: true })), { key: 'alt+.' })
  assert.deepEqual(keyStep(ev(' ', { code: 'Space', ctrlKey: true })), { key: 'ctrl+space' })
  // Copy with text selected or with Shift; paste is the paste event's; Ctrl+] leaves.
  assert.deepEqual(keyStep(ev('c', { code: 'KeyC', ctrlKey: true }), { selection: true }), { copy: true })
  assert.deepEqual(keyStep(ev('C', { code: 'KeyC', ctrlKey: true, shiftKey: true })), { copy: true })
  assert.equal(keyStep(ev('v', { code: 'KeyV', ctrlKey: true })), null)
  assert.equal(keyStep(ev('Insert', { shiftKey: true })), null)
  assert.deepEqual(keyStep(ev(']', { code: 'BracketRight', ctrlKey: true })), { leave: true })
  assert.deepEqual(keyStep(ev('ъ', { code: 'BracketRight', ctrlKey: true })), { leave: true })
  // Characters come as input; AltGr types one; Cmd shortcuts and a composition stay the browser's.
  assert.equal(keyStep(ev('a', { code: 'KeyA' })), null)
  assert.equal(keyStep(ev('A', { code: 'KeyA', shiftKey: true })), null)
  assert.equal(keyStep(ev('@', { code: 'KeyQ', ctrlKey: true, altKey: true })), null)
  assert.equal(keyStep(ev('{', { code: 'Digit7', ctrlKey: true, altKey: true })), null)
  assert.equal(keyStep(ev('c', { code: 'KeyC', metaKey: true })), null)
  assert.equal(keyStep(ev('Process', { isComposing: true })), null)
  assert.equal(keyStep(ev('Shift', { shiftKey: true })), null)
})

test('typed and pasted text: lines with an Enter between, no control characters', () => {
  assert.deepEqual(textSteps('ls -la'), [{ text: 'ls -la' }])
  assert.deepEqual(textSteps('a\r\nb\nc'), [{ text: 'a' }, { key: 'enter' }, { text: 'b' }, { key: 'enter' }, { text: 'c' }])
  assert.deepEqual(textSteps('x\n'), [{ text: 'x' }, { key: 'enter' }])
  assert.deepEqual(textSteps(`a${ESC}[31mb\x07\tc`), [{ text: 'a[31mb\tc' }])
  assert.equal(cleanText('\x9b2J\x7fok'), '2Jok')
  assert.deepEqual(mergeSteps([{ text: 'a' }, { text: 'b' }, { key: 'enter' }, { key: 'up' }, { text: 'c' }]), [{ text: 'ab' }, { key: 'enter' }, { key: 'up' }, { text: 'c' }])
})

test('the server takes only keys the board sends, in canonical form', () => {
  for (const name of ['enter', 'esc', 'ctrl+c', 'ctrl+alt+shift+left', 'alt+.', 'f12', 'shift+tab', 'home', 'ctrl+delete', 'ctrl+]']) assert.ok(splitKey(name), name)
  for (const name of ['', 'a', 'shift+a', 'meta+c', 'shift+ctrl+c', 'ctrl+ctrl+c', 'ctrl+é', 'f13', 'ctrl+', '+', 'enter ', 'ctrl+enter\n']) assert.equal(splitKey(name), null, name)
  // Keys herdr has no name for go as the sequences a terminal sends.
  assert.deepEqual(keyCall('home'), { text: '\x1b[H' })
  assert.deepEqual(keyCall('ctrl+end'), { text: '\x1b[1;5F' })
  assert.deepEqual(keyCall('delete'), { text: '\x1b[3~' })
  assert.deepEqual(keyCall('shift+pageup'), { text: '\x1b[5;2~' })
  assert.deepEqual(keyCall('ctrl+shift+left'), { text: '\x1b[1;6D' })
  assert.deepEqual(keyCall('ctrl+left'), { keys: ['ctrl+left'] })
})

test('an input request becomes herdr calls in order, or nothing at all', () => {
  assert.deepEqual(herdrCalls([{ text: 'git st' }, { key: 'tab' }, { key: 'enter' }, { text: '-x' }, { key: 'home' }, { text: 'y' }]), {
    calls: [{ text: 'git st' }, { keys: ['tab', 'enter'] }, { text: '-x\x1b[Hy' }],
  })
  assert.deepEqual(herdrCalls([{ text: 'a\x1b]0;x\x07b' }]), { calls: [{ text: 'a]0;xb' }] })
  assert.deepEqual(herdrCalls([{ text: '\x00' }, { key: 'enter' }]), { calls: [{ keys: ['enter'] }] })
  assert.equal(herdrCalls([{ key: 'enter' }, { key: 'rm -rf' }]).error, 'key')
  assert.equal(herdrCalls([{ key: 'enter', text: 'x' }]).error, 'step')
  assert.equal(herdrCalls([{ text: 5 }]).error, 'step')
  assert.equal(herdrCalls([null]).error, 'step')
  assert.equal(herdrCalls([]).error, 'empty')
  assert.equal(herdrCalls('enter').error, 'empty')
  assert.equal(herdrCalls(Array(257).fill({ key: 'up' })).error, 'too many')
  assert.equal(herdrCalls([{ text: 'x'.repeat(16_385) }]).error, 'too long')
})
