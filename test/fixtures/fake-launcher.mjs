// A stand-in for a launcher such as spawn-agent: writes down what it was given and prints its
// pane. For a name with "fail" in it, it fails the way PowerShell reports a thrown error; with
// "hang" in it, it starts a descendant that would open a tab a little later, then never ends.
import { spawn } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
const [out, ...args] = process.argv.slice(2)
if (args[0] === '--late') {
  // The descendant: still alive after the launcher's timeout, it would write this.
  setTimeout(() => writeFileSync(out, 'opened a tab late'), 2500)
} else {
  const i = args.indexOf('-BriefFile')
  const brief = i >= 0 ? readFileSync(args[i + 1], 'utf8') : null
  writeFileSync(out, JSON.stringify({ args, brief, cwd: process.cwd(), workspace: process.env.HERDR_WORKSPACE_ID ?? null, pane: process.env.HERDR_PANE_ID ?? null }))
  if (args.some(a => /\bfail\b/i.test(a))) {
    console.error('Exception: C:\\tools\\spawn-agent.ps1:46\nLine |\n  46 |  …   throw "Claude in $pane waits for a dialog"\n     |      ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~\n     | Claude in wT:p9 waits for a dialog (folder trust?). Answer it in that tab.')
    process.exit(1)
  }
  if (args.some(a => /\bhang\b/i.test(a))) {
    spawn(process.execPath, [fileURLToPath(import.meta.url), `${out}.late`, '--late'], { stdio: 'ignore' })
    setInterval(() => {}, 1000)
  } else console.log('pane=wT:p7 name=Stand-in agent=stand-in')
}
