import { NextResponse } from 'next/server'
import { isAdminAuthenticated } from '@/lib/admin-auth'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { DISPLAY_EVENT, readProjectionDisplay } from '@/lib/projection-display'
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const headers={'Cache-Control':'no-store'}
async function sessionExists(id:unknown) {
  if(typeof id!=='string'||!uuid.test(id))return false
  const {data,error}=await supabaseAdmin.from('sessions').select('id,is_archived,admin_deleted_at,status')
    .eq('id',id).eq('room_mode','shared').maybeSingle()
  if(error)throw error
  return data&&!data.is_archived&&!data.admin_deleted_at&&!['completed','closed','locked'].includes(data.status)
}
export async function GET(request:Request) {
  if(!await isAdminAuthenticated())return NextResponse.json({error:'管理者認証が必要です。'},{status:401,headers})
  try{
    const id=new URL(request.url).searchParams.get('sessionId')
    if(!await sessionExists(id))return NextResponse.json({error:'操作できない授業回です。'},{status:400,headers})
    return NextResponse.json({display:await readProjectionDisplay(id!)},{headers})
  }catch{return NextResponse.json({error:'表示方式を取得できませんでした。'},{status:503,headers})}
}
export async function POST(request:Request) {
  if(!await isAdminAuthenticated())return NextResponse.json({error:'管理者認証が必要です。'},{status:401,headers})
  try{
    const text=await request.text()
    if(text.length>1024)return NextResponse.json({error:'入力が長すぎます。'},{status:413,headers})
    const b=JSON.parse(text)
    if(!b||!['simultaneous','staggered'].includes(b.display)||!await sessionExists(b.sessionId))return NextResponse.json({error:'授業回または表示方式が正しくありません。'},{status:400,headers})
    const {error}=await supabaseAdmin.from('event_logs').insert({session_id:b.sessionId,event_type:DISPLAY_EVENT,metadata:{display:b.display,version:'projection-display-v1'}})
    if(error)throw error
    return NextResponse.json({display:b.display},{headers})
  }catch{return NextResponse.json({error:'表示方式を保存できませんでした。'},{status:503,headers})}
}
