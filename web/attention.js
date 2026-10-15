// Viewing is a browser-local receipt, never acceptance, a pin, or a Herdr state.
export const resultToken = item => JSON.stringify([item.activity ?? 0, item.result ?? '', item.lastText ?? ''])
export const unseenResult = (item, seen) => item.column === 'done' && !!(item.result || item.lastText) && seen[item.key] !== resultToken(item)
export const attentionTime = item => item.column === 'me' ? item.askSince || item.activity || null : null
export function nextAttention(items, current, seen) {
  const candidates = items.filter(item => item.column === 'me' || unseenResult(item, seen))
  if (!candidates.length) return null
  const index = candidates.findIndex(item => item.key === current)
  return candidates[(index + 1) % candidates.length].key
}
export function recordView(seen, item) {
  const next = { ...seen, [item.key]: resultToken(item) }
  // Bound storage even when sessions are no longer on the board.
  return Object.fromEntries(Object.entries(next).slice(-500))
}
