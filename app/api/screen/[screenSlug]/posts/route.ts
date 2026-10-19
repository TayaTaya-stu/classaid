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
    const afterParam = url.searchParams.get('afterId')
    const afterId = afterParam && /^\d+$/.test(afterParam) ? Number(afterParam) : null

    let query = supabaseAdmin
      .from('posts')
      .select('id, author_display_name, author_type, is_ai, message, audience_type, created_at')
      .eq('room_id', rooms[0].id)
      .eq('is_deleted', false)

    query = afterId !== null
      ? query.gt('id', afterId).order('id', { ascending: true }).limit(100)
      : query.order('created_at', { ascending: false }).order('id', { ascending: false }).limit(100)

    const { data: rawPosts, error: postsError } = await query
    if (postsError) {
      return NextResponse.json({ error: '投稿の取得に失敗しました。' }, { status: 500 })
    }

    const ordered = afterId !== null ? (rawPosts || []) : (rawPosts || []).slice().reverse()
    return NextResponse.json({
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
      resultMode: afterId !== null ? 'delta' : 'full',
      entryPath: `/enter/${session.entry_slug}`,
      isSessionClosed: session.is_locked || ['completed', 'locked'].includes(session.status),
    })
  } catch {
    return NextResponse.json({ error: '表示情報の取得に失敗しました。' }, { status: 500 })
  }
}
