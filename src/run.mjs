// What the board pane runs: keeps the terminal board (tui.mjs) going and restarts it when the
// plugin's code changes, so an update reaches the open board (and the web board it serves)
// without anyone touching herdr. Quitting the board (Ctrl+C) ends the pane as before; a crash
// leaves its error on screen and waits for the next code change.
import { spawn } from 'node:child_process'
import { readdirSync, statSync, watch } from 'node:fs'
import { join } from 'node:path'
import { ROOT } from './paths.mjs'

const RESTART = 75
let child = null
let wanted = false // a restart was asked for, so the exit that follows is not a quit

function start() {
  wanted = false
  child = spawn(process.execPath, [join(ROOT, 'src', 'tui.mjs')], { stdio: ['inherit', 'inherit', 'inherit', 'ipc'], env: process.env })
  child.on('exit', code => {
    if (code === RESTART || wanted) return setTimeout(start, 150)
    if (code === 0) process.exit(0)
    console.error(`\nagent-board stopped (exit ${code}). It starts again on the next code change.`)
    child = null
  })
}

// On Windows a plain read fires the watcher too (it updates the access time), and the hooks read
// these files on every prompt of every session: restart only when a file really changed.
const SRC = join(ROOT, 'src')
const stamp = () =>
  readdirSync(SRC)
    .filter(n => n.endsWith('.mjs'))
    .map(n => {
      const s = statSync(join(SRC, n), { throwIfNoEntry: false })
      return `${n}:${s?.mtimeMs}:${s?.size}`
    })
    .join('|')
let code = stamp()

let timer = null
watch(SRC, (_, name) => {
  if (name && !name.endsWith('.mjs')) return
  clearTimeout(timer)
  timer = setTimeout(() => {
    const now = stamp()
    if (now === code) return
    code = now
    if (!child) return start()
    wanted = true
    const old = child
    old.send('restart')
    // A board that does not answer is stopped the hard way.
    setTimeout(() => old.exitCode === null && old.kill(), 3000)
  }, 400)
})

start()
