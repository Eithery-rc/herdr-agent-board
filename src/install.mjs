// The "install" action: puts the `board` and `spawn-agent` commands on PATH (~/.local/bin, a sh
// script for Git Bash, Linux and macOS and a .cmd for PowerShell), registers the SessionStart /
// UserPromptSubmit hooks and the status line in ~/.claude/settings.json, then says what else is
// set up and what is not (setup.mjs). Idempotent; replaces its own earlier entries and keeps a
// backup of settings.json next to it. Run it again after moving or updating the plugin.
//
//   node src/install.mjs              the above; desktop notifications stay as they were
//   node src/install.mjs --toast      also Windows notifications with the agent's words (the
//                                     "notifications" action)
//   node src/install.mjs --no-toast   and without them
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { loadConfig } from './config.mjs'
import { t } from './lang.mjs'
import { ROOT } from './paths.mjs'
import { boardFiles, checkSetup, gatherFacts, patchSettings, report, shimFiles, tomlValue, herdrConfigFile } from './setup.mjs'

const args = process.argv.slice(2)
let toast = args.includes('--toast') ? true : args.includes('--no-toast') ? false : undefined
if (toast && process.platform !== 'win32') {
  console.log('desktop notifications: Windows only; on Linux and macOS herdr shows its own ([ui.toast] delivery = "system")')
  toast = undefined
}

const settingsFile = join(homedir(), '.claude', 'settings.json')
const binDir = join(homedir(), '.local', 'bin')
const files = boardFiles(ROOT)

// --- commands
mkdirSync(binDir, { recursive: true })
for (const [name, body] of Object.entries(shimFiles(ROOT))) {
  const file = join(binDir, name)
  if (existsSync(file) && !readFileSync(file, 'utf8').includes('agent-board')) {
    console.log(`skipped ${file}: exists and is not ours`)
    continue
  }
  writeFileSync(file, body, { mode: 0o755 })
}
console.log(`commands: board, spawn-agent in ${binDir} (+ .cmd for PowerShell)`)

// --- hooks, status line, notifications
const before = existsSync(settingsFile) ? JSON.parse(readFileSync(settingsFile, 'utf8')) : {}
if (existsSync(settingsFile)) copyFileSync(settingsFile, `${settingsFile}.bak-agent-board`)
mkdirSync(join(homedir(), '.claude'), { recursive: true })
const r = patchSettings(before, { root: ROOT, toast })
writeFileSync(settingsFile, `${JSON.stringify(r.settings, null, 2)}\n`)
console.log(`hooks: SessionStart, UserPromptSubmit -> ${files.hook} in ${settingsFile}`)
console.log(r.statusLine === 'set' ? `status line: ${files.statusline}` : 'status line: left as it was (not ours)')
if (process.platform === 'win32') {
  console.log(r.toast ? `desktop notifications: on (Stop, Notification, PreToolUse AskUserQuestion -> ${files.toast})` : 'desktop notifications: off')
  const delivery = tomlValue(readText(herdrConfigFile()), 'ui.toast', 'delivery') ?? 'off'
  if (r.toast && delivery !== 'off') console.log(`  herdr shows its own too: set [ui.toast] delivery = "off" in ${herdrConfigFile()}, then herdr server reload-config`)
}

// --- what else is (not) set up
console.log('')
console.log(report(checkSetup(await gatherFacts(loadConfig(), { root: ROOT }), t), t))

function readText(file) {
  try {
    return readFileSync(file, 'utf8')
  } catch {
    return null
  }
}
