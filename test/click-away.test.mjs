import assert from 'node:assert/strict'
import test from 'node:test'
import { outsidePanelPress, panelPress } from '../web/click-away.js'

const event = (target, path, x = 10, y = 20) => ({ button: 0, target, composedPath: () => path, clientX: x, clientY: y })
test('an inside press stays inside after a handler replaces and detaches its DOM', () => {
  const root = { matches: selector => selector === '.ql' }
  const chip = { closest: () => root }
  const press = panelPress(event(chip, [chip, root]), '.ql')
  chip.closest = () => null // opening the file replaced the history results
  assert.equal(outsidePanelPress(press, event(chip, [chip]), '.ql'), false)
})
test('only a genuine outside click closes; selection, a menu dismissal and protected click paths stay', () => {
  const blank = { closest: () => null }
  const click = event(blank, [blank])
  assert.equal(outsidePanelPress(panelPress(click, '.ql'), click, '.ql'), true)
  assert.equal(outsidePanelPress(panelPress(click, '.ql', true), click, '.ql'), false)
  assert.equal(outsidePanelPress(panelPress(click, '.ql'), event(blank, [blank], 30, 20), '.ql'), false)
  const root = { matches: () => true }
  assert.equal(outsidePanelPress(panelPress(click, '.ql'), event(blank, [blank, root]), '.ql'), false)
  assert.equal(outsidePanelPress(panelPress({ ...click, button: 2 }, '.ql'), click, '.ql'), false)
})
