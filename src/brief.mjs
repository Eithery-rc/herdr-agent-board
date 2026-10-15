// What a Claude session is told about the board (see hook.mjs).
import { categoryFor } from './config.mjs'
import { languageName } from './lang.mjs'

// Bump when the brief says something new: every running session gets it again on its next prompt.
export const BRIEF_VERSION = 2

export function brief(cfg, card, cwd) {
  const cat = card?.category
  const guess = categoryFor(cfg, cwd)
  const now = cat ? `${cat}` : guess ? `${guess} (guessed from the folder, set it if wrong)` : 'not set, set it now'
  const known = cfg.categories.map(c => `${c.id} (${c.title})`).join(', ')
  const state = [card?.doing && `doing "${card.doing}"`, card?.wait && `waiting "${card.wait}"`, card?.ask && `asks the user "${card.ask}"`].filter(Boolean).join(', ')
  return [
    '[agent-board] The user watches every Claude session on a kanban board in herdr: lanes by category; columns working, needs the user, waiting on someone else, done, idle.',
    "Working, done and terminal dialogs are detected automatically. Keep the rest of this session's card current with the `board` shell command (Bash or PowerShell; it prints one line; no need to tell the user):",
    `- board cat <id>: this session's lane. Now: ${now}. Known: ${known}. For a client that has none yet: board cat <new-id> "<Title>" adds it.`,
    '- board doing "<3-8 words>": when you start a distinct task.',
    '- board ask "<the question, short>": before ending a turn that needs the user\'s answer or decision (approve a draft, pick an option, give data). Puts the card under "needs the user"; cleared by itself when the user replies.',
    '- board wait "<who/what>": before ending a turn blocked on something outside this chat (client reply, CI, another session, a date). The card stays in "waiting" until you run doing or done.',
    '- board done ["<result>"]: task finished; clears doing, wait and ask.',
    `Card texts in ${languageName()}, short. Call it only when the state changes, not every turn.${state ? ` Card now: ${state}.` : ''}`,
  ].join('\n')
}

export function waitReminder(card) {
  return `[agent-board] This session's card says it waits for: "${card.wait}". If this prompt resolves that, update the card (board doing / done / wait).`
}
