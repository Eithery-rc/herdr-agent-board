import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { sandbox } from './fixtures/sandbox.mjs'

for (const background of [false, true]) {
  for (const existing of [false, true]) {
    for (const result of ['ok', 'error', 'missing-pane']) {
      test(`open: existing=${existing}, background=${background}, result=${result}`, { timeout: 10_000 }, async t => {
        const box = sandbox(t)
        const stateDir = join(box.env.LOCALAPPDATA, 'herdr/plugins/agent-board')
        mkdirSync(stateDir, { recursive: true })
        writeFileSync(join(stateDir, 'board.json'), JSON.stringify({ pane: 'gone' }))
        box.state({
          'api snapshot': { result: { snapshot: {
            panes: [], workspaces: existing ? [{ label: 'Board', workspace_id: 'w1' }] : [],
            tabs: [{ tab_id: 'user-tab', workspace_id: 'w1' }, { tab_id: 'other-user-tab', workspace_id: 'w1' }],
          } } },
          'workspace create': { result: { workspace: { workspace_id: 'w1' }, tab: { tab_id: 'initial-shell' } } },
          'plugin pane open': result === 'error' ? { error: 'open failed' } : { result: result === 'ok' ? { plugin_pane: { pane: { pane_id: 'new-board' } } } : {} },
          'tab close': { result: {} }, 'pane zoom': { result: {} },
        })
        const out = await box.open(background).exited
        assert.equal(out.code, result === 'error' ? 1 : 0, out.stderr)
        const closes = box.calls().filter(a => a[0] === 'tab' && a[1] === 'close')
        assert.deepEqual(closes, !existing && result === 'ok' ? [['tab', 'close', 'initial-shell']] : [])
        if (closes.length) {
          const calls = box.calls()
          assert.ok(calls.findIndex(a => a[2] === 'open') < calls.findIndex(a => a[1] === 'close'))
        }
      })
    }
  }
}
