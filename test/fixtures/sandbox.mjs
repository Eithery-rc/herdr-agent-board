import { spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const root = fileURLToPath(new URL('../../', import.meta.url))
const runner = fileURLToPath(new URL('./runner.mjs', import.meta.url))
const fake = fileURLToPath(new URL('./fake-herdr.mjs', import.meta.url))

export function sandbox(t) {
  const dir = mkdtempSync(join(tmpdir(), 'board-regression-'))
  const children = []
  const env = {
    HOME: join(dir, 'home'), USERPROFILE: join(dir, 'home'),
    APPDATA: join(dir, 'config'), LOCALAPPDATA: join(dir, 'state'),
    TMPDIR: dir, TMP: dir, TEMP: dir,
    PATH: dirname(process.execPath),
    ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
    HERDR_BIN_PATH: fake,
    FAKE_HERDR_STATE: join(dir, 'fake.json'), FAKE_HERDR_LOG: join(dir, 'calls.jsonl'),
  }
  for (const name of ['HOME', 'APPDATA', 'LOCALAPPDATA']) mkdirSync(env[name], { recursive: true })
  writeFileSync(env.FAKE_HERDR_LOG, '')
  t.after(async () => {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill()
    await Promise.all(children.map(child => child.exited))
    rmSync(dir, { recursive: true, force: true })
  })
  function child(args, input) {
    const proc = spawn(process.execPath, args, { cwd: root, env: { ...env, TEST_INPUT: JSON.stringify(input) }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })
    children.push(proc)
    proc.messages = []
    proc.on('message', message => proc.messages.push(message))
    let stdout = '', stderr = ''
    proc.stdout.on('data', chunk => { stdout += chunk })
    proc.stderr.on('data', chunk => { stderr += chunk })
    proc.exited = new Promise((resolve, reject) => {
      proc.once('error', reject)
      proc.once('close', code => resolve({ code, stdout, stderr }))
    })
    return proc
  }
  return {
    dir, env,
    state(value) { writeFileSync(env.FAKE_HERDR_STATE, JSON.stringify(value)) },
    calls() { return readFileSync(env.FAKE_HERDR_LOG, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) },
    run(mode, input) { return child([runner, mode], input) },
    open(background = false) { return child([runner, 'open', ...(background ? ['--background'] : [])]) },
    cards: join(env.LOCALAPPDATA, 'herdr/plugins/agent-board/cards'),
  }
}

export async function until(fn, timeout = 5000) {
  const deadline = Date.now() + timeout
  while (!fn()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for test fixture')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}
