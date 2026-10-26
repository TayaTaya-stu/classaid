import { NextResponse } from 'next/server'
import { designatedSession, studentEntryUrl } from '@/lib/student-entry'
export const dynamic = 'force-dynamic'
export async function GET(request: Request) {
  const headers = { 'Cache-Control': 'no-store, max-age=0', 'Referrer-Policy': 'no-referrer' }
  try {
    const session = await designatedSession()
    if (session) {
      const response = NextResponse.redirect(new URL(`/enter/${session.entry_slug}`, studentEntryUrl(request)), 303)
      Object.entries(headers).forEach(([k,v]) => response.headers.set(k,v))
      return response
    }
    return new NextResponse('<!doctype html><html lang="ja"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>SupporTalk</title><main><h1>授業の準備中です</h1><p>現在参加できる授業が指定されていないか、授業が終了しています。先生の案内をお待ちください。</p><button onclick="location.reload()">もう一度確認する</button></main></html>', { status: 409, headers: { ...headers, 'Content-Type':'text/html; charset=utf-8' } })
  } catch { return new NextResponse('授業情報を確認できません。少し待ってから再読み込みしてください。', { status: 503, headers }) }
}
