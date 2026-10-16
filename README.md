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

## Setup

Node 20 or newer, no dependencies. Windows, Linux and macOS (desktop notifications: Windows only).
Steps 1 and 2 are what the board needs; the rest adds to it.

1. **The plugin and its install** (required).

   ```sh
   herdr plugin install MokuTeam/herdr-agent-board   # or clone it and: herdr plugin link <folder>
   herdr plugin action invoke agent-board.install
   ```

   The install puts two commands into `~/.local/bin` (a sh script for Git Bash, Linux and macOS,
   a `.cmd` for PowerShell): `board`, which agents keep their cards current with, and
   [`spawn-agent`](#spawn-agent), which starts a session in a new herdr tab. It registers the
   Claude Code hooks (SessionStart, UserPromptSubmit) that brief every session about the board,
   and the status line when you have none (usage windows and context fill on the board). It
   replaces only its own entries in `~/.claude/settings.json`, keeps a copy of the file before
   (`settings.json.bak-agent-board`), leaves a command of someone else's name alone, and ends with
   the check below. `~/.local/bin` must be on PATH. Run it again after the plugin moved or was
   updated: the hooks and the commands point at the plugin's folder.
2. **A key** (recommended), in herdr's `config.toml` (`%APPDATA%\herdr\config.toml` on Windows,
   `~/.config/herdr/config.toml` elsewhere), then `herdr server reload-config`. Without it the
   board opens with `herdr plugin action invoke agent-board.open`.

   ```toml
   [[keys.command]]
   key = "prefix+a"
   type = "plugin_action"
   command = "agent-board.open"
   description = "agent board"
   ```

