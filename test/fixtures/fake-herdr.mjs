// Only file-backed canned replies; never loads or contacts Herdr.
import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { basename } from 'node:path'
const args = [basename(process.argv[1]), ...process.argv.slice(2)]
appendFileSync(process.env.FAKE_HERDR_LOG, `${JSON.stringify(args)}\n`)
const state = JSON.parse(readFileSync(process.env.FAKE_HERDR_STATE, 'utf8'))
const reply = state[args.slice(0, 3).join(' ')] ?? state[args.slice(0, 2).join(' ')]
if (!reply) throw new Error(`Unexpected fake command: ${args.join(' ')}`)
if (reply.waitFor) {
  const deadline = Date.now() + 5000
  while (!existsSync(reply.waitFor)) {
    if (Date.now() > deadline) throw new Error('Fake response gate timed out')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}
if (reply.text !== undefined) {
  // Commands that print plain text (agent read).
  process.stdout.write(reply.text)
} else if (reply.error) {
  console.error(JSON.stringify({ error: { message: reply.error } }))
  process.exitCode = 1
} else {
  console.log(JSON.stringify({ result: reply.result ?? null }))
}
// This module is preloaded before Node tries to resolve the fake CLI's command as a file.
process.exit(process.exitCode ?? 0)
