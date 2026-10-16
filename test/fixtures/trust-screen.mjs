// Claude Code's folder-trust dialog as herdr reads it from a pane (`agent read --ansi`), laid out
// as Claude draws it: the folder wrapped at the pane's width, the ❯ on the picked answer.
export function trustScreen(folder, { selected = 'no', width = 48, ansi = true } = {}) {
  const b = s => (ansi ? `\x1b[0m\x1b[1m${s}\x1b[0m` : s)
  const pick = which => (selected === which ? (ansi ? '\x1b[0m\x1b[38;2;177;185;249m❯ ' : '❯ ') : '  ')
  const lines = folder.match(new RegExp(`.{1,${width}}`, 'g')).map(s => ` ${b(s)}`)
  return [
    `PS ${folder}> claude`,
    `${ansi ? '\x1b[0m\x1b[38;2;255;193;7m' : ''}${'─'.repeat(80)}${ansi ? '\x1b[0m' : ''}`,
    ` ${b('Accessing workspace:')}`,
    ...lines,
    ' Quick safety check: Is this a project you created or one you trust? (Like your own code, a well-known',
    " open source project, or work from your team). If not, take a moment to review what's in this folder",
    ' first.',
    " Claude Code'll be able to read, edit, and execute files here.",
    ' Security guide',
    ` ${pick('no')}No, exit`,
    ` ${pick('yes')}Yes, I trust this folder`,
    ' Enter to confirm · Esc to cancel',
  ].join('\r\n')
}
