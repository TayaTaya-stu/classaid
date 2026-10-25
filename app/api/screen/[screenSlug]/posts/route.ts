import { NextResponse } from 'next/server'
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
      .select('id, entry_slug, status, is_locked')
      .eq('screen_slug', screenSlug)
      .eq('room_mode', 'shared')
      .maybeSingle()

    if (sessionError || !session) {
      return NextResponse.json({ error: '表示対象の授業が見つかりません。' }, { status: 404 })
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
    const cursorParam = url.searchParams.get('afterCursor') || url.searchParams.get('afterId')
    const afterCursor = cursorParam && /^\d+$/.test(cursorParam) ? Number(cursorParam) : null

    // 1. 新基盤: projection_events による順序逆転・欠落防止のイベント取得を試行
    try {
      const { getProjectionEvents } = await import('@/lib/reaction-ai/service')
      const { events, nextCursor } = await getProjectionEvents({
        roomId: rooms[0].id,
        afterCursor,
        limit: 50,
      })

      if (events.length > 0 || afterCursor !== null) {
        // 旧クライアントとの互換用 posts 配列を構築（ペアの場合は人間投稿とAI返信を順に展開）
        const flatPosts: Array<{
          id: number
          authorDisplayName: string
          authorType: 'human' | 'ai'
          message: string
          audienceType: 'room'
          createdAt: string
        }> = []

        for (const ev of events) {
          flatPosts.push({
            id: ev.humanPost.id,
            authorDisplayName: ev.humanPost.authorDisplayName,
            authorType: 'human',
            message: ev.humanPost.message,
            audienceType: 'room',
            createdAt: ev.humanPost.createdAt,
          })
          if (ev.aiReply) {
            flatPosts.push({
              id: ev.aiReply.id,
              authorDisplayName: ev.aiReply.authorDisplayName,
              authorType: 'ai',
              message: ev.aiReply.message,
              audienceType: 'room',
              createdAt: ev.aiReply.createdAt,
            })
          }
        }

        return NextResponse.json({
          events, // 新クライアント向け: ペア構造＆単調増加カーソル
          cursor: nextCursor,
          posts: flatPosts, // 旧Electronクライアント向け後方互換
          resultMode: afterCursor !== null ? 'delta' : 'full',
          entryPath: `/enter/${session.entry_slug}`,
          isSessionClosed: session.is_locked || ['completed', 'locked'].includes(session.status),
        })
      }
    } catch (eventError) {
      // projection_events テーブルが未マイグレーション等の場合はフォールバックへ
      console.warn('Fallback to legacy posts query:', eventError)
    }

    // 2. フォールバック: 従来の posts テーブル直接クエリ
    let query = supabaseAdmin
      .from('posts')
      .select('id, author_display_name, author_type, is_ai, message, audience_type, created_at')
      .eq('room_id', rooms[0].id)
      .eq('is_deleted', false)

    query = afterCursor !== null
      ? query.gt('id', afterCursor).order('id', { ascending: true }).limit(100)
      : query.order('created_at', { ascending: false }).order('id', { ascending: false }).limit(100)

    const { data: rawPosts, error: postsError } = await query
    if (postsError) {
      return NextResponse.json({ error: '投稿の取得に失敗しました。' }, { status: 500 })
    }

    const ordered = afterCursor !== null ? (rawPosts || []) : (rawPosts || []).slice().reverse()
    return NextResponse.json({
      events: ordered.map((post) => ({
        cursor: post.id,
        eventType: 'human_only',
        humanPost: {
          id: post.id,
          authorDisplayName: post.author_type === 'ai' || post.is_ai ? '学生AI' : post.author_display_name,
          authorType: post.author_type === 'ai' || post.is_ai ? 'ai' : 'human',
          message: post.message,
          createdAt: post.created_at,
        },
        aiReply: null,
        createdAt: post.created_at,
      })),
      cursor: ordered.at(-1)?.id ?? afterCursor,
      posts: ordered.map((post) => {
        const isAi = post.author_type === 'ai' || post.is_ai === true
        return {
          id: post.id,
          authorDisplayName: isAi ? '学生AI' : post.author_display_name,
          authorType: isAi ? 'ai' : 'human',
          message: post.message,
          audienceType: post.audience_type === 'teacher' ? 'teacher' : 'room',
          createdAt: post.created_at,
        }
      }),
      resultMode: afterCursor !== null ? 'delta' : 'full',
      entryPath: `/enter/${session.entry_slug}`,
      isSessionClosed: session.is_locked || ['completed', 'locked'].includes(session.status),
    })
  } catch {
    return NextResponse.json({ error: '表示情報の取得に失敗しました。' }, { status: 500 })
  }
}
