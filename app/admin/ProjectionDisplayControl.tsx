'use client'
import { useEffect, useRef, useState } from 'react'
export default function ProjectionDisplayControl({sessionId,disabled}:{sessionId:string;disabled:boolean}) {
  const [display,setDisplay]=useState<'simultaneous'|'staggered'|'staggered_random'|null>(null)
  const [busy,setBusy]=useState(false)
  const [message,setMessage]=useState('')
  const flight=useRef(false)
  const current=useRef<string|null>(sessionId)
  useEffect(()=>{
    const abort=new AbortController()
    current.current=sessionId
    void fetch(`/api/admin/projection-display?sessionId=${encodeURIComponent(sessionId)}`,{cache:'no-store',signal:abort.signal})
      .then(async r=>{const d=await r.json();if(!r.ok)throw Error(d.error);if(!abort.signal.aborted)setDisplay(d.display)})
      .catch(e=>{if(!abort.signal.aborted)setMessage(e instanceof Error?e.message:'取得できませんでした。')})
    return()=>{current.current=null;abort.abort()}
  },[sessionId])
  async function change(next:'simultaneous'|'staggered'|'staggered_random') {
    if(flight.current||!display||disabled||display===next)return
    flight.current=true;setBusy(true);setMessage('')
    const id=sessionId
    try{
      const r=await fetch('/api/admin/projection-display',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sessionId:id,display:next}),signal:AbortSignal.timeout(10000)})
      const d=await r.json();if(!r.ok)throw Error(d.error)
      if(current.current===id){setDisplay(d.display);setMessage('次に表示する投稿から反映します。')}
    }catch(e){if(current.current===id)setMessage(e instanceof Error?e.message:'保存できませんでした。')}
    finally{if(current.current===id){flight.current=false;setBusy(false)}}
  }
  return <div style={{padding:'12px 0',borderTop:'1px dashed #d0c2e8'}}>
    <strong>投影の表示方式：{display==='staggered'?'一定間隔':display==='staggered_random'?'ランダム間隔':display==='simultaneous'?'同時':'確認中'}</strong>
    <div role="group" aria-label="投影の表示方式" style={{display:'flex',gap:8,flexWrap:'wrap',marginTop:8}}>
      {([['simultaneous','同時'],['staggered','一定間隔'],['staggered_random','ランダム間隔']] as const).map(([value,label])=><button key={value} type="button" aria-pressed={display===value} onClick={()=>void change(value)} disabled={disabled||busy||!display} style={{padding:'8px 12px',borderRadius:8,border:'1px solid #214f7b',background:display===value?'#214f7b':'#fff',color:display===value?'#fff':'#214f7b',fontWeight:700}}>{label}</button>)}
    </div>
    <p style={{fontSize:12,marginBottom:0}}>時間差は試験版0.1.8専用です。完成したペアを受け取り、AIの吹き出しが後ろから横に流れてきます。一定間隔は約0.6秒、ランダムは約0.45～0.75秒（画面・速度により間隔を抑えます）。表示名は「学生AI」、線と色でつながります。0.1.5～0.1.7は従来の同時表示です。</p>
    {message&&<p role="status">{message}</p>}
  </div>
}
