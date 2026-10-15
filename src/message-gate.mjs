// One in-flight message per session. Successful request IDs suppress HTTP replays
// within this server process; this does not make Herdr get/prompt atomic.
import { t } from './lang.mjs'

export function messageGate() {
  const pending = new Map()
  const completed = new Map()
  return async (key, id, payload, action) => {
    if (typeof id !== 'string' || !/^[a-zA-Z0-9-]{1,80}$/.test(id)) return { ok: false, error: t('err.msg.id') }
    const token = `${key}:${id}`
    const signature = JSON.stringify(payload)
    const previous = completed.get(token) ?? pending.get(key)
    if (previous) {
      if (previous.token !== token || previous.signature !== signature) return { ok: false, error: t('err.msg.busy') }
      return previous.result ?? previous.promise
    }
    const entry = { token, signature }
    // Install the entry before invoking asynchronous work.
    pending.set(key, entry)
    entry.promise = Promise.resolve().then(action)
    try {
      const result = await entry.promise
      if (result.ok) {
        completed.set(token, { ...entry, result })
        if (completed.size > 500) completed.delete(completed.keys().next().value)
      }
      return result
    } finally { pending.delete(key) }
  }
}
