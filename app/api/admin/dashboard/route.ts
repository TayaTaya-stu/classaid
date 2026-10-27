import { NextResponse } from 'next/server'
import { isAdminAuthenticated } from '@/lib/admin-auth'
import { supabaseAdmin } from '@/lib/supabase-admin'

const UUID_REGEX = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/

export async function GET(request: Request) {
  if (!(await isAdminAuthenticated())) {
    return NextResponse.json({ error: '管理者認証が必要です。' }, { status: 401 })
  }

  const { data: rawSessions, error: sessionsError } = await supabaseAdmin
    .from('sessions')
    .select('id, session_number, wave_number, scheduled_at, status, is_locked, protocol_snapshot, pdf_file_url, class_started_at, room_mode, screen_slug, entry_slug, reaction_ai_mode, reaction_ai_status, is_mock_ai, reaction_pipeline_enabled, projection_status, demo_projected_at, auto_expired_at, is_current_target, is_archived, admin_deleted_at')
    .neq('id', '00000000-0000-0000-0000-000000000001')
    .order('scheduled_at', { ascending: false })
  if (sessionsError) return NextResponse.json({ error: '授業回の取得に失敗しました。' }, { status: 500 })

  const history = new URL(request.url).searchParams.get('view') === 'history'
  const sessions = (rawSessions || []).filter(s => {
    if (s.admin_deleted_at) return false
    const past = Boolean(s.is_archived) || ['completed','closed','locked'].includes(s.status)
    return history ? past : (!past || Boolean(s.is_current_target))
  }).map((s) => ({
    ...s,
    is_current_target: Boolean((s as { is_current_target?: boolean }).is_current_target),
  }))

  const requestedSessionId = new URL(request.url).searchParams.get('sessionId')
  if (requestedSessionId && !UUID_REGEX.test(requestedSessionId)) {
    return NextResponse.json({ error: '授業回の指定が不正です。' }, { status: 400 })
  }
  const selectedSession = requestedSessionId
    ? sessions?.find((session) => session.id === requestedSessionId)
    : sessions.find(s => s.is_current_target) || sessions[0]
  if (!selectedSession) {
    return NextResponse.json({ sessions: sessions.map(session => ({
      id: session.id, sessionNumber: session.session_number, scheduledAt: session.scheduled_at,
      status: session.status, isArchived: Boolean(session.is_archived), isCurrentTarget: Boolean(session.is_current_target),
      isDevelopment: session.session_number === 0 || (session.protocol_snapshot as { exclude_from_analysis?: boolean } | null)?.exclude_from_analysis === true,
    })), selectedSessionId: null, sessionControl: null, sharedWall: null, rooms: [] })
  }

  const { data: rooms, error: roomsError } = await supabaseAdmin
    .from('rooms').select('id, group_label, ai_condition').eq('session_id', selectedSession.id).order('group_label')
  if (roomsError) return NextResponse.json({ error: 'ルーム情報の取得に失敗しました。' }, { status: 500 })

  return NextResponse.json({
    sessions: (sessions || []).map((session) => ({
      id: session.id,
      sessionNumber: session.session_number,
      waveNumber: session.wave_number,
      scheduledAt: session.scheduled_at,
      status: session.status,
      isLocked: session.is_locked,
      isArchived: Boolean(session.is_archived),
      isCurrentTarget: Boolean(session.is_current_target),
      isDevelopment: session.session_number === 0 ||
        (session.protocol_snapshot as { exclude_from_analysis?: boolean } | null)?.exclude_from_analysis === true,
    })),
    selectedSessionId: selectedSession.id,
    sharedWall: selectedSession.room_mode === 'shared' ? {
      screenSlug: selectedSession.screen_slug,
      entrySlug: selectedSession.entry_slug,
    } : null,
    sessionControl: {
      status: selectedSession.status,
      isLocked: selectedSession.is_locked,
      pdfFilePath: selectedSession.pdf_file_url,
      classStartedAt: selectedSession.class_started_at,
      isCurrentTarget: Boolean(selectedSession.is_current_target),
      isArchived: Boolean(selectedSession.is_archived),
      reactionConfig: {
        mode: selectedSession.reaction_ai_mode || 'off',
        status: selectedSession.reaction_ai_status || 'active',
        projectionStatus: selectedSession.projection_status || 'active',
        isMockAi: Boolean(selectedSession.is_mock_ai),
        pipelineEnabled: Boolean(selectedSession.reaction_pipeline_enabled),
        hasAiKey: Boolean(process.env.GEMINI_API_KEY),
        demoProjectedAt: selectedSession.demo_projected_at,
        autoExpiredAt: selectedSession.auto_expired_at,
      },

    },
    rooms: (rooms || []).map((room) => ({
      id: room.id,
      groupLabel: room.group_label,
      aiCondition: room.ai_condition,
    })),
  })
}
