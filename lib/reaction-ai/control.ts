import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase-admin'

export async function controlReaction(sessionId: unknown, action: string, mode?: unknown, isMockAi: boolean = false) {
  if (typeof sessionId !== 'string' || !/^[0-9a-f-]{36}$/i.test(sessionId)) {
    return NextResponse.json({ error: '授業回が不正です。' }, { status: 400 })
  }
  const validActions = [
    'configure',
    'start',
    'stop',
    'pause_ai',
    'resume_ai',
    'pause_projection',
    'resume_projection',
    'record_demo_projection',
    'check_or_expire_120m',
  ]
  if (!validActions.includes(action)) {
    return NextResponse.json({ error: '未対応の操作です。' }, { status: 400 })
  }
  if (action === 'configure' && !['off', 'empathy', 'lecture_bridge', 'neutral'].includes(String(mode))) {
    return NextResponse.json({ error: 'AIモードが不正です。' }, { status: 400 })
  }

  if (action === 'start') {
    const {error:schemaError}=await supabaseAdmin.from('reaction_generation_budget').select('session_id').limit(1)
    if(schemaError)return NextResponse.json({error:'SQL 020の反映を確認してから開始してください。'},{status:503})
    const { data: target, error: targetError } = await supabaseAdmin.from('sessions')
      .select('is_current_target').eq('id', sessionId).maybeSingle()
    if (targetError) return NextResponse.json({ error: '今回の授業回を確認できません。' }, { status: 503 })
    if (!target?.is_current_target) return NextResponse.json({ error: '管理者画面で今回使用する回に指定してから開始してください。' }, { status: 409 })
  }

  // 実際の処理経路で120分期限到達を確実にDB判定・確定
  const { error: expiryError } = await supabaseAdmin.rpc('check_or_expire_120m', { p_session_id: sessionId })
  if (expiryError) return NextResponse.json({ error: '授業の期限を確認できません。通信を確認して再試行してください。' }, { status: 503 })

  const { data, error } = action==='start'
    ? await supabaseAdmin.rpc('start_designated_reaction_session',{p_session_id:sessionId})
    : await supabaseAdmin.rpc('control_reaction_session',{
      p_session_id:sessionId,p_action:action,p_mode:action==='configure'?mode:null,p_is_mock_ai:isMockAi,
    })

  if (error) {
    const conflict = /already_started|condition_locked|not_started|session_not_designated|session_closed|session_expired/.test(error.message)
    const errorText = error.message.includes('session_expired')
      ? '授業開始から120分が経過したため自動停止しました。期限後の操作はできません。'
      : error.message.includes('session_closed')
      ? '授業はすでに終了しています。終了後の再開はできません。'
      : conflict
      ? '開始済み、未開始、または終了済みのため、この操作はできません。'
      : '設定を保存できません。DB更新を確認してください。'
    return NextResponse.json({ error: errorText, detail: error.message }, { status: conflict ? 409 : 500 })
  }

  if (data && data.success === false) {
    const errorText = data.error === 'session_expired'
      ? '授業開始から120分が経過したため自動停止しました。期限後の操作はできません。'
      : data.error === 'session_closed'
      ? '授業はすでに終了しています。終了後の再開はできません。'
      : 'この操作は現在できません。'
    return NextResponse.json({ error: errorText, ...data }, { status: 409 })
  }

  return NextResponse.json(data)
}
