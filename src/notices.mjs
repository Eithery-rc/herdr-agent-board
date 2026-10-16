// Turns that reach a session as a prompt but were not typed by a person: Claude Code's
// <task-notification> when a background command, agent, monitor or workflow reports back, and
// the board's own reminders (scheduler.mjs). The detail view shows them as a line of their own,
// and they never count as the user answering.

const DETAIL_LIMIT = 4000

const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

function tag(text, name) {
  const m = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(text)
  return m ? m[1].trim() : ''
}

// What reported back, by the start of the notification's summary.
const KINDS = [
  ['command', /^Background (?:shell )?command\b/],
  ['agent', /^(?:Background )?agents?\b|^\d+ background agents\b/i],
  ['monitor', /^Monitor\b/],
  ['workflow', /^(?:Dynamic )?workflow\b/i],
  ['mcp', /^MCP task\b/],
]

/**
 * A task notification as { kind, status, name, exit, summary, detail, file, id }, or null when
 * the text is not one.
 *   kind     command | agent | monitor | workflow | mcp | task
 *   status   completed | failed | killed | stopped | event (a monitor's new lines)
 *   name     the task's own description, as quoted in the summary ('' when it has none)
 *   exit     a command's exit code, or null
 *   detail   an agent's final report or a monitor's event lines, clipped
 *   file     the task's output file
 */
export function taskNotice(text) {
  const t = String(text ?? '').trim()
  if (!t.startsWith('<task-notification>')) return null
  const summary = tag(t, 'summary')
  if (!summary) return null // nothing to show
  const kind = KINDS.find(([, re]) => re.test(summary))?.[0] ?? 'task'
  const event = tag(t, 'event')
  const status = tag(t, 'status') || (event ? 'event' : 'completed')
  const name = kind === 'mcp' ? (/\(([^)]+)\)/.exec(summary)?.[1] ?? '') : (/"([^"]+)"/.exec(summary)?.[1] ?? '')
  const exit = /exit code (-?\d+)/.exec(summary)
  return {
    kind,
    status,
    name: clip(name, 200),
    exit: exit ? Number(exit[1]) : null,
    summary: clip(summary, 300),
    detail: clip(tag(t, 'result') || event, DETAIL_LIMIT),
    file: tag(t, 'output-file'),
    id: tag(t, 'task-id'),
  }
}

/**
 * A reminder the board typed in (scheduler.mjs promptOf), "[board reminder from X; notes] text"
 * or "[board schedule <id> from X: <cron>; notes] text", as
 * { kind: 'reminder' | 'schedule', status: 'event', name: text, from, cron, note }. Null for
 * anything else.
 */
export function reminderNotice(text) {
  const m = /^\[board (reminder|schedule)\b([^\]]*)\]\s*([\s\S]*)$/.exec(String(text ?? '').trim())
  if (!m) return null
  const [head, ...notes] = m[2].split(';')
  return {
    kind: m[1],
    status: 'event',
    name: clip(m[3].trim(), 1000),
    from: /\bfrom (.+?)(?::|$)/.exec(head)?.[1].trim() ?? '',
    cron: m[1] === 'schedule' ? (/:\s*(.+)$/.exec(head)?.[1].trim() ?? '') : '',
    note: clip(notes.join(';').trim(), 300),
  }
}

/** True for a prompt the user did not type: a task notification or a board reminder. */
export const isNotice = text => !!(taskNotice(text) || reminderNotice(text))
