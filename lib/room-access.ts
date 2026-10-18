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

    // 1. DB 上で session, room の実在と整合性を確認
    const { data: room, error: roomError } = await supabaseAdmin
      .from('rooms')
      .select('id, session_id, room_slug, group_label')
      .eq('id', payload.roomId)
      .eq('room_slug', roomSlug.trim())
      .maybeSingle()

    if (roomError || !room || room.session_id !== payload.sessionId) {
      return null
    }

    const { data: session, error: sessionError } = await supabaseAdmin
      .from('sessions')
      .select('id, session_number, status, is_locked')
      .eq('id', payload.sessionId)
      .maybeSingle()

    if (sessionError || !session) {
      return null
    }

    // 2. 出席情報 (session_attendances) の整合性を確認
    const { data: attendance, error: attendanceError } = await supabaseAdmin
      .from('session_attendances')
      .select('id, display_name')
      .eq('session_id', session.id)
      .eq('room_id', room.id)
      .eq('participant_id', payload.participantId)
      .maybeSingle()

    if (attendanceError || !attendance || attendance.display_name !== payload.displayName) {
      return null
    }

    // 3. 認証リンク (participant_auth_links) の厳密な組み合わせ確認
    // Cookie 内の authUserId と participantId が正確に結合されているか検証
    const { data: authLink, error: authLinkError } = await supabaseAdmin
      .from('participant_auth_links')
      .select('auth_user_id')
      .eq('participant_id', payload.participantId)
      .eq('auth_user_id', payload.authUserId)
      .maybeSingle()

    if (authLinkError || !authLink) {
      return null
    }

    return {
      session: {
        id: session.id,
        sessionNumber: session.session_number,
        status: session.status,
        isLocked: session.is_locked,
      },
      room: {
        id: room.id,
        roomSlug: room.room_slug,
        groupLabel: room.group_label,
      },
      participant: {
        id: payload.participantId,
        displayName: attendance.display_name,
      },
      authUserId: payload.authUserId,
    }
  } catch {
    return null
  }
}
