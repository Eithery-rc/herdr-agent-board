// Git output for the quick look's Changes view: `git status --porcelain=v1` and a unified
// `git diff` read into files, lines and counts. Used by the page and by the tests.

const STATUS = { M: 'M', T: 'M', A: 'A', D: 'D', R: 'R', C: 'A', U: 'U' }

/** Porcelain v1 lines to [{ path, from, code }]; code is M, A, D, R, U or ?? (untracked). */
export function parseStatus(text) {
  const out = []
  for (const line of String(text ?? '').split('\n')) {
    if (line.length < 4) continue
    const xy = line.slice(0, 2)
    let path = line.slice(3)
    let from = null
    const arrow = path.indexOf(' -> ')
    if (arrow >= 0) {
      from = unquote(path.slice(0, arrow))
      path = path.slice(arrow + 4)
    }
    path = unquote(path)
    const code = xy === '??' ? '??' : xy.includes('U') || xy === 'AA' || xy === 'DD' ? 'U' : (STATUS[xy[0]] ?? STATUS[xy[1]] ?? 'M')
    out.push({ path, from, code })
  }
  return out
}

/** Git quotes paths with unusual characters: "a\tb.txt", octal escapes for UTF-8 bytes. */
function unquote(p) {
  if (!p.startsWith('"') || !p.endsWith('"')) return p
  const bytes = []
  const s = p.slice(1, -1)
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== '\\') {
      bytes.push(...new TextEncoder().encode(s[i]))
      continue
    }
    const next = s[++i]
    if (/[0-7]/.test(next)) {
      bytes.push(parseInt(s.slice(i, i + 3), 8))
      i += 2
    } else bytes.push(({ n: 10, t: 9, '"': 34, '\\': 92 })[next] ?? next.charCodeAt(0))
  }
  return new TextDecoder().decode(new Uint8Array(bytes))
}

/**
 * A unified diff to [{ path, from, binary, added, removed, lines }]; a line is
 * { kind: hunk | add | del | ctx | note, old, new, text } with the line numbers on each side.
 */
export function parseDiff(text) {
  const files = []
  let f = null
  let o = 0
  let n = 0
  for (const line of String(text ?? '').split('\n')) {
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git "?a\/(.+?)"? "?b\/(.+?)"?$/.exec(line)
      f = { path: m ? unquote(`"${m[2]}"`) : line.slice(11), from: null, binary: false, added: 0, removed: 0, lines: [] }
      if (m && m[1] !== m[2]) f.from = unquote(`"${m[1]}"`)
      files.push(f)
      continue
    }
    if (!f) continue
    if (line.startsWith('Binary files')) {
      f.binary = true
      continue
    }
    if (!f.lines.length && /^(index |--- |\+\+\+ |new file mode|deleted file mode|old mode|new mode|similarity index|dissimilarity index|rename from|rename to|copy from|copy to)/.test(line)) continue
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(line)
    if (hunk) {
      o = Number(hunk[1])
      n = Number(hunk[2])
      f.lines.push({ kind: 'hunk', old: null, new: null, text: line })
    } else if (line.startsWith('+')) {
      f.lines.push({ kind: 'add', old: null, new: n++, text: line.slice(1) })
      f.added++
    } else if (line.startsWith('-')) {
      f.lines.push({ kind: 'del', old: o++, new: null, text: line.slice(1) })
      f.removed++
    } else if (line.startsWith(' ')) {
      f.lines.push({ kind: 'ctx', old: o++, new: n++, text: line.slice(1) })
    } else if (line.startsWith('\\')) {
      f.lines.push({ kind: 'note', old: null, new: null, text: line })
    }
  }
  return files
}

/** Status and diff together: every changed file once, in status order, with its diff when there is one. */
export function changedFiles(status, diff) {
  const blocks = new Map(parseDiff(diff).map(f => [f.path, f]))
  const out = parseStatus(status).map(s => ({ ...s, diff: blocks.get(s.path) ?? null }))
  for (const [path, block] of blocks) if (!out.some(f => f.path === path)) out.push({ path, from: block.from, code: 'M', diff: block })
  return out
}
