// The dot in the toolbar. An open connection alone does not mean fresh herdr data: green only
// after a successful refresh; orange while waiting for the first one or after a failed one,
// with the time of the last good data. `t` is the page's translator (i18n.js).
export function updateLive(element, data, t) {
  const fresh = data.stale === false && data.lastSuccessfulRefreshAt != null
  element.classList.toggle('on', fresh)
  element.classList.toggle('stale', !fresh)
  element.title = fresh
    ? t('live.on')
    : data.lastSuccessfulRefreshAt == null
      ? t('live.waiting')
      : t('live.stale', { time: new Date(data.lastSuccessfulRefreshAt).toLocaleTimeString(t.lang) })
}
