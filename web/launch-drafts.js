// A launch draft is one whole form, scoped to the place that opened it. Nothing
// is persisted to disk or sent by restoring it; drafts live in this page for ten minutes.
export function launchContext(ctx, filter = 'all') {
  let path = String(ctx.item?.cwd ?? ctx.cwd ?? '').trim().replace(/\\/g, '/').replace(/\/+$/, '')
  if (/^[A-Za-z]:\//.test(path) || path.startsWith('//')) path = path.toLowerCase()
  return JSON.stringify([path, ctx.item?.category ?? ctx.category ?? (filter === 'all' ? '' : filter), !!ctx.newWorkspace])
}

export function launchDraftBook({ now = Date.now, lifetime = 600_000, limit = 20 } = {}) {
  const entries = new Map()
  let serial = 0
  function prune() {
    for (const [key, entry] of entries) if (now() - entry.at >= lifetime) entries.delete(key)
    while (entries.size > limit) entries.delete(entries.keys().next().value)
  }
  return {
    read(key) {
      prune()
      const entry = entries.get(key)
      return entry ? structuredClone(entry.form) : null
    },
    write(key, form) {
      prune()
      const previous = entries.get(key)
      const version = previous && JSON.stringify(previous.form) === JSON.stringify(form) ? previous.version : ++serial
      entries.delete(key)
      entries.set(key, { form: structuredClone(form), at: now(), version })
      prune()
      return version
    },
    clear(key, version) {
      if (entries.get(key)?.version === version) entries.delete(key)
    },
  }
}
