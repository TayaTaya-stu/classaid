import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase-admin'

export async function POST(request: Request, context: { params: Promise<{ screenSlug: string }> }) {
  try {
    const { screenSlug } = await context.params
    if (!/^[a-zA-Z0-9_-]{16,128}$/.test(screenSlug)) return NextResponse.json({ error: 'Invalid URL' }, { status: 400 })

    const body = await request.text()
    if (body.length > 2048) return NextResponse.json({ error: 'Too large' }, { status: 413 })
    const x = JSON.parse(body)

    const { data: session, error: se } = await supabaseAdmin
      .from('sessions')
      .select('id')
      .eq('screen_slug', screenSlug)
      .eq('room_mode', 'shared')
      .single()
    if (se || !session) return NextResponse.json({ error: 'Not found' }, { status: 404 })

    // 5. デモ実投影時刻の記録: rendererの描画通知 (isDemo: true または phase: 'demo_viewport_entered') から記録
    if (x.isDemo === true || x.phase === 'demo_viewport_entered') {
      if (!Number.isFinite(x.renderedAt)) return NextResponse.json({ error: 'Invalid demo renderedAt' }, { status: 400 })
      const renderedAtIso = new Date(x.renderedAt).toISOString()
      const { error: rpcErr } = await supabaseAdmin.rpc('record_demo_projected', {
        p_session_id: session.id,
        p_rendered_at: renderedAtIso,
      })
      if (rpcErr) throw rpcErr
      return NextResponse.json({ ok: true, isDemo: true, demoProjectedAt: renderedAtIso })
    }

    if (!Number.isSafeInteger(x.eventId) || x.eventId < 1 || typeof x.clientInstanceId !== 'string' || !/^[a-f0-9-]{36}$/.test(x.clientInstanceId) || !['dom_added', 'viewport_entered'].includes(x.phase) || !Number.isFinite(x.renderedAt) || !Number.isFinite(x.dispatchedAt) || x.renderedAt < x.dispatchedAt || x.renderedAt - x.dispatchedAt > 7200000) {
      return NextResponse.json({ error: 'Invalid data' }, { status: 400 })
    }

    const { data: event, error: ee } = await supabaseAdmin.from('projection_events').select('id').eq('id', x.eventId).eq('session_id', session.id).single()
    if (ee || !event) return NextResponse.json({ error: 'Not found' }, { status: 404 })

    const since = new Date(Date.now() - 60000).toISOString()
    const { count, error: ce } = await supabaseAdmin.from('projection_render_logs').select('id', { count: 'exact', head: true }).eq('session_id', session.id).gte('created_at', since)
    if (ce) throw new Error('Rate check unavailable')
    if ((count ?? 0) > 2400) return NextResponse.json({ error: 'Rate limit' }, { status: 429 })

    const { error } = await supabaseAdmin.from('projection_render_logs').insert({
      session_id: session.id,
      event_id: x.eventId,
      client_instance_id: x.clientInstanceId,
      phase: x.phase,
      dispatched_at: new Date(x.dispatchedAt).toISOString(),
      rendered_at: new Date(x.renderedAt).toISOString(),
      render_latency_ms: Math.round(x.renderedAt - x.dispatchedAt),
    })
    if (error && error.code !== '23505') throw new Error('Render log failed')
    return NextResponse.json({ ok: true })
  } catch {
    return NextResponse.json({ error: '表示ログを保存できませんでした。' }, { status: 503 })
  }
}
