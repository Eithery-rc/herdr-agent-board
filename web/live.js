// Transport connectivity alone does not mean Herdr data is fresh.
export function updateLive(element, data) {
  const fresh = data.stale === false && data.lastSuccessfulRefreshAt != null
  element.classList.toggle('on', fresh)
  element.classList.toggle('stale', !fresh)
  element.title = fresh ? 'Живые данные' : data.lastSuccessfulRefreshAt == null
    ? 'Ожидаю первые данные от Herdr'
    : `Данные устарели. Последнее обновление: ${new Date(data.lastSuccessfulRefreshAt).toLocaleTimeString('ru-RU')}`
}
