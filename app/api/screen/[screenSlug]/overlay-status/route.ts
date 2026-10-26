import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase-admin'

interface RouteContext {
  params: Promise<{ screenSlug: string }>
}

export async function POST(request: Request, context: RouteContext) {
  try {
    const { screenSlug } = await context.params
    if (!/^[a-zA-Z0-9_-]{16,128}$/.test(screenSlug)) {
      return NextResponse.json({ error: 'Invalid screenSlug' }, { status: 400 })
    }

    const body = await request.json().catch(() => null)
    if (!body || typeof body.status !== 'string') {
      return NextResponse.json({ error: 'Invalid body' }, { status: 400 })
    }

    const { data: session } = await supabaseAdmin
      .from('sessions')
      .select('id, status, is_locked, class_started_at, auto_expired_at')
      .eq('screen_slug', screenSlug)
      .eq('room_mode', 'shared')
      .maybeSingle()

    if (!session) {
      return NextResponse.json({ error: 'Session not found' }, { status: 404 })
    }

    // イベントログにオーバーレイ稼働状態を記録
    const {error:logError}=await supabaseAdmin.from('event_logs').insert({
      session_id: session.id,
      event_type: 'overlay_client_status',
      metadata: {
        status: body.status,
        displayLabel: body.displayLabel || 'デフォルト画面',
        clientInstanceId: body.clientInstanceId || null,
        reportedAt: new Date().toISOString(),
      },
    })

    if(logError)throw new Error('Status log failed')
    return NextResponse.json({ ok: true, status: body.status })
  } catch {
    return NextResponse.json({ error: 'ステータス更新に失敗しました。' }, { status: 500 })
  }
}

export async function GET() {return NextResponse.json({error:'旧稼働判定は使用しません。実表示ログを確認してください。'},{status:410})}
