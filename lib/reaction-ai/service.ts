import { supabaseAdmin } from '@/lib/supabase-admin'
import type {
  ReactionAiMode,
  ReactionAiStatus,
  ReactionSessionConfig,
  ProjectionEventDTO,
  ProcessReactionResult,
} from './types'

// 試験用モック返信（明示的試験設定であることが一目でわかる文面）
const DEFAULT_MOCK_PROMPTS: Record<Exclude<ReactionAiMode, 'off'>, (msg: string) => string> = {
  empathy: (msg) => `【試験モック:共感】「${msg.slice(0, 24)}」という視点、すごくよくわかります！`,
  lecture_bridge: (msg) => `【試験モック:授業接続】「${msg.slice(0, 24)}」は本日の講義テーマと密接に関係していますね。`,
  neutral: (msg) => `【試験モック:中立】「${msg.slice(0, 24)}」という意見として整理・共有されました。`,
}

// モード別予備返信マスター（外部AI遅延・失敗時の事前用意返信）
export const MODE_FALLBACK_REPLIES: Record<Exclude<ReactionAiMode, 'off'>, Array<{ id: string; text: string }>> = {
  empathy: [
    { id: 'emp-fb-1', text: 'その着眼点、すごく共感できます！' },
    { id: 'emp-fb-2', text: '確かにそう感じるポイントですよね。' },
    { id: 'emp-fb-3', text: 'なるほど、その見方はとても新鮮です！' },
  ],
  lecture_bridge: [
    { id: 'lbr-fb-1', text: 'この着眼点は、本日の講義のキーワードと深く結びついています。' },
    { id: 'lbr-fb-2', text: '授業内で登場した概念を踏まえると、さらに理解が深まる話題ですね。' },
    { id: 'lbr-fb-3', text: '講義内容の応用として、まさに注目すべき視点です。' },
  ],
  neutral: [
    { id: 'neu-fb-1', text: '講義のチャット欄に新しい視点として共有されました。' },
    { id: 'neu-fb-2', text: '投稿内容がトピックの1つとして整理されました。' },
    { id: 'neu-fb-3', text: '授業参加者へ向けた発言として共有されています。' },
  ],
}

/**
 * セッションの返信AI設定を取得
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
        mode: 'empathy',
        status: 'active',
        isMockAi: true,
        lectureTheme: null,
      }
    }

    const rawMode = (session.reaction_ai_mode as ReactionAiMode) || 'off'
    const validModes: ReactionAiMode[] = ['off', 'empathy', 'lecture_bridge', 'neutral']
    const mode = validModes.includes(rawMode) ? rawMode : 'off'
    const status: ReactionAiStatus = session.reaction_ai_status === 'stopped' ? 'stopped' : 'active'
    const isMockAi = session.is_mock_ai ?? true

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
 * 返信ジョブをDBに永続登録（待ち時間の分離・ジョブ消失防止）
 * 投稿APIはこれを呼び出した直後に学生へ200 OKを即時返却できる
 */
export async function enqueueReplyJob(params: {
  sessionId: string
  roomId: string
  humanPostId: number
  mode: ReactionAiMode
}): Promise<string | null> {
  const { sessionId, roomId, humanPostId, mode } = params
  try {
    const { data: job, error } = await supabaseAdmin
      .from('ai_reply_jobs')
      .insert({
        session_id: sessionId,
        room_id: roomId,
        human_post_id: humanPostId,
        mode,
        status: 'pending',
      })
      .select('id')
      .maybeSingle()

    if (error) {
      console.warn('Failed to insert ai_reply_job (may already exist):', error.message)
      return null
    }
    return job?.id ?? null
  } catch (caught) {
    console.error('enqueueReplyJob exception:', caught)
    return null
  }
}

/**
 * 人間投稿に対する返信ジョブの実行処理
 * 非同期ワーカーまたはバックグラウンドで実行される
 */
