// Where the board keeps things. The board command and the Claude Code hooks run outside the
// herdr plugin context (no HERDR_PLUGIN_* env), so every path is computed the same way herdr
// seeds them: config under %APPDATA%, runtime state under %LOCALAPPDATA%.
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const PLUGIN_ID = 'agent-board'
export const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
export const CONFIG_DIR = join(process.env.APPDATA || join(homedir(), '.config'), 'herdr', 'plugins', 'config', PLUGIN_ID)
export const STATE_DIR = join(process.env.LOCALAPPDATA || join(homedir(), '.local', 'state'), 'herdr', 'plugins', PLUGIN_ID)
export const CARDS_DIR = join(STATE_DIR, 'cards')
// Reminders and repeating pings for sessions (schedule.mjs), one file per entry.
export const SCHEDULE_DIR = join(STATE_DIR, 'schedule')
export const BOARD_FILE = join(STATE_DIR, 'board.json')
export const CLAUDE_DIR = join(homedir(), '.claude')
