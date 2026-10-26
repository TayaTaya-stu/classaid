import 'server-only'
import { cookies } from 'next/headers'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { verifySessionToken } from '@/lib/participant'

export type VerifiedRoomAccess = {
  session: {
    id: string
    sessionNumber: number
    status: string
    isLocked: boolean
  }
  room: {
    id: string
    roomSlug: string
    groupLabel: string
  }
  participant: {
    id: string
    displayName: string
  }
  authUserId: string
}

/**
 * サーバー側で Cookie と DB を照合し、学生が正当なルームアクセス権を持っているか検証する共通関数
 * - Cookie の署名、有効期限、形式（各ID、UUID形式のauthUserId等）を検証
 * - Cookie 内の roomSlug と引数の roomSlug の一致を検証
 * - DB 上で sessions, rooms, session_attendances, participant_auth_links の対応関係を厳密に照合
 * 
 * 不正、不一致、またはDBエラーの場合は null を返します。
 */
export async function verifyRoomAccess(roomSlug: string): Promise<VerifiedRoomAccess | null> {
  try {
    if (!roomSlug || typeof roomSlug !== 'string') {
      return null
    }

    const cookieStore = await cookies()
    const sessionCookie = cookieStore.get('classaid_session')?.value
    if (!sessionCookie) {
      return null
    }

    const payload = verifySessionToken(sessionCookie)
    if (!payload) {
      return null
    }

    // URLの roomSlug と Cookie 内の情報が一致しているか確認
    if (payload.roomSlug !== roomSlug.trim()) {
      return null
    }

    const {data,error}=await supabaseAdmin.rpc('verify_reaction_room_access',{
      p_session_id:payload.sessionId,p_room_id:payload.roomId,p_participant_id:payload.participantId,
      p_auth_user_id:payload.authUserId,p_room_slug:roomSlug.trim(),
    })
    if(error||!data||data.length!==1)return null
    const row=data[0]
    return {
      session:{id:row.session_id,sessionNumber:row.session_number,status:row.status,isLocked:row.is_locked},
      room:{id:row.room_id,roomSlug:row.room_slug,groupLabel:row.group_label},
      participant:{id:row.participant_id,displayName:row.display_name},authUserId:payload.authUserId,
    }
  } catch {return null}
}
