// A selected session's read-only detail request. Old replies never replace a
// new selection or resurrect a session removed by a newer board snapshot.
export function detailResource({ read, changed, now = Date.now, timeoutMs = 15_000 }) {
  let value = { key: null, data: null, status: 'idle', error: '', at: null }
  let epoch = 0, pending = null
  const notify = () => changed({ ...value })
  function cancel() { ++epoch; pending?.controller.abort(); clearTimeout(pending?.timer); pending = null }
  return {
    snapshot: () => ({ ...value }),
    reset(key) { cancel(); value = { key, data: null, status: 'idle', error: '', at: null } },
    cancel,
    missing() {
      if (value.status === 'missing') return
      cancel(); value = { ...value, status: 'missing', error: '' }; notify()
    },
    load(key) {
      if (value.key !== key) { cancel(); value = { key, data: null, status: 'idle', error: '', at: null } }
      if (pending) return pending.promise
      const id = ++epoch, controller = new AbortController()
      value = { ...value, status: 'loading', error: '' }
      notify()
      let timer
      const timeout = new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error('Request timed out')) }, timeoutMs) })
      const promise = Promise.race([Promise.resolve().then(() => read(key, controller.signal)), timeout]).then(data => {
        if (id !== epoch) return
        value = { key, data, status: 'ready', error: '', at: now() }
      }, error => {
        if (id !== epoch) return
        value = { ...value, status: error.missing ? 'missing' : 'error', error: error.message || String(error) }
      }).finally(() => { clearTimeout(timer); if (id === epoch) { pending = null; notify() } })
      pending = { controller, promise, timer }
      return promise
    },
  }
}
