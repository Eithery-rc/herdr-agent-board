// Text drafts belong to a stable Claude session, not to the pane occupying the screen.
export function draftBook(storage) {
  const prefix = 'board.draft.'
  return {
    read(session) {
      if (!session) return null
      try {
        const value = JSON.parse(storage.getItem(prefix + session))
        return value && typeof value.text === 'string' && typeof value.id === 'string' ? value : null
      } catch { return null }
    },
    save(session, text) {
      if (!session) return null
      const draft = { text, id: crypto.randomUUID() }
      try { storage.setItem(prefix + session, JSON.stringify(draft)) } catch {}
      return draft
    },
    clear(session, expectedId) {
      if (!session) return
      const value = this.read(session)
      if (expectedId && value?.id !== expectedId) return
      try { storage.removeItem(prefix + session) } catch {}
    },
  }
}
