// The board's terminal without a page: a herdr pane read (ANSI) into styled runs, the frames the
// server sends as line diffs, web links in the output, and how big the text can be to fit the
// pane's width. Shared by the server (src/terminal.mjs) and the page (terminal.js).

// The 16 colors on the terminal's dark screen. Programs pick these by number; 256-color and
// true-color values pass through as they are, which is why the screen stays dark in both themes:
// that is what the programs drew for.
export const PALETTE = [
  '#3a3a40', '#ff6b64', '#5fd27a', '#f2cc60', '#62a8ff', '#d68cf5', '#5fd0e0', '#d8d8de',
  '#86868f', '#ff918a', '#86e59a', '#ffe08a', '#93c3ff', '#e6b2ff', '#8fe6f0', '#ffffff',
]

const hex = n => n.toString(16).padStart(2, '0')
/** A color of the 256-color palette, as #rrggbb. */
export function color256(n) {
  if (n < 16) return PALETTE[n]
  if (n < 232) {
    const c = n - 16
    const level = v => (v ? 55 + v * 40 : 0)
    return `#${hex(level(Math.floor(c / 36)))}${hex(level(Math.floor(c / 6) % 6))}${hex(level(c % 6))}`
  }
  const g = 8 + (n - 232) * 10
  return `#${hex(g)}${hex(g)}${hex(g)}`
}

