 'use client'
import { useEffect, useState } from 'react'
import { classState } from '@/lib/class-state'
import type { SessionControlData } from './AdminSessionControl'
export default function ClassStatus({ control }: { control: SessionControlData }) {
 const [now, setNow] = useState(() => Date.now())
 useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer) }, [])
 const state = classState(control, now)
 const hours = Math.floor(state.remainingMinutes / 60), minutes = state.remainingMinutes % 60
 return <section aria-label="授業の状態" style={{padding:'18px 20px',marginBottom:20,border:'1px solid #bcdacb',borderRadius:14,background:state.active?'#effbf4':'#f3f6f9'}}>
   <div style={{display:'flex',alignItems:'baseline',gap:16,flexWrap:'wrap'}}><strong style={{fontSize:28,color:state.active?'#166534':'#475569'}}>{state.label}</strong>{state.active&&<span style={{fontSize:15,color:'#526273'}}>開始から{state.elapsedMinutes}分</span>}</div>
   {state.active&&<p style={{fontSize:13,margin:'6px 0',color:state.remainingMinutes<=10?'#c45b08':'#526273'}}>自動停止まで {hours?`${hours}時間`:''}{minutes||!hours?`${minutes}分`:''}</p>}
   <p style={{fontSize:12,color:'#64748b',margin:'6px 0 0'}}>開始から120分で、AI・音声・投影が自動停止します。</p>
 </section>
}