export async function executeReactionJob(params: {
  jobId?: string | null
  sessionId: string
  roomId: string
  humanPostId: number
  humanMessage: string
  clientSentAt?: string | null
}): Promise<ProcessReactionResult> {
  const { jobId, sessionId, roomId, humanPostId, humanMessage, clientSentAt } = params
  const startTime = Date.now()

  const config = await getReactionSessionConfig(sessionId)

  // 1. AIなし (off) または 緊急停止中 (stopped) の場合のみ、合意された仕様として human_only を公開
  if (config.mode === 'off' || config.status === 'stopped') {
    return await registerHumanOnlyEvent({
      sessionId,
      roomId,
      humanPostId,
      mode: config.mode,
      clientSentAt,
      startTime,
    })
  }

  // 2. AIあり条件（empathy, lecture_bridge, neutral）:
  // 通常生成またはモック生成を行い、失敗時も「human_only」には決して格下げせず、
  // 必ずモード別の事前用意「予備返信 (fallback)」とセットで公開する。
  let aiReplyText = ''
  let replySourceType: 'mock' | 'fallback' = 'mock'
  let fallbackId: string | null = null

  try {
    if (config.isMockAi) {
      const generator = DEFAULT_MOCK_PROMPTS[config.mode] || DEFAULT_MOCK_PROMPTS.empathy
      aiReplyText = generator(humanMessage)
      replySourceType = 'mock'
    } else {
      // Phase 2/3 で外部AI生成を組み込み（失敗時は catch して予備返信へフォールバック）
      throw new Error('Real AI generation not configured yet in Phase 1')
    }
  } catch (generationError) {
    // 通常生成失敗・例外時は、合意仕様に基づきモード別予備返信へフォールバック
    console.warn('Generation failed, using fallback reply:', generationError)
    const fallbacks = MODE_FALLBACK_REPLIES[config.mode] || MODE_FALLBACK_REPLIES.empathy
    const selectedFallback = fallbacks[Math.floor(Math.random() * fallbacks.length)]
    aiReplyText = selectedFallback.text
    fallbackId = selectedFallback.id
    replySourceType = 'fallback'
  }

  const replyCreatedAt = new Date().toISOString()

  // 2-1. posts テーブルへ AI 返信レコードを保存
  // posts_parent_ai_reply_unique 制約により、同一親投稿への重複INSERTはDBレベルで物理的に拒絶される
  const { data: aiPost, error: aiPostError } = await supabaseAdmin
    .from('posts')
    .insert({
      session_id: sessionId,
      room_id: roomId,
      participant_id: null,
      author_type: 'ai',
      author_display_name: '学生AI',
      name: '学生AI',
      message: aiReplyText,
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
    // 重複INSERTエラー（23505）の場合、既に並行処理で返信が作成済み
    if (aiPostError?.code === '23505') {
      console.log('AI reply already exists for human_post_id:', humanPostId)
      return {
        projectionEventId: 0,
        aiPostId: null,
        mode: config.mode,
        sourceType: replySourceType,
        isPaired: true,
        jobStatus: 'completed',
      }
    }

    // 重大なDB障害等で返信セットを保存できない場合：
    // 「AIあり条件」を勝手に単独投影に格下げせず、ジョブを failed 状態として保持（再試行・復旧可能にする）
    console.error('Fatal DB error inserting AI reply post:', aiPostError)
    if (jobId) {
      await supabaseAdmin.from('ai_reply_jobs').update({
        status: 'failed',
        last_error: aiPostError?.message || 'ai_post_insert_failed',
        updated_at: new Date().toISOString(),
      }).eq('id', jobId)
    }

    return {
      projectionEventId: 0,
      aiPostId: null,
      mode: config.mode,
      sourceType: replySourceType,
      isPaired: true,
      jobStatus: 'failed',
    }
  }

  const durationMs = Date.now() - startTime

  // 2-2. ai_reply_logs への記録（研究分析用・追記専用）
  await supabaseAdmin.from('ai_reply_logs').insert({
    session_id: sessionId,
    room_id: roomId,
    human_post_id: humanPostId,
    ai_post_id: aiPost.id,
    mode: config.mode,
    source_type: replySourceType,
    model_name: replySourceType === 'mock' ? 'mock-phase1' : 'fallback-rule',
    prompt_version: replySourceType === 'mock' ? 'mock-v1' : 'fallback-v1',
    fallback_id: fallbackId,
    context_reference: {
      is_mock: replySourceType === 'mock',
      lecture_theme: config.lectureTheme,
    },
    generation_duration_ms: durationMs,
    client_sent_at: clientSentAt || null,
    reply_created_at: replyCreatedAt,
  })

  // 2-3. 直列化アドバイザリーロック関数を用いた安全な単調増加投影イベントの作成
  let projectionEventId = 0
  const { data: rpcEventId, error: rpcError } = await supabaseAdmin.rpc('create_projection_event_atomic', {
    p_session_id: sessionId,
    p_room_id: roomId,
    p_human_post_id: humanPostId,
    p_ai_post_id: aiPost.id,
    p_event_type: 'paired',
  })

  if (!rpcError && typeof rpcEventId === 'number') {
    projectionEventId = rpcEventId
  } else {
    // RPC未マイグレーション環境等へのフォールバック（直接INSERT）
    const { data: directEvent } = await supabaseAdmin
      .from('projection_events')
      .insert({
        session_id: sessionId,
        room_id: roomId,
        human_post_id: humanPostId,
        ai_post_id: aiPost.id,
        event_type: 'paired',
      })
      .select('id')
      .maybeSingle()

    projectionEventId = directEvent?.id ?? 0
  }

  // ジョブの完了更新
  if (jobId) {
    await supabaseAdmin.from('ai_reply_jobs').update({
      status: 'completed',
      updated_at: new Date().toISOString(),
    }).eq('id', jobId)
  }

  return {
    projectionEventId,
    aiPostId: aiPost.id,
    mode: config.mode,
    sourceType: replySourceType,
    isPaired: true,
    jobStatus: 'completed',
  }
}

async function registerHumanOnlyEvent(params: {
  sessionId: string
  roomId: string
  humanPostId: number
  mode: ReactionAiMode
  clientSentAt?: string | null
  startTime: number
}): Promise<ProcessReactionResult> {
  const { sessionId, roomId, humanPostId, mode, clientSentAt, startTime } = params
  const durationMs = Date.now() - startTime

  // ログ記録
  await supabaseAdmin.from('ai_reply_logs').insert({
    session_id: sessionId,
    room_id: roomId,
    human_post_id: humanPostId,
    ai_post_id: null,
    mode,
    source_type: 'none',
    client_sent_at: clientSentAt || null,
    generation_duration_ms: durationMs,
  })

  // 投影イベント登録（RPC）
  let projectionEventId = 0
  const { data: rpcEventId } = await supabaseAdmin.rpc('create_projection_event_atomic', {
    p_session_id: sessionId,
    p_room_id: roomId,
    p_human_post_id: humanPostId,
    p_ai_post_id: null,
    p_event_type: 'human_only',
  })

  if (typeof rpcEventId === 'number') {
    projectionEventId = rpcEventId
  } else {
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
      .maybeSingle()

    projectionEventId = event?.id ?? 0
  }

  return {
    projectionEventId,
    aiPostId: null,
    mode,
    sourceType: 'none',
    isPaired: false,
    jobStatus: 'completed',
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
