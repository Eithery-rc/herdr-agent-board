// A stand-in for a launcher such as spawn-agent: writes down what it was given and prints its
// pane; for a name with "fail" in it, it fails the way PowerShell reports a thrown error.
import { readFileSync, writeFileSync } from 'node:fs'
const [out, ...args] = process.argv.slice(2)
const i = args.indexOf('-BriefFile')
const brief = i >= 0 ? readFileSync(args[i + 1], 'utf8') : null
writeFileSync(out, JSON.stringify({ args, brief, cwd: process.cwd(), workspace: process.env.HERDR_WORKSPACE_ID ?? null, pane: process.env.HERDR_PANE_ID ?? null }))
if (args.some(a => /\bfail\b/i.test(a))) {
  console.error('Exception: C:\\tools\\spawn-agent.ps1:46\nLine |\n  46 |  …   throw "Claude in $pane waits for a dialog"\n     |      ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~\n     | Claude in wT:p9 waits for a dialog (folder trust?). Answer it in that tab.')
  process.exit(1)
}
console.log('pane=wT:p7 name=Stand-in agent=stand-in')
