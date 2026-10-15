import {test} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,writeFileSync,rmSync,symlinkSync,unlinkSync} from 'node:fs'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {localUsage} from '../src/usage.mjs'
function fixture(t){const dir=mkdtempSync(join(tmpdir(),'board-usage-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));return {dir,file:join(dir,'claude-limits-latest.json')}}
test('only known numeric cache fields leave the reader; zero is valid, context/account stay unknown',t=>{
 const {dir,file}=fixture(t),now=1000000
 writeFileSync(file,JSON.stringify({fetchedAtMs:now-1000,fiveHour:{usedPercentage:0,resetsAt:2000},sevenDay:{usedPercentage:50},secret:'must not leave reader'}))
 const out=localUsage(dir,now)
 assert.equal(out.limits.available,true);assert.equal(out.limits.windows[0].usedPercentage,0)
 assert.equal(out.limits.ageMs,1000);assert.equal(out.limits.stale,false)
 assert.equal(out.context.available,false);assert.equal(out.limits.sessionAccountVerified,false)
 assert.doesNotMatch(JSON.stringify(out),/must not leave/)
})
test('old/expired, malformed, future and missing caches never become invented fresh usage',t=>{
 const {dir,file}=fixture(t),now=1000000
 assert.equal(localUsage(dir,now).limits.available,false)
 writeFileSync(file,JSON.stringify({fetchedAtMs:1,fiveHour:{usedPercentage:90,resetsAt:10}}))
 assert.equal(localUsage(dir,now).limits.stale,true);assert.equal(localUsage(dir,now).limits.windows[0].expired,true)
 for(const data of ['bad',JSON.stringify({fetchedAtMs:now+6000,fiveHour:{usedPercentage:10}}),JSON.stringify({fetchedAtMs:now,fiveHour:{usedPercentage:'10'}}),JSON.stringify({fetchedAtMs:now,fiveHour:{usedPercentage:101}})]){
  writeFileSync(file,data);assert.equal(localUsage(dir,now).limits.available,false)
 }
 unlinkSync(file);const other=join(dir,'other.json');writeFileSync(other,'{}');symlinkSync(other,file)
 assert.equal(localUsage(dir,now).limits.available,false)
})
