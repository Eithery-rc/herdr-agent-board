# agent-board

A [herdr](https://herdr.dev) plugin: a kanban of the Claude Code sessions running in herdr.
Lanes are categories (one per client, say, plus Личные and Прочее), columns are Работает /
Ждёт меня / Ждёт внешнего / Готово / Простой. Sessions
[herdr-wake](https://github.com/Eithery-rc/tg-mcp/tree/main/herdr-wake) put to sleep are on it
too (one line, `z`). The interface is in Russian.

No model runs for the board. It reads herdr's snapshot, Claude's session registry and the tail
of each transcript (ai-title, last prompt), herdr-wake's `/sleeping`, and the cards. A card is
what only the agent knows: its category, what it works on, what it waits for. Agents keep it
current with the `board` command; a SessionStart / UserPromptSubmit hook tells each session how.

## Install

```sh
herdr plugin install Eithery-rc/herdr-agent-board   # or clone it and: herdr plugin link <folder>
herdr plugin action invoke agent-board.install      # board command in ~/.local/bin, hooks in ~/.claude/settings.json
```

Node 20 or newer, no dependencies. Then set up the lanes: "Категории" on the web board (titles,
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
  session, else "Ты: <your last request>"), its last words, the tool it runs now, the question
  it is stuck on, what it waits for.
- Drag a card to another lane to change its category, or to another column to put it there by
  hand (also the "Статус" chips in the sheet). See "Moving a card by hand" below.
- Click a card: a sheet with its card fields, the question and screen when it waits for you,
  the conversation (tool calls folded), a message box, "Перейти в herdr" (focuses the pane and
  brings the terminal window up), "Усыпить" (through herdr-wake, idle sessions only; also the
  moon on a card), "Разбудить" for sleeping sessions. To close: click the board beside it, flick it right, or Esc.
  Another card switches it to that session. Attachments stay with their session through a close.
- `/` search, Esc closes. Light and dark, reduced motion and transparency respected.
- The sheet's thread renders Markdown (headings, lists, tables, code, quotes, links; escaped,
  links http(s) only). Files and screenshots go with a message: the clip, Ctrl+V, or a drop on
  the panel. They upload to `%LOCALAPPDATA%\herdr\plugins\agent-board\uploads\<day>\` (kept 14
  days, `keepUploadsDays`) and the message carries their paths; Claude reads them, images as
  images. Sent images show as previews in the thread.
- "Категории" (or a click on a lane title): rename, recolor, add or remove the folders that
  sort sessions into the lane, create, delete (two clicks; its sessions fall back to the folder
  guess), drag rows by the handle to reorder lanes. Written to config.json at once.

## When a card is under "Ждёт меня"

1. A dialog holds the session in the terminal (permission prompt, question form, MCP input):
   herdr reports `blocked` from its own screen rules. The card shows the question or the
   permission asked; the sheet shows the screen.
2. The agent ran `board ask "<question>"` before ending its turn. Cleared by the hook as soon as
   you write to that session.
3. Its last message ends with a question and you have not written since. "Не ждёт ответа" on
   the card or in the sheet waves that one question off.

4. You dragged it there yourself to look at it later ("Отложено"). The check mark on the card
   ("Посмотрел") takes it out.

## Moving a card by hand

A card dragged to another column (or set with the "Статус" chips) stays there, marked with a pin,
until the session works again: you write to it, or another session does. Then the board sorts it
by itself as before. Dragged while the session works, it stays under "Работает" and moves once
that turn is over. A terminal dialog still puts it under "Ждёт меня". Dropped back on the column
the board would pick, or with the "Само" chip, the pin goes. "Работает" takes no cards. The pin is
`pin` in the card file; the hook and the board clear it.

## Everything updates live

- Cards (agents' `board` calls, edits on either board): instantly.
- herdr state, transcripts, sleeping sessions: every `refreshSec` (2 s).
- config.json, edited by hand or from the web board: the running board reloads it, the web
  board and the terminal board redraw, and the agents' next brief lists the new categories.
- Plugin code: the pane runs `src/run.mjs`, which restarts the board when a file in `src/`
  changes (by its time and size: on Windows a plain read fires the watcher too); open web pages
  reload themselves when a file in `web/` changes.

Code: `src/server.mjs`, `web/` (no build step, no dependencies; springs in `web/spring.js`).

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

Russian layout keys work as well (ь, ц, ч, с, й, ...).

## Agents

```
board cat <id>          lane of this session
board cat <id> "<Title>"  a new client: adds the category to the config too
board doing "<text>"    what it works on now
board wait "<text>"     what it waits for outside the chat (card goes to Ждёт внешнего)
board ask "<question>"  needs your answer: "Ждёт меня" until you reply
board done ["<text>"]   finished: clears doing, wait and ask
board list              every session, one line each
board cats              known categories
--session <id|name|pane> for another session's card
```

## Settings

`%APPDATA%\herdr\plugins\config\agent-board\config.json`: categories (id, title, color, folders
that guess the category), `placement` (`workspace` default: the board lives in a workspace of its
own and stays open; `tab`; `overlay`), `refreshSec`, `wakeUrl` (herdr-wake router), `port`
(web board, 12422), `web` (false turns the web board off), `browser` (path for the app window),
`terminalTitle` (window title pattern to raise, default `<COMPUTERNAME>:*`), `raiseTerminal`.

Cards: `%LOCALAPPDATA%\herdr\plugins\agent-board\cards\<session id>.json`.
