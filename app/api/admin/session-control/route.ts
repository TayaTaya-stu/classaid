import { NextResponse } from 'next/server'
import { isAdminAuthenticated } from '@/lib/admin-auth'
import { supabaseAdmin } from '@/lib/supabase-admin'

const UUID_REGEX = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/
const MAX_PDF_BYTES = 25 * 1024 * 1024

async function canControlSession(sessionId: string) {
  if (!UUID_REGEX.test(sessionId)) return false
  const { data, error } = await supabaseAdmin
    .from('sessions').select('id, status, is_locked').eq('id', sessionId).maybeSingle()
  return !error && data && !data.is_locked && !['completed', 'locked'].includes(data.status)
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

    const { error: updateError } = await supabaseAdmin
      .from('sessions').update({ pdf_file_url: objectPath, current_page: 1 }).eq('id', sessionId)
    if (updateError) return NextResponse.json({ error: 'PDF情報の登録に失敗しました。' }, { status: 500 })
    await supabaseAdmin.from('event_logs').insert({
      session_id: sessionId, event_type: 'lecture_pdf_uploaded', metadata: { object_path: objectPath, size: file.size },
    })
    return NextResponse.json({ success: true, pdfFilePath: objectPath, currentPage: 1 })
  }

  let body: unknown
  try { body = await request.json() } catch {
    return NextResponse.json({ error: '不正なリクエストです。' }, { status: 400 })
  }
  if (!body || typeof body !== 'object') {
    return NextResponse.json({ error: '不正なリクエストです。' }, { status: 400 })
  }
  const { action, sessionId, currentPage } = body as { action?: unknown; sessionId?: unknown; currentPage?: unknown }
  if (typeof sessionId !== 'string' || !(await canControlSession(sessionId))) {
    return NextResponse.json({ error: '操作できない授業回です。' }, { status: 400 })
  }

  if (action === 'set_page') {
    if (!Number.isInteger(currentPage) || Number(currentPage) < 1 || Number(currentPage) > 9999) {
      return NextResponse.json({ error: 'ページ番号は1以上の整数で指定してください。' }, { status: 400 })
    }
    const { error } = await supabaseAdmin.from('sessions').update({ current_page: currentPage }).eq('id', sessionId)
    if (error) return NextResponse.json({ error: '現在ページの更新に失敗しました。' }, { status: 500 })
    await supabaseAdmin.from('event_logs').insert({
      session_id: sessionId, event_type: 'current_slide_page_changed', metadata: { current_page: currentPage },
    })
    return NextResponse.json({ success: true, currentPage })
  }

  if (action === 'start_protocol') {
    const { data, error } = await supabaseAdmin.rpc('start_session_protocol', { p_session_id: sessionId })
    if (error) {
      const alreadyStarted = error.message.includes('already started')
      return NextResponse.json({ error: alreadyStarted ? 'この授業回は既に開始されています。' : 'サイクルを開始できませんでした。' }, { status: alreadyStarted ? 409 : 500 })
    }
    return NextResponse.json({ success: true, startedAt: data })
  }

  return NextResponse.json({ error: '未対応の操作です。' }, { status: 400 })
}
