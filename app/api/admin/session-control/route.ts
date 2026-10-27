import { NextResponse } from 'next/server'
import { isAdminAuthenticated } from '@/lib/admin-auth'
import { controlReaction } from '@/lib/reaction-ai/control'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { extractTextFromPdf } from '@/lib/reaction-ai/pdf'
import { setPdfContext } from '@/lib/reaction-ai/context'

const UUID_REGEX = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/
const MAX_PDF_BYTES = 25 * 1024 * 1024

async function canControlSession(sessionId: string) {
  if (!UUID_REGEX.test(sessionId)) return false
  const { data, error } = await supabaseAdmin
    .from('sessions').select('id, status, is_locked, is_archived, admin_deleted_at').eq('id', sessionId).maybeSingle()
  return !error && data && !data.is_locked && !data.is_archived && !data.admin_deleted_at && !['completed', 'locked'].includes(data.status)
}

export async function POST(request: Request) {
  if (!(await isAdminAuthenticated())) {
    return NextResponse.json({ error: '管理者認証が必要です。' }, { status: 401 })
  }

  const contentType = request.headers.get('content-type') || ''
  if (contentType.includes('multipart/form-data')) {
    const form = await request.formData()
    const sessionId = form.get('sessionId')
    const file = form.get('file')
    if (typeof sessionId !== 'string' || !(file instanceof File) || !(await canControlSession(sessionId))) {
      return NextResponse.json({ error: '授業回またはファイルの指定が不正です。' }, { status: 400 })
    }
    if (file.type !== 'application/pdf' || file.size < 5 || file.size > MAX_PDF_BYTES) {
      return NextResponse.json({ error: '25MB以下のPDFを選択してください。' }, { status: 400 })
    }
    const bytes = new Uint8Array(await file.arrayBuffer())
    if (new TextDecoder().decode(bytes.slice(0, 5)) !== '%PDF-') {
      return NextResponse.json({ error: 'PDFファイルとして確認できませんでした。' }, { status: 400 })
    }
    const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(-100) || 'lecture.pdf'
    const objectPath = `${sessionId}/${Date.now()}-${safeName}`
    const { error: uploadError } = await supabaseAdmin.storage
      .from('lecture-materials').upload(objectPath, bytes, { contentType: 'application/pdf', upsert: false })
    if (uploadError) return NextResponse.json({ error: 'PDFの保存に失敗しました。' }, { status: 500 })

    let extractedCount = 0
    try {
      const pages = await extractTextFromPdf(bytes)
      if (!pages.some(p=>p.text.trim())) return NextResponse.json({error:'PDFから文字を読み取れません。文字を含むPDFをご用意ください。以前の資料は変更していません。'},{status:422})
      await setPdfContext(sessionId,pages,objectPath)
      extractedCount=pages.length
    } catch {
      return NextResponse.json({error:'PDF資料を登録できませんでした。以前の資料は維持しています。'},{status:503})
    }

    await supabaseAdmin.from('event_logs').insert({
      session_id: sessionId,
      event_type: 'lecture_pdf_uploaded',
      metadata: { object_path: objectPath, size: file.size, extracted_pages: extractedCount },
    })
    return NextResponse.json({ success: true, pdfFilePath: objectPath, currentPage: 1, extractedPages: extractedCount })
  }

  let body: unknown
  try { body = await request.json() } catch {
    return NextResponse.json({ error: '不正なリクエストです。' }, { status: 400 })
  }
  if (!body || typeof body !== 'object') {
    return NextResponse.json({ error: '不正なリクエストです。' }, { status: 400 })
  }
  const { action, sessionId, sessionNumber, scheduledAt, isDevelopment, mode } = body as {
    action?: unknown
    sessionId?: unknown
    sessionNumber?: unknown
    scheduledAt?: unknown
    isDevelopment?: unknown
    mode?: unknown
  }

  if (action === 'create_shared_session') {
    if (!Number.isInteger(sessionNumber) || Number(sessionNumber) < 0 || Number(sessionNumber) > 999) {
      return NextResponse.json({ error: '授業回は0〜999の整数で指定してください。' }, { status: 400 })
    }
    if (typeof scheduledAt !== 'string') {
      return NextResponse.json({ error: '授業日時を指定してください。' }, { status: 400 })
    }
    const match = scheduledAt.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T\s](\d{2}):(\d{2})(?::(\d{2}))?)?/)
    if (!match) {
      return NextResponse.json({ error: '授業日時は年4桁・月2桁・日2桁（例: 2026-10-25T13:00）で指定してください。' }, { status: 400 })
    }
    const [, yStr, mStr, dStr, hStr = '00', minStr = '00'] = match
    const y = Number(yStr), m = Number(mStr), d = Number(dStr), h = Number(hStr), min = Number(minStr)
    if (y < 2020 || y > 2099 || m < 1 || m > 12 || d < 1 || d > 31 || h < 0 || h > 23 || min < 0 || min > 59) {
      return NextResponse.json({ error: '授業日時の数値範囲（年4桁: 2020-2099、月2桁: 01-12、日2桁: 01-31）が不正です。' }, { status: 400 })
    }
    const parsedDate = new Date(scheduledAt)
    if (Number.isNaN(parsedDate.getTime())) {
      return NextResponse.json({ error: '授業日時を解析できませんでした。' }, { status: 400 })
    }
    if (typeof isDevelopment !== 'boolean') {
      return NextResponse.json({ error: '試運転設定が正しくありません。' }, { status: 400 })
    }

    const normalizedScheduledAt = parsedDate.toISOString()
    const { data, error } = await supabaseAdmin.rpc('create_shared_session', {
      p_session_number: Number(sessionNumber),
      p_scheduled_at: normalizedScheduledAt,
      p_is_development: isDevelopment,
    })
    if (error || typeof data !== 'string') {
      const errorDetails = error && typeof error === 'object'
        ? {
            code: 'code' in error ? (error as { code?: unknown }).code : undefined,
            message: 'message' in error ? (error as { message?: unknown }).message : undefined,
            details: 'details' in error ? (error as { details?: unknown }).details : undefined,
            hint: 'hint' in error ? (error as { hint?: unknown }).hint : undefined,
          }
        : { message: String(error) }

      console.error('create_shared_session failed', {
        sessionNumber: Number(sessionNumber),
        scheduledAt: normalizedScheduledAt,
        isDevelopment,
        error: errorDetails,
      })

      return NextResponse.json(
        { error: '新しい授業回を作成できませんでした。データベース更新を確認してください。' },
        { status: 500 }
      )
    }
    return NextResponse.json({ success: true, sessionId: data })
  }

  if (typeof sessionId !== 'string' || !(await canControlSession(sessionId))) {
    return NextResponse.json({ error: '操作できない授業回です。' }, { status: 400 })
  }

  if (action === 'set_designated') {
    const { data, error: rpcError } = await supabaseAdmin.rpc('set_designated_session', { p_session_id: sessionId })
    if (data?.error === 'class_in_progress') return NextResponse.json({ error: '別の授業が実施中です。終了してから指定してください。' }, { status: 409 })
    if (rpcError || data?.success !== true) {
      return NextResponse.json({ error: '授業回の指定を保存できませんでした。再試行してください。' }, { status: 503 })
    }
    return NextResponse.json({ success: true, designatedSessionId: sessionId })
  }

  if (action === 'set_page') {
    return NextResponse.json({ error: '手動ページ指定は旧仕様のため無効化されています。' }, { status: 410 })
  }

  if (action === 'configure_protocol') {
    return NextResponse.json({ error: '旧来のサイクル設定APIは無効化されています。新しい授業開始と自動返信設定を利用してください。' }, { status: 410 })
  }

  if (action === 'start_protocol') {
    return NextResponse.json({ error: '旧来のサイクル開始APIは無効化されています。授業開始は教授アプリから行ってください。' }, { status: 410 })
  }

  if (action === 'set_reaction_mode' || action === 'set_reaction_config') {
    return controlReaction(sessionId, 'configure', mode)
  }
  if (action === 'start_experiment') return NextResponse.json({ error: '授業開始は教授アプリから行ってください。' }, { status: 410 })
  if (action === 'emergency_stop_reaction') return controlReaction(sessionId, 'stop')
  if (action === 'pause_ai') return controlReaction(sessionId, 'pause_ai')
  if (action === 'resume_ai') return controlReaction(sessionId, 'resume_ai')
  if (action === 'pause_projection') return controlReaction(sessionId, 'pause_projection')
  if (action === 'resume_projection') return controlReaction(sessionId, 'resume_projection')
  if (action === 'record_demo_projection') return controlReaction(sessionId, 'record_demo_projection')

  return NextResponse.json({ error: '未対応の操作です。' }, { status: 400 })
}
