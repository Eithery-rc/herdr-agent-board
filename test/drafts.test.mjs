import { test } from 'node:test'
import assert from 'node:assert/strict'
import { draftBook } from '../web/drafts.js'
import { messageGate } from '../src/message-gate.mjs'
test('draft text survives reload and session switches; completed old sends cannot clear new edits', () => {
  const data=new Map();const storage={getItem:k=>data.get(k)??null,setItem:(k,v)=>data.set(k,v),removeItem:k=>data.delete(k)}
  const drafts=draftBook(storage)
  const first=drafts.save('a','first');drafts.save('b','second')
  assert.equal(draftBook(storage).read('a').text,'first')
  const edited=drafts.save('a','edited');drafts.clear('a',first.id)
  assert.equal(drafts.read('a').id,edited.id)
  drafts.clear('b');assert.equal(drafts.read('b'),null)
  assert.equal(drafts.read('a').text,'edited')
})
test('duplicate clicks and completed replays send once; other sessions remain independent', async () => {
  const gate=messageGate();let release,calls=0
  const action=async()=>{calls++;await new Promise(r=>release=r);return {ok:true}}
  const first=gate('a','id-1',['a','text'],action)
  const duplicate=gate('a','id-1',['a','text'],action)
  assert.equal((await gate('a','id-2',['a','new'],action)).ok,false)
  assert.equal((await gate('b','id-1',['b','text'],async()=>({ok:true}))).ok,true)
  await Promise.resolve();release();await Promise.all([first,duplicate])
  assert.equal(calls,1)
  assert.equal((await gate('a','id-1',['a','text'],action)).ok,true)
  assert.equal(calls,1)
  assert.equal((await gate('a','id-1',['a','changed'],action)).ok,false)
})
test('interrupted preflight releases the guard and storage errors do not send anything', async () => {
  const gate=messageGate()
  await assert.rejects(gate('a','id',[],async()=>{throw new Error('offline')}),/offline/)
  assert.equal((await gate('a','new',[],async()=>({ok:true}))).ok,true)
  const drafts=draftBook({getItem(){throw Error('disabled')},setItem(){throw Error('disabled')}})
  assert.equal(drafts.read('a'),null);assert.equal(drafts.save('a','text').text,'text')
})

test('HTTP messages recheck a fresh snapshot and reject replaced sessions/offline without prompt', {timeout:15000}, async t => {
  const http=await import('node:http')
  const {writeFileSync}=await import('node:fs')
  const {join}=await import('node:path')
  const {sandbox,until}=await import('./fixtures/sandbox.mjs')
  const box=sandbox(t)
  const reserve=http.createServer();await new Promise(r=>reserve.listen(0,'127.0.0.1',r))
  const port=reserve.address().port;await new Promise(r=>reserve.close(r))
  const snapshot=session=>({panes:[{pane_id:'p',agent:'claude',agent_session:{value:session},agent_status:'idle'}],tabs:[],workspaces:[]})
  const state=session=>({'api snapshot':{result:{snapshot:snapshot(session)}},'agent get':{result:{agent:{agent_session:{value:session},agent_status:'idle'}}},'agent prompt':{result:{}}})
  box.state(state('a'))
  const proc=box.run('server',{port,categories:[{id:'other',title:'Other',color:'gray'}],wakeUrl:null,refreshSec:3600})
  await until(()=>proc.messages.some(m=>m.ready))
  const base=`http://127.0.0.1:${port}`
  async function fresh() {
    const deadline=Date.now()+5000
    while (Date.now()<deadline) {
      const board=await (await fetch(`${base}/api/board`)).json()
      if (!board.stale && board.items[0]?.session==='a') return
      await new Promise(r=>setTimeout(r,10))
    }
    throw Error('No fresh fixture board')
  }
  await fresh()
  const post=async id => (await fetch(`${base}/api/session/a/message`,{method:'POST',headers:{'content-type':'application/json','x-board':'1'},body:JSON.stringify({text:'hello',session:'a',requestId:id})})).json()
  box.state(state('b'))
  assert.equal((await post('replaced')).ok,false)
  assert.equal(box.calls().filter(a=>a[1]==='prompt').length,0)
  box.state(state('a'));proc.send('refresh');await fresh()
  const release=join(box.dir,'release-prompt')
  const delayed=state('a');delayed['agent prompt'].waitFor=release;box.state(delayed)
  const first=post('duplicate'),second=post('duplicate')
  await until(()=>box.calls().some(a=>a[1]==='prompt'))
  writeFileSync(release,'')
  assert.ok((await first).ok);assert.ok((await second).ok)
  assert.equal((await post('duplicate')).ok,true)
  assert.equal(box.calls().filter(a=>a[1]==='prompt').length,1)
  box.state({'api snapshot':{error:'offline'}})
  assert.notEqual((await post('offline')).ok,true)
  assert.equal(box.calls().filter(a=>a[1]==='prompt').length,1)
})

test('a pane with no Claude session id still takes messages, also without a request id', { timeout: 15000 }, async t => {
  const http = await import('node:http')
  const { sandbox, until } = await import('./fixtures/sandbox.mjs')
  const box = sandbox(t)
  const reserve = http.createServer()
  await new Promise(r => reserve.listen(0, '127.0.0.1', r))
  const port = reserve.address().port
  await new Promise(r => reserve.close(r))
  box.state({
    'api snapshot': { result: { snapshot: { panes: [{ pane_id: 'p', agent: 'codex', agent_status: 'idle' }], tabs: [], workspaces: [] } } },
    'agent get': { result: { agent: { agent_status: 'idle' } } },
    'agent prompt': { result: {} },
  })
  const proc = box.run('server', { port, categories: [{ id: 'other', title: 'Other', color: 'gray' }], wakeUrl: null, refreshSec: 3600 })
  await until(() => proc.messages.some(m => m.ready))
  const base = `http://127.0.0.1:${port}`
  for (let i = 0; i < 100; i++) {
    const board = await (await fetch(`${base}/api/board`)).json()
    if (board.items[0]?.key === 'pane-p') break
    await new Promise(r => setTimeout(r, 20))
  }
  const r = await (await fetch(`${base}/api/session/pane-p/message`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-board': '1' }, body: JSON.stringify({ text: 'hi', session: null }) })).json()
  assert.equal(r.ok, true, JSON.stringify(r))
  assert.deepEqual(box.calls().filter(a => a[1] === 'prompt'), [['agent', 'prompt', 'p', 'hi']])
})
