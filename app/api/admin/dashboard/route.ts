import { NextResponse } from 'next/server'
import { isAdminAuthenticated } from '@/lib/admin-auth'
import { supabaseAdmin } from '@/lib/supabase-admin'

const UUID_REGEX = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/

export async function GET(request: Request) {
  if (!(await isAdminAuthenticated())) {
    return NextResponse.json({ error: '管理者認証が必要です。' }, { status: 401 })
  }

  const { data: sessions, error: sessionsError } = await supabaseAdmin
    .from('sessions')
    .select('id, session_number, wave_number, scheduled_at, status, is_locked, protocol_snapshot, pdf_file_url, current_page, intervention_started_at, cycle_count, cycle_duration_minutes, slot_minutes, room_mode, screen_slug, entry_slug')
    .neq('id', '00000000-0000-0000-0000-000000000001')
    .order('scheduled_at', { ascending: false })
  if (sessionsError) return NextResponse.json({ error: '授業回の取得に失敗しました。' }, { status: 500 })

  const requestedSessionId = new URL(request.url).searchParams.get('sessionId')
  if (requestedSessionId && !UUID_REGEX.test(requestedSessionId)) {
    return NextResponse.json({ error: '授業回の指定が不正です。' }, { status: 400 })
  }
  const selectedSession = requestedSessionId
    ? sessions?.find((session) => session.id === requestedSessionId)
    : sessions?.[0]
  if (!selectedSession) {
    return NextResponse.json({ sessions: sessions || [], selectedSessionId: null, rooms: [], teacherPosts: [] })
  }

  const { data: rooms, error: roomsError } = await supabaseAdmin
    .from('rooms').select('id, group_label, ai_condition').eq('session_id', selectedSession.id).order('group_label')
  if (roomsError) return NextResponse.json({ error: 'ルーム情報の取得に失敗しました。' }, { status: 500 })

  const { data: cycles, error: cyclesError } = await supabaseAdmin
    .from('session_cycles').select('id, cycle_number, status, started_at, ended_at')
    .eq('session_id', selectedSession.id).order('cycle_number')
  if (cyclesError) return NextResponse.json({ error: 'サイクル情報の取得に失敗しました。' }, { status: 500 })

  const cycleIds = (cycles || []).map((cycle) => cycle.id)
  const { data: interventions, error: interventionsError } = cycleIds.length
    ? await supabaseAdmin.from('ai_interventions')
      .select('id, cycle_id, room_id, slot_index, scheduled_at, status, planned_message_type')
      .in('cycle_id', cycleIds).order('scheduled_at')
    : { data: [], error: null }
  if (interventionsError) return NextResponse.json({ error: '介入予定の取得に失敗しました。' }, { status: 500 })

  const interventionIds = (interventions || []).map((item) => item.id)
  const { data: generationAttempts, error: attemptsError } = interventionIds.length
    ? await supabaseAdmin.from('ai_generation_attempts')
      .select('id, intervention_id, attempt_index, candidate_messages, created_at')
      .in('intervention_id', interventionIds).order('attempt_index', { ascending: false })
    : { data: [], error: null }
  if (attemptsError) return NextResponse.json({ error: 'AI候補の取得に失敗しました。' }, { status: 500 })
  const latestAttemptByIntervention = new Map<string, { id: string; attempt_index: number; candidate_messages: unknown }>()
  for (const attempt of generationAttempts || []) {
    if (!latestAttemptByIntervention.has(attempt.intervention_id)) {
      latestAttemptByIntervention.set(attempt.intervention_id, attempt)
    }
  }

  const roomLabelById = new Map((rooms || []).map((room) => [room.id, room.group_label]))
  const roomConditionById = new Map((rooms || []).map((room) => [room.id, room.ai_condition]))

  return NextResponse.json({
    sessions: (sessions || []).map((session) => ({
      id: session.id,
      sessionNumber: session.session_number,
      waveNumber: session.wave_number,
      scheduledAt: session.scheduled_at,
      status: session.status,
      isLocked: session.is_locked,
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
      currentPage: selectedSession.current_page,
      interventionStartedAt: selectedSession.intervention_started_at,
      cycleCount: selectedSession.cycle_count,
      cycleDurationMinutes: selectedSession.cycle_duration_minutes,
      slotMinutes: selectedSession.slot_minutes,
      cycles: (cycles || []).map((cycle) => ({
        id: cycle.id,
        cycleNumber: cycle.cycle_number,
        status: cycle.status,
        startedAt: cycle.started_at,
        endedAt: cycle.ended_at,
      })),
      interventions: (interventions || []).map((item) => {
        const latestAttempt = latestAttemptByIntervention.get(item.id)
        return {
          id: item.id,
          cycleId: item.cycle_id,
          roomId: item.room_id,
          roomLabel: roomLabelById.get(item.room_id) || '?',
          aiCondition: roomConditionById.get(item.room_id) || 'none',
          slotIndex: item.slot_index,
          scheduledAt: item.scheduled_at,
          status: item.status,
          plannedMessageType: item.planned_message_type,
          latestAttempt: latestAttempt ? {
            id: latestAttempt.id,
            attemptIndex: latestAttempt.attempt_index,
            candidates: Array.isArray(latestAttempt.candidate_messages) ? latestAttempt.candidate_messages : [],
          } : null,
        }
      }),
    },
    rooms: (rooms || []).map((room) => ({
      id: room.id,
      groupLabel: room.group_label,
      aiCondition: room.ai_condition,
    })),
  })
}
