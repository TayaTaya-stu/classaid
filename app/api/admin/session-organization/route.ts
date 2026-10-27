import { NextResponse } from 'next/server'
import { isAdminAuthenticated } from '@/lib/admin-auth'
import { supabaseAdmin } from '@/lib/supabase-admin'

export async function POST(request: Request) {
  if (!(await isAdminAuthenticated())) return NextResponse.json({ error: '管理者認証が必要です。' }, { status: 401 })
  const body = await request.json().catch(() => null)
  if (!body || typeof body.sessionId !== 'string' || !/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(body.sessionId) ||
      !['archive','restore','delete_unused'].includes(body.action) ||
      (body.action === 'delete_unused' && body.confirmation !== 'delete-unused')) {
    return NextResponse.json({ error: '授業回と確認内容を確認してください。' }, { status: 400 })
  }
  try {
    const { data, error } = await supabaseAdmin.rpc('organize_admin_session', { p_session_id: body.sessionId, p_action: body.action })
    if (error) return NextResponse.json({ error: '整理を保存できませんでした。SQL 026の反映と通信を確認してください。' }, { status: 503 })
    if (data?.success !== true) {
      if (data?.error === 'session_not_found') return NextResponse.json({ error: '対象の授業回が見つかりません。一覧を更新してください。' }, { status: 404 })
      if (data?.error === 'session_in_use') return NextResponse.json({ error: '授業中・今回指定中の回は整理できません。授業を終了し、別の回を今回使用する回に指定してください。' }, { status: 409 })
      if (data?.error === 'session_has_records') return NextResponse.json({ error: '参加・投稿・音声・資料などの記録があるため削除できません。「履歴に移す」を使ってください。' }, { status: 409 })
      return NextResponse.json({ error: '整理を保存できませんでした。再試行してください。' }, { status: 503 })
    }
    return NextResponse.json({ success: true, action: body.action }, { headers: { 'Cache-Control': 'no-store' } })
  } catch {
    return NextResponse.json({ error: '整理を保存できませんでした。通信を確認して再試行してください。' }, { status: 503 })
  }
}
