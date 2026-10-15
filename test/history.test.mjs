import {test} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,symlinkSync} from 'node:fs'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {searchHistory} from '../src/history.mjs'
function fixture(t) {
 const base=mkdtempSync(join(tmpdir(),'board-history-'));t.after(()=>rmSync(base,{recursive:true,force:true}))
 const cwd='/project-one',dir=join(base,'-project-one');mkdirSync(dir)
 return {base,cwd,dir}
}
const row=(cwd,text,extra={})=>JSON.stringify({cwd,type:'assistant',timestamp:'2026-01-01T00:00:00Z',message:{content:[{type:'text',text}]},...extra})
test('search stays in selected project, verifies colliding cwd, skips sidechains and includes provenance',async t=>{
 const {base,cwd,dir}=fixture(t)
 writeFileSync(join(dir,'session-a.jsonl'),['broken',row(cwd,'Needle: project note'),row('/project/one','needle: colliding path'),row(cwd,'needle: sidechain',{isSidechain:true})].join('\n'))
 writeFileSync(join(dir,'session-b.jsonl'),row(cwd,'needle: unknown date',{timestamp:'bad'}))
 mkdirSync(join(base,'-other'));writeFileSync(join(base,'-other/secret.jsonl'),row('/other','needle: other project'))
 const out=await searchHistory(cwd,'NEEDLE',base)
 assert.equal(out.results.length,2);assert.equal(out.scanned,2)
 const first=out.results.find(r=>r.session==='session-a'),second=out.results.find(r=>r.session==='session-b')
 assert.match(first.excerpt,/project note/);assert.equal(second.date,null)
 assert.equal(first.role,'assistant');assert.equal(first.text,'Needle: project note');assert.equal(typeof first.title,'string')
 assert.match(first.source,/-project-one\/session-a.jsonl/);assert.ok(first.byteOffset>0)
 assert.equal((await searchHistory(cwd,'absent',base)).results.length,0)
 assert.equal((await searchHistory(cwd,'project note',base,'session-a')).results.length,0)
})
test('limits results and bytes, rejects invalid queries and symlink escape',async t=>{
 const {base,cwd,dir}=fixture(t)
 writeFileSync(join(dir,'many.jsonl'),Array.from({length:50},()=>row(cwd,'needle')).join('\n'))
 const out=await searchHistory(cwd,'needle',base);assert.equal(out.results.length,30);assert.equal(out.truncated,true)
 assert.equal((await searchHistory(cwd,'x',base)).invalid,true)
 symlinkSync('/tmp',join(base,'-escape'))
 assert.equal((await searchHistory('/escape','needle',base)).unavailable,true)
 writeFileSync(join(dir,'tail.jsonl'),'x'.repeat(2<<20)+'\n'+row(cwd,'tail needle'))
 const tail=await searchHistory(cwd,'tail needle',base);assert.equal(tail.results.length,1);assert.ok(tail.bytesRead<=(8<<20))
})
