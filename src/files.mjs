// Local files and folders the chat mentions: what a path is, a preview of it, and opening it
// with the system. Paths come as agents write them: absolute, herdr-reveal: or file: links,
// ~/..., or relative to the session's folder, with an optional :line(:column).
// Only the board's own page reaches this: its POSTs carry the X-Board header, and raw bytes
// (for <img>, <video>, the PDF viewer) need FILE_TOKEN, which only that page can read.
import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { closeSync, openSync, readdirSync, readSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, extname, isAbsolute, resolve } from 'node:path'

export const FILE_TOKEN = randomBytes(18).toString('base64url')

const TEXT_LIMIT = 512 << 10 // bytes of a text file shown
const LINE_LIMIT = 5000
const CSV_ROWS = 300
const DIR_LIMIT = 1000

const EXT = {
  image: 'png jpg jpeg gif webp bmp ico svg avif',
  pdf: 'pdf',
  video: 'mp4 webm m4v mov ogv',
  audio: 'mp3 wav ogg oga m4a flac aac opus',
  markdown: 'md markdown mdx',
  json: 'json jsonc webmanifest',
  csv: 'csv tsv',
  text:
    'txt log text ini cfg conf toml yaml yml xml html htm css scss less js mjs cjs jsx ts tsx mts cts vue svelte py rb go rs java kt kts swift c h cc cpp hpp cs fs vb php pl lua r sql sh bash zsh fish ps1 psm1 psd1 bat cmd gradle properties env gitignore gitattributes editorconfig dockerfile makefile lock jsonl ndjson diff patch srt vtt rst tex bib graphql proto',
}
const KIND_OF = new Map(Object.entries(EXT).flatMap(([kind, list]) => list.split(' ').map(e => [e, kind])))
const NAMED = new Set(['dockerfile', 'makefile', 'license', 'readme', 'changelog', 'procfile', 'gemfile', 'rakefile'])

export const MEDIA_TYPES = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp',
  ico: 'image/x-icon', svg: 'image/svg+xml', avif: 'image/avif', pdf: 'application/pdf',
  mp4: 'video/mp4', m4v: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', ogv: 'video/ogg',
  mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', oga: 'audio/ogg', m4a: 'audio/mp4', flac: 'audio/flac', aac: 'audio/aac', opus: 'audio/ogg',
}

const ext = p => extname(p).slice(1).toLowerCase()

/** What a file is by its name: image, pdf, video, audio, markdown, json, csv, text, or file (unknown). */
export function kindOf(path) {
  const e = ext(path)
  if (KIND_OF.has(e)) return KIND_OF.get(e)
  return NAMED.has(basename(path).toLowerCase()) ? 'text' : 'file'
}

/**
 * A path as an agent wrote it to { path, line }, absolute: herdr-reveal: / file: prefixes and
 * %-escapes off, ~ expanded, relative ones resolved against the session's folder, :line(:col) split off.
 */
export function resolvePath(raw, cwd = '') {
  let p = String(raw ?? '').trim().replace(/^["'`]|["'`]$/g, '')
  if (/^herdr-reveal:/i.test(p) || /^file:/i.test(p)) {
    // file:///work/x keeps its root slash; file:///C:/x loses it below.
    p = p.replace(/^herdr-reveal:/i, '').replace(/^file:(\/\/)?/i, '')
    try {
      p = decodeURIComponent(p)
    } catch {}
    if (/^\/[A-Za-z]:[\\/]/.test(p)) p = p.slice(1) // file:///C:/x
  }
  let line = null
  const m = /^(.*?[^:]):(\d+)(?::\d+)?$/.exec(p)
  if (m && !/^[A-Za-z]$/.test(m[1])) {
    p = m[1]
    line = Number(m[2])
  }
  if (/^~(?=$|[\\/])/.test(p)) p = homedir() + p.slice(1)
  if (!p) return { path: '', line }
  if (!isAbsolute(p)) {
    if (!cwd) return { path: '', line }
    p = resolve(cwd, p)
  } else p = resolve(p)
  return { path: p, line }
}

/** What is at `path`: { path, name, exists, dir, size, mtime, kind }. */
export function describe(path) {
  const name = basename(path) || path
  const st = path ? statSync(path, { throwIfNoEntry: false }) : null
  if (!st) return { path, name, exists: false }
  const dir = st.isDirectory()
  return { path, name, exists: true, dir, size: dir ? null : st.size, mtime: st.mtimeMs, kind: dir ? 'dir' : kindOf(path) }
}

/** The first `limit` bytes of a file and whether there was more. */
function head(path, size, limit) {
  const n = Math.min(size, limit)
  const buf = Buffer.alloc(n)
  const fd = openSync(path, 'r')
  try {
    let got = 0
    while (got < n) {
      const r = readSync(fd, buf, got, n - got, got)
      if (!r) break
      got += r
    }
    return { buf: buf.subarray(0, got), cut: size > limit }
  } finally {
    closeSync(fd)
  }
}

/** Bytes to text, or null for binary: BOMs honored, NUL bytes mean binary. */
function decode(buf) {
  if (buf[0] === 0xff && buf[1] === 0xfe) return new TextDecoder('utf-16le').decode(buf.subarray(2))
  if (buf[0] === 0xfe && buf[1] === 0xff) return new TextDecoder('utf-16be').decode(buf.subarray(2))
  const sample = buf.subarray(0, 8192)
  if (sample.includes(0)) return null
  return new TextDecoder('utf-8').decode(buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf ? buf.subarray(3) : buf)
}

/** Simple CSV/TSV: quoted fields with "" escapes and line breaks inside quotes. */
export function parseCsv(text, sep = ',', maxRows = CSV_ROWS) {
  const rows = []
  let row = []
  let field = ''
  let quoted = false
  for (let i = 0; i < text.length && rows.length < maxRows; i++) {
    const c = text[i]
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"'
        i++
      } else if (c === '"') quoted = false
      else field += c
    } else if (c === '"' && field === '') quoted = true
    else if (c === sep) {
      row.push(field)
      field = ''
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++
      row.push(field)
      rows.push(row)
      row = []
      field = ''
    } else field += c
  }
  if ((field || row.length) && rows.length < maxRows) rows.push([...row, field])
  return rows
}

