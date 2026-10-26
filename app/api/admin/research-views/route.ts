import { NextResponse } from 'next/server'
import { isAdminAuthenticated } from '@/lib/admin-auth'
import { supabaseAdmin } from '@/lib/supabase-admin'
export async function GET(request:Request) {
 if(!(await isAdminAuthenticated()))return NextResponse.json({error:'管理者認証が必要です。'},{status:401})
 const url=new URL(request.url),type=url.searchParams.get('type')||'overview',sid=url.searchParams.get('sessionId')
 const raw=url.searchParams.get('offset')||'0'
 if(!/^\d+$/.test(raw)||!Number.isSafeInteger(Number(raw))||Number(raw)>1000000)return NextResponse.json({error:'取得位置が不正です。'},{status:400})
 if(sid&&!/^[a-f0-9-]{36}$/i.test(sid))return NextResponse.json({error:'授業回が不正です。'},{status:400})
 const views:Record<string,string>={overview:'v_analysis_session_overview',posts:'v_analysis_posts_and_replies',logs:'v_analysis_session_logs'}
 if(!views[type])return NextResponse.json({error:'取得種別が不正です。'},{status:400})
 try {
  let q=supabaseAdmin.from(views[type]).select('*')
  if(type==='overview')q=q.order('session_number',{ascending:false}).order('session_id')
  else if(type==='posts')q=q.order('post_created_at').order('human_post_id')
  else q=q.order('created_at').order('log_id')
  if(sid&&type!=='overview')q=q.eq('session_id',sid)
  const offset=Number(raw)
  const {data,error}=await q.range(offset,offset+200)
  if(error)throw error
  const rows=data||[]
  return NextResponse.json({data:rows.slice(0,200),hasMore:rows.length>200,nextOffset:offset+Math.min(200,rows.length),analysisOnly:true},{headers:{'Cache-Control':'no-store'}})
 } catch {return NextResponse.json({error:'研究データを取得できませんでした。0件と判断せず、再試行してください。'},{status:503})}
}
