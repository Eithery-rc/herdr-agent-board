#!/usr/bin/env node
// spawn-agent: opens a new herdr tab, starts a Claude session in it, names it and hands it the
// brief. The board starts new sessions with it when config.json sets no `launch.command`, and
// agents start other sessions with it (the board links the two by what it prints).
//
//   spawn-agent --name <Name> --cwd <folder> [--label <tab label>]
//               [--brief-file <utf-8 file> | --brief <text>] [--workspace <herdr workspace id>]
//               [--timeout-sec 120] [--session-id <uuid>] [--pane <herdr pane id>]
//   PowerShell-style names work too: -Name, -Cwd, -Label, -BriefFile, -Brief, -Workspace, -TimeoutSec.
//
// What it types into the tab is `launch.claude` in the board's config.json (default: claude),
// so a launcher of your own (one that sets up Telegram topics, say) goes there. --pane starts
// Claude in that pane (at a shell prompt) instead of a new tab.
//
// Prints "pane=<id> name=<Name> agent=<herdr name>"; exits 1 with the reason when it fails.
// The board reads that line (src/launch.mjs) and finds who started whom by it (src/links.mjs).
import { readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { checkName, slugName, uniqueSlug } from '../web/launch-model.js'
import { loadConfig } from './config.mjs'
import { herdr, herdrText } from './herdr.mjs'

export const USAGE = 'spawn-agent --name <Name> --cwd <folder> [--label <tab label>] [--brief-file <file> | --brief <text>] [--workspace <herdr workspace id>] [--timeout-sec 120] [--session-id <uuid>] [--pane <pane id>]'

// Option names without dashes and case: --brief-file, -BriefFile and -brieffile are one.
const OPTIONS = { name: 'name', cwd: 'cwd', label: 'label', brieffile: 'briefFile', brief: 'brief', workspace: 'workspace', timeoutsec: 'timeoutSec', sessionid: 'sessionId', pane: 'pane', help: 'help', h: 'help' }
const NAME_ERRORS = {
  'launch.err.nameEmpty': '--name is empty',
  'launch.err.nameLong': '--name is longer than 60 characters',
  'launch.err.nameChars': '--name has control characters in it',
  'launch.err.nameStart': '--name must not start with - or /',
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** The command line as options: { name, cwd, label, briefFile, brief, workspace, timeoutSec, sessionId, pane, help }. */
export function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i++) {
    const arg = String(argv[i])
    const m = /^--?([A-Za-z][A-Za-z-]*)(?:[=:]([\s\S]*))?$/.exec(arg)
    if (!m) throw new Error(`unexpected argument "${arg}". ${USAGE}`)
    const key = OPTIONS[m[1].toLowerCase().replace(/-/g, '')]
    if (!key) throw new Error(`unknown option ${arg.replace(/[=:][\s\S]*$/, '')}. ${USAGE}`)
    if (key === 'help') {
      out.help = true
      continue
    }
    let value = m[2]
    if (value === undefined) {
      if (i + 1 >= argv.length) throw new Error(`${arg} needs a value`)
      value = String(argv[++i])
    }
    out[key] = value
  }
  if (out.help) return out
  if (out.name === undefined) throw new Error(`--name is missing. ${USAGE}`)
  out.name = out.name.trim()
  const bad = checkName(out.name)
  if (bad) throw new Error(NAME_ERRORS[bad] ?? bad)
  if (!out.cwd?.trim()) throw new Error(`--cwd is missing. ${USAGE}`)
  if (out.briefFile !== undefined && out.brief !== undefined) throw new Error('give --brief-file or --brief, not both')
  const timeout = out.timeoutSec === undefined ? 120 : Number(out.timeoutSec)
  if (!Number.isFinite(timeout) || timeout <= 0) throw new Error(`--timeout-sec must be a number of seconds, not "${out.timeoutSec}"`)
  out.timeoutSec = timeout
  if (out.sessionId !== undefined && !UUID.test(out.sessionId)) throw new Error(`--session-id must be a UUID, not "${out.sessionId}"`)
  return out
}

/** `launch.claude` from config.json as a list: the program and its arguments. */
export function claudeCommand(setting) {
  if (setting === undefined || setting === null || setting === '') return ['claude']
  const list = typeof setting === 'string' ? [setting] : setting
  if (!Array.isArray(list) || !list.length || !list.every(s => typeof s === 'string') || !list[0].trim()) {
    throw new Error('launch.claude in the board’s config.json must be a program, or a list of the program and its arguments: ["claude", "--model", "opus"]')
  }
  return list
}

/** Whether the command picks its session itself, so no --session-id may go with it. */
export const choosesSession = command => command.some(a => /^(--session-id|-r|--resume|-c|--continue)(=|$)/.test(a))

/**
 * A command line for the tab's shell prompt (PowerShell, bash, zsh or fish): plain words as they
 * are, anything else in single quotes, which all of them take literally. The program cannot be
 * quoted (PowerShell would read a quoted word as a string, not a command), so it must be a plain
 * word: a name on PATH, or a path without spaces.
 */
