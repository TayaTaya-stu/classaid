import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { verifyRoomAccess } from '@/lib/room-access'
export async function POST(request: Request, context:{params:Promise<{roomSlug:string}>}) {
  try {
    const {roomSlug}=await context.params
    const access=await verifyRoomAccess(roomSlug)
    if (!access) return NextResponse.json({error:'今回のQRから入り直してください。'},{status:403})
    const body=await request.json().catch(()=>null)
    if (!body || !Number.isSafeInteger(body.postId) || body.postId<1 || typeof body.liked!=='boolean') return NextResponse.json({error:'入力が不正です。'},{status:400})
    const {data,error}=await supabaseAdmin.rpc('set_reaction_like',{
      p_session_id:access.session.id,p_room_id:access.room.id,p_participant_id:access.participant.id,
      p_auth_user_id:access.authUserId,p_post_id:body.postId,p_liked:body.liked,
    })
    if(error) return NextResponse.json({error:'いいねを保存できませんでした。再確認してください。'},{status:error.message.includes('session_closed')?409:503})
    return NextResponse.json(data)
  } catch {return NextResponse.json({error:'いいねを確認できません。'},{status:503})}
}
