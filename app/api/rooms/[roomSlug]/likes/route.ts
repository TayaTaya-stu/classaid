import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { verifyRoomAccess } from '@/lib/room-access'

interface RouteContext {
  params: Promise<{
    roomSlug: string
  }>
}

/**
 * POST: 投稿に対するいいねのトグル（追加・解除）
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

    const { room, session, participant, authUserId } = roomAccess

    // 1. セッション終了・ロック状態の確認（いいねの追加・解除も拒否）
    if (session.isLocked || ['completed', 'locked'].includes(session.status)) {
      return NextResponse.json(
        { error: 'この授業セッションは終了しているため、リアクションを変更できません。' },
        { status: 403 }
      )
    }

    // 2. 匿名認証ユーザーIDの確認
    if (!authUserId) {
      return NextResponse.json(
        { error: '認証情報が確認できません。再度入室してください。' },
        { status: 401 }
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

    const { postId } = body as Record<string, unknown>

    if (typeof postId !== 'number' || !Number.isInteger(postId) || postId <= 0) {
      return NextResponse.json(
        { error: '無効な投稿IDです。' },
        { status: 400 }
      )
    }

    // 3. 対象投稿が同一ルームかつ未削除か確認
    const { data: targetPost, error: postFindError } = await supabaseAdmin
      .from('posts')
      .select('id')
      .eq('id', postId)
      .eq('room_id', room.id)
      .eq('is_deleted', false)
      .maybeSingle()

    if (postFindError || !targetPost) {
      return NextResponse.json(
        { error: '対象の投稿が見つからないか、削除されています。' },
        { status: 404 }
      )
    }

    // 4. 既存のいいねレコードを確認
    const { data: existingLike, error: likeFindError } = await supabaseAdmin
      .from('post_likes')
      .select('id')
      .eq('post_id', postId)
      .eq('participant_id', participant.id)
      .maybeSingle()

    if (likeFindError) {
      return NextResponse.json(
        { error: 'いいね情報の確認に失敗しました。' },
        { status: 500 }
      )
    }

    let isLikedNow = false

    if (existingLike) {
      // 5-A. 既にいいね済み: 解除 (DELETE)
      const { error: deleteError } = await supabaseAdmin
        .from('post_likes')
        .delete()
        .eq('id', existingLike.id)

      if (deleteError) {
        return NextResponse.json(
          { error: 'いいねの解除に失敗しました。' },
          { status: 500 }
        )
      }
      isLikedNow = false
    } else {
      // 5-B. 未いいね: 追加 (INSERT)
      // Cookieで検証済みの authUserId のみを使用し、存在しないダミーUUIDは絶対に使用しない
      const { error: insertError } = await supabaseAdmin
        .from('post_likes')
        .insert({
          post_id: postId,
          participant_id: participant.id,
          user_id: authUserId,
        })

      if (insertError) {
        // 重複競合（23505）が発生した場合は、他方のリクエストで既にいいねされたとみなして正常終了
        if (insertError.code !== '23505') {
          return NextResponse.json(
            { error: 'いいねの登録に失敗しました。' },
            { status: 500 }
          )
        }
      }
      isLikedNow = true
    }

    // 6. 最新の総いいね数を取得
    const { count, error: countError } = await supabaseAdmin
      .from('post_likes')
      .select('*', { count: 'exact', head: true })
      .eq('post_id', postId)

    const finalLikesCount = countError || count === null ? 0 : count

    return NextResponse.json({
      success: true,
      isLiked: isLikedNow,
      likesCount: finalLikesCount,
    })
  } catch {
    return NextResponse.json(
      { error: 'サーバー内部エラーが発生しました。' },
      { status: 500 }
    )
  }
}
