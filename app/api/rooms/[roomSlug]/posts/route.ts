import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { verifyRoomAccess } from '@/lib/room-access'

interface RouteContext {
  params: Promise<{
    roomSlug: string
  }>
}

/**
 * GET: ルーム内の投稿一覧を取得
 * - 最新100件を取得し、クライアント向けに時系列昇順へ並べ替え
 * - いいね情報取得時のDBエラーを適切にハンドリング
 */
export async function GET(_request: Request, context: RouteContext) {
  try {
    const { roomSlug } = await context.params
    const roomAccess = await verifyRoomAccess(roomSlug)

    if (!roomAccess) {
      return NextResponse.json(
        { error: 'ルームへのアクセス権がありません。再度入室してください。' },
        { status: 403 }
      )
    }

    const { room, session, participant } = roomAccess

    // 1. 同一ルームかつ未削除の「最新100件」を降順で取得
    const { data: rawPosts, error: postsError } = await supabaseAdmin
      .from('posts')
      .select('id, author_display_name, author_type, is_ai, message, audience_type, created_at')
      .eq('room_id', room.id)
      .eq('is_deleted', false)
      .order('created_at', { ascending: false })
      .order('id', { ascending: false })
      .limit(100)

    if (postsError) {
      return NextResponse.json(
        { error: '投稿一覧の取得に失敗しました。' },
        { status: 500 }
      )
    }

    // クライアントへ返す前に時系列昇順（古い順）へ反転
    const postList = (rawPosts || []).slice().reverse()
    const postIds = postList.map((p) => p.id)

    // 2. いいね情報の集計（DBエラーは無視せず500として処理）
    const likeCounts: Record<number, number> = {}
    const likedPostIds = new Set<number>()

    if (postIds.length > 0) {
      const { data: likesData, error: likesError } = await supabaseAdmin
        .from('post_likes')
        .select('post_id, participant_id')
        .in('post_id', postIds)

      if (likesError) {
        return NextResponse.json(
          { error: 'いいね情報の集計に失敗しました。' },
          { status: 500 }
        )
      }

      likesData?.forEach((like) => {
        likeCounts[like.post_id] = (likeCounts[like.post_id] || 0) + 1
        if (like.participant_id === participant.id) {
          likedPostIds.add(like.post_id)
        }
      })
    }

    // 3. クライアントへ返す安全なDTOの組み立て
    const posts = postList.map((post) => {
      const isAi = post.author_type === 'ai' || post.is_ai === true

      return {
        id: post.id,
        authorDisplayName: isAi ? '学生AI' : post.author_display_name,
        authorType: isAi ? ('ai' as const) : ('human' as const),
        message: post.message,
        createdAt: post.created_at,
        likesCount: likeCounts[post.id] || 0,
        isLiked: likedPostIds.has(post.id),
        audienceType: post.audience_type === 'teacher' ? ('teacher' as const) : ('room' as const),
      }
    })

    return NextResponse.json({
      posts,
      isSessionLocked: session.isLocked || ['completed', 'locked'].includes(session.status),
      currentUser: {
        displayName: participant.displayName,
      },
    })
  } catch {
    return NextResponse.json(
      { error: 'サーバー内部エラーが発生しました。' },
      { status: 500 }
    )
  }
}

/**
 * POST: 人間学生による新規投稿の作成
 */
export async function POST(request: Request, context: RouteContext) {
  try {
    const { roomSlug } = await context.params
    const roomAccess = await verifyRoomAccess(roomSlug)

    if (!roomAccess) {
      return NextResponse.json(
        { error: 'ルームへのアクセス権限が確認できません。' },
        { status: 403 }
      )
    }

    const { room, session, participant } = roomAccess

    // セッション終了・ロック状態の確認
    if (session.isLocked || ['completed', 'locked'].includes(session.status)) {
      return NextResponse.json(
        { error: 'この授業セッションは終了しているため、投稿できません。' },
        { status: 403 }
      )
    }

    let body: unknown
    try {
      body = await request.json()
    } catch {
      return NextResponse.json(
        { error: '不正なリクエスト形式です。' },
        { status: 400 }
      )
    }

    if (!body || typeof body !== 'object') {
      return NextResponse.json(
        { error: 'リクエストデータが無効です。' },
        { status: 400 }
      )
    }

    const requestBody = body as Record<string, unknown>
    const { message, audienceType } = requestBody

    // 学生用APIでは返信を受け付けない
    if (Object.prototype.hasOwnProperty.call(requestBody, 'parentId')) {
      return NextResponse.json(
        { error: '返信機能は利用できません。通常の投稿として送信してください。' },
        { status: 400 }
      )
    }

    // 1. 本文の検証
    if (typeof message !== 'string' || message.trim().length === 0) {
      return NextResponse.json(
        { error: '投稿内容を入力してください。' },
        { status: 400 }
      )
    }

    const trimmedMessage = message.trim()
    if (trimmedMessage.length > 500) {
      return NextResponse.json(
        { error: '投稿内容は500文字以内で入力してください。' },
        { status: 400 }
      )
    }

    // 2. 投稿先の検証
    if (audienceType !== 'room' && audienceType !== 'teacher') {
      return NextResponse.json(
        { error: '投稿先を正しく選択してください。' },
        { status: 400 }
      )
    }

    // 3. 直近の二重送信防止チェック（同一参加者が同一ルーム・同一本文を3秒以内に連投していないか）
    const threeSecondsAgo = new Date(Date.now() - 3000).toISOString()
    const { data: recentDuplicate } = await supabaseAdmin
      .from('posts')
      .select('id')
      .eq('room_id', room.id)
      .eq('participant_id', participant.id)
      .eq('message', trimmedMessage)
      .gte('created_at', threeSecondsAgo)
      .limit(1)

    if (recentDuplicate && recentDuplicate.length > 0) {
      return NextResponse.json(
        { error: '同じ内容が送信されました。連続送信はお控えください。' },
        { status: 429 }
      )
    }

    // 4. サーバー側による安全な投稿レコードの作成
    const { data: newPost, error: insertError } = await supabaseAdmin
      .from('posts')
      .insert({
        session_id: session.id,
        room_id: room.id,
        participant_id: participant.id,
        author_type: 'human',
        author_display_name: participant.displayName,
        name: participant.displayName, // 既存互換カラム
        message: trimmedMessage,
        is_ai: false, // 既存互換カラム
        likes: 0,
        dislikes: 0,
        parent_id: null,
        reply_target_type: 'none',
        audience_type: audienceType,
        is_deleted: false,
      })
      .select('id, created_at')
      .single()

    if (insertError || !newPost) {
      return NextResponse.json(
        { error: '投稿の保存に失敗しました。' },
        { status: 500 }
      )
    }

    return NextResponse.json({
      success: true,
      post: {
        id: newPost.id,
        authorDisplayName: participant.displayName,
        authorType: 'human',
        message: trimmedMessage,
        createdAt: newPost.created_at,
        likesCount: 0,
        isLiked: false,
        audienceType,
      },
    })
  } catch {
    return NextResponse.json(
      { error: 'サーバー内部エラーが発生しました。' },
      { status: 500 }
    )
  }
}
