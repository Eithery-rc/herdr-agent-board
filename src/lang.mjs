// The board's language in this process. loadConfig() sets it from the config's `language`, so a
// switch on the web board reaches the terminal board, the server and the next brief at once.
import { LANGUAGE_NAMES, resolveLanguage, translator } from '../web/i18n.js'

let current = translator(resolveLanguage('auto'))
const listeners = new Set()

/** Text in the board's language: t('col.me'), t('sent.files', { n: 2 }). */
export const t = (key, vars) => current(key, vars)

export const lang = () => current.lang

/** For the brief: "English", "Russian". */
export const languageName = () => LANGUAGE_NAMES[current.lang] ?? 'English'

/** Switch to `pref` ("auto", "en", "ru"); returns the language now in use. */
export function useLanguage(pref) {
  const next = resolveLanguage(pref)
  if (next !== current.lang) {
    current = translator(next)
    for (const fn of listeners) fn(next)
  }
  return next
}

/** Runs `fn(lang)` after every switch (caches that hold translated text clear themselves). */
export function onLanguage(fn) {
  listeners.add(fn)
}
