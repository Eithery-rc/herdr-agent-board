// Explicit local search in a single Claude project. Never scans sibling projects.
import { readdir, lstat, realpath, open } from 'node:fs/promises'
import { join, relative, isAbsolute } from 'node:path'
import { CLAUDE_DIR } from './paths.mjs'
const norm = s => /^[a-z]:/i.test(s) ? s.replace(/\\/g,'/').replace(/\/+$/,'').toLowerCase() : s.replace(/\/+$/,'')
export async function searchHistory(cwd, query, projects = join(CLAUDE_DIR,'projects'), excludeSession = null) {
  query=String(query??'').trim()
  if (!cwd || query.length<2 || query.length>100) return {results:[],invalid:true}
  const encoded=cwd.replace(/[\\/]+$/,'').replace(/[^a-zA-Z0-9]/g,'-')
  const results=[]
  let truncated=false,bytesRead=0,scanned=0
  try {
    const base=await realpath(projects),dir=await realpath(join(projects,encoded)),rel=relative(base,dir)
    if (rel.startsWith('..')||isAbsolute(rel)) return {results,unavailable:true}
    const entries=await readdir(dir,{withFileTypes:true})
    const files=[]
    for (const entry of entries.slice(0,2000)) {
      if (entry.name !== `${excludeSession}.jsonl` && entry.isFile() && /^[A-Za-z0-9_-]+\.jsonl$/.test(entry.name)) files.push({name:entry.name,stat:await lstat(join(dir,entry.name))})
    }
    files.sort((a,b)=>b.stat.mtimeMs-a.stat.mtimeMs)
    truncated=files.length>200||entries.length>2000
    for (const {name,stat} of files.slice(0,200)) {
      if (!stat.isFile()||stat.isSymbolicLink()) continue
      const length=Math.min(stat.size,1<<20,(8<<20)-bytesRead)
      if (length<=0) {truncated=true;break}
      const start=Math.max(0,stat.size-length),handle=await open(join(dir,name),'r')
      let buffer
      try {buffer=Buffer.alloc(length);const read=await handle.read(buffer,0,length,start);buffer=buffer.subarray(0,read.bytesRead)} finally {await handle.close()}
      bytesRead+=buffer.length;scanned++;if(start)truncated=true
      let offset=start
      for (const [index,line] of buffer.toString('utf8').split('\n').entries()) {
        const byteOffset=offset;offset+=Buffer.byteLength(line)+1
        if(start&&index===0)continue
        try {
          const row=JSON.parse(line)
          if(row.isSidechain||typeof row.cwd!=='string'||norm(row.cwd)!==norm(cwd)||!['user','assistant'].includes(row.type))continue
          const content=row.message?.content
          const text=typeof content==='string'?content:Array.isArray(content)?content.filter(b=>b.type==='text').map(b=>b.text).join('\n'):''
          const at=text.toLowerCase().indexOf(query.toLowerCase())
          if(at<0)continue
          const date=Date.parse(row.timestamp)
          results.push({session:name.slice(0,-6),excerpt:text.slice(Math.max(0,at-100),at+query.length+180),date:Number.isFinite(date)?new Date(date).toISOString():null,source:`${encoded}/${name}`,byteOffset})
          if(results.length===30){truncated=true;break}
        }catch{}
      }
      if(results.length===30||bytesRead>=(8<<20)){truncated=true;break}
    }
    return {results,truncated,scanned,bytesRead}
  }catch{return {results:[],unavailable:true,truncated}}
}
