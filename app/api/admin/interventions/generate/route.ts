import { GoogleGenAI } from '@google/genai'
import { NextResponse } from 'next/server'
import { isAdminAuthenticated } from '@/lib/admin-auth'
import { EXPERIMENT_AI_CONFIG, generationInstruction } from '@/lib/experiment-config'
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

async function generateWithFallback(
  ai: GoogleGenAI,
  contents: Parameters<typeof ai.models.generateContent>[0]['contents'],
) {
  const models = [EXPERIMENT_AI_CONFIG.model, ...EXPERIMENT_AI_CONFIG.fallbackModels]
  const failures: Array<{ model: string; error: string }> = []

  for (const model of models) {
    try {
      const result = await ai.models.generateContent({ model, contents })
      return { result, modelUsed: model }
    } catch (error) {
      failures.push({ model, error: error instanceof Error ? error.message : 'unknown error' })
    }
  }

  throw new Error(JSON.stringify(failures))
}

export async function POST(request: Request) {
  if (!(await isAdminAuthenticated())) return NextResponse.json({ error: '管理者認証が必要です。' }, { status: 401 })
  const apiKey = process.env.GEMINI_API_KEY
  if (!apiKey) return NextResponse.json({ error: 'GEMINI_API_KEYが設定されていません。' }, { status: 503 })

  let interventionId: unknown
  let audioFiles: File[] = []
  try {
    if (request.headers.get('content-type')?.includes('multipart/form-data')) {
      const form = await request.formData()
      interventionId = form.get('interventionId')
      audioFiles = form.getAll('audio').filter((audio): audio is File => audio instanceof File && audio.size > 0).slice(-7)
    } else {
      const body = await request.json() as { interventionId?: unknown }
      interventionId = body?.interventionId
    }
  } catch { return NextResponse.json({ error: '不正なリクエストです。' }, { status: 400 }) }
  if (typeof interventionId !== 'string' || !UUID_REGEX.test(interventionId)) {
    return NextResponse.json({ error: '介入枠の指定が不正です。' }, { status: 400 })
  }

  const { data: intervention, error: interventionError } = await supabaseAdmin
    .from('ai_interventions')
    .select('id, cycle_id, room_id, slot_index, status, planned_message_type, planned_actor_id, planned_actor_display_name, session_cycles!inner(session_id), rooms!inner(ai_condition)')
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
    supabaseAdmin.from('sessions').select('current_page, pdf_file_url, is_locked, status, protocol_snapshot').eq('id', sessionId).single(),
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
  const messageType = intervention.planned_message_type || (roomRelation.ai_condition === 'standard' ? 'standard' : 'reaction')
  const generationStyle = generationInstruction(session.protocol_snapshot, roomRelation.ai_condition, messageType, intervention.planned_actor_id)
  const parts: Array<{ text: string } | { inlineData: { mimeType: string; data: string } }> = []
  let transcript = ''
  let audioWarning = ''

  if (audioFiles.length) {
    const acceptedAudio = ['audio/webm', 'audio/ogg', 'audio/mp4', 'audio/mpeg', 'audio/wav', 'audio/x-wav']
    const totalBytes = audioFiles.reduce((sum, file) => sum + file.size, 0)
    if (totalBytes > 15 * 1024 * 1024 || audioFiles.some((file) => !acceptedAudio.includes(file.type.split(';')[0].toLowerCase()))) {
      audioWarning = '音声形式または容量が対象外だったため、音声は参照していません。'
    } else {
      try {
        const ai = new GoogleGenAI({ apiKey })
        const audioParts: Array<{ inlineData: { mimeType: string; data: string } }> = []
        for (const audioFile of audioFiles) {
          const mimeType = audioFile.type.split(';')[0].toLowerCase()
          const audioData = Buffer.from(await audioFile.arrayBuffer()).toString('base64')
          audioParts.push({ inlineData: { mimeType, data: audioData } })
        }
        const { result: transcription } = await generateWithFallback(ai, [{ role: 'user', parts: [
            ...audioParts,
            { text: 'これらは時間順に並んだ連続する日本語授業音声です。全体を一つの音声として文字起こししてください。聞き取れた発話だけを自然な日本語で出力し、説明や推測を加えないでください。' },
          ] }])
        transcript = (transcription.text || '').trim().slice(0, 6000)
        if (!transcript) audioWarning = '音声を文字起こしできなかったため、音声なしで生成しました。'
      } catch { audioWarning = '音声処理に失敗したため、音声なしで生成しました。' }
    }
  } else {
    audioWarning = '利用できる直近音声がなかったため、音声なしで生成しました。'
  }

  if (session.pdf_file_url) {
    const { data: pdf } = await supabaseAdmin.storage.from('lecture-materials').download(session.pdf_file_url)
    if (pdf && pdf.size <= 20 * 1024 * 1024) {
      parts.push({ inlineData: { mimeType: 'application/pdf', data: Buffer.from(await pdf.arrayBuffer()).toString('base64') } })
    }
  }

  parts.push({ text: `あなたは授業内匿名チャットに参加する「${intervention.planned_actor_display_name || '学生AI'}」です。
AIであることは画面上で明示されます。教師ではなく学生の立場で、議論の核心を奪わないでください。

【今回のAIプロトコル】${generationStyle.protocolId}
【今回のAI参加者】${intervention.planned_actor_display_name || '学生AI'}
【人格指示】${generationStyle.actor?.personaInstruction || '自然な学生参加者として振る舞う。'}
【今回の発言カテゴリー】${generationStyle.categoryLabel}（${messageType}）
【個別指示】${generationStyle.instruction}
【共通文体】${generationStyle.sharedStyle}
【現在のPDFページ】${session.current_page}
【直近の授業音声の文字起こし】
${transcript || '音声情報なし'}
【直近チャット】
${chat}

文脈と現在ページに合う、互いに異なる投稿候補を${EXPERIMENT_AI_CONFIG.candidateCount}個作ってください。
各候補は${EXPERIMENT_AI_CONFIG.maxCharacters}文字以内です。AIへの返答を強制する質問は避けます。
出力は文字列だけのJSON配列にし、コードブロックや説明を付けないでください。` })

  await supabaseAdmin.from('ai_interventions').update({ status: 'generating' }).eq('id', interventionId)
  const resetIntervention = async () => {
    await supabaseAdmin.from('ai_interventions').update({ status: 'pending' }).eq('id', interventionId)
  }

  let generatedText = ''
  let modelUsed = ''
  try {
    const ai = new GoogleGenAI({ apiKey })
    const generated = await generateWithFallback(ai, [{ role: 'user', parts }])
    const result = generated.result
    modelUsed = generated.modelUsed
    generatedText = result.text || ''
  } catch (error) {
    console.error('AI candidate API request failed', {
      interventionId,
      error: error instanceof Error ? error.message : 'unknown error',
    })
    await resetIntervention()
    return NextResponse.json({
      error: '利用可能なAIモデルすべてで候補生成に失敗しました。少し待って再生成してください。',
      errorCode: 'ai_api_failed',
    }, { status: 502 })
  }

  const candidates = parseCandidates(generatedText)
  if (candidates.length !== EXPERIMENT_AI_CONFIG.candidateCount) {
    console.error('AI candidate format mismatch', {
      interventionId,
      expected: EXPERIMENT_AI_CONFIG.candidateCount,
      received: candidates.length,
    })
    await resetIntervention()
    return NextResponse.json({
      error: `AIから候補を${EXPERIMENT_AI_CONFIG.candidateCount}件取得できませんでした。再生成してください。`,
      errorCode: 'candidate_format_mismatch',
    }, { status: 502 })
  }

  const attemptIndex = (attempts?.[0]?.attempt_index || 0) + 1
  const { data: attempt, error: insertError } = await supabaseAdmin.from('ai_generation_attempts').insert({
      intervention_id: interventionId,
      attempt_index: attemptIndex,
      ai_condition: roomRelation.ai_condition,
      damekko_mode: roomRelation.ai_condition === 'damekko' && ['reaction', 'positive', 'uncertainty'].includes(messageType) ? messageType : null,
      protocol_id: generationStyle.protocolId,
      message_category: messageType,
      actor_id: intervention.planned_actor_id || 'student_ai',
      candidate_messages: candidates,
      slide_page_used: session.current_page,
      referenced_chat_ids: (posts || []).map((post) => post.id),
      referenced_transcript_text: transcript || null,
      prompt_version: generationStyle.promptVersion,
      git_commit_hash: process.env.VERCEL_GIT_COMMIT_SHA || null,
    }).select('id, attempt_index, candidate_messages').single()
  if (insertError || !attempt) {
    console.error('AI generation attempt insert failed', {
      interventionId,
      code: insertError?.code || 'no_data',
      message: insertError?.message || 'insert returned no data',
    })
    await resetIntervention()
    return NextResponse.json({
      error: '候補は生成されましたが、生成ログを保存できませんでした。管理者へ確認してください。',
      errorCode: 'generation_log_save_failed',
    }, { status: 500 })
  }
  const { error: readyError } = await supabaseAdmin
    .from('ai_interventions').update({ status: 'ready_for_review' }).eq('id', interventionId)
  if (readyError) {
    console.error('AI intervention ready status update failed', { interventionId, code: readyError.code })
    await resetIntervention()
    return NextResponse.json({
      error: '候補は保存されましたが、確認待ち状態へ更新できませんでした。管理者へ確認してください。',
      errorCode: 'intervention_status_update_failed',
    }, { status: 500 })
  }
  return NextResponse.json({
    attempt: { id: attempt.id, attemptIndex: attempt.attempt_index, candidates: attempt.candidate_messages },
    audioUsed: Boolean(transcript),
    audioWarning: audioWarning || undefined,
    modelUsed,
  })
}
