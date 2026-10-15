// A small Markdown renderer for the thread: what agents actually write (headings, lists, tables,
// code, quotes, links, emphasis). Safe by construction: every piece of text is escaped first and
// only known tags are produced; links are http(s) or mailto only and open in a new tab.

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
const ITEM = /^(\s*)([-*+•]|\d+[.)])\s+(.*)$/
const FENCE = /^\s*(`{3,}|~{3,})\s*([\w+#.-]*)\s*$/
const RULE = /^\s*([-*_])(?:\s*\1){2,}\s*$/
const TABLE_SEP = /^\s*\|?\s*:?-{2,}:?\s*(?:\|\s*:?-{2,}:?\s*)*\|?\s*$/
const indentOf = l => l.match(/^\s*/)[0].replace(/\t/g, '  ').length

function safeUrl(u) {
  return /^(https?:\/\/|mailto:)/i.test(u)
}

/** Inline markup on one line of text. */
export function inline(text) {
  const codes = []
  let s = String(text ?? '').replace(/`([^`]+)`/g, (_, c) => `\u0000${codes.push(c) - 1}\u0000`)
  s = esc(s)
  // [text](url); local links (herdr-reveal:, file paths) keep only their text
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, t, u) => (safeUrl(u) ? `<a href="${u}" target="_blank" rel="noopener noreferrer">${t}</a>` : `<span class="local" title="${u}">${t}</span>`))
  s = s.replace(/(^|[\s(])(https?:\/\/[^\s<)]+[^\s<).,;:!?])/g, '$1<a href="$2" target="_blank" rel="noopener noreferrer">$2</a>')
  s = s.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>').replace(/(^|[^\w])__([^_]+)__(?!\w)/g, '$1<b>$2</b>')
  s = s.replace(/(^|[^*\w])\*([^*\s](?:[^*]*[^*\s])?)\*(?![*\w])/g, '$1<i>$2</i>')
  s = s.replace(/(^|[^_\w\\])_([^_\s](?:[^_]*[^_\s])?)_(?![_\w])/g, '$1<i>$2</i>')
  s = s.replace(/~~([^~]+)~~/g, '<s>$1</s>')
  return s.replace(/\u0000(\d+)\u0000/g, (_, n) => `<code>${esc(codes[n])}</code>`)
}

function startsBlock(lines, i) {
  const l = lines[i]
  return FENCE.test(l) || /^#{1,6}\s/.test(l) || RULE.test(l) || /^\s*>/.test(l) || ITEM.test(l) || (l.includes('|') && TABLE_SEP.test(lines[i + 1] ?? ''))
}

function list(lines, i) {
  const base = indentOf(lines[i])
  const ordered = /^\s*\d/.test(lines[i])
  const start = ordered ? parseInt(lines[i].trim(), 10) : 1
  let html = ordered ? `<ol${start !== 1 ? ` start="${start}"` : ''}>` : '<ul>'
  while (i < lines.length) {
    const l = lines[i]
    if (!l.trim()) {
      // A blank line inside a list: the list goes on if an item at this level follows.
      const next = lines[i + 1] ?? ''
      if (ITEM.test(next) && indentOf(next) >= base) {
        i++
        continue
      }
      break
    }
    const m = ITEM.exec(l)
    if (!m || indentOf(l) !== base) break
    const parts = [m[3]]
    let inner = ''
    i++
    while (i < lines.length && lines[i].trim() && indentOf(lines[i]) > base) {
      if (ITEM.test(lines[i])) {
        const [h, next] = list(lines, i)
        inner += h
        i = next
      } else parts.push(lines[i++].trim())
    }
    html += `<li>${parts.map(inline).join('<br>')}${inner}</li>`
  }
  return [`${html}${ordered ? '</ol>' : '</ul>'}`, i]
}

function table(lines, i) {
  const cells = l => l.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim())
  const head = cells(lines[i])
  const align = cells(lines[i + 1]).map(c => (c.startsWith(':') && c.endsWith(':') ? 'center' : c.endsWith(':') ? 'right' : ''))
  const at = k => (align[k] ? ` style="text-align:${align[k]}"` : '')
  i += 2
  const rows = []
  while (i < lines.length && lines[i].includes('|') && lines[i].trim()) rows.push(cells(lines[i++]))
  const thead = `<tr>${head.map((c, k) => `<th${at(k)}>${inline(c)}</th>`).join('')}</tr>`
  const tbody = rows.map(r => `<tr>${r.map((c, k) => `<td${at(k)}>${inline(c)}</td>`).join('')}</tr>`).join('')
  return [`<div class="table"><table><thead>${thead}</thead><tbody>${tbody}</tbody></table></div>`, i]
}

/** Markdown to HTML. */
export function markdown(src) {
  const lines = String(src ?? '').replace(/\r\n?/g, '\n').split('\n')
  let html = ''
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    if (!line.trim()) {
      i++
      continue
    }
    const fence = FENCE.exec(line)
    if (fence) {
      const body = []
      i++
      while (i < lines.length && !lines[i].trim().startsWith(fence[1])) body.push(lines[i++])
      i++
      html += `<pre><code>${esc(body.join('\n'))}</code></pre>`
      continue
    }
    const h = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line)
    if (h) {
      const level = Math.min(6, h[1].length + 2) // h3..h6: headings inside a bubble stay modest
      html += `<h${level}>${inline(h[2])}</h${level}>`
      i++
      continue
    }
    if (RULE.test(line)) {
      html += '<hr>'
      i++
      continue
    }
    if (line.includes('|') && TABLE_SEP.test(lines[i + 1] ?? '')) {
      const [t, next] = table(lines, i)
      html += t
      i = next
      continue
    }
    if (/^\s*>/.test(line)) {
      const quote = []
      while (i < lines.length && /^\s*>/.test(lines[i])) quote.push(lines[i++].replace(/^\s*>\s?/, ''))
      html += `<blockquote>${markdown(quote.join('\n'))}</blockquote>`
      continue
    }
    if (ITEM.test(line)) {
      const [l, next] = list(lines, i)
      html += l
      i = next
      continue
    }
    const para = [line]
    i++
    while (i < lines.length && lines[i].trim() && !startsBlock(lines, i)) para.push(lines[i++])
    html += `<p>${para.map(l => inline(l.trim())).join('<br>')}</p>`
  }
  return html
}
