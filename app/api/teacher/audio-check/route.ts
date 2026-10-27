import { NextResponse } from 'next/server'
import { isTeacherAuthenticated } from '@/lib/teacher-auth'
import { transcribeLectureAudio } from '@/lib/reaction-ai/audio-transcription'

export const runtime = 'nodejs'
export const maxDuration = 40
const MAX_BODY = 1024 * 1024
const headers = { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' }

// Diagnostic only: deliberately no session, context, database, or event-log writes.
export async function POST(request: Request) {
  if (!(await isTeacherAuthenticated(request))) return NextResponse.json({ error: '先生用認証が必要です。' }, { status: 401, headers })
  if (!request.headers.get('content-type')?.includes('multipart/form-data')) return NextResponse.json({ error: '音声データが不正です。' }, { status: 400, headers })
  if (Number(request.headers.get('content-length')) > MAX_BODY) return NextResponse.json({ error: 'チェック音声が大きすぎます。' }, { status: 413, headers })
  const reader = request.body?.getReader()
  if (!reader) return NextResponse.json({ error: '音声データがありません。' }, { status: 400, headers })
  let size = 0
  const parts: Uint8Array[] = []
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > MAX_BODY) {
        await reader.cancel()
        return NextResponse.json({ error: 'チェック音声が大きすぎます。' }, { status: 413, headers })
      }
      parts.push(value)
    }
    const form = await new Response(Buffer.concat(parts), { headers: { 'Content-Type': request.headers.get('content-type')! } }).formData()
    const files = form.getAll('audio')
    if (files.length !== 1 || !(files[0] instanceof File) || !files[0].size || !['audio/webm', 'audio/ogg', 'audio/mp4'].includes(files[0].type.split(';')[0])) return NextResponse.json({ error: 'チェック音声が不正です。' }, { status: 400, headers })
    const result = await transcribeLectureAudio([files[0]], request.signal)
    return NextResponse.json({ success: true, transcript: result.transcript, modelUsed: result.modelUsed, checkedAt: new Date().toISOString() }, { headers })
  } catch {
    return NextResponse.json({ error: '文字起こしを確認できませんでした。接続・API設定を確認して再試行してください。' }, { status: 503, headers })
  } finally { reader.releaseLock() }
}
