# agent-board

A [herdr](https://herdr.dev) plugin: a kanban of the Claude Code sessions running in herdr.
Lanes are categories (one per client, say, plus Personal and Other), columns are Working /
Needs me / Waiting on others / Done / Idle. Sessions
[herdr-wake](https://github.com/Eithery-rc/tg-mcp/tree/main/herdr-wake) put to sleep are on it
too (one line, `z`). In English and Russian; see [Language](#language).

No model runs for the board. It reads herdr's snapshot, Claude's session registry and the tail
of each transcript (ai-title, last prompt), herdr-wake's `/sleeping`, and the cards. A card is
what only the agent knows: its category, what it works on, what it waits for. Agents keep it
current with the `board` command; a SessionStart / UserPromptSubmit hook tells each session how.

## Install

```sh
herdr plugin install Eithery-rc/herdr-agent-board   # or clone it and: herdr plugin link <folder>
herdr plugin action invoke agent-board.install      # board command in ~/.local/bin; hooks and status line in ~/.claude/settings.json
```

Node 20 or newer, no dependencies. Then set up the lanes: "Categories" on the web board (titles,
colors, the folders that sort sessions into each lane), or let the agents add them.

Key, in herdr's `config.toml`:

```toml
[[keys.command]]
key = "prefix+a"
type = "plugin_action"
command = "agent-board.open"
description = "agent board"
```

## Web board

The terminal board also serves a web board at http://127.0.0.1:12422 (loopback only; POSTs
need an `X-Board` header, so no other site can type into a session). Open it with `o` on the
terminal board or `herdr plugin action invoke agent-board.web`: an Edge app window of its own,
raised when it is already open.

- Lanes by category, columns by state, live over Server-Sent Events.
- A card says what the session works on (its own `board doing`, else Claude's title of the
  session, else "You: <your last request>"), its last words, the tool it runs now, the question
  it is stuck on, what it waits for.
- Drag a card to another lane to change its category, or to another column to put it there by
  hand (also the "Status" chips in the sheet). See [Moving a card by hand](#moving-a-card-by-hand).
- Click a card: a sheet with its card fields, the question and screen when it waits for you,
  the conversation (tool calls folded), a message box, "Go to herdr" (focuses the pane and
  brings the terminal window up), "Put to sleep" (through herdr-wake, idle sessions only; also
  the moon on a card), "Wake" for sleeping sessions. To close: click the board beside it, flick
  it right, or Esc. Another card switches it to that session. Attachments stay with their
  session through a close.
- `/` search, Esc closes. Light and dark, reduced motion and transparency respected.
- The sheet's thread renders Markdown (headings, lists, tables, code, quotes, links; escaped,
  links http(s) only). Files and screenshots go with a message: the clip, Ctrl+V, or a drop on
  the panel. They upload to `%LOCALAPPDATA%\herdr\plugins\agent-board\uploads\<day>\` (kept 14
  days, `keepUploadsDays`) and the message carries their paths; Claude reads them, images as
  images. Sent images show as previews in the thread.
- Files, folders and links in the thread. A path an agent writes (absolute, `~/...`, a
  `herdr-reveal:` or `file:` link, or relative to the session's folder in `code`, with an
  optional `:line`) becomes a chip once the board finds it on disk; file tool calls in the
  folded runs open the same way. A chip opens a quick look over the board, grown out of the
  chip: images, PDF, video and audio, Markdown (rendered or source), code and text with line
  numbers (the `:line` lit and scrolled to), JSON pretty, CSV as a table, folders as a list to
  walk through (the path bar goes up; Backspace goes back). From there: open it with the
  system, show it in its folder, copy the path. Esc closes it. Web links open in the default
  browser.
- "Categories" (or a click on a lane title): rename, recolor, add or remove the folders that
  sort sessions into the lane, create, delete (two clicks; its sessions fall back to the folder
  guess), drag rows by the handle to reorder lanes. Written to config.json at once.
- A clock on a card: the session has something scheduled, with the soonest time (orange while a
  due one waits for the session to be free). The sheet lists its next three; "Schedule" on the
  toolbar shows every entry by day, then what was sent or missed lately. The trash can cancels
  an entry (two clicks). See [Schedule](#schedule).

## When a card is under "Needs me"

1. A dialog holds the session in the terminal (permission prompt, question form, MCP input):
   herdr reports `blocked` from its own screen rules. The card shows the question or the
   permission asked; the sheet shows the screen.
2. The agent ran `board ask "<question>"` before ending its turn. Cleared by the hook as soon as
   you write to that session.
3. Its last message ends with a question and you have not written since. "No reply needed" on
   the card or in the sheet waves that one question off.
4. You dragged it there yourself to look at it later ("Parked"). The check mark on the card
   ("Seen") takes it out.

## Moving a card by hand

A card dragged to another column (or set with the "Status" chips) stays there, marked with a
pin, until the session works again: you write to it, or another session does. Then the board
sorts it by itself as before. Dragged while the session works, it stays under "Working" and
moves once that turn is over. A terminal dialog still puts it under "Needs me". Dropped back on
the column the board would pick, or with the "Auto" chip, the pin goes. "Working" takes no
cards. The pin is `pin` in the card file; the hook and the board clear it.

## Schedule

An agent can ask the board to come back to it later: `board remind in 2h "check the CI run"`,
or on a cron schedule, `board every "0 9 * * 1-5" "go through the inbox"`. When an entry is due,
the board types `[board reminder] <text>` into that session as a prompt (`[board schedule <id>:
<cron>] <text>` for a repeating one), waking it through herdr-wake first when it sleeps. The
agent wrote the text for itself, so it knows what to do.

This is what Claude Code's own CronCreate and ScheduleWakeup cannot do here: they live inside
the Claude process, and herdr-wake ends that process after an idle hour. The board's entries
are files, and the board keeps running.

- Times are local: `in 30m`, `in 1h30m`, `at 15:30` (the next 15:30), `tomorrow 9:00`,
  `fri 17:00`, `2026-10-20 14:00`, or an ISO time with a zone. A date alone means 9:00.
- Cron has the usual 5 fields (minute, hour, day of month, month, day of week; names, ranges,
  lists and steps) or `@hourly`, `@daily`, `@weekly`, `@monthly`, `@yearly`. Day fields work as
  in Vixie cron: two restricted ones are either-or, one that starts with `*` narrows the other.
  Runs closer than 5 minutes apart are refused: each one is a turn of the session. On a DST
  change, a time that does not exist that day is skipped and a repeated hour runs once.
- A session that works, waits on a dialog, or has text the user started typing in its input
  box (read from the screen as herdr-wake does: dim suggestions do not count) is not
  interrupted: the scheduler tries again every tick (15 s) and sends once it is free. After
  `scheduleWaitMin` (240) minutes of trying, the run is logged as missed: a one-off entry goes,
  a cron one moves to its next time.
- An entry belongs to the session that set it. After `/clear`, which gives the session a new
  id, it goes to the Claude session now in the same pane and folder.
- At most two sleeping sessions are woken at once. An entry cancelled while its session wakes
  up is not sent.
- Runs that came due while the board was off: a one-off is sent once, saying how late it is; a
  cron entry sends one prompt for all the runs it missed, saying how many. Time the board was
  off does not count against the wait.
- A reminder prompt is not the user writing: the hook leaves the card's `ask` in place.
- One file per entry in `%LOCALAPPDATA%\herdr\plugins\agent-board\schedule\<id>.json`, written
  under the same per-file lock as the cards, so an agent cancelling an entry while the
  scheduler marks its run never brings it back. Before sending, the scheduler claims the entry
  in its file: a second board running at the same time (a restart that overlaps) never sends a
  run twice. `log.jsonl` there keeps the last 200 runs.
- The scheduler runs in the web board's server (`src/scheduler.mjs`), one per machine since
  only one board holds the port; with `web: false` the terminal board runs it.
- At most 30 entries per session.
- The terminal board shows `⏰` and the soonest time by a card's age, the count in its header.

## Language

English and Russian. The globe button on the web board's toolbar switches between them; the
choice is `language` in config.json (`"auto"`, the default, follows the system's language,
English when there is no dictionary for it). A switch reaches at once the web board, the
terminal board, error messages, and the agents' next brief, which tells them the language to
write their cards in. Titles you give lanes and whatever agents write stay as written.

All texts live in `web/i18n.js`, shared by the browser and Node. Another language is one more
dictionary there plus its plural rule; a test checks that every dictionary has every text.

## Everything updates live

- Cards (agents' `board` calls, edits on either board): instantly.
- herdr state, transcripts, sleeping sessions: every `refreshSec` (2 s).
- config.json, edited by hand or from the web board: the running board reloads it, the web
  board and the terminal board redraw, and the agents' next brief lists the new categories.
- Plugin code: the pane runs `src/run.mjs`, which restarts the board when a file in `src/`
  changes (by its time and size: on Windows a plain read fires the watcher too); open web pages
  reload themselves when a file in `web/` changes.

Code: `src/server.mjs`, `web/` (no build step, no dependencies; springs in `web/spring.js`).

The web API (`GET /api/board` and SSE `/api/events`) includes `stale` and
`lastSuccessfulRefreshAt` (Unix milliseconds, or `null` before the first successful refresh).
A failed refresh keeps the last snapshot and marks it stale; the indicator turns orange until
Herdr data can be collected again. Opening the SSE connection alone does not mark data live.
SSE sends the board again only when it changed (stale included); GET always has the latest
`lastSuccessfulRefreshAt`.

Claude usage (`src/statusline.mjs`, `src/usage.mjs`): the install action sets Claude Code's status line
to the board's own command when there is none (a status line someone else set stays). Claude runs it
after every reply with the session's state; it keeps the account's 5h and 7d usage windows
(`claude-limits-latest.json` in the state folder, the usagebar shape) and each session's context fill
(`context/<session id>.json`), and prints a short line under the prompt: `ctx 34% · 5h 23% · 7d 41%`.
The board shows the windows as a pill by the live dot (windows past their reset left out) and the
context fill in the sheet; without the status line it falls back to the usagebar cache and to the
tokens of the last request in the transcript.

Files (`src/files.mjs`, `web/files.js`): `POST /api/fs/stat` (which of these paths exist),
`POST /api/fs/preview`, `POST /api/fs/open` (`open` or `reveal`, through explorer.exe, `open`
or `xdg-open`, no shell) and `POST /api/open-url` (http(s) only) need the `X-Board` header like
every POST. `GET /api/fs/raw` serves images, PDF, video and audio, with ranges, to the page's
`<img>`, `<video>` and PDF viewer, which cannot send headers: it needs the `fsToken` from the
board payload, new on every start, which only the board's own page can read. Text never comes
raw, and raw responses carry a CSP that runs no script.

## Board keys

| Key | Action |
| --- | --- |
| arrows / hjkl, mouse click | select |
| Enter, double click | go to the session (wakes it if it sleeps) |
| m | send the session a message (typed into its prompt) |
| w | set what it waits for (empty clears) |
| x | clear its card (doing, wait, result, a column set by hand) |
| z | put the session to sleep (herdr-wake; idle sessions only) |
| c | change its category (n: a new one) |
| 1-9 / 0 | show one lane / all |
| o | open the web board |
| q, Esc, the board key again | back to where you were |
| Ctrl+C | close the board |

The same keys work on a Russian keyboard layout.

## Agents

```
board cat <id>            lane of this session
board cat <id> "<Title>"  a new client: adds the category to the config too
board doing "<text>"      what it works on now
board wait "<text>"       what it waits for outside the chat (card goes to "Waiting on others")
board ask "<question>"    needs your answer: "Needs me" until you reply
board done ["<text>"]     finished: clears doing, wait and ask
board list                every session, one line each
board cats                known categories
board remind <when> "<text>"   at that time, "[board reminder] <text>" goes into the session
board every "<cron>" "<text>"  the same on a cron schedule
board schedule [--all]    this session's entries (every session's)
board unschedule <id|all> remove an entry (all: every entry of this session)
--session <id|name|pane>  for another session's card
```

## Settings

`%APPDATA%\herdr\plugins\config\agent-board\config.json`: `language` (`auto`, `en`, `ru`),
categories (id, title, color, folders that guess the category), `placement` (`workspace`
default: the board lives in a workspace of its own and stays open; `tab`; `overlay`),
`refreshSec`, `wakeUrl` (herdr-wake router), `scheduleWaitMin` (how long a due entry waits for a
busy session, 240), `port` (web board, 12422), `web` (false turns the
web board off), `browser` (path for the app window), `terminalTitle` (window title pattern to
raise, default `<COMPUTERNAME>:*`), `raiseTerminal`.

Cards: `%LOCALAPPDATA%\herdr\plugins\agent-board\cards\<session id>.json`.

Writes to the same card use a per-card directory lock (`<session id>.json.lock`) around the
read/merge/rename. Contention waits at most two seconds, then reports an error without replacing
the card. Locks are released on ordinary errors. A writer killed mid-write leaves its lock
behind; a write holds it for milliseconds, so one older than 30 seconds is taken over by the
next writer. A card write the board itself fails at is retried on its next refresh.
