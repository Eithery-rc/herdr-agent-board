// Invoked only by tests with an explicit temporary HOME and fake Herdr.
// Only the CLI subprocesses preload the fake. Using Node itself as the executable
// also works on Windows, where execFile cannot execute a shebang script directly.
process.env.HERDR_BIN_PATH = process.execPath
process.env.NODE_OPTIONS = `--import=${new URL('./fake-herdr.mjs', import.meta.url).href}`
const mode = process.argv[2]
if (mode === 'open') {
  await import('../../src/open.mjs')
} else if (mode === 'send') {
  const { send } = await import('../../src/actions.mjs')
  const { item, cfg, text } = JSON.parse(process.env.TEST_INPUT)
  console.log(JSON.stringify(await send(cfg, item, text)))
} else if (mode === 'server') {
  const { startServer } = await import('../../src/server.mjs')
  const server = await startServer({ cfg: JSON.parse(process.env.TEST_INPUT), log: text => process.send({ log: text }) })
  process.send({ ready: true })
  process.on('message', async message => {
    if (message === 'refresh') {
      await server.refresh()
      process.send({ refreshed: true })
    }
  })
} else if (mode === 'write') {
  const { existsSync } = await import('node:fs')
  const { writeCard } = await import('../../src/store.mjs')
  const { key, patch, release, failPatch } = JSON.parse(process.env.TEST_INPUT)
  if (release) {
    Object.defineProperty(patch, 'held', { enumerable: true, get() {
      process.send({ held: true })
      const deadline = Date.now() + 5000
      const pause = new Int32Array(new SharedArrayBuffer(4))
      while (!existsSync(release)) {
        if (Date.now() > deadline) throw new Error('Write gate timed out')
        Atomics.wait(pause, 0, 0, 10)
      }
      return true
    } })
  }
  if (failPatch) Object.defineProperty(patch, 'bad', { enumerable: true, get() { throw new Error('patch failed') } })
  process.send({ attempting: true })
  try {
    writeCard(key, patch)
    process.send({ done: true })
  } catch (err) {
    process.send({ error: err.message })
  }
  process.disconnect()
} else {
  throw new Error(`Unknown test mode: ${mode}`)
}
