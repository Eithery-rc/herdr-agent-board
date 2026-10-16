import assert from 'node:assert/strict'
import test from 'node:test'
import { modalFocusManager } from '../web/modal-focus.js'

function fixture() {
  const handlers = {}
  const doc = { body: { children: [] }, activeElement: null, addEventListener: (name, fn) => handlers[name] = fn }
  function node(id, parent, { tabIndex = -1, disabled = false, hidden = false, inert = false } = {}) {
    const el = { id, parent, tabIndex, disabled, hidden, inert, isConnected: true, children: [],
      contains(child) { return child === this || this.children.some(x => x.contains(child)) },
      closest(selector) {
        for (let x = this; x; x = x.parent) {
          if (selector.includes('[inert]') && x.inert || selector.includes('[hidden]') && x.hidden) return x
        }
        return null
      },
      getClientRects() { return this.hidden ? [] : [{}] },
      querySelectorAll() { return this.children.flatMap(x => [x, ...x.querySelectorAll()]) },
      focus() { doc.activeElement = this },
    }
    if (parent) parent.children.push(el)
    else doc.body.children.push(el)
    return el
  }
  const make = modalFocusManager(doc)
  const key = (shiftKey = false) => { let prevented = false; handlers.keydown({ key: 'Tab', target: doc.activeElement, shiftKey, preventDefault: () => prevented = true }); return prevented }
  return { doc, handlers, node, make, key }
}

test('modal Tab wraps over visible enabled controls; background focus is brought back and origin restored', () => {
  const f = fixture()
  const page = f.node('page'), origin = f.node('origin', page, { tabIndex: 0 })
  const layer = f.node('dialog'), win = f.node('window', layer)
  const first = f.node('first', win, { tabIndex: 0 })
  f.node('disabled', win, { tabIndex: 0, disabled: true })
  f.node('hidden', win, { tabIndex: 0, hidden: true })
  const last = f.node('last', win, { tabIndex: 0 })
  const scope = f.make(layer, win)
  scope.open(origin)
  assert.equal(page.inert, true)
  assert.equal(f.key(), true)
  assert.equal(f.doc.activeElement, first)
  first.focus(); f.key(true)
  assert.equal(f.doc.activeElement, last)
  assert.equal(f.key(), true)
  assert.equal(f.doc.activeElement, first)
  origin.focus(); f.handlers.focusin({ target: origin })
  assert.equal(f.doc.activeElement, first)
  scope.close()
  assert.equal(page.inert, false)
  assert.equal(f.doc.activeElement, origin)
})

test('nested dialogs restore the lower scope and preserve pre-existing inert state', () => {
  const f = fixture()
  const background = f.node('background', null, { inert: true })
  const a = f.node('a'), aw = f.node('aw', a), button = f.node('button', aw, { tabIndex: 0 })
  const b = f.node('b'), bw = f.node('bw', b)
  const lower = f.make(a, aw), upper = f.make(b, bw)
  lower.open(); upper.open(button)
  assert.equal(a.inert, true)
  assert.equal(lower.isTop(), false)
  assert.equal(upper.isTop(), true)
  upper.close()
  assert.equal(a.inert, false)
  assert.equal(f.doc.activeElement, button)
  lower.close()
  assert.equal(background.inert, true)
})
