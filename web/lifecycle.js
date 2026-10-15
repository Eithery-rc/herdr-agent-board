// Resume always opens a new transport and fetches an uncached snapshot. Epochs
// and the first SSE event keep delayed replies from restoring an older board.
export function boardConnection({ source, snapshot, data, connected }) {
  let epoch=0, stream=null, controller=null
  function suspend() {
    ++epoch;stream?.close();controller?.abort();connected(false)
  }
  function resume() {
    suspend()
    const current=epoch
    controller=new AbortController()
    let eventReceived=false, transportReady=false, hasSnapshot=false
    stream=source()
    stream.onopen=()=>{if(current===epoch){transportReady=true;if(hasSnapshot)connected(true)}}
    stream.onerror=()=>{if(current===epoch){transportReady=false;connected(false)}}
    stream.onmessage=event=>{
      if(current!==epoch)return
      try {const value=JSON.parse(event.data);if(!Array.isArray(value.items))return;eventReceived=true;hasSnapshot=true;transportReady=true;data(value);connected(true)}catch{}
    }
    snapshot(controller.signal).then(value=>{
      if(current!==epoch||eventReceived||!Array.isArray(value.items))return
      hasSnapshot=true;data(value);connected(transportReady)
    }).catch(()=>{if(current===epoch&&!eventReceived)connected(false)})
  }
  return {resume,suspend}
}

// A single sentinel protects all open layers. Back closes only the top layer;
// manual close consumes the sentinel only when the last dialog is gone.
export function dialogHistory({ history, mobile, isOpen, closeTop }) {
  let armed=false,pending=false
  const marker='agentBoardDialog'
  const state=()=>({...history.state,[marker]:true})
  function sync() {
    if(pending)return
    if(isOpen() && (mobile()||armed) && !armed){history.pushState(state(),'');armed=true}
    else if(!isOpen()&&armed){armed=false;pending=true;history.back()}
  }
  function pop() {
    if(pending){pending=false;sync();return}
    if(armed){armed=false;closeTop();sync()}
    else if(history.state?.[marker]){const next={...history.state};delete next[marker];history.replaceState(next,'')}
  }
  // A reload closes dialogs but may leave our sentinel in the current entry.
  if(history.state?.[marker] && !isOpen()){pending=true;history.back()}
  return {sync,pop}
}
