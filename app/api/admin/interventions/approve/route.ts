import { NextResponse } from 'next/server'
import { isAdminAuthenticated } from '@/lib/admin-auth'
import { supabaseAdmin } from '@/lib/supabase-admin'

const UUID_REGEX = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/

export async function POST(request: Request) {
  if (!(await isAdminAuthenticated())) return NextResponse.json({ error: '管理者認証が必要です。' }, { status: 401 })
  let body: unknown
  try { body = await request.json() } catch { return NextResponse.json({ error: '不正なリクエストです。' }, { status: 400 }) }
  const value = body as { interventionId?: unknown; attemptId?: unknown; candidateIndex?: unknown; finalMessage?: unknown }
  if (!body || typeof body !== 'object' || typeof value.interventionId !== 'string' || !UUID_REGEX.test(value.interventionId) ||
      typeof value.attemptId !== 'string' || !UUID_REGEX.test(value.attemptId) || !Number.isInteger(value.candidateIndex)) {
    return NextResponse.json({ error: '承認内容が不正です。' }, { status: 400 })
  }

  const [{ data: intervention }, { data: attempt }] = await Promise.all([
    supabaseAdmin.from('ai_interventions').select('id, status')
      .eq('id', value.interventionId).maybeSingle(),
    supabaseAdmin.from('ai_generation_attempts').select('id, intervention_id, candidate_messages')
      .eq('id', value.attemptId).eq('intervention_id', value.interventionId).maybeSingle(),
  ])
  if (!intervention || !attempt) return NextResponse.json({ error: '候補が見つかりません。' }, { status: 404 })
  if (intervention.status === 'posted') return NextResponse.json({ error: '既に投稿済みです。' }, { status: 409 })
  const candidates = Array.isArray(attempt.candidate_messages) ? attempt.candidate_messages : []
  const selected = candidates[Number(value.candidateIndex)]
  const finalMessage = typeof value.finalMessage === 'string' && value.finalMessage.trim()
    ? value.finalMessage.trim() : typeof selected === 'string' ? selected.trim() : ''
  if (!finalMessage || finalMessage.length > 100) return NextResponse.json({ error: '投稿文は1～100文字にしてください。' }, { status: 400 })

  const original = typeof selected === 'string' ? selected.trim() : ''
  const { data: postId, error: approvalError } = await supabaseAdmin.rpc('approve_ai_intervention', {
    p_intervention_id: value.interventionId,
    p_attempt_id: value.attemptId,
    p_final_message: finalMessage,
    p_original_message: original,
  })
  if (approvalError) {
    const alreadyPosted = approvalError.message.includes('already posted')
    return NextResponse.json({ error: alreadyPosted ? '既に投稿済みです。' : 'AI投稿の保存に失敗しました。' }, { status: alreadyPosted ? 409 : 500 })
  }
  return NextResponse.json({ success: true, postId })
}