const PLAIN = Object.freeze({ fg: null, bg: null, bold: false, dim: false, italic: false, underline: false, inverse: false, strike: false, hidden: false })
// CSI (with its parameters), OSC (to BEL or ST), and any other two-byte escape.
const ESCAPE = /\x1b\[([0-9;:?<=>]*)[ -/]*([@-~])|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?|\x1b[P^_][^\x1b]*(?:\x1b\\)?|\x1b[ -/]*[0-~]?/g
const CONTROL = /[\x00-\x08\x0a-\x1f\x7f-\x9f]/g

/** A color given by SGR 38/48 arguments: { color, used } (how many arguments it took). */
function extended(args, i) {
  // The first 16 of the 256 are the palette's own: kept as their number, so they follow it.
  if (args[i + 1] === 5 && args[i + 2] != null) {
    const n = Math.max(0, Math.min(255, args[i + 2]))
    return { color: n < 16 ? n : color256(n), used: 2 }
  }
  if (args[i + 1] === 2 && args[i + 4] != null) return { color: `#${[args[i + 2], args[i + 3], args[i + 4]].map(v => hex(Math.max(0, Math.min(255, v)))).join('')}`, used: 4 }
  return { color: null, used: args.length - i }
}

/** The style after an SGR sequence ("1;38;5;208"). Colon forms (38:2::r:g:b) count too. */
export function sgr(style, params) {
  const s = { ...style }
  // A colon form puts one color in one parameter: 38:2::255:0:0 (the empty slot is a color space).
  const groups = String(params || '0').split(';')
  const args = []
  for (const g of groups) {
    if (!g.includes(':')) args.push(g === '' ? 0 : Number(g))
    else {
      const [head, mode, ...rest] = g.split(':')
      const values = (Number(mode) === 2 && rest.length === 4 ? rest.slice(1) : rest).map(Number)
      args.push(Number(head), Number(mode), ...values)
    }
  }
  for (let i = 0; i < args.length; i++) {
    const c = args[i]
    if (c === 0) Object.assign(s, PLAIN)
    else if (c === 1) s.bold = true
    else if (c === 2) s.dim = true
    else if (c === 3) s.italic = true
    else if (c === 4 || c === 21) s.underline = true
    else if (c === 7) s.inverse = true
    else if (c === 8) s.hidden = true
    else if (c === 9) s.strike = true
    else if (c === 22) s.bold = s.dim = false
    else if (c === 23) s.italic = false
    else if (c === 24) s.underline = false
    else if (c === 27) s.inverse = false
    else if (c === 28) s.hidden = false
    else if (c === 29) s.strike = false
    else if (c >= 30 && c <= 37) s.fg = c - 30
    else if (c >= 90 && c <= 97) s.fg = c - 90 + 8
    else if (c >= 40 && c <= 47) s.bg = c - 40
    else if (c >= 100 && c <= 107) s.bg = c - 100 + 8
    else if (c === 39) s.fg = null
    else if (c === 49) s.bg = null
    else if (c === 38 || c === 48 || c === 58) {
      const { color, used } = extended(args, i)
      if (c === 38) s.fg = color
      else if (c === 48) s.bg = color
      i += used
    }
  }
  return s
}

/**
 * One line of a pane read with --ansi, as runs of text with their style: { text, style }. fg and
 * bg are a palette index (0-15), a #hex, or null for the screen's own. Each line starts plain:
 * herdr resets the style at the start of every line. Other escapes and control characters go;
 * a tab becomes spaces to the next stop of 8.
 */
export function parseLine(line) {
  const s = String(line ?? '')
  const runs = []
  let style = PLAIN
  let col = 0
  const push = raw => {
    let text = ''
    for (const ch of raw.replace(CONTROL, '')) {
      const n = ch === '\t' ? 8 - (col % 8) : 1
      text += ch === '\t' ? ' '.repeat(n) : ch
      col += n
    }
    if (!text) return
    const last = runs.at(-1)
    if (last && last.style === style) last.text += text
    else runs.push({ text, style })
  }
  let at = 0
  for (const m of s.matchAll(ESCAPE)) {
    push(s.slice(at, m.index))
    at = m.index + m[0].length
    if (m[2] === 'm') style = sgr(style, m[1])
  }
  push(s.slice(at))
  return runs
}

/** A line without its escapes. */
export const plainText = line => parseLine(line).map(r => r.text).join('')

// Web links in the output: http(s), up to whitespace or a quote; closing punctuation at the end
// is the sentence's, a closing bracket only when it has no opening one in the link.
const URL_RE = /\bhttps?:\/\/[^\s"'<>`]+/g
export function findLinks(text) {
  const out = []
  for (const m of String(text).matchAll(URL_RE)) {
    let url = m[0]
    for (;;) {
      const last = url.at(-1)
      if (/[.,;:!?]/.test(last)) url = url.slice(0, -1)
      else if (last === ')' && (url.match(/\(/g)?.length ?? 0) < (url.match(/\)/g)?.length ?? 0)) url = url.slice(0, -1)
      else if (last === ']' && (url.match(/\[/g)?.length ?? 0) < (url.match(/\]/g)?.length ?? 0)) url = url.slice(0, -1)
      else break
    }
    if (url.length > 10) out.push({ start: m.index, end: m.index + url.length, url })
  }
  return out
}

/** The runs of a line split where links start and end; a run inside a link has its `href`. */
export function withLinks(runs) {
  const text = runs.map(r => r.text).join('')
  const links = findLinks(text)
  if (!links.length) return runs
  const out = []
  let pos = 0
  for (const run of runs) {
    const end = pos + run.text.length
    let cut = pos
    while (cut < end) {
      const link = links.find(l => l.end > cut && l.start < end && l.start <= cut)
      const next = links.find(l => l.start > cut && l.start < end)
      const stop = link ? Math.min(link.end, end) : next ? next.start : end
      out.push({ text: run.text.slice(cut - pos, stop - pos), style: run.style, ...(link ? { href: link.url } : {}) })
      cut = stop
    }
    pos = end
  }
  return out
}

/**
 * What changed between two reads of a pane, as lines: drop that many from the top, keep the
 * next `keep`, add `lines`. Output that scrolls keeps the lines it shares with the last read
 * (a drop, a few new lines at the bottom); a line typed into changes only itself.
 */
export function diffLines(prev, next) {
  if (!prev.length || !next.length) return { drop: prev.length, keep: 0, lines: next.slice() }
  let best = { drop: prev.length, keep: 0 }
  for (let d = 0; d < prev.length; d++) {
    if (prev[d] !== next[0]) continue
    // Not longer than the rest of the old read, nor than the new one.
    const room = Math.min(prev.length - d, next.length)
    if (room <= best.keep) break
    let k = 1
    while (k < room && prev[d + k] === next[k]) k++
    if (k > best.keep) best = { drop: d, keep: k }
    if (k === room) break
  }
  return { drop: best.drop, keep: best.keep, lines: next.slice(best.keep) }
}

/** The lines a diff makes of the last ones. */
export const applyDiff = (lines, d) => lines.slice(d.drop, d.drop + d.keep).concat(d.lines)

/**
 * How big the text can be for `cols` columns to fit `width` pixels; `ratio` is a character's
 * width per pixel of font size (0.6 for most monospace faces). Below `min` it stays at `min` and
 * the lines wrap at the window's width instead.
 */
export function fitFont({ width, cols, ratio = 0.6, min = 10, max = 14 }) {
  if (!(width > 0) || !(cols > 0)) return { size: max, wrap: false }
  const size = Math.floor((width / (cols * ratio)) * 4) / 4
  if (size < min) return { size: min, wrap: true }
  return { size: Math.min(max, size), wrap: false }
}

/** The line a shell at its prompt waits on: the last that is not blank (its index), or -1. */
export function promptLine(lines) {
  for (let i = lines.length - 1; i >= 0; i--) if (plainText(lines[i]).trim()) return i
  return -1
}

const RULE = /^\s*─{8,}/
const width = s => [...s].length

/**
 * Where the cursor most likely is, as { line, col }, or null: herdr does not say. `kind`:
 *   shell   after the last thing on screen; one space after it when the line ends in spaces
 *           (a prompt ends in one; spaces a prediction left behind count as that one)
 *   claude  in Claude Code's input box (the ❯ line under a rule, down to the next rule), after
 *           the text typed there; none when the box is not on screen (a dialog) or Claude draws
 *           its own (an inverse cell in it)
 */
export function caretSpot(lines, kind) {
  if (kind === 'shell') {
    const i = promptLine(lines)
    if (i < 0) return null
    const text = plainText(lines[i])
    return { line: i, col: width(text.trimEnd()) + (/\s$/.test(text) ? 1 : 0) }
  }
  if (kind !== 'claude') return null
  for (let i = lines.length - 1; i > 0; i--) {
    const text = plainText(lines[i])
    if (!text.trimStart().startsWith('❯') || !RULE.test(plainText(lines[i - 1]))) continue
    let last = i
    for (let j = i + 1; j < lines.length && !RULE.test(plainText(lines[j])); j++) if (plainText(lines[j]).trim()) last = j
    if ([...Array(last - i + 1).keys()].some(k => parseLine(lines[i + k]).some(r => r.style.inverse))) return null
    const own = plainText(lines[last])
    const min = last === i ? text.indexOf('❯') + 2 : 0
    return { line: last, col: Math.max(min, width(own.trimEnd())) }
  }
  return null
}
