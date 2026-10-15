// Scheduled times in words, in the board's language (`t` from i18n.js): the clock on a card, the
// day headers of the schedule panel, "2 h 10 min" late. Shared by the web board, the terminal
// board and the scheduler's prompts.

const DAY = 86_400_000
const midnight = ms => {
  const d = new Date(ms)
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
}
/** Calendar days from `now` to `ms`: 0 today, 1 tomorrow, -1 yesterday. */
export const daysFrom = (ms, now = Date.now()) => Math.round((midnight(ms) - midnight(now)) / DAY)

export const timeOf = (ms, t) => new Date(ms).toLocaleTimeString(t.lang, { hour: 'numeric', minute: '2-digit' })

/** A length of time: "45 min", "2 h 10 min", "3 d 4 h". */
export function span(ms, t) {
  const min = Math.max(1, Math.round(ms / 60_000))
  if (min < 60) return t('ago.min', { n: min })
  const h = Math.floor(min / 60)
  if (h < 24) return [t('ago.h', { n: h }), min % 60 && t('ago.min', { n: min % 60 })].filter(Boolean).join(' ')
  const d = Math.floor(h / 24)
  return [t('ago.d', { n: d }), h % 24 && t('ago.h', { n: h % 24 })].filter(Boolean).join(' ')
}

/** As short as it gets, for a card: "15:30", "Fri 9:00", "20 Oct". */
export function shortWhen(ms, t, now = Date.now()) {
  const days = daysFrom(ms, now)
  if (days === 0) return timeOf(ms, t)
  const d = new Date(ms)
  if (Math.abs(days) < 7) return `${d.toLocaleDateString(t.lang, { weekday: 'short' })} ${timeOf(ms, t)}`
  return d.toLocaleDateString(t.lang, { day: 'numeric', month: 'short' })
}

/** For the start of a line: "завтра 9:00" -> "Завтра 9:00". */
export const capital = (s, t) => (s ? s[0].toLocaleUpperCase(t.lang) + s.slice(1) : s)

/** A day in words, as in a sentence: "today", "tomorrow", "Friday, 16 October". */
export function dayLabel(ms, t, now = Date.now()) {
  const days = daysFrom(ms, now)
  if (days === 0) return t('when.today')
  if (days === 1) return t('when.tomorrow')
  if (days === -1) return t('when.yesterday')
  const sameYear = new Date(ms).getFullYear() === new Date(now).getFullYear()
  return new Date(ms).toLocaleDateString(t.lang, { weekday: 'long', day: 'numeric', month: 'long', ...(sameYear ? {} : { year: 'numeric' }) })
}

/** A moment in words: "15:30" today, else "tomorrow 9:00", "Friday, 16 October 9:00". */
export function longWhen(ms, t, now = Date.now()) {
  return daysFrom(ms, now) === 0 ? timeOf(ms, t) : `${dayLabel(ms, t, now)} ${timeOf(ms, t)}`
}
