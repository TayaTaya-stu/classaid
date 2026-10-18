import { NextResponse } from 'next/server'
import { isTeacherAuthenticated } from '@/lib/teacher-auth'
import { supabaseAdmin } from '@/lib/supabase-admin'

const UUID_REGEX = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/

export async function GET(request: Request) {
  if (!(await isTeacherAuthenticated())) return NextResponse.json({ error: '先生用認証が必要です。' }, { status: 401 })
  const requested = new URL(request.url).searchParams.get('sessionId')
  if (requested && !UUID_REGEX.test(requested)) return NextResponse.json({ error: '授業回の指定が不正です。' }, { status: 400 })
  const { data: sessions, error } = await supabaseAdmin.from('sessions')
    .select('id, session_number, scheduled_at, protocol_snapshot').neq('id', '00000000-0000-0000-0000-000000000001')
    .order('scheduled_at', { ascending: false })
  if (error) return NextResponse.json({ error: '授業回を取得できませんでした。' }, { status: 500 })
  const selected = (requested && sessions?.find((item) => item.id === requested)) || sessions?.[0]
  if (!selected) return NextResponse.json({ sessions: [], selectedSessionId: null, rooms: [], posts: [] })
  const { data: rooms, error: roomsError } = await supabaseAdmin.from('rooms').select('id, group_label').eq('session_id', selected.id)
  if (roomsError) return NextResponse.json({ error: 'ルーム情報を取得できませんでした。' }, { status: 500 })
  const labels = new Map((rooms || []).map((room) => [room.id, room.group_label]))
  const { data: posts, error: postsError } = await supabaseAdmin.from('posts')
    .select('id, room_id, author_display_name, message, created_at').eq('session_id', selected.id)
    .eq('audience_type', 'teacher').eq('is_deleted', false).order('created_at', { ascending: false }).limit(200)
  if (postsError) return NextResponse.json({ error: '質問・感想を取得できませんでした。' }, { status: 500 })
  return NextResponse.json({
    sessions: (sessions || []).map((session) => ({ id: session.id, sessionNumber: session.session_number, scheduledAt: session.scheduled_at,
      isDevelopment: session.session_number === 0 || (session.protocol_snapshot as { exclude_from_analysis?: boolean } | null)?.exclude_from_analysis === true })),
    selectedSessionId: selected.id,
    rooms: (rooms || []).map((room) => ({ id: room.id, groupLabel: room.group_label })),
    posts: (posts || []).map((post) => ({ id: post.id, roomLabel: labels.get(post.room_id) || '?', authorDisplayName: post.author_display_name, message: post.message, createdAt: post.created_at })),
  })
}
