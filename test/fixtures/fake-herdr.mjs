// Only file-backed canned replies; never loads or contacts Herdr.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { basename } from 'node:path'
// A real script (a test's stand-in launcher) inherits this preload too: it runs as itself.
if (!/\.m?js$/.test(process.argv[1] ?? '')) {
  const args = [basename(process.argv[1]), ...process.argv.slice(2)]
  appendFileSync(process.env.FAKE_HERDR_LOG, `${JSON.stringify(args)}\n`)
  const state = JSON.parse(readFileSync(process.env.FAKE_HERDR_STATE, 'utf8'))
  const key = state[args.slice(0, 3).join(' ')] ? args.slice(0, 3).join(' ') : args.slice(0, 2).join(' ')
  let reply = state[key]
  if (!reply) throw new Error(`Unexpected fake command: ${args.join(' ')}`)
  // { seq: [...] }: one reply per call in turn, the last one from then on (a screen that changes).
  if (reply.seq) {
    const counter = `${process.env.FAKE_HERDR_STATE}.${key.replace(/[^\w-]+/g, '_')}.n`
    const n = existsSync(counter) ? Number(readFileSync(counter, 'utf8')) : 0
    writeFileSync(counter, String(n + 1))
    reply = reply.seq[Math.min(n, reply.seq.length - 1)]
  }
  if (reply.waitFor) {
    const deadline = Date.now() + 5000
    while (!existsSync(reply.waitFor)) {
      if (Date.now() > deadline) throw new Error('Fake response gate timed out')
      await new Promise(resolve => setTimeout(resolve, 10))
    }
  }
  if (reply.text !== undefined) {
    // Commands that print plain text (agent read, pane read).
    process.stdout.write(reply.text)
  } else if (reply.error) {
    console.error(JSON.stringify({ error: { code: reply.code, message: reply.error } }))
    process.exitCode = 1
  } else {
    console.log(JSON.stringify({ result: reply.result ?? null }))
  }
  // This module is preloaded before Node tries to resolve the fake CLI's command as a file.
  process.exit(process.exitCode ?? 0)
}
