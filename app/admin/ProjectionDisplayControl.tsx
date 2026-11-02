'use client'
import { useEffect, useRef, useState } from 'react'
export default function ProjectionDisplayControl({sessionId,disabled}:{sessionId:string;disabled:boolean}) {
  const [display,setDisplay]=useState<'simultaneous'|'staggered'|null>(null)
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
  async function change() {
    if(flight.current||!display||disabled)return
    flight.current=true;setBusy(true);setMessage('')
    const id=sessionId,next=display==='simultaneous'?'staggered':'simultaneous'
    try{
      const r=await fetch('/api/admin/projection-display',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sessionId:id,display:next}),signal:AbortSignal.timeout(10000)})
      const d=await r.json();if(!r.ok)throw Error(d.error)
      if(current.current===id){setDisplay(d.display);setMessage('次に表示する投稿から反映します。')}
    }catch(e){if(current.current===id)setMessage(e instanceof Error?e.message:'保存できませんでした。')}
    finally{if(current.current===id){flight.current=false;setBusy(false)}}
  }
  return <div style={{padding:'12px 0',borderTop:'1px dashed #d0c2e8'}}>
    <strong>投影の表示方式：{display==='staggered'?'時間差':display==='simultaneous'?'同時':'確認中'}</strong>{' '}
    <button type="button" onClick={()=>void change()} disabled={disabled||busy||!display} style={{padding:'8px 12px',borderRadius:8,border:'1px solid #214f7b',background:'#fff',color:'#214f7b',fontWeight:700}}>
      {busy?'保存中…':display==='staggered'?'同時表示に戻す':'時間差表示を試す'}
    </button>
    <p style={{fontSize:12,marginBottom:0}}>教授アプリ0.1.6以降に対応。同時：従来の表示。時間差：人間投稿を先に出し、生成後のAI返信を線でつなぎます。AI条件・生成内容は変わりません。</p>
    {message&&<p role="status">{message}</p>}
  </div>
}
