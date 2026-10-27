import { after, NextResponse } from 'next/server'
import crypto from 'crypto'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { isTeacherAuthenticated } from '@/lib/teacher-auth'
import { isAdminAuthenticated } from '@/lib/admin-auth'

function verifySecretHeader(provided: string | null | undefined, expectedSecret: string | undefined): boolean {
  if (!provided || !expectedSecret || typeof provided !== 'string') return false
  const a = Buffer.from(provided, 'utf8')
  const b = Buffer.from(expectedSecret, 'utf8')
  return a.length === b.length && crypto.timingSafeEqual(a, b)
}

export async function GET(request: Request) {
  // 1. 教員または認証済み投影端末に限定
  const isTeacher = await isTeacherAuthenticated()
  const isAdmin = await isAdminAuthenticated()
  const teacherPwdHeader = request.headers.get('x-teacher-password') || request.headers.get('x-projection-key')
  const url = new URL(request.url)

  const isAuthHeaderValid =
    verifySecretHeader(teacherPwdHeader, process.env.TEACHER_ACCESS_PASSWORD) ||
    verifySecretHeader(teacherPwdHeader, process.env.ADMIN_ACCESS_PASSWORD)

  if (!isTeacher && !isAdmin && !isAuthHeaderValid) {
    return NextResponse.json({ error: '教員認証または投影端末認証が必要です。' }, { status: 401 })
  }

  try {
    // 2. セッション一覧を取得
    const { data: rawSessions, error } = await supabaseAdmin
      .from('sessions')
      .select('id, session_number, scheduled_at, screen_slug, entry_slug, status, is_locked, class_started_at, reaction_ai_mode, reaction_ai_status, projection_status, auto_expired_at, pdf_file_url, is_current_target, is_archived, admin_deleted_at')
      .eq('room_mode', 'shared')
      .neq('id', '00000000-0000-0000-0000-000000000001')
      .order('session_number', { ascending: false })
      .limit(30)

    // SQL 019の指定フラグを利用する。DB失敗時に日時選択へ切り替えない。
    const sessions = (rawSessions || []).filter(s => !s.is_archived && !s.admin_deleted_at).map((s) => ({
      ...s,
      is_current_target: Boolean((s as { is_current_target?: boolean }).is_current_target),
    }))

    if (error) return NextResponse.json({ error: '授業回の取得に失敗しました。再試行してください。' }, { status: 503 })
    if ((rawSessions || []).length === 0) {
      return NextResponse.json({ error: '利用可能な授業回がありません。' }, { status: 404 })
    }

    const requestedSessionId = url.searchParams.get('sessionId')
    // Resolve the target independently of the bounded history list. A designated
    // or explicitly requested class must not disappear after 30 other histories.
    let targetQuery = supabaseAdmin.from('sessions')
      .select('id, session_number, scheduled_at, screen_slug, entry_slug, status, is_locked, class_started_at, reaction_ai_mode, reaction_ai_status, projection_status, auto_expired_at, pdf_file_url, is_current_target, is_archived, admin_deleted_at')
      .eq('room_mode', 'shared')
      .neq('id', '00000000-0000-0000-0000-000000000001')
    targetQuery = requestedSessionId ? targetQuery.eq('id', requestedSessionId) : targetQuery.eq('is_current_target', true)
    const {data: targets, error: targetError} = await targetQuery.limit(2)
    if (targetError) return NextResponse.json({error:'指定授業回の取得に失敗しました。再試行してください。'},{status:503})
    // Use the same explicit designation as /join. Never guess by date or an old running class.
    const targetSession = targets?.length === 1 && !targets[0].is_archived && !targets[0].admin_deleted_at ? targets[0] : null
    if (!targetSession) return NextResponse.json({
      error: requestedSessionId ? '指定された授業回が見つかりません。' : '管理者画面で今回使用する授業回を1つ指定してください。',
    }, { status: requestedSessionId ? 404 : 409 })

    after(async()=>{
      const {recoverSessionJobs}=await import('@/lib/reaction-ai/service')
      try {await recoverSessionJobs(targetSession.id)} catch {console.error('Reply recovery poll failed')}
    })

    // 動的ホスト名（localhost:3000, localhost:3001, 公開URLのいずれにも対応）
    const origin = new URL(request.url).origin

    const preparedSessions = [targetSession, ...sessions.filter(s => s.id !== targetSession.id)].map((s) => ({
      sessionId: s.id,
      sessionNumber: s.session_number,
      scheduledAt: s.scheduled_at,
      reactionAiMode: s.reaction_ai_mode || 'off',
      status: s.status,
      isLocked: s.is_locked,
      isCurrentTarget: Boolean(s.is_current_target),
      classStartedAt: s.class_started_at,
      autoExpiredAt: s.auto_expired_at,
      screenSlug: s.screen_slug,
      screenUrl: `${origin}/screen/${s.screen_slug}`,
      entrySlug: s.entry_slug,
      entryUrl: `${origin}/enter/${s.entry_slug}`,
      pdfFilePath: s.pdf_file_url,
    }))

    return NextResponse.json({
      status: targetSession.status,
      sessionId: targetSession.id,
      sessionNumber: targetSession.session_number,
      scheduledAt: targetSession.scheduled_at,
      screenSlug: targetSession.screen_slug,
      entrySlug: targetSession.entry_slug,
      screenPath: `/screen/${targetSession.screen_slug}`,
      screenUrl: `${origin}/screen/${targetSession.screen_slug}`,
      entryPath: `/enter/${targetSession.entry_slug}`,
      entryUrl: `${origin}/enter/${targetSession.entry_slug}`,
      classStartedAt: targetSession.class_started_at,
      projectionStatus: targetSession.projection_status || 'active',
      autoExpiredAt: targetSession.auto_expired_at,
      reactionMode: targetSession.reaction_ai_mode || 'off',
      reactionStatus: targetSession.reaction_ai_status || 'active',
      pdfFilePath: targetSession.pdf_file_url,
      isCurrentTarget: Boolean(targetSession.is_current_target),
      sessions: preparedSessions,
    }, { headers: { 'Cache-Control': 'no-store' } })
  } catch {
    return NextResponse.json({ error: '最新情報の取得に失敗しました。' }, { status: 500 })
  }
}
