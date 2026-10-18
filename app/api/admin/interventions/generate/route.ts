import { GoogleGenAI } from '@google/genai'
import { NextResponse } from 'next/server'
import { isAdminAuthenticated } from '@/lib/admin-auth'
import { EXPERIMENT_AI_CONFIG, instructionFor, type PlannedMessageType } from '@/lib/experiment-config'
import { supabaseAdmin } from '@/lib/supabase-admin'

const UUID_REGEX = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/

function parseCandidates(text: string): string[] {
  const cleaned = text.trim().replace(/^```json\s*/i, '').replace(/```$/, '').trim()
  try {
    const parsed = JSON.parse(cleaned) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.filter((item): item is string => typeof item === 'string')
      .map((item) => item.replace(/[\r\n]+/g, ' ').trim().slice(0, EXPERIMENT_AI_CONFIG.maxCharacters))
      .filter(Boolean).slice(0, EXPERIMENT_AI_CONFIG.candidateCount)
  } catch { return [] }
}

export async function POST(request: Request) {
  if (!(await isAdminAuthenticated())) return NextResponse.json({ error: '管理者認証が必要です。' }, { status: 401 })
  const apiKey = process.env.GEMINI_API_KEY
  if (!apiKey) return NextResponse.json({ error: 'GEMINI_API_KEYが設定されていません。' }, { status: 503 })

  let body: unknown
  try { body = await request.json() } catch { return NextResponse.json({ error: '不正なリクエストです。' }, { status: 400 }) }
  const interventionId = body && typeof body === 'object' && 'interventionId' in body
    ? (body as { interventionId?: unknown }).interventionId : undefined
  if (typeof interventionId !== 'string' || !UUID_REGEX.test(interventionId)) {
    return NextResponse.json({ error: '介入枠の指定が不正です。' }, { status: 400 })
  }

  const { data: intervention, error: interventionError } = await supabaseAdmin
    .from('ai_interventions')
    .select('id, cycle_id, room_id, slot_index, status, planned_message_type, session_cycles!inner(session_id), rooms!inner(ai_condition)')
    .eq('id', interventionId).maybeSingle()
  if (interventionError || !intervention) return NextResponse.json({ error: '介入枠が見つかりません。' }, { status: 404 })
  if (intervention.status === 'posted' || intervention.status === 'skipped') {
    return NextResponse.json({ error: 'この介入枠は既に完了しています。' }, { status: 409 })
  }

  const cycleRelation = intervention.session_cycles as unknown as { session_id: string }
  const roomRelation = intervention.rooms as unknown as { ai_condition: 'none' | 'standard' | 'damekko' }
  if (roomRelation.ai_condition === 'none') return NextResponse.json({ error: 'AIなし条件には生成できません。' }, { status: 400 })
  const sessionId = cycleRelation.session_id

  const [{ data: session }, { data: posts }, { data: attempts }] = await Promise.all([
    supabaseAdmin.from('sessions').select('current_page, pdf_file_url, is_locked, status').eq('id', sessionId).single(),
    supabaseAdmin.from('posts').select('id, author_display_name, author_type, message')
      .eq('room_id', intervention.room_id).eq('is_deleted', false)
      .order('created_at', { ascending: false }).limit(EXPERIMENT_AI_CONFIG.recentChatLimit),
    supabaseAdmin.from('ai_generation_attempts').select('attempt_index').eq('intervention_id', interventionId)
      .order('attempt_index', { ascending: false }).limit(1),
  ])
  if (!session || session.is_locked || ['completed', 'locked'].includes(session.status)) {
    return NextResponse.json({ error: 'この授業回では生成できません。' }, { status: 403 })
  }

  const chat = (posts || []).slice().reverse().map((post) =>
    `${post.author_type === 'ai' ? '学生AI' : post.author_display_name}: ${post.message}`).join('\n') || 'まだ投稿はありません。'
  const messageType = (intervention.planned_message_type || (roomRelation.ai_condition === 'standard' ? 'standard' : 'reaction')) as PlannedMessageType
  const parts: Array<{ text: string } | { inlineData: { mimeType: string; data: string } }> = []

  if (session.pdf_file_url) {
    const { data: pdf } = await supabaseAdmin.storage.from('lecture-materials').download(session.pdf_file_url)
    if (pdf && pdf.size <= 20 * 1024 * 1024) {
      parts.push({ inlineData: { mimeType: 'application/pdf', data: Buffer.from(await pdf.arrayBuffer()).toString('base64') } })
    }
  }

  parts.push({ text: `あなたは授業内匿名チャットに参加する「学生AI」です。
AIであることは画面上で明示されます。教師ではなく学生の立場で、議論の核心を奪わないでください。

【今回の条件】${roomRelation.ai_condition}
【今回の発言タイプ】${messageType}
【個別指示】${instructionFor(roomRelation.ai_condition, messageType)}
【共通文体】${EXPERIMENT_AI_CONFIG.style.shared}
【現在のPDFページ】${session.current_page}
【直近チャット】
${chat}

文脈と現在ページに合う、互いに異なる投稿候補を${EXPERIMENT_AI_CONFIG.candidateCount}個作ってください。
各候補は${EXPERIMENT_AI_CONFIG.maxCharacters}文字以内です。AIへの返答を強制する質問は避けます。
出力は文字列だけのJSON配列にし、コードブロックや説明を付けないでください。` })

  await supabaseAdmin.from('ai_interventions').update({ status: 'generating' }).eq('id', interventionId)
  try {
    const ai = new GoogleGenAI({ apiKey })
    const result = await ai.models.generateContent({ model: EXPERIMENT_AI_CONFIG.model, contents: [{ role: 'user', parts }] })
    const candidates = parseCandidates(result.text || '')
    if (candidates.length !== EXPERIMENT_AI_CONFIG.candidateCount) throw new Error('candidate count mismatch')
    const attemptIndex = (attempts?.[0]?.attempt_index || 0) + 1
    const { data: attempt, error: insertError } = await supabaseAdmin.from('ai_generation_attempts').insert({
      intervention_id: interventionId,
      attempt_index: attemptIndex,
      ai_condition: roomRelation.ai_condition,
      damekko_mode: roomRelation.ai_condition === 'damekko' ? messageType : null,
      candidate_messages: candidates,
      slide_page_used: session.current_page,
      referenced_chat_ids: (posts || []).map((post) => post.id),
      prompt_version: EXPERIMENT_AI_CONFIG.promptVersion,
      git_commit_hash: process.env.VERCEL_GIT_COMMIT_SHA || null,
    }).select('id, attempt_index, candidate_messages').single()
    if (insertError || !attempt) throw new Error('attempt insert failed')
    await supabaseAdmin.from('ai_interventions').update({ status: 'ready_for_review' }).eq('id', interventionId)
    return NextResponse.json({ attempt: { id: attempt.id, attemptIndex: attempt.attempt_index, candidates: attempt.candidate_messages } })
  } catch {
    await supabaseAdmin.from('ai_interventions').update({ status: 'pending' }).eq('id', interventionId)
    return NextResponse.json({ error: 'AI候補を生成できませんでした。再生成してください。' }, { status: 502 })
  }
}
