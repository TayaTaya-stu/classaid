import { NextResponse } from 'next/server'
import { studentEntryUrl, designatedSession } from '@/lib/student-entry'
import { supabaseAdmin } from '@/lib/supabase-admin'

interface RouteContext {
  params: Promise<{ screenSlug: string }>
}

const SCREEN_SLUG_REGEX = /^[a-zA-Z0-9_-]{16,128}$/

export async function GET(request: Request, context: RouteContext) {
  try {
    const { screenSlug } = await context.params
    if (!SCREEN_SLUG_REGEX.test(screenSlug)) {
      return NextResponse.json({ error: '表示用URLが正しくありません。' }, { status: 400 })
    }

    const { data: session, error: sessionError } = await supabaseAdmin
      .from('sessions')
      .select('id, entry_slug, status, is_locked, class_started_at, projection_status, auto_expired_at, reaction_ai_mode, reaction_ai_status')
      .eq('screen_slug', screenSlug)
      .eq('room_mode', 'shared')
      .maybeSingle()

    if (sessionError || !session) {
      return NextResponse.json({ error: '表示対象の授業が見つかりません。' }, { status: 404 })
    }

    let fixedEntryUrl: string | null = null
    try { fixedEntryUrl = studentEntryUrl(request) } catch {}
    const current = await designatedSession()
    const isDesignatedSession = current?.id === session.id

    const isExpired = Boolean(
      session.auto_expired_at ||
      (session.class_started_at && Date.now() >= new Date(session.class_started_at).getTime() + 120 * 60 * 1000)
    )

    // 実際の処理経路で期限到達をDB確定
    if (isExpired && !session.auto_expired_at) {
      await supabaseAdmin.rpc('check_or_expire_120m', { p_session_id: session.id })
    }

    const isClosed = !isDesignatedSession || session.is_locked || ['completed', 'locked', 'closed'].includes(session.status) || isExpired
    const isProjectionPaused = session.projection_status === 'paused'
    const expiresAt = session.class_started_at ? new Date(new Date(session.class_started_at).getTime() + 120 * 60 * 1000).toISOString() : null
    const reactionAiMode = session.reaction_ai_mode || 'off'

    if (isClosed) {
      return NextResponse.json({
        fixedEntryUrl, isDesignatedSession,
        events: [],
        cursor: null,
        protocol: 'reaction-events-v1',
        entryPath: `/enter/${session.entry_slug}`,
        isSessionClosed: true,
        isProjectionPaused: false,
        isExpired,
        classStartedAt: session.class_started_at,
        expiresAt,
        reactionAiMode, reactionAiStatus: session.reaction_ai_status,
      }, { headers: { 'Cache-Control': 'no-store' } })
    }

    if (isProjectionPaused) {
      return NextResponse.json({
        fixedEntryUrl, isDesignatedSession,
        events: [],
        cursor: null,
        protocol: 'reaction-events-v1',
        entryPath: `/enter/${session.entry_slug}`,
        isSessionClosed: false,
        isProjectionPaused: true,
        isExpired: false,
        classStartedAt: session.class_started_at,
        expiresAt,
        reactionAiMode, reactionAiStatus: session.reaction_ai_status,
      }, { headers: { 'Cache-Control': 'no-store' } })
    }

    const { data: rooms, error: roomError } = await supabaseAdmin
      .from('rooms')
      .select('id')
      .eq('session_id', session.id)
      .limit(2)

    if (roomError || !rooms || rooms.length !== 1) {
      return NextResponse.json({ error: '共有ルームの設定が正しくありません。' }, { status: 503 })
    }

    const url = new URL(request.url)
    if (url.searchParams.has('afterId')) return NextResponse.json({error:'Update the overlay client to the event protocol.'},{status:400})
    const raw=url.searchParams.get('afterCursor')
    if(raw!==null && (!/^\d+$/.test(raw)||!Number.isSafeInteger(Number(raw)))) return NextResponse.json({error:'Invalid cursor'},{status:400})
    const { getProjectionEvents }=await import('@/lib/reaction-ai/service')
    const {events,nextCursor}=await getProjectionEvents({sessionId:session.id,roomId:rooms[0].id,afterCursor:raw===null?null:Number(raw)})
    return NextResponse.json({
      fixedEntryUrl, isDesignatedSession,
      events,
      cursor: nextCursor,
      protocol: 'reaction-events-v1',
      entryPath: `/enter/${session.entry_slug}`,
      isSessionClosed: false,
      isProjectionPaused: false,
      isExpired: false,
      classStartedAt: session.class_started_at,
      expiresAt,
      reactionAiMode, reactionAiStatus: session.reaction_ai_status,
    }, { headers: { 'Cache-Control': 'no-store' } })
  } catch {
    return NextResponse.json({error:'表示情報の取得に失敗しました。'},{status:503})
  }
}
