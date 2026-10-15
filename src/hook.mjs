// Claude Code hooks (installed by the "install" action) that tell each session about the board.
//   SessionStart (new, resume, clear, compact): the full brief, since the context is fresh.
//   UserPromptSubmit: clears the card's `ask` (the user answered) and `pin`, unless the prompt is
//   a board reminder (scheduler.mjs); the brief once for sessions
//   that were running before the install; after that a one-line reminder only while the card
//   says it waits for something.
// Only sessions in a herdr pane are briefed: `claude -p` runs and other terminals are not on the board.
import { brief, BRIEF_VERSION, waitReminder } from './brief.mjs'
import { loadConfig } from './config.mjs'
import { readCard, writeCard } from './store.mjs'

async function readStdin() {
  let data = ''
  for await (const chunk of process.stdin) data += chunk
  return JSON.parse(data || '{}')
}

async function main() {
  const input = await readStdin()
  const event = input.hook_event_name
  const sid = input.session_id
  if (!sid || !process.env.HERDR_PANE_ID) return
  const card = readCard(sid)
  // The user wrote to the session: whatever it asked them is answered, and a column the user
  // dragged the card to has done its job. A reminder from the board's scheduler is not the user.
  const fromBoard = /^\s*\[board (reminder|schedule)\b/.test(input.prompt ?? '')
  if (event === 'UserPromptSubmit' && !fromBoard && (card?.ask || card?.pin)) writeCard(sid, { ask: '', askSince: '', pin: '', pinAt: '', pinBusy: '' })
  let context = null
  const briefed = card?.briefV ?? (card?.briefedAt ? 1 : 0)
  if (event === 'SessionStart' || (event === 'UserPromptSubmit' && briefed < BRIEF_VERSION)) {
    context = brief(loadConfig(), card, input.cwd)
    writeCard(sid, { briefedAt: Date.now(), briefV: BRIEF_VERSION })
  } else if (event === 'UserPromptSubmit' && card?.wait) {
    context = waitReminder(card)
  }
  if (context) console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: context } }))
}

main().catch(() => {})