export function shellLine(argv, win = process.platform === 'win32') {
  const plain = win ? /^[\w=:./\\~+-]+$/ : /^[\w=:./~+-]+$/
  return argv
    .map((arg, i) => {
      const s = String(arg)
      if (i === 0 && s.startsWith('-')) throw new Error(`launch.claude: the program "${s}" starts with a dash`)
      if (plain.test(s)) return s
      if (i === 0) throw new Error(`launch.claude: "${s}" is typed at the tab's shell prompt, so the program must be a name on PATH or a path without spaces or quotes`)
      if (/['\u0000-\u001f\u007f]/.test(s)) throw new Error(`launch.claude: the argument ${JSON.stringify(s)} cannot be typed into a shell as it is (a single quote or a control character)`)
      return `'${s}'`
    })
    .join(' ')
}

/** A folder as given, absolute: ~ is the home folder, a relative one is from here. */
export function absoluteDir(p) {
  const s = String(p).trim().replace(/^["']|["']$/g, '')
  return resolve(/^~([\\/]|$)/.test(s) ? homedir() + s.slice(1) : s)
}

const sleep = ms => new Promise(r => setTimeout(r, ms))
const stalled = err => /agent_prompt_stalled/.test(`${err?.code} ${err?.message}`)
const screen = pane => herdrText(['pane', 'read', pane, '--source', 'visible'], 5000).catch(() => '')

/** Type a line into the agent's prompt; a leading dash would read as an option to herdr. */
const prompt = (pane, text) => herdr(['agent', 'prompt', pane, /^-/.test(text) ? ` ${text}` : text])

export async function spawnAgent(o, { claude = ['claude'], log = () => {} } = {}) {
  const cwd = absoluteDir(o.cwd)
  let isDir = false
  try {
    isDir = statSync(cwd).isDirectory()
  } catch {}
  if (!isDir) throw new Error(`No such folder: ${cwd}`)
  const workspace = o.workspace || process.env.HERDR_WORKSPACE_ID
  if (!o.pane && !workspace) throw new Error('No herdr workspace: run it inside herdr or pass --workspace')
  const label = o.label?.trim() || o.name
  const text = o.briefFile !== undefined ? readFileSync(o.briefFile, 'utf8').replace(/^﻿/, '').trim() : (o.brief ?? '').trim()
  const command = shellLine(o.sessionId && !choosesSession(claude) ? [...claude, '--session-id', o.sessionId] : claude)

  // The tab is labelled before Claude runs: a launcher may name things after it (a Telegram topic).
  let pane = o.pane
  if (pane) {
    const tab = (await herdr(['pane', 'get', pane]))?.pane?.tab_id
    if (tab) await herdr(['tab', 'rename', tab, label]).catch(() => {})
  } else {
    pane = (await herdr(['tab', 'create', '--workspace', workspace, '--cwd', cwd, '--label', label, '--no-focus'])).root_pane.pane_id
  }
  log(`pane ${pane}: ${command}`)
  await herdr(['pane', 'run', pane, command])

  const deadline = Date.now() + o.timeoutSec * 1000
  let ready = false
  while (Date.now() < deadline) {
    await sleep(1500)
    let p = null
    try {
      p = (await herdr(['pane', 'get', pane], 10_000))?.pane
    } catch (err) {
      if (/not.?found|no such/i.test(err.message)) throw new Error(`The tab of ${pane} was closed before Claude got ready`)
      continue
    }
    if (p?.agent !== 'claude') continue
    if (p.agent_status === 'idle' || p.agent_status === 'done') {
      ready = true
      break
    }
    if (p.agent_status === 'blocked') {
      throw new Error(`Claude in ${pane} waits for a dialog (folder trust?). Answer it in that tab, then: herdr agent prompt ${pane} "/rename ${o.name}" and send the brief.`)
    }
  }
  if (!ready) throw new Error(`Claude did not get ready in ${pane} within ${o.timeoutSec} s`)

  // herdr's own name for targeting: [a-z][a-z0-9_-]{0,31}, not one another agent has.
  let agent
  try {
    const others = ((await herdr(['agent', 'list']))?.agents ?? []).filter(a => a.pane_id !== pane)
    agent = uniqueSlug(slugName(o.name), new Set(others.map(a => a.name).filter(Boolean)))
    await herdr(['agent', 'rename', pane, agent])
  } catch {
    agent = pane
  }

  // /rename runs locally, no turn: herdr never sees it working and calls the prompt stalled.
  try {
    await prompt(pane, `/rename ${o.name}`)
  } catch (err) {
    if (!stalled(err)) throw err
  }
  for (let i = 0; i < 10; i++) {
    await sleep(500)
    if (/Session renamed/i.test(await screen(pane))) break
  }

  // Right after a slash command Claude can drop typed text, and a short turn can end before herdr
  // sees it working: both read as "agent_prompt_stalled". Text still on screen (or a pasted-text
  // chip) gets an Enter; text that vanished is typed again.
  if (text) {
    let sent = false
    for (let i = 1; i <= 3 && !sent; i++) {
      await sleep(800)
      try {
        await prompt(pane, text)
        sent = true
      } catch (err) {
        if (!stalled(err)) throw err
        const shown = await screen(pane)
        if (shown.includes(text.split('\n')[0].slice(0, 30)) || /Pasted text/.test(shown)) {
          await herdr(['pane', 'send-keys', pane, 'enter']).catch(() => {})
          sent = true
        }
      }
    }
    if (!sent) throw new Error(`The brief did not reach Claude in ${pane}. Send it by hand: herdr agent prompt ${pane} "<brief>"`)
  }
  return { pane, name: o.name, agent }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const o = parseArgs(process.argv.slice(2))
    if (o.help) {
      console.log(USAGE)
    } else {
      const r = await spawnAgent(o, { claude: claudeCommand(loadConfig().launch?.claude) })
      console.log(`pane=${r.pane} name=${r.name} agent=${r.agent}`)
    }
  } catch (err) {
    console.error(`spawn-agent: ${err.message}`)
    process.exitCode = 1
  }
}
