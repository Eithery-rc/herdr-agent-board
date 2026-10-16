// Keys for the board's terminal, both ends. The page turns a browser key into a step (a key herdr
// knows by name, or text); the server checks every step again and turns them into herdr calls:
// `pane send-keys` for named keys, `pane send-text` for text and for the keys herdr has no name
// for (Home, End, Page Up and Down, Delete, Insert, and arrows with two modifiers), which go as
// the escape sequences a terminal sends for them.

// Keys herdr takes by name (herdr 0.9), modifiers apart.
const NAMED = new Set(['enter', 'esc', 'tab', 'backspace', 'space', 'up', 'down', 'left', 'right', ...Array.from({ length: 12 }, (_, i) => `f${i + 1}`)])
// Keys herdr has no name for: their sequence, and the final byte that takes the modifier.
const SEQUENCES = {
  home: ['\x1b[H', 'H'],
  end: ['\x1b[F', 'F'],
  insert: ['\x1b[2~', '2~'],
  delete: ['\x1b[3~', '3~'],
  pageup: ['\x1b[5~', '5~'],
  pagedown: ['\x1b[6~', '6~'],
}
const ARROWS = { up: 'A', down: 'B', right: 'C', left: 'D' }
const MODS = ['ctrl', 'alt', 'shift']
// A character a modifier can go with: letters, digits and the punctuation of a US keyboard.
const CHAR = /^[a-z0-9`\-=[\]\\;',./]$/
export const MAX_STEPS = 256
export const MAX_TEXT = 16_384

const BROWSER_KEYS = {
  Enter: 'enter', Escape: 'esc', Tab: 'tab', Backspace: 'backspace',
  ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right',
  Home: 'home', End: 'end', PageUp: 'pageup', PageDown: 'pagedown', Delete: 'delete', Insert: 'insert',
}
// F11 and F12 stay the browser's (full screen, the inspector).
for (let i = 1; i <= 10; i++) BROWSER_KEYS[`F${i}`] = `f${i}`

/**
 * What a key pressed in the terminal does: { key } (a herdr key name, modifiers first),
 * { leave: true } (Ctrl+]: the focus leaves the terminal), { copy: true } (Ctrl+C or Ctrl+Shift+C
 * with text selected), or null: the browser keeps it (typing and pasting arrive as input and
 * paste events, Cmd shortcuts, keys a terminal has no use for). `selection`: text is selected.
 */
export function keyStep(e, { selection = false } = {}) {
  if (e.isComposing || e.key === 'Process' || e.key === 'Dead' || e.metaKey) return null
  // A letter key: by its character on a Latin layout (Ctrl+Z on a German one is its own Z), by
  // its place on another script's (Ctrl+С on a Russian layout is Ctrl+C).
  const own = /^[a-z]$/i.test(e.key ?? '') ? e.key.toLowerCase() : null
  const letter = own ?? /^Key([A-Z])$/.exec(e.code ?? '')?.[1]?.toLowerCase()
  if (e.ctrlKey && !e.altKey) {
    if (e.code === 'BracketRight') return { leave: true }
    if (letter === 'c' && (selection || e.shiftKey)) return { copy: true }
    if (letter === 'v' || (e.shiftKey && letter === 'c')) return null // paste: the paste event
    if (e.key === 'Insert' || e.key === 'Shift') return null
  }
  if (e.shiftKey && e.key === 'Insert') return null // paste
  // AltGr types a character (Ctrl+Alt on Windows): it comes as input. A letter of the layout
  // with Ctrl+Alt is a key, Ctrl+Alt+Ф as much as Ctrl+Alt+A.
  if (e.getModifierState?.('AltGraph') || (e.ctrlKey && e.altKey && e.key?.length === 1 && e.key.toLowerCase() !== letter && !/\p{L}/u.test(e.key))) return null
  const mods = [e.ctrlKey && 'ctrl', e.altKey && 'alt', e.shiftKey && 'shift'].filter(Boolean)
  const named = BROWSER_KEYS[e.key]
  if (named) {
    // Shift alone with a character key is that character; with these keys it counts.
    return { key: [...mods, named].join('+') }
  }
  if (e.key === ' ' && e.ctrlKey) return { key: 'ctrl+space' }
  if (!e.ctrlKey && !e.altKey) return null // a character: the input event types it
  // Ctrl or Alt with a character key: a letter as above, anything else by its character.
  const ch = letter ?? (e.key?.length === 1 ? e.key.toLowerCase() : null)
  if (!ch || !CHAR.test(ch)) return null
  return { key: [...mods.filter(m => m !== 'shift' || !letter), ch].join('+') }
}

/** Text typed or pasted, as steps: lines go with an Enter between them; control characters go. */
export function textSteps(text) {
  const steps = []
  const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n')
  lines.forEach((line, i) => {
    if (i) steps.push({ key: 'enter' })
    const clean = cleanText(line)
    if (clean) steps.push({ text: clean })
  })
  return steps
}

/** Text without control characters (C0 but tab, DEL, C1). */
export const cleanText = s => String(s ?? '').replace(/[\x00-\x08\x0a-\x1f\x7f-\x9f]/g, '')

/** Steps put together: neighbouring texts into one, neighbouring keys into one call's worth. */
export function mergeSteps(steps) {
  const out = []
  for (const s of steps) {
    const last = out.at(-1)
    if (s.text != null && last?.text != null) last.text += s.text
    else if (s.key && last?.keys) last.keys.push(s.key)
    else out.push(s.text != null ? { text: s.text } : { keys: [s.key] })
  }
  return out.map(s => (s.keys ? s.keys.map(key => ({ key })) : [s])).flat()
}

/** A key name split: { mods: ['ctrl', ...], base }, or null when it is not one the board sends. */
export function splitKey(name) {
  const parts = String(name ?? '').split('+')
  const base = parts.pop()
  const mods = parts
  // Modifiers once each, in the order ctrl, alt, shift.
  if (!base || mods.join('+') !== MODS.filter(m => mods.includes(m)).join('+')) return null
  if (NAMED.has(base) || Object.hasOwn(SEQUENCES, base)) return { mods, base }
  // A character goes with Ctrl or Alt (Shift alone types it).
  if (CHAR.test(base) && mods.length && !(mods.length === 1 && mods[0] === 'shift')) return { mods, base }
  return null
}

/** The xterm modifier parameter: 1 + shift + 2·alt + 4·ctrl. */
const modParam = mods => 1 + (mods.includes('shift') ? 1 : 0) + (mods.includes('alt') ? 2 : 0) + (mods.includes('ctrl') ? 4 : 0)

/** How one key goes to herdr: { keys: [name] } or { text: sequence }. */
export function keyCall(name) {
  const k = splitKey(name)
  if (!k) return null
  const seq = Object.hasOwn(SEQUENCES, k.base) ? SEQUENCES[k.base] : null
  if (seq) {
    if (!k.mods.length) return { text: seq[0] }
    const [, fin] = seq
    return { text: fin === 'H' || fin === 'F' ? `\x1b[1;${modParam(k.mods)}${fin}` : `\x1b[${fin[0]};${modParam(k.mods)}~` }
  }
  // herdr names arrows with one modifier; two or more go as the sequence.
  if (Object.hasOwn(ARROWS, k.base) && k.mods.length > 1) return { text: `\x1b[1;${modParam(k.mods)}${ARROWS[k.base]}` }
  return { keys: [name] }
}

/**
 * The steps of an input request checked and turned into herdr calls, in order:
 * [{ keys: [...] } | { text }]. { error } when any step is not one the board sends: nothing of a
 * request that fails goes. Dashes a text starts with go as keys, so the text never reads as an
 * option to herdr's command line.
 */
export function herdrCalls(steps) {
  if (!Array.isArray(steps) || !steps.length) return { error: 'empty' }
  if (steps.length > MAX_STEPS) return { error: 'too many' }
  let size = 0
  const calls = []
  const add = call => {
    const last = calls.at(-1)
    if (call.keys && last?.keys) last.keys.push(...call.keys)
    else if (call.text != null && last?.text != null) last.text += call.text
    else calls.push(call.keys ? { keys: [...call.keys] } : { text: call.text })
  }
  for (const s of steps) {
    let call
    if (s && typeof s.text === 'string' && s.key == null) {
      const text = cleanText(s.text)
      size += text.length
      if (!text) continue
      call = { text }
    } else if (s && typeof s.key === 'string' && s.text == null) {
      call = keyCall(s.key)
      if (!Array.isArray(call?.keys) && typeof call?.text !== 'string') return { error: 'key' }
    } else return { error: 'step' }
    if (size > MAX_TEXT) return { error: 'too long' }
    add(call)
  }
  // Text after text is one call by now: only where a call starts can a dash be read as an option.
  const out = []
  for (const c of calls) {
    const dashes = c.text?.match(/^-+/)?.[0]
    if (!dashes) {
      out.push(c)
      continue
    }
    const keys = [...dashes].map(() => '-')
    if (out.at(-1)?.keys) out.at(-1).keys.push(...keys)
    else out.push({ keys })
    if (c.text.length > dashes.length) out.push({ text: c.text.slice(dashes.length) })
  }
  return { calls: out }
}
