import {test} from 'node:test'
import assert from 'node:assert/strict'
import {boardConnection,dialogHistory} from '../web/lifecycle.js'
test('return/reconnect closes old streams and ignores delayed GET/events from old generations',async()=>{
 const streams=[],requests=[],received=[],states=[]
 const connection=boardConnection({source(){const s={closed:false,close(){this.closed=true}};streams.push(s);return s},snapshot:()=>new Promise(resolve=>requests.push(resolve)),data:d=>received.push(d.tag),connected:v=>states.push(v)})
 connection.resume();connection.resume()
 assert.equal(streams[0].closed,true)
 requests[0]({items:[],tag:'old'});streams[0].onmessage({data:JSON.stringify({items:[],tag:'old-event'})})
 streams[1].onmessage({data:JSON.stringify({items:[],tag:'new'})});requests[1]({items:[],tag:'late-get'})
 await Promise.resolve();assert.deepEqual(received,['new'])
 connection.suspend();assert.equal(states.at(-1),false)
 connection.resume();requests[2]({items:[],tag:'returned'});await Promise.resolve()
 assert.deepEqual(received,['new','returned'])
})
test('Back closes top dialog only; manual close consumes its entry and rapid reopening is preserved',()=>{
 let layers=[],backs=0,pushes=0
 const history={state:{other:1},pushState(s){this.state=s;pushes++},replaceState(s){this.state=s},back(){backs++}}
 const controller=dialogHistory({history,mobile:()=>true,isOpen:()=>layers.length>0,closeTop:()=>layers.pop()})
 layers.push('session');controller.sync();layers.push('preview');controller.sync()
 assert.equal(pushes,1)
 history.state={other:1};controller.pop();assert.deepEqual(layers,['session']);assert.equal(pushes,2)
 layers=[];controller.sync();assert.equal(backs,1)
 layers=['new-session'];controller.sync();history.state={other:1};controller.pop()
 assert.deepEqual(layers,['new-session']);assert.equal(pushes,3);assert.equal(history.state.other,1)
})
test('wide desktop does not add dialog history entries',()=>{
 let pushes=0
 const controller=dialogHistory({history:{pushState(){pushes++}},mobile:()=>false,isOpen:()=>true,closeTop(){}})
 controller.sync();assert.equal(pushes,0)
})

test('stale herdr data: herdr actions wait, the board’s own edits and previews go on', {timeout:15000}, async t=>{
 const http=await import('node:http');const {writeFileSync}=await import('node:fs');const {join}=await import('node:path')
 const {sandbox,until}=await import('./fixtures/sandbox.mjs');const box=sandbox(t)
 const reserve=http.createServer();await new Promise(r=>reserve.listen(0,'127.0.0.1',r));const port=reserve.address().port;await new Promise(r=>reserve.close(r))
 box.state({'api snapshot':{result:{snapshot:{panes:[{pane_id:'p',agent:'claude',agent_session:{value:'a'},agent_status:'idle'}],tabs:[],workspaces:[]}}}})
 const proc=box.run('server',{port,categories:[{id:'other',title:'Other',color:'gray'}],wakeUrl:null,refreshSec:3600})
 await until(()=>proc.messages.some(m=>m.ready))
 const url=`http://127.0.0.1:${port}`
 const deadline=Date.now()+5000
 while((await(await fetch(`${url}/api/board`)).json()).stale){if(Date.now()>deadline)throw Error('not fresh');await new Promise(r=>setTimeout(r,10))}
 box.state({'api snapshot':{error:'offline'}});proc.send('refresh');await until(()=>proc.messages.some(m=>m.log?.includes('offline')))
 const post=(path,body)=>fetch(url+path,{method:'POST',headers:{'content-type':'application/json','x-board':'1'},body:JSON.stringify(body)})
 assert.equal((await post('/api/session/a/focus',{})).status,409)
 assert.equal((await post('/api/session/a/message',{text:'must not send'})).status,409)
 // What the board does itself goes on without herdr: settings, card edits, opening files and links
 // (checked here by the answers they give, without opening anything).
 assert.equal((await post('/api/settings',{language:'ru'})).status,200)
 assert.equal((await post('/api/session/a/card',{doing:'still editable'})).status,200)
 assert.equal((await post('/api/open-url',{url:'javascript:alert(1)'})).status,400)
 assert.equal((await post('/api/fs/open',{path:join(box.dir,'missing.txt')})).status,404)
 const file=join(box.dir,'preview.txt');writeFileSync(file,'synthetic')
 assert.equal((await post('/api/fs/preview',{path:file})).status,200)
 assert.equal(box.calls().some(args=>args[0]==='agent'),false)
})


test('late GET after an SSE failure stays read-only until the stream reconnects',async()=>{
 let stream,resolveSnapshot
 const states=[]
 const connection=boardConnection({source(){stream={close(){}};return stream},snapshot:()=>new Promise(resolve=>resolveSnapshot=resolve),data(){},connected:value=>states.push(value)})
 connection.resume();stream.onerror();resolveSnapshot({items:[]});await Promise.resolve()
 assert.equal(states.at(-1),false)
 stream.onopen();assert.equal(states.at(-1),true)
})

test('reload consumes an abandoned dialog sentinel without closing a newly opened panel',()=>{
 let backs=0,pushes=0,open=false,closed=0
 const history={state:{agentBoardDialog:true},back(){backs++},pushState(state){this.state=state;pushes++},replaceState(state){this.state=state}}
 const controller=dialogHistory({history,mobile:()=>true,isOpen:()=>open,closeTop(){closed++;open=false}})
 assert.equal(backs,1)
 open=true;controller.sync();history.state=null;controller.pop()
 assert.equal(closed,0);assert.equal(open,true);assert.equal(pushes,1)
})
