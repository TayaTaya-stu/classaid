import { NextResponse } from 'next/server'
import { isAdminAuthenticated } from '@/lib/admin-auth'
import { supabaseAdmin } from '@/lib/supabase-admin'

const UUID_REGEX = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/

export async function GET(request: Request) {
  if (!(await isAdminAuthenticated())) return NextResponse.json({ error: '管理者認証が必要です。' }, { status: 401 })
  const roomId = new URL(request.url).searchParams.get('roomId')
  if (!roomId || !UUID_REGEX.test(roomId)) return NextResponse.json({ error: 'ルーム指定が不正です。' }, { status: 400 })

  const { data: room, error: roomError } = await supabaseAdmin.from('rooms')
    .select('id, session_id, group_label').eq('id', roomId).maybeSingle()
  if (roomError || !room) return NextResponse.json({ error: 'ルームが見つかりません。' }, { status: 404 })

  const { data: posts, error: postsError } = await supabaseAdmin.from('posts')
    .select('id, author_display_name, author_type, is_ai, message, audience_type, created_at')
    .eq('room_id', room.id).eq('session_id', room.session_id).eq('is_deleted', false)
    .order('created_at', { ascending: false }).order('id', { ascending: false }).limit(200)
  if (postsError) return NextResponse.json({ error: '投稿の取得に失敗しました。' }, { status: 500 })

  return NextResponse.json({
    roomLabel: room.group_label,
    posts: (posts || []).slice().reverse().map((post) => {
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
  })
}
