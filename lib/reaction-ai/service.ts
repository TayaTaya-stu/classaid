import { supabaseAdmin } from '@/lib/supabase-admin'
import type {
  ReactionAiMode,
  ReactionAiStatus,
  ReactionSessionConfig,
  ProjectionEventDTO,
  ProcessReactionResult,
} from './types'

const DEFAULT_MOCK_PROMPTS: Record<Exclude<ReactionAiMode, 'off'>, (msg: string) => string> = {
  empathy: (msg) => `【試験モック:共感】「${msg.slice(0, 20)}」という視点、すごくよくわかります！`,
  lecture_bridge: (msg) => `【試験モック:授業接続】「${msg.slice(0, 20)}」は本日の講義テーマと密接に関係していますね。`,
  neutral: (msg) => `【試験モック:中立】「${msg.slice(0, 20)}」という意見として整理・共有されました。`,
}

/**
 * セッションの返信AI設定を取得
 * 未マイグレーション環境でもエラーにならずフォールバックする安全設計
 */
export async function getReactionSessionConfig(sessionId: string): Promise<ReactionSessionConfig> {
  try {
    const { data: session, error } = await supabaseAdmin
      .from('sessions')
      .select('reaction_ai_mode, reaction_ai_status, is_mock_ai, lecture_theme, protocol_snapshot')
      .eq('id', sessionId)
      .maybeSingle()

    if (error || !session) {
      return {
        mode: 'empathy', // Phase 1 開発初期のデフォルト（モック動作確認用）
        status: 'active',
        isMockAi: true,
        lectureTheme: null,
      }
    }

    const rawMode = (session.reaction_ai_mode as ReactionAiMode) || 'off'
    const validModes: ReactionAiMode[] = ['off', 'empathy', 'lecture_bridge', 'neutral']
    const mode = validModes.includes(rawMode) ? rawMode : 'off'
    const status: ReactionAiStatus = session.reaction_ai_status === 'stopped' ? 'stopped' : 'active'
    const isMockAi = session.is_mock_ai ?? true // 明示設定がなければモック安全側

    return {
      mode,
      status,
      isMockAi,
      lectureTheme: session.lecture_theme ?? null,
      protocolSnapshot: session.protocol_snapshot as Record<string, unknown> | null,
    }
  } catch {
    return {
      mode: 'empathy',
      status: 'active',
      isMockAi: true,
      lectureTheme: null,
    }
  }
}

/**
 * 人間投稿に対する返信処理と投影イベント登録のエントリポイント
 * 人間投稿の保存完了後に呼び出される
 */
export async function processHumanPostForReactionAi(params: {
  sessionId: string
  roomId: string
  humanPostId: number
  humanMessage: string
  clientSentAt?: string | null
}): Promise<ProcessReactionResult> {
  const { sessionId, roomId, humanPostId, humanMessage, clientSentAt } = params
  const startTime = Date.now()

  const config = await getReactionSessionConfig(sessionId)

  // 1. AIなし (off) または 緊急停止中 (stopped) の場合
  if (config.mode === 'off' || config.status === 'stopped') {
    return await registerHumanOnlyEvent({
      sessionId,
      roomId,
      humanPostId,
      mode: config.mode,
      sourceType: 'none',
      clientSentAt,
      startTime,
    })
  }

  // 2. Phase 1: モック返信経路（研究用実AIと混同しない明示的試験設定）
  try {
    const generator = DEFAULT_MOCK_PROMPTS[config.mode] || DEFAULT_MOCK_PROMPTS.empathy
    const mockReplyMessage = generator(humanMessage)
    const replyCreatedAt = new Date().toISOString()

    // 2-1. posts テーブルへ AI 返信レコードを保存
    const { data: aiPost, error: aiPostError } = await supabaseAdmin
      .from('posts')
      .insert({
        session_id: sessionId,
        room_id: roomId,
        participant_id: null,
        author_type: 'ai',
        author_display_name: '学生AI',
        name: '学生AI',
        message: mockReplyMessage,
        is_ai: true,
        parent_id: humanPostId,
        reply_target_type: 'to_human',
        audience_type: 'room',
        likes: 0,
        dislikes: 0,
        is_deleted: false,
      })
      .select('id')
      .single()

    if (aiPostError || !aiPost) {
      console.error('Failed to insert mock AI post:', aiPostError)
      // 返信保存に失敗した場合でも人間投稿単体として表示キューへ流す
      return await registerHumanOnlyEvent({
        sessionId,
        roomId,
        humanPostId,
        mode: config.mode,
        sourceType: 'none',
        clientSentAt,
        startTime,
        errorReason: 'mock_ai_insert_failed',
      })
    }

    const durationMs = Date.now() - startTime

    // 2-2. ai_reply_logs への記録（研究分析用・追記専用）
    await supabaseAdmin.from('ai_reply_logs').insert({
      session_id: sessionId,
      room_id: roomId,
      human_post_id: humanPostId,
      ai_post_id: aiPost.id,
      mode: config.mode,
      source_type: 'mock',
      model_name: 'mock-phase1',
      prompt_version: 'mock-v1',
      context_reference: {
        is_mock: true,
        lecture_theme: config.lectureTheme,
      },
      generation_duration_ms: durationMs,
      client_sent_at: clientSentAt || null,
      reply_created_at: replyCreatedAt,
    })

    // 2-3. projection_events への登録（単調増加カーソル）
    const { data: event, error: eventError } = await supabaseAdmin
      .from('projection_events')
      .insert({
        session_id: sessionId,
        room_id: roomId,
        human_post_id: humanPostId,
        ai_post_id: aiPost.id,
        event_type: 'paired',
      })
      .select('id')
      .single()

    if (eventError || !event) {
      console.error('Failed to insert paired projection event:', eventError)
      return {
        projectionEventId: 0,
        aiPostId: aiPost.id,
        mode: config.mode,
        sourceType: 'mock',
        isPaired: true,
      }
    }

    return {
      projectionEventId: event.id,
      aiPostId: aiPost.id,
      mode: config.mode,
      sourceType: 'mock',
      isPaired: true,
    }
  } catch (caught) {
    console.error('Error in processHumanPostForReactionAi:', caught)
    return await registerHumanOnlyEvent({
      sessionId,
      roomId,
      humanPostId,
      mode: config.mode,
      sourceType: 'none',
      clientSentAt,
      startTime,
      errorReason: caught instanceof Error ? caught.message : 'unknown_error',
    })
  }
}

