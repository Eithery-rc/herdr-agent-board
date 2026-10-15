import assert from 'node:assert/strict'
import { test } from 'node:test'
import { countRuns, nextRun, parseCron, parseDuration, parseWhen } from '../src/when.mjs'
import { translator } from '../web/i18n.js'
import { dayLabel, shortWhen, span } from '../web/when.js'

// Local time throughout: Thursday 15 October 2026, 14:00.
const now = new Date(2026, 9, 15, 14, 0).getTime()
const local = (...args) => new Date(...args).getTime()

test('durations: units, compounds and decimals', () => {
  assert.equal(parseDuration('30m'), 30 * 60e3)
  assert.equal(parseDuration('1h30m'), 90 * 60e3)
  assert.equal(parseDuration('1h 30 min'), 90 * 60e3)
  assert.equal(parseDuration('2 hours'), 2 * 3600e3)
  assert.equal(parseDuration('1.5h'), 90 * 60e3)
  assert.equal(parseDuration('2d'), 2 * 86400e3)
  assert.equal(parseDuration('45 seconds'), 45e3)
  assert.equal(parseDuration('3'), null)
  assert.equal(parseDuration('2h 3'), null)
  assert.equal(parseDuration('soon'), null)
})

test('one-off times: relative, time of day, days, weekdays, dates', () => {
  assert.equal(parseWhen('in 30m', now), now + 30 * 60e3)
  assert.equal(parseWhen('in 2h', now), now + 2 * 3600e3)
  assert.equal(parseWhen('+90 min', now), now + 90 * 60e3)
  // A time of day is its next occurrence.
  assert.equal(parseWhen('at 15:30', now), local(2026, 9, 15, 15, 30))
  assert.equal(parseWhen('15:30', now), local(2026, 9, 15, 15, 30))
  assert.equal(parseWhen('at 13:00', now), local(2026, 9, 16, 13, 0))
  assert.equal(parseWhen('at 3pm', now), local(2026, 9, 15, 15, 0))
  assert.equal(parseWhen('at 3 pm', now), local(2026, 9, 15, 15, 0))
  assert.equal(parseWhen('at 9', now), local(2026, 9, 16, 9, 0))
  assert.equal(parseWhen('tomorrow 9:00', now), local(2026, 9, 16, 9, 0))
  assert.equal(parseWhen('tomorrow at 9:15', now), local(2026, 9, 16, 9, 15))
  assert.equal(parseWhen('tomorrow', now), local(2026, 9, 16, 9, 0))
  // "today" is taken as written: the caller refuses a time that has passed.
  assert.equal(parseWhen('today 9:00', now), local(2026, 9, 15, 9, 0))
  assert.equal(parseWhen('fri 17:00', now), local(2026, 9, 16, 17, 0))
  assert.equal(parseWhen('friday', now), local(2026, 9, 16, 9, 0))
  assert.equal(parseWhen('next monday 9:00', now), local(2026, 9, 19, 9, 0))
  assert.equal(parseWhen('thu 15:00', now), local(2026, 9, 15, 15, 0))
  assert.equal(parseWhen('thu 13:00', now), local(2026, 9, 22, 13, 0))
  assert.equal(parseWhen('2026-10-20 14:00', now), local(2026, 9, 20, 14, 0))
  assert.equal(parseWhen('2026-10-20T14:00', now), local(2026, 9, 20, 14, 0))
  assert.equal(parseWhen('2026-10-20', now), local(2026, 9, 20, 9, 0))
  assert.equal(parseWhen('2026-10-20T14:00:00Z', now), Date.UTC(2026, 9, 20, 14, 0))
  assert.equal(parseWhen('2026-10-20T14:00+03:00', now), Date.UTC(2026, 9, 20, 11, 0))
})

test('one-off times: what is not a time', () => {
  for (const s of ['', 'soon', 'today', 'tomorrow 3', 'tomorrow 3 reports', 'in 2h 3', 'monthly', '2026-02-30 10:00', 'at 25:00', 'at 13pm', 'mon tue']) {
    assert.equal(parseWhen(s, now), null, s)
  }
})

