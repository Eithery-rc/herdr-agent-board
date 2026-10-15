// Read only the dedicated, existing usagebar statusLine cache. Never reads auth,
// settings, ~/.claude.json, keychains or provider APIs, and never writes a cache.
import { lstatSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { CLAUDE_DIR } from './paths.mjs'
const pct = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100
export function localUsage(directory = join(CLAUDE_DIR,'herdr-usagebar'), now = Date.now()) {
  const context = { available: false, observedAt: null, source: null }
  const unknown = { context, limits: { available:false, observedAt:null, source:'usagebar default-profile statusLine cache', sessionAccountVerified:false } }
  try {
    const path=join(directory,'claude-limits-latest.json')
    const stat=lstatSync(path)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size>65536) return unknown
    const data=JSON.parse(readFileSync(path,'utf8'))
    const at=data.fetchedAtMs
    if (typeof at!=='number'||!Number.isFinite(at)||at<=0||at>now+5000) return unknown
    const windows=[]
    for (const [key,minutes] of [['fiveHour',300],['sevenDay',10080]]) {
      const value=data[key]
      if (!value || !pct(value.usedPercentage)) continue
      const resetsAt=typeof value.resetsAt==='number'&&Number.isFinite(value.resetsAt)&&value.resetsAt>0?value.resetsAt*1000:null
      windows.push({minutes,usedPercentage:value.usedPercentage,resetsAt,expired:resetsAt!==null&&resetsAt<=now})
    }
    if (!windows.length) return unknown
    return {context,limits:{...unknown.limits,available:true,observedAt:at,ageMs:Math.max(0,now-at),stale:now-at>300000||windows.some(w=>w.expired),windows}}
  } catch {return unknown}
}
