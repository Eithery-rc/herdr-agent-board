// The "install" action: puts the `board` command on PATH (~/.local/bin, a sh script for Git Bash
// and a .cmd for PowerShell) and registers the SessionStart / UserPromptSubmit hooks in
// ~/.claude/settings.json. Idempotent; replaces its own earlier entries and keeps a backup of
// settings.json next to it. Run it again after moving the plugin.
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { ROOT } from './paths.mjs'

const settingsFile = join(homedir(), '.claude', 'settings.json')
const binDir = join(homedir(), '.local', 'bin')
const cli = join(ROOT, 'src', 'cli.mjs')
const hook = join(ROOT, 'src', 'hook.mjs')
const statusline = join(ROOT, 'src', 'statusline.mjs')

// --- board command
mkdirSync(binDir, { recursive: true })
const shims = {
  board: `#!/bin/sh\n# agent-board\nexec node "${cli.replace(/\\/g, '/')}" "$@"\n`,
  'board.cmd': `@rem agent-board\r\n@node "${cli}" %*\r\n`,
}
for (const [name, body] of Object.entries(shims)) {
  const file = join(binDir, name)
  if (existsSync(file) && !readFileSync(file, 'utf8').includes('agent-board')) {
    console.log(`skipped ${file}: exists and is not ours`)
    continue
  }
  writeFileSync(file, body, { mode: 0o755 })
}

// --- hooks
const settings = existsSync(settingsFile) ? JSON.parse(readFileSync(settingsFile, 'utf8')) : {}
if (existsSync(settingsFile)) copyFileSync(settingsFile, `${settingsFile}.bak-agent-board`)
settings.hooks ??= {}
const ours = command => /agent-board.*hook\.mjs/.test(command ?? '')
function put(event) {
  const list = (settings.hooks[event] ??= [])
  for (const entry of list) entry.hooks = (entry.hooks ?? []).filter(h => !ours(h.command))
  settings.hooks[event] = list.filter(entry => entry.hooks.length)
  settings.hooks[event].push({ hooks: [{ type: 'command', command: `node "${hook}"`, timeout: 10 }] })
}
put('SessionStart')
put('UserPromptSubmit')

// --- status line: Claude Code's own numbers for the board (usage windows, context fill). A status
// line someone else set stays; the board then reads the usagebar cache, if there is one.
const ourLine = command => /agent-board.*statusline\.mjs/.test(command ?? '')
if (!settings.statusLine || ourLine(settings.statusLine.command)) {
  settings.statusLine = { type: 'command', command: `node "${statusline.replace(/\\/g, '/')}"` }
  console.log(`status line: ${statusline}`)
} else console.log('status line: left as it was (not ours)')
writeFileSync(settingsFile, `${JSON.stringify(settings, null, 2)}\n`)

console.log(`board command: ${join(binDir, 'board')} (+ board.cmd)`)
console.log(`hooks: SessionStart, UserPromptSubmit -> ${hook} in ${settingsFile}`)