test('cron: fields, ranges, steps, names and macros', () => {
  const c = parseCron('*/15 9-17 * jan-mar mon-fri')
  assert.deepEqual([...c.minute], [0, 15, 30, 45])
  assert.deepEqual([...c.hour], [9, 10, 11, 12, 13, 14, 15, 16, 17])
  assert.deepEqual([...c.month], [1, 2, 3])
  assert.deepEqual([...c.dow], [1, 2, 3, 4, 5])
  assert.deepEqual([...parseCron('5/20 * * * *').minute], [5, 25, 45])
  assert.deepEqual([...parseCron('0 0 * * 7').dow], [0])
  assert.deepEqual([...parseCron('0 0 * * 5-7').dow].sort(), [0, 5, 6])
  assert.equal(parseCron('@daily').expr, '@daily')
  assert.deepEqual([...parseCron('@hourly').minute], [0])
  for (const bad of ['* * *', '* * * * * *', '61 * * * *', '0 24 * * *', '0 9 * * 8', '5-1 * * * *', '0 9 * * foo', '*/0 * * * *', '0 9 32 * *', '@often']) {
    assert.throws(() => parseCron(bad), Error, bad)
  }
})

test('cron: next run', () => {
  assert.equal(nextRun('0 9 * * 1-5', now), local(2026, 9, 16, 9, 0))
  assert.equal(nextRun('0 9 * * 1-5', local(2026, 9, 16, 9, 0)), local(2026, 9, 19, 9, 0))
  assert.equal(nextRun('*/15 * * * *', now), local(2026, 9, 15, 14, 15))
  assert.equal(nextRun('* * * * *', now + 30_000), now + 60_000)
  assert.equal(nextRun('@daily', now), local(2026, 9, 16, 0, 0))
  assert.equal(nextRun('0 12 * * sun', now), local(2026, 9, 18, 12, 0))
  // Both days restricted: either one, as in cron.
  assert.equal(nextRun('30 8 1 * mon', now), local(2026, 9, 19, 8, 30))
  assert.equal(nextRun('0 0 29 2 *', now), local(2028, 1, 29, 0, 0))
  assert.equal(nextRun('0 0 30 2 *', now), null)
})

test('cron: runs stay in order and on their minute across a whole year, DST included', () => {
  for (const expr of ['30 2 * * *', '0 * * * *', '15 1,2,3 * * 0']) {
    const c = parseCron(expr)
    let at = local(2026, 0, 1)
    for (let i = 0; i < 400; i++) {
      const next = nextRun(c, at)
      assert.ok(next > at, `${expr} moves forward`)
      const d = new Date(next)
      assert.ok(c.minute.has(d.getMinutes()) && c.hour.has(d.getHours()) && d.getSeconds() === 0, `${expr}: ${d}`)
      at = next
    }
  }
})

test('cron: runs in a stretch of time', () => {
  assert.equal(countRuns('0 * * * *', local(2026, 9, 15, 11, 0), local(2026, 9, 15, 14, 0)), 4)
  assert.equal(countRuns('0 * * * *', local(2026, 9, 15, 11, 0), local(2026, 9, 15, 13, 59)), 3)
  assert.equal(countRuns('* * * * *', 0, now, 50), 50)
})

test('scheduled times in words', () => {
  const t = translator('en')
  assert.equal(span(45 * 60e3, t), '45 min')
  assert.equal(span(130 * 60e3, t), '2 h 10 min')
  assert.equal(span(3 * 86400e3 + 4 * 3600e3, t), '3 d 4 h')
  assert.equal(dayLabel(local(2026, 9, 16, 9, 0), t, now), 'Tomorrow')
  assert.equal(dayLabel(local(2026, 9, 15, 20, 0), t, now), 'Today')
  assert.match(shortWhen(local(2026, 9, 15, 15, 30), t, now), /^3:30\s?PM$/)
  assert.match(shortWhen(local(2026, 9, 16, 9, 0), t, now), /^Fri 9:00\s?AM$/)
  assert.match(shortWhen(local(2026, 10, 20, 9, 0), t, now), /Nov 20|20 Nov/)
  assert.equal(dayLabel(local(2026, 9, 16, 9, 0), translator('ru'), now), 'Завтра')
})

test('the brief tells agents about the schedule', async () => {
  const { brief, BRIEF_VERSION } = await import('../src/brief.mjs')
  const text = brief({ categories: [{ id: 'other', title: 'Other' }] }, null, 'C:\X')
  assert.match(text, /board remind <when> "<text>"/)
  assert.match(text, /board every "<cron, 5 fields>"/)
  assert.match(text, /CronCreate or ScheduleWakeup/)
  assert.ok(BRIEF_VERSION >= 3)
})