async function registerHumanOnlyEvent(params: {
  sessionId: string
  roomId: string
  humanPostId: number
  mode: ReactionAiMode
  sourceType: 'none'
  clientSentAt?: string | null
  startTime: number
  errorReason?: string
}): Promise<ProcessReactionResult> {
  const { sessionId, roomId, humanPostId, mode, sourceType, clientSentAt, startTime, errorReason } = params
  const durationMs = Date.now() - startTime

  // ログ記録
  await supabaseAdmin.from('ai_reply_logs').insert({
    session_id: sessionId,
    room_id: roomId,
    human_post_id: humanPostId,
    ai_post_id: null,
    mode,
    source_type: sourceType,
    client_sent_at: clientSentAt || null,
    generation_duration_ms: durationMs,
    error_reason: errorReason || null,
  })

  // 投影イベント登録
  const { data: event } = await supabaseAdmin
    .from('projection_events')
    .insert({
      session_id: sessionId,
      room_id: roomId,
      human_post_id: humanPostId,
      ai_post_id: null,
      event_type: 'human_only',
    })
    .select('id')
    .single()

  return {
    projectionEventId: event?.id ?? 0,
    aiPostId: null,
    mode,
    sourceType,
    isPaired: false,
  }
}

/**
 * 投影用イベントを取得し、人間投稿と返信をセットにしたDTOを構築する
 */
export async function getProjectionEvents(params: {
  roomId: string
  afterCursor: number | null
  limit?: number
}): Promise<{ events: ProjectionEventDTO[]; nextCursor: number | null }> {
  const { roomId, afterCursor, limit = 50 } = params

  let query = supabaseAdmin
    .from('projection_events')
    .select('id, human_post_id, ai_post_id, event_type, created_at')
    .eq('room_id', roomId)

  if (afterCursor !== null) {
    query = query.gt('id', afterCursor).order('id', { ascending: true }).limit(limit)
  } else {
    // 初回取得時は最新のイベント群を取得（古い順にソート）
    query = query.order('id', { ascending: false }).limit(limit)
  }

  const { data: rawEvents, error } = await query
  if (error || !rawEvents || rawEvents.length === 0) {
    return { events: [], nextCursor: afterCursor }
  }

  const orderedEvents = afterCursor !== null ? rawEvents : rawEvents.slice().reverse()
  const postIdsToFetch = new Set<number>()
  for (const ev of orderedEvents) {
    postIdsToFetch.add(ev.human_post_id)
    if (ev.ai_post_id) postIdsToFetch.add(ev.ai_post_id)
  }

  const { data: postRows } = await supabaseAdmin
    .from('posts')
    .select('id, author_display_name, author_type, is_ai, message, created_at')
    .in('id', Array.from(postIdsToFetch))

  const postMap = new Map<number, (typeof postRows extends (infer U)[] | null ? U : never)>()
  postRows?.forEach((post) => postMap.set(post.id, post))

  const dtos: ProjectionEventDTO[] = []
  for (const ev of orderedEvents) {
    const humanPost = postMap.get(ev.human_post_id)
    if (!humanPost) continue

    const aiPost = ev.ai_post_id ? postMap.get(ev.ai_post_id) : null

    dtos.push({
      cursor: ev.id,
      eventType: ev.event_type as 'human_only' | 'paired',
      humanPost: {
        id: humanPost.id,
        authorDisplayName: humanPost.author_display_name,
        authorType: 'human',
        message: humanPost.message,
        createdAt: humanPost.created_at,
      },
      aiReply: aiPost
        ? {
            id: aiPost.id,
            authorDisplayName: '学生AI',
            authorType: 'ai',
            message: aiPost.message,
            createdAt: aiPost.created_at,
            isMock: true,
          }
        : null,
      createdAt: ev.created_at,
    })
  }

  const nextCursor = orderedEvents.at(-1)?.id ?? afterCursor
  return { events: dtos, nextCursor }
}