3. **How Claude starts** (optional). New sessions from the board and from `spawn-agent` start as
   `claude` in a new tab. `launch.claude` in the board's config.json changes that: say
   `["claude", "--dangerously-skip-permissions"]` (your call: Claude then runs every tool without
   asking), a model, or a launcher of your own, such as tg-mcp's
   [`claude-tg`](https://github.com/Eithery-rc/tg-mcp#herdr-launcher), which gives each herdr tab
   its own Telegram topic. See [New sessions](#new-sessions).
4. **[herdr-wake](https://github.com/Eithery-rc/tg-mcp/tree/main/herdr-wake)** (optional, worth it
   with many sessions). It puts sessions that sat idle for an hour to sleep and wakes them for a
   message, a reminder or a click; with [tg-mcp](https://github.com/Eithery-rc/tg-mcp) it also
   brings your Telegram messages to them. Without it the board has no "Put to sleep" and "Wake",
   shows no sleeping sessions, and a reminder cannot wake one. The board finds it at `wakeUrl`
   (`http://127.0.0.1:12421`).
5. **Desktop notifications** (optional, Windows): `herdr plugin action invoke
   agent-board.notifications`. See [Notifications](#notifications).
6. **Lanes**: "Categories" on the web board (titles, colors, the folders that sort sessions into
   each lane), or let the agents add them.

`board doctor` (or `herdr plugin action invoke agent-board.doctor`) says what is set up and what
is not, what each missing piece costs and how to fix it: the commands (and whether PowerShell or
Git Bash finds someone else's of that name first), the hooks and the status line (and whether they
run this copy of the plugin), the key, herdr-wake, how new sessions start, the notifications. The
web board says it too, quietly: "Setup incomplete" in its toolbar while something the board needs
does not work (see [Web board](#web-board)).

## Web board

The terminal board also serves a web board at http://127.0.0.1:12422 (loopback only; POSTs
need an `X-Board` header, so no other site can type into a session). Open it with `o` on the
terminal board or `herdr plugin action invoke agent-board.web`: an Edge app window of its own,
raised when it is already open.

To land on one session, from a desktop notification's click handler (the board's own
[notifications](#notifications) do this) say: `node src/web-open.mjs --pane <herdr pane id>`. The board's window comes up and opens that session's sheet (a page in
a minimized or covered window is told as it connects again, within 15 s); with no board window,
a new one opens on it (`#session=<key>` in its address). It does not start the
board: exit code 3 means the board does not run or has no session in that pane, so the handler
can go to the pane in herdr instead. The same goes to the board as `POST /api/reveal` with
`{ "pane": "<id>" }` or `{ "key": "<session>" }`.

- Lanes by category, columns by state, live over Server-Sent Events. A column with no card on
  show narrows to its head (name and count) and the others share its room, gliding as it fills
  or empties.
- One compact toolbar row: the title with the board's summary under it while the row has room
  (else in the title's tooltip), the lanes, search, categories and the schedule as small buttons
  named by their tooltips, and Settings (the gear). A narrower window takes two rows, a phone
  three.
- Settings (the gear): appearance (as the system has it, light or dark; kept in this browser),
  language, where the session panel sits, and whether sleeping sessions show.
- A card says what the session works on (its own `board doing`, else Claude's title of the
  session, else "You: <your last request>"), its last words, the tool it runs now, the question
  it is stuck on, what it waits for.
- Drag a card to another lane to change its category, or to another column to put it there by
  hand (also the "Status" chips in the sheet). See [Moving a card by hand](#moving-a-card-by-hand).
- Click a card: a sheet with its card fields, the question and screen when it waits for you
  (a question form or a permission prompt is answered right there, see
  [Answering from the board](#answering-from-the-board)), the conversation (tool calls folded;
  a background command, agent, monitor or MCP task reporting back and a board reminder are a
  quiet line of their own, not your message: an agent's report opens from it, a command's
  "Output" opens its output file), a message box, "Go to herdr" (focuses the pane and
  brings the terminal window up), "Put to sleep" (through herdr-wake, idle sessions only; also
  the moon on a card), "Wake" for sleeping sessions. To close: click the board beside it, flick
  it out the way it came, or Esc. Another card switches it to that session. Attachments stay
  with their session through a close.
- The sheet's place and size are the viewer's own (kept in this browser): docked right, left or
  at the bottom, flush with that edge like a sidebar, where the board makes room for it (a window
  too narrow for that keeps the board's columns and lays the sheet over them), or floating over
  the board as a window of its own. The button in its head or Settings picks the place; or pull
  the sheet by its head until it comes loose and carry it to an edge: within a tenth of the
  window of it a preview shows where it lands, holds steady there, and that is where it goes. Its inner edge resizes it (double-click: the default
  size; arrow keys once it has focus; flung narrower than half the smallest size, it folds
  away); a floating one moves by its head and resizes by any edge. Wide and low (at the
  bottom), it shows the card on the left and the conversation on the right. "Categories" opens
  in the same place. On a phone it stays the full-height sheet.
- `/` search, Esc closes. Light and dark, reduced motion and transparency respected.
- "Setup incomplete" in the toolbar, quietly, while something the board needs does not work on
  this computer (the checks of `board doctor`, run when the board starts and every 10 minutes).
  It opens the list: what is set up, what is not, what each missing piece costs and how to fix
  it, with the commands to copy. Optional parts that are off (herdr-wake, notifications) are
  listed but never raise it. "Hide until something changes" puts it away until the problems are
  other ones.
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
- Images and SVG in the quick look zoom as in Preview and Photos: Ctrl+wheel or a trackpad
  pinch, two fingers on a phone, a click (a double-tap) zooms in to 100% at that spot and a
  double-click goes back to fit, `+` `-` `0` (fit) and the arrows from the keyboard. A zoomed
  image drags 1:1, glides on after a flick and gives at its edges; a plain wheel moves it. Up to
  800% (an image pixel over three device pixels shows as a crisp square); the footer shows the
  scale and a button in to 100% or back to fit. Each opening starts fitted.
- "Categories" (or a click on a lane title): rename, recolor, add or remove the folders that
  sort sessions into the lane, create, delete (two clicks; its sessions fall back to the folder
  guess), drag rows by the handle to reorder lanes. Written to config.json at once.
- A clock on a card: the session has something scheduled, with the soonest time (orange while a
  due one waits for the session to be free). The sheet lists its next three; "Schedule" on the
  toolbar shows every entry by day, then what was sent or missed lately. The trash can cancels
  an entry (two clicks). See [Schedule](#schedule).
- "New session" (the toolbar, a lane's +, "New session here" in the sheet, the menus, Shift+N):
  a window for a new Claude session in herdr. See [New sessions](#new-sessions).
- "Terminal" in the sheet (a card's menu, Ctrl+` with the sheet open): a live shell in the
  session's folder, or the session's own terminal, to type into from the board. See
  [Terminal](#terminal).
- Helpers and sessions working together: a card says when subagents, forks, workflow agents or
  teammates of its session are at work, and which session started it; the sheet lists the
  helpers, and each one's own conversation opens live. See
  [Helpers and linked sessions](#helpers-and-linked-sessions).
- Right click (or a long press on a touch screen, or the menu key / Shift+F10 on a focused card)
  opens the board's own menu: on a card (open, go to herdr, message, wake or sleep, rename, move
  to a category, status, "No reply needed", open its folder, Changes, History, a new session in
  its folder, copy its name, folder, session or pane id, clear the card), on a lane (a new
  session or workspace there, edit the category, show only it), on the board, on the sheet's
  head, on a starting session and on file chips. It opens where you clicked, stays on screen,
  takes arrows, Enter, Esc and the first letters of an item. Gray items say why (no fresh data
  from herdr, the session works). Fields, selected text and links keep the browser's own menu;
  Shift+right click always gives it.
- Rename a session where its name is: "Rename" in its menu, F2 on the card, or a click on the
  name in the sheet's head. Enter keeps it, Esc puts it back, an empty name gives the automatic
  one back. The name is the board's (`name` on the card), shown on both boards and found by the
  search. "Rename in Claude and herdr too" also types `/rename <name>` into the session and
  gives its herdr agent the same name, so other sessions and herdr-wake see it: only when ticked,
  and only while the session is idle (not working, not asleep).

## New sessions

The window asks for a name, a folder, the lane, where to open it (one of herdr's workspaces or a
new one) and, if you like, a first message. It fills in what fits where it was opened from: the
card's folder and workspace, the lane's folders and the workspace most of its sessions are in,
else the folders of sessions on the board and of recent Claude sessions on this computer. The
folder field completes folder names as you type (Tab or Enter takes one), lists those
suggestions when it has the focus, and "Browse" opens columns to walk the disk, Finder style;
the server says whether the folder exists. The lane follows the folder (by the lanes' folders)
until you pick one. For a folder in a git checkout, "In a new git worktree" makes a branch in a
sibling folder (`repo-branch`) and starts there. Ctrl+Enter starts.

The new card shows in its lane at once, under "Working" while it starts, and becomes the
session's own card once herdr sees it. If it fails, it moves under "Needs me" with the reason
(the folder, a dialog Claude waits on, a timeout) and what to do: retry with the same values,
go to its tab, or dismiss it. A retry starts in the worktree or the workspace the failed launch
made already. One that failed only at its first message has no retry: the session runs; send
the message from its card. Dismissing a launch that still runs only takes it off the board: it
goes on, and its session still gets its lane.

In a folder Claude has not seen, it first asks whether to trust it. The launch then waits on its
card, under "Needs me", with the folder: "Trust and continue" reads the dialog off the screen,
checks it is for that folder, moves the cursor to "Yes" as the screen shows it and confirms; the
board then names the session and sends the first message, each only into an empty input box.
"Close the tab" closes it instead. The same holds when a launcher gives up there (spawn-agent
says "waits for a dialog (folder trust?)"): the session is in its tab, so the board takes it from
there rather than retry. A dialog Claude asks next (a project's MCP servers) is answered in
herdr; the card says it waits there.

How it starts, by `launch` in config.json:

- Nothing set (the default): the board's own [spawn-agent](#spawn-agent), run as a launcher (see
  `launch.command` below), with a session id the board picked, so the card has its lane before
  Claude starts. A new workspace's first tab is used for the session. `launch.claude` (`"claude"`)
  is what it types into the tab: a program, or a list of the program and its arguments, such as
  `["claude", "--dangerously-skip-permissions"]` or `["claude-tg"]`. Without it, `launch.args`
  (from before the board had its own launcher) are `claude`'s arguments. `launch.timeoutSec`
  (120) is how long it waits for Claude to be ready. When Claude stops at a dialog before that, the card
  says so: the folder trust as below, any other in herdr; the board then names the session and
  sends the first message.
- `launch.agent`: through herdr itself. A tab in the chosen workspace (or a new workspace),
  `herdr agent start <name> --kind <agent> --pane <tab's pane> -- --session-id <id>` (the id for
  `claude` only), then `/rename <name>` and the first message. When Claude stops at a dialog, the
  card says so; answer it in herdr and the board goes on. herdr starts the agent kind's own
  program, so `launch.claude` does not apply; `launch.args` adds the agent's arguments,
  `launch.timeoutSec` (120) how long to wait.
- `launch.command`: your own launcher, run without a shell. The first element is the program,
  each other element one argument, with `{name}`, `{label}`, `{cwd}`, `{workspace}` (herdr
  workspace id), `{workspaceLabel}`, `{category}`, `{message}`, `{messageFile}` (the first message
  in a UTF-8 file) or `{sessionId}` filled in; a nested list is left out when a value in it is
  empty. Nothing from the request becomes a program or an option: values only fill those
  places. It runs with `HERDR_WORKSPACE_ID` set to the chosen workspace (the board itself lives
  in a workspace of its own) and should print `pane=<pane id>` when the session is up; it fails
  with a non-zero exit, its last error line is the reason shown. A new workspace's first tab is
  closed after a launcher opened its own tab in it. `launch.timeoutSec` (180): then the
  launcher and everything it started are ended (`taskkill /T` on Windows, its process group
  elsewhere), so nothing opens a tab after the card said it timed out.
  - Prefer `{messageFile}` to `{message}`. A first message is free text: as a plain argument it
    can start with `-` and be read as an option by a launcher that parses its own arguments.
    The file is written for this user only, new for each launch, and removed when the launcher
    exits, so the launcher must read it before it does.
  - `cmd`, `.bat` and `.cmd` files are refused as the program: cmd.exe reads its own command
    line, so the values would meet a shell after all. Run a script with its interpreter
    (`pwsh -File`, `node`, `python`).

```json
"launch": {
  "command": ["pwsh", "-NoProfile", "-File", "C:\\tools\\start-session.ps1",
              "-Name", "{name}", "-Cwd", "{cwd}", "-Workspace", "{workspace}",
              ["-BriefFile", "{messageFile}"]],
  "timeoutSec": 180
}
```

### spawn-agent

The command the board starts sessions with, and agents start other sessions with (the install
puts it on PATH; it is `node src/spawn.mjs`):

```
spawn-agent --name <Name> --cwd <folder> [--label <tab label>]
            [--brief-file <utf-8 file> | --brief <text>] [--workspace <herdr workspace id>]
            [--timeout-sec 120] [--session-id <uuid>] [--pane <herdr pane id>]
```

PowerShell's spelling works too: `-Name`, `-Cwd`, `-Label`, `-BriefFile`, `-Brief`, `-Workspace`,
`-TimeoutSec`. It opens a tab in the workspace (inside herdr the current one, from
`HERDR_WORKSPACE_ID`), labelled with `--label` or the name, and types `launch.claude` into it
(with `--session-id` when given). Once herdr sees Claude ready, it gives the agent a herdr name to
address it by (the name in `[a-z0-9_-]`, Cyrillic spelled in Latin, `-2` when taken), types
`/rename <Name>`, then the brief. It prints

```
pane=<pane id> name=<Name> agent=<herdr name>
```

which is how the board knows who started whom. It fails (exit code 1, the reason on stderr) when
the folder is not there, Claude is not ready in time, or Claude waits for a dialog first (the
folder trust): answer it in that tab, then name and brief the session there. A brief that does
not get through fails it too, saying so: the session runs, send the brief by hand rather than
start another. A `/rename` that does not take is only a warning. `--pane` starts Claude in that
pane instead of a new tab; it must be at a shell prompt, not running an agent.

Details it takes care of: `/rename` runs without a turn, so herdr calls it stalled, and the
screen is read for "Session renamed" instead. Right after it Claude can drop typed text, and a
short turn can end before herdr sees it working: a brief herdr calls stalled gets an Enter when
it is still on screen (or shows as a pasted-text chip), else it is typed again, three times at
most. A brief that starts with a dash goes with a space before it, or herdr would take it for an
option. From PowerShell prefer `--brief-file` for a brief with quotes or `&` in it: the `.cmd`
goes through cmd.exe. From Git Bash, a brief that starts with `/` (a slash command) reaches it
as a path (MSYS rewrites such arguments for Windows programs): use `--brief-file` there too.

`launch.claude` is typed at the tab's shell prompt (PowerShell, bash, zsh, fish): plain words as
they are, other arguments in single quotes, which those shells take literally (in fish, keep a
backslash away from the end and from another backslash). An argument with a quote in it
(`'`, or a typographic one PowerShell also ends a string at) or a control character is refused.
The program itself must be a name on PATH, or a path without spaces (backslashes only on
Windows, where the tab runs PowerShell).

Launches live in the board's memory. A board that restarts in the middle of one forgets it: its
card goes, a launcher it ran is left running (and finishes or fails on its own), and a session
that comes up lands in the lane its folder gives, or in the chosen one when the board had given
it its session id (the herdr path, or `{sessionId}`). A first message file left behind is
removed when the board starts again.

## When a card is under "Needs me"

1. A dialog holds the session in the terminal (permission prompt, question form, MCP input):
   herdr reports `blocked` from its own screen rules. The card shows the question or the
   permission asked; the sheet shows the screen, and a question form or a permission prompt can
   be answered from it.
2. The agent ran `board ask "<question>"` before ending its turn. Cleared by the hook as soon as
   you write to that session.
3. Its last message ends with a question and you have not written since. "No reply needed" on
   the card or in the sheet waves that one question off.
4. You dragged it there yourself to look at it later ("Parked"). The check mark on the card
   ("Seen") takes it out.

## Answering from the board

When a session waits in Claude Code's question form (AskUserQuestion), its card says so with the
header, the first question and its options in a line (`+2 questions` when there are more). The
sheet shows the form itself: every question in order, its header, "Pick one" or "Pick any",
the options with their descriptions, an own answer, and the mockup of an option that has a
preview. The questions come from the tool call in the transcript, not from the screen. A lone
single-choice question is answered with one click on an option, as a digit does in the
terminal; otherwise pick the answers and press "Answer" (or Enter in an own answer). Keys 1 to 9
pick an option of the question in focus while the focus is in the sheet. The conversation shows
each form as a turn of its own, with the answers once given. A form the board cannot answer for
sure is left to the terminal ("Go to herdr"): more than 4 questions or 8 options, a question or
label longer than the board shows whole, two questions with the same text or two options with
the same label. An own answer is one line, without control characters (C0, C1) or the Unicode
marks that change the direction of text.

A permission prompt ("Do you want to proceed?") shows its title, what the tool will do and the
terminal's own choices (Yes, Yes and don't ask again, No...), read from the screen as drawn; one
click or digit picks one. A very long prompt is cut on the board with a mark ("12 more lines: see
the terminal screen"), never silently.

The board answers by pressing keys in the pane through herdr (`herdr agent send-keys` with the
pane id, and `herdr pane send-text` for an own answer: `agent prompt` refuses a pane in a
dialog). `send-text` types its text literally (backslashes and a leading dash included, herdr
0.9); an own answer that starts with a dash still goes with a space before it, as the board's
other calls do, and the board then takes that space out of the field (Ctrl+A, right, Backspace)
and checks it is gone, since Claude Code would keep it in the answer. How the form takes keys,
as found on a live session (Claude Code 2.1, `src/questions.mjs`):

- The cursor starts on option 1. In a single-choice question a digit picks that option and moves
  on at once; a lone question is then submitted. With previews a digit only moves the cursor and
  Enter picks.
- The own answer is the row after the options. A digit there picks the text it already holds, so
  the board reaches it with the arrow keys (the row then takes text; up leaves it), clears it with
  Ctrl+U, types, and presses Enter. Typing on it in a multi-choice question ticks it.
- In a multi-choice question a digit toggles an option and the cursor stays; "Next" (or
  "Submit" for a lone question) under the options goes on with Enter.
- Several questions, or one multi-choice question, end on a "Review your answers" screen that
  lists every answer above "1. Submit answers". Left and right arrows move between the questions.

What keeps it from pressing keys in the wrong place:

- The answer needs fresh herdr data, like a message, and comes only from the board's own page
  (the `Origin` check of new sessions). The pane must still hold the same Claude session (as
  `send` checks), herdr must say it is blocked, and the transcript must still have that very
  question call without a result: one answered in the terminal meanwhile is refused. One answer
  at a time per session.
- Before every key the screen is read and parsed; the board goes on only when it shows the
  question it expects, with the same options. After every key it waits until the screen shows
  what the key should have done (an option ticked, the next question, the field cleared). A
  dialog begun in the terminal is taken back to its first question and set to the board's
  answers.
- The review screen must list exactly the board's answers, with "Submit answers" as its first
  choice, before that is pressed.
- Done needs proof, which a blank or half-drawn screen is not: the transcript holds the answer,
  or two reads in a row show Claude's input box without the dialog, or a whole other dialog.
- A permission prompt is pressed only while the screen shows the prompt the user saw: a
  fingerprint of its title, text, question and choices exactly as drawn, every character and
  space (`rm -rf build_*` is not `rm -rf build`); where the cursor stands does not count.
- On the page, a click or a digit in the first half second after another dialog took the place
  of the one on show is not taken (permission prompts can come back to back), nor is a held key.
  A form that went through stays as "Answered" until herdr sees the session move on (at most 10
  seconds); the same prompt asked again is a new one.
- Anything unexpected stops it at once. The sheet says where it stopped and, once keys went in,
  that the form may be partly filled in (a herdr failure midway too), shows the screen, and
  offers "Go to herdr". Without fresh data the form stays readable and cannot be sent.

`POST /api/session/<key>/answer` with `{ session, toolUseId, answers: [{ options: [labels],
other }] }` and `POST /api/session/<key>/permit` with `{ session, fingerprint, option }` (the
fingerprint comes with the sheet's data); both need the `X-Board` header. Code:
`src/questions.mjs` (the questions, the screen, the keys), `src/answer.mjs` (the steps through
herdr), `web/questions.js` and `web/question-model.js` (the form).

## Terminal

"Terminal" opens a window over the board with a live terminal of the session, one of two (the
switch in its head; the window opens on the one used last):

- **Shell**: a shell in the session's folder, to run something there: `gh auth login`,
  `bw unlock`, the tests. The board opens it the first time as a tab of its own in the session's
  workspace in herdr, named after the session, so it is in herdr too ("Open in herdr" goes
  there). It stays when the window closes; a dot on the sheet's Terminal button says it is open.
  "Close the shell" (two clicks) ends it and closes its tab, unless something else was put in
  that tab since. `exit` in it, or closing it in herdr, does the same, and the board offers a new
  one.
- **Claude** (the session's agent): the session's own pane, for what its terminal asks and the
  board has no form for: `/login`, `/mcp`, a menu, a dialog too big for the sheet. It opens
  without the keys, so an Esc meant for the window never stops a turn. A sleeping session shows
  "Wake" instead.

A click or a tap on the screen gives it the keys; its ring and the line under it say so. From
then on keys go to the terminal: text, Enter, Tab, Esc, the arrows, Home, End, Page Up and Down,
Delete, F1 to F10, and Ctrl or Alt with a key (by the key's place: Ctrl+C on a Russian layout is
Ctrl+C). Ctrl+C with text selected on the screen copies it, Ctrl+V pastes; a paste of several
lines asks first, since every line runs as typed, and its last line break is left off. Ctrl+]
gives the keys back to the board; then Esc closes the window (Ctrl+` closes it from anywhere in
it). On a phone a tap on the screen brings up the keyboard, and a row under the screen has the
keys it lacks: Esc, Tab, Ctrl+C and the arrows. Web links in the output open in the default
browser.

What it shows: herdr has no output stream, so the board reads the pane (`pane read --source
recent-unwrapped --ansi`, its last 400 lines) right after every key, every 120 ms while
something changes, then every 0.4 to 1 s, and sends the page only the lines that changed (a line
longer than 4000 characters is cut there). A board page out of sight reads nothing until it is
back. Typed text shows in about a quarter of a second. Colors as the programs draw them (16, 256 and true
colors; bold, dim, italic, underline, inverse) on a screen that stays dark in both themes, which
is what the programs draw for. The text is sized for the pane's columns to fit, and lines wrap at
the window's edge. herdr does not say where the cursor is: the caret goes after a shell's prompt
or into Claude Code's input box, and only once the screen has been still for a moment.

It runs commands on this computer, so:

- Loopback only, as the whole board, and every request that types, opens or closes needs the
  `X-Board` header, the page's own `Origin` and fresh herdr data. Without fresh data the window
  keeps showing the screen and takes no keys. The stream (Server-Sent Events, which send no
  headers) needs the per-run token of the board payload, as raw files do.
- Keys go only to the shell the board opened for that session (kept in `terminals.json` in the
  state folder, and checked to be still that pane, in its tab, with the terminal it was opened
  with), or to the session's own pane once herdr says the same session still runs there, as for
  a message. A shell moved elsewhere in herdr is no longer the board's: it is neither typed into
  nor closed. The server takes only keys from its list, text without control characters, at most
  16 KB a request; a request with anything else types nothing.
- The board logs nothing typed or shown and keeps none of it. But typed text reaches herdr as a
  command-line argument of `herdr pane send-text` (its CLI takes text no other way), so for the
  moment that call runs it is visible to other processes of the same user and to process
  auditing that records command lines (Windows event 4688, when it is on). A password is better
  typed in herdr itself.
- Keys never land late: a request herdr is slow with shows "Waiting for herdr", the page gives
  it up after 8 s and drops what was typed meanwhile (and says so), and the server starts no
  herdr call for a request older than 4 s. The first call that fails stops the rest of it.
- `"terminal": false` in config.json turns it off: no button, and every terminal route answers
  404 (for a board opened from a phone through a tunnel, say).

`GET /api/term/<key>/<agent|shell>/stream?t=<fsToken>` (the screen, then line diffs),
`POST /api/term/<key>/shell/open`, `/shell/close`, `/shell/focus`, and
`POST /api/term/<key>/<agent|shell>/input` with `{ session, steps: [{ text } | { key }] }`.
Code: `src/terminal.mjs` (the shell, the reads, the input), `web/terminal.js` (the window),
`web/term-model.js` (ANSI, line diffs, links, the caret), `web/term-keys.js` (keys, both ends).

## Helpers and linked sessions

A session rarely works alone. Its helpers are what Claude Code runs for it: subagents (the Agent
tool, in the background or while the session waits), forks, the agents of a workflow, and
in-process teammates. Sessions in herdr also hand work to each other: one starts another with
`spawn-agent` and they write to each other with SendMessage.

- On a card, only while it is so: "3 helpers at work" with a dot for each (a subagent blue, a fork
  purple, a workflow teal, a teammate in its own color) and what the newest one does. A session
  whose turn is over can still have helpers at work; its card says so where it is. At its foot,
  quietly, the session that started it (a click opens that one) and how many it started. Pointing
  at a card, or tabbing to it, rings the cards of the sessions it works with. The toolbar counts
  the helpers at work on the whole board.
- In the sheet, above the conversation: the helpers at work, each with what it does now (the
  call that runs, or "thinking after Read") and a running clock; with none at work, the newest one
  in a line. "All" opens the list: at work, workflow runs with their agents, teammates, then the
  finished ones, newest first. A helper another helper started goes under it.
- A helper's row opens its own conversation in a window grown out of the row: what the session
  asked it, its messages, its calls folded as in the session's thread, its report; read again
  every second and a half while it works. The head says what it is (subagent, fork, workflow
  agent, teammate; its type, name and model; in the background or not) and how it stands, the
  foot how long it ran, its tool calls and its tokens (the last request's, as Claude Code counts a
  subagent's). Backspace goes back to the list, Esc closes.
- "Sessions" among the card's fields: each linked session once, marked when it started this one
  or this one started it, with the messages each way. A name opens that session.
- In the conversation, a call that works with others is a line of its own: a subagent, fork or
  workflow it started (it opens the helper, with its status and clock), a message it sent to
  another session or a teammate (it opens to the whole text), a session it started with
  spawn-agent. Another session's or a teammate's message is a bubble with their name; an agent's
  report has "Conversation" beside it.

Where it comes from, all read, nothing written:

- `~/.claude/projects/<project>/<session id>/subagents/agent-<id>.jsonl` is a helper's own
  transcript and `agent-<id>.meta.json` says what it is (agentType, description, the tool call
  that made it, `isFork`, `name`, `requestShape` background or foreground, `taskKind`
  `in_process_teammate`, `parentAgentId` for one a helper started, `stoppedByUser`). Workflow
  agents are under `subagents/workflows/<run>/`; a run's name and totals are in
  `<session id>/workflows/<run>.json` once it is over, its name in
  `workflows/scripts/<name>-<run>.js` while it runs. A teammate's team is
  `~/.claude/teams/session-<id>/` (its members); the board needs only the helper files.
- How a helper stands comes from the end of its transcript: its final answer (done; a teammate
  then waits for its next message), a call without a result or the model at work (at work),
  "Request interrupted" (stopped), an API error (failed). A helper that ended its turn while a
  background command of its own, or an agent it started, is still out is at work: Claude Code
  wakes it when that reports back (after an hour without a word, it counts as done). Only a
  session whose Claude process runs has helpers at work, and only those that process wrote to:
  what a process left half done before the session slept or restarted is stopped, and so is one
  that has not written for six hours.
- Who started whom: the `pane=<id> name=<name>` line spawn-agent prints, matched to the card in
  that pane under that name (a pane id comes back once its tab is gone). Messages: the session's
  SendMessage calls, and the messages that came in (Claude Code records the sender's name and the
  pipe it writes from). A name is matched only when one session on the board goes by it; a reply
  to a pipe, by the session that runs on that pipe now, else by who wrote from it.

What it costs: a helper's meta file and the head and tail of its transcript are read once and
again only when they change (time and size); a session's folder is listed again only when it
changes. The links come from a read of each session's transcript in the background, once in
full and then only what it gained, parsing only the lines with a marker (spawn-agent,
SendMessage, a message from another session). A helper's whole conversation is read only when
its window is open.

`GET /api/session/<key>` carries `helpers` and `workflows`; `GET /api/session/<key>/helper/<id>`
one helper with its conversation, where the id only picks among that session's own helpers. The
board payload has each item's `helpers` (counts and the newest at work) and `links`. Code:
`src/helpers.mjs`, `src/links.mjs`, `web/helpers.js` (the window), `web/helper-model.js`.

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
- On time by default: a session that works gets the text right away, and Claude Code queues it
  into the running turn the way your own mid-turn messages arrive. With `--idle` (or the switch
  on the entry in the panel or the sheet) it waits until the session is free instead.
- Either way, a session that waits on a dialog (typing would answer it) or has text the user
  started typing in its input box (read from the screen as herdr-wake does: dim suggestions do
  not count) is not touched: the scheduler tries again every tick (15 s) and sends once it can.
  After `scheduleWaitMin` (240) minutes of trying, the run is logged as missed: a one-off entry
  goes, a cron one moves to its next time.
- An entry belongs to the session it is for. After `/clear`, which gives the session a new id,
  it goes to the Claude session now in the same pane and folder (the folder herdr gives the
  pane, not the shell's after a `cd`), and the prompt says it was set before `/clear`.
- `--session` sets one for another session; the tag then names who set it,
  `[board reminder from <name>] <text>`, since the receiver takes it as a prompt. Control
  characters are taken out of the text.
- A cron entry whose session stays gone for 3 runs in a row is dropped (logged as removed).
- Delivery is at least once: a board that dies between typing the text and recording the run
  sends it again once its claim expires (5 minutes).
- With no board running the scheduler, `board remind` says so; the entry goes out once one runs.
- At most two sleeping sessions are woken at once. An entry cancelled while its session wakes
  up is not sent.
- Runs that came due while the board was off: a one-off is sent once, saying how late it is; a
  cron entry sends one prompt for all the runs it missed, saying how many. Time the board was
  off does not count against the wait.
- A reminder prompt is not the user writing, nor is a background task reporting back
  (`<task-notification>`): the hook leaves the card's `ask` in place, and a question the agent
  asked still waits for you. A column
  you dragged the card to goes, as with any work of the session.
- One file per entry in `%LOCALAPPDATA%\herdr\plugins\agent-board\schedule\<id>.json`, written
  under the same per-file lock as the cards, so an agent cancelling an entry while the
  scheduler marks its run never brings it back. Before sending, the scheduler claims the entry
  in its file: a second board running at the same time (a restart that overlaps) never sends a
  run twice. `log.jsonl` there keeps the last 200 runs.
- The scheduler runs in the web board's server (`src/scheduler.mjs`), one per machine since
  only one board holds the port; with `web: false` the terminal board runs it.
- At most 30 entries per session.
- The terminal board shows `⏰` (`⏳` for one that waits until the session is free) and the soonest
  time by a card's age, the count in its header.

## Notifications

On Windows, `herdr plugin action invoke agent-board.notifications` (`node src/install.mjs
--toast`) adds Claude Code hooks that show a Windows notification in the agent's own words:

- a session finished its turn: its last reply;
- it needs a permission or asks for input (Notification, `permission_prompt` and
  `elicitation_dialog`): Claude's message;
- it asks a question (AskUserQuestion): the question.

The title is `<workspace> · <session>`. None comes for the pane you are looking at (focused in
herdr, with the terminal in front), for a subagent, or for a `claude -p` run inside a session. A
newer one replaces the pane's last one in the notification center. They make no sound (herdr
plays its own). A click opens that session on the web board when the board runs and has it (as
`src/web-open.mjs --pane` does); else herdr goes to the pane and the terminal comes to the front.

The click goes through a `claude-pane:<pane id>` link, a URL protocol the script registers for
the current user (`HKCU\Software\Classes\claude-pane`, and the app id `Herdr.ClaudeAgent` that
names the notifications). Any program or page can open such a link, so the handler takes nothing
but a pane id (`w1:p2`) and only shows or focuses that pane.

Keep herdr's own notifications off (`[ui.toast] delivery = "off"`, herdr's default), or each
comes twice; `board doctor` says when they are on, and when another hook with "toast" in its
command shows them too (a script of your own from before: take it out of settings.json). `node src/install.mjs --no-toast` takes the
hooks out again (the protocol entry stays; it only ever opens a pane). The hooks run
`powershell -File src\toast.ps1` from the plugin's folder, in the background, so Claude does not
wait for them. To see one, from a herdr pane (`force` shows it for the pane you are in):

```powershell
'{"hook_event_name":"Stop","last_assistant_message":"Hello"}' | powershell -NoProfile -File src\toast.ps1 force
```

On Linux and macOS the board shows none; herdr's own (`delivery = "system"`) say that a session
finished, without its words.

## Language

English and Russian. Settings (the gear) on the web board's toolbar switches between them; the
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

Code: `src/server.mjs`, `web/` (no build step, no dependencies; springs in `web/spring.js`, the
sheet's place in `web/panel.js` with its geometry in `web/panel-layout.js`).

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

New sessions (`src/launch.mjs`, `web/launch.js`): `GET /api/launch/options` (herdr's workspaces,
recent folders, the launcher), `POST /api/fs/dirs` (the subfolders of a folder, or the drives),
`POST /api/launch` (starts one in the background; its progress is `launches` in the board
payload), `POST /api/launch/<id>/dismiss` and `/focus`. `POST /api/launch` also needs the page's
own `Origin` when the browser sends one, and fresh herdr data like every action through herdr.
Renaming: `POST /api/session/<key>/rename` with `{ name, claude }`.

Setup (`src/setup.mjs`, `web/setup.js`): `GET /api/setup` runs the checks again and answers
`{ checks, todo, sig }`; the board payload has `setup: { todo, sig }` from the last check.

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
  --idle                  (remind, every) wait until the session is free, not on time
board schedule [--all]    this session's entries (every session's)
board unschedule <id|all> remove an entry (all: every entry of this session)
--session <id|name|pane>  for another session's card
board doctor              what is set up on this computer, and what is missing
spawn-agent --name <Name> --cwd <folder> [--brief-file <file>]   a new session in a herdr tab
```

## Settings

`%APPDATA%\herdr\plugins\config\agent-board\config.json`: `language` (`auto`, `en`, `ru`),
categories (id, title, color, folders that guess the category), `placement` (`workspace`
default: the board lives in a workspace of its own and stays open; `tab`; `overlay`),
`refreshSec`, `wakeUrl` (herdr-wake router), `scheduleWaitMin` (how long a due entry waits for a
busy session, 240), `port` (web board, 12422), `web` (false turns the
web board off), `terminal` (false turns the web board's [terminal](#terminal) off), `browser`
(path for the app window), `terminalTitle` (window title pattern to
raise, default `<COMPUTERNAME>:*`), `raiseTerminal`, `launch` (how new sessions start: `claude`,
`command`, `agent`, `args`, `timeoutSec`, see [New sessions](#new-sessions)).

Cards: `%LOCALAPPDATA%\herdr\plugins\agent-board\cards\<session id>.json`.

Writes to the same card use a per-card directory lock (`<session id>.json.lock`) around the
read/merge/rename. Contention waits at most two seconds, then reports an error without replacing
the card. Locks are released on ordinary errors. A writer killed mid-write leaves its lock
behind; a write holds it for milliseconds, so one older than 30 seconds is taken over by the
next writer. A card write the board itself fails at is retried on its next refresh.
