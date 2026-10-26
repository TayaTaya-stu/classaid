import crypto from 'node:crypto'
import { NextResponse } from 'next/server'
import { isTeacherAuthenticated } from '@/lib/teacher-auth'
import { appendSpeechText } from '@/lib/reaction-ai/context'
import { transcribeLectureAudio } from '@/lib/reaction-ai/audio-transcription'
import { supabaseAdmin } from '@/lib/supabase-admin'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
async function activeSession(id: string) {
  const { data, error } = await supabaseAdmin.from('sessions')
    .select('id,room_mode,status,is_locked,class_started_at,auto_expired_at,reaction_ai_status,is_current_target').eq('id', id).maybeSingle()
  if (error) throw error
  return Boolean(data && data.room_mode === 'shared' && data.is_current_target && !data.is_locked && data.status === 'in_progress' && data.class_started_at && !data.auto_expired_at && data.reaction_ai_status === 'active' && Date.now() < Date.parse(data.class_started_at) + 120 * 60 * 1000)
}
export async function POST(request: Request) {
  const receivedAt = new Date().toISOString()
  let targetSessionId: string | null = null
  let stage = 'validation'
  if (!(await isTeacherAuthenticated(request))) return NextResponse.json({ error: '先生用認証が必要です。' }, { status: 401 })
  try {
    let sessionId: unknown, text = '', event: unknown
    let audioFiles: File[] = []
    if (request.headers.get('content-type')?.includes('multipart/form-data')) {
      if (Number(request.headers.get('content-length') || 0) > 16 * 1024 * 1024) return NextResponse.json({ error: '音声データが大きすぎます。' }, { status: 413 })
      const form = await request.formData()
      sessionId = form.get('sessionId')
      audioFiles = form.getAll('audio').filter((f): f is File => f instanceof File)
      if (!audioFiles.length || audioFiles.length > 7) return NextResponse.json({ error: '音声データが不正です。' }, { status: 400 })
    } else {
      const body = await request.json().catch(() => null)
      sessionId = body?.sessionId; event = body?.event
      text = typeof body?.text === 'string' ? body.text.trim() : ''
      if (body?.audioBase64 !== undefined) return NextResponse.json({ error: '旧音声送信形式は使用しません。' }, { status: 400 })
    }
    if (typeof sessionId !== 'string' || !UUID.test(sessionId) || text.length > 6000) return NextResponse.json({ error: '入力が不正です。' }, { status: 400 })
    targetSessionId = sessionId
    if (!(await activeSession(sessionId))) return NextResponse.json({ error: '音声取得は停止しています。' }, { status: 409 })
    if (event) {
      if (!['audio_reconnected','audio_disconnected'].includes(String(event))) return NextResponse.json({ error: '不正なイベントです。' }, { status: 400 })
      const { error } = await supabaseAdmin.from('event_logs').insert({ session_id: sessionId, event_type: event, metadata: {} })
      if (error) throw error
      return NextResponse.json({ success: true })
    }
    let hashes: string[] | undefined
    let modelUsed: string | null = null
    if (audioFiles.length) {
      if(audioFiles.reduce((n,f)=>n+f.size,0)>15*1024*1024) return NextResponse.json({error:'音声が大きすぎます。'},{status:413})
      const pairs=await Promise.all(audioFiles.map(async file=>({file,hash:crypto.createHash('sha256').update(Buffer.from(await file.arrayBuffer())).digest('hex')})))
      const {data:done,error:lookupError}=await supabaseAdmin.from('lecture_audio_deliveries').select('segment_hash').eq('session_id',sessionId).in('segment_hash',pairs.map(p=>p.hash))
      if(lookupError)throw lookupError
      const known=new Set((done||[]).map(x=>x.segment_hash))
      const pending=pairs.filter(p=>!known.has(p.hash))
      if(!pending.length)return NextResponse.json({success:true,updated:true,duplicate:true})
      hashes=pending.map(p=>p.hash)
      audioFiles=pending.map(p=>p.file)
      stage = 'transcription'
      const result = await transcribeLectureAudio(audioFiles, request.signal, async()=>{
        const configured=Number(process.env.REACTION_AUDIO_CALL_LIMIT||1500)
        const limit=Number.isInteger(configured)&&configured>=1&&configured<=100000?configured:1500
        const {data,error}=await supabaseAdmin.rpc('reserve_reaction_generation',{p_session_id:sessionId,p_limit:limit,p_kind:'audio'})
        return !error&&data===true
      })
      text = result.transcript; modelUsed = result.modelUsed
    }
    // Recognition runs in the background. Re-check pause/end before saving its result.
    if (request.signal.aborted || !(await activeSession(sessionId))) return NextResponse.json({ error: '音声取得は停止しています。' }, { status: 409 })
    if (!text && !hashes) return NextResponse.json({ success: true, updated: true, empty: true, modelUsed })
    stage = 'persistence'
    const context = await appendSpeechText(sessionId, text, hashes, {modelUsed,receivedAt})
    if (modelUsed) {
      const { error } = await supabaseAdmin.from('event_logs').insert({ session_id: sessionId, event_type: 'lecture_audio_transcribed', metadata: { modelUsed, segments: audioFiles.length, characters: text.length } })
      // A logging failure must not cause an already-saved transcript to be replayed.
      if (error) console.error('Audio metadata log failed:', error.code)
    }
    return NextResponse.json({ success: true, updated: true, modelUsed, recentTopics: context.recentAcademicTopics })
  } catch {
    console.warn('[SupporTalk] Audio context failed:', stage)
    if (targetSessionId) {
      try {
        await supabaseAdmin.from('event_logs').insert({session_id:targetSessionId,event_type:'lecture_audio_processing_failed',metadata:{stage,receivedAt}}).abortSignal(AbortSignal.timeout(1500))
      } catch { /* No transcript is acknowledged on failure. */ }
    }
    return NextResponse.json({ error: '音声文脈を更新できませんでした。投稿と投影は継続します。' }, { status: 503 })
  }
}