/**
 * A preview of a file or folder for the board's quick look:
 *   folder: entries (folders first), each { name, dir, size, mtime, kind }
 *   markdown, json, csv, text: the text (cut at TEXT_LIMIT bytes / LINE_LIMIT lines), csv also rows
 *   image, pdf, video, audio: metadata; the bytes come from /api/fs/raw
 *   file: metadata only (binary or unknown)
 */
export function preview(path) {
  const info = describe(path)
  if (!info.exists) return { ...info, error: 'missing' }
  if (info.dir) {
    let dirents = []
    try {
      dirents = readdirSync(path, { withFileTypes: true })
    } catch (err) {
      return { ...info, error: err.code === 'EPERM' || err.code === 'EACCES' ? 'denied' : err.message }
    }
    dirents.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }))
    const entries = dirents.slice(0, DIR_LIMIT).map(d => {
      const full = resolve(path, d.name)
      const st = statSync(full, { throwIfNoEntry: false })
      const dir = st ? st.isDirectory() : d.isDirectory()
      return { name: d.name, dir, size: dir || !st ? null : st.size, mtime: st?.mtimeMs ?? null, kind: dir ? 'dir' : kindOf(d.name) }
    })
    return { ...info, entries, total: dirents.length }
  }
  if (['image', 'pdf', 'video', 'audio'].includes(info.kind)) return info
  let read
  try {
    read = head(path, info.size, TEXT_LIMIT)
  } catch (err) {
    return { ...info, error: err.code === 'EPERM' || err.code === 'EACCES' || err.code === 'EBUSY' ? 'denied' : err.message }
  }
  let text = decode(read.buf)
  if (text === null) return { ...info, kind: info.kind === 'file' ? 'file' : 'binary' }
  let cut = read.cut
  const lines = text.split('\n')
  if (lines.length > 1 && lines.at(-1) === '') lines.pop() // a final line break ends the last line, it starts none
  if (lines.length > LINE_LIMIT) {
    text = lines.slice(0, LINE_LIMIT).join('\n')
    cut = true
  }
  const kind = info.kind === 'file' ? 'text' : info.kind
  const out = { ...info, kind, text, truncated: cut, lines: Math.min(lines.length, LINE_LIMIT) }
  if (kind === 'json' && !cut) {
    try {
      out.text = JSON.stringify(JSON.parse(text), null, 2)
    } catch {}
  }
  if (kind === 'csv') out.rows = parseCsv(text, ext(path) === 'tsv' ? '\t' : ',')
  return out
}

/** The system command that opens a file or folder (how: open) or shows it in its folder (reveal), or opens a URL. */
export function openCommand(target, how = 'open', platform = process.platform) {
  if (platform === 'win32') return how === 'reveal' ? ['explorer.exe', [`/select,${target}`]] : ['explorer.exe', [target]]
  if (platform === 'darwin') return how === 'reveal' ? ['open', ['-R', target]] : ['open', [target]]
  return ['xdg-open', [how === 'reveal' ? dirname(target) : target]]
}

/** Run openCommand; resolves when it started. explorer.exe exits 1 even when it worked, so its code is ignored. */
export function openWith(target, how = 'open') {
  const [cmd, args] = openCommand(target, how)
  return new Promise(res => {
    const child = execFile(cmd, args, { windowsHide: false }, () => {})
    child.once('error', err => res({ ok: false, error: err.message }))
    child.once('spawn', () => res({ ok: true }))
  })
}
