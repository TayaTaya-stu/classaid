import { NextResponse } from 'next/server'
import { studentEntryUrl } from '@/lib/student-entry'
import QRCode from 'qrcode'

export async function GET(request: Request) {
  const target = new URL(request.url).searchParams.get('target')
  if (!target || target.length > 500) {
    return NextResponse.json({ error: 'QRコードのURLが正しくありません。' }, { status: 400 })
  }

  let parsed: URL
  try {
    parsed = new URL(target)
  } catch {
    return NextResponse.json({ error: 'QRコードのURLが正しくありません。' }, { status: 400 })
  }

  let allowed: string
  try { allowed = studentEntryUrl(request) } catch {
    return NextResponse.json({ error: '学生向けURLを設定してください。' }, { status: 503 })
  }
  if (parsed.toString() !== allowed) return NextResponse.json({ error: '許可されていないURLです。' }, { status: 400 })

  const svg = await QRCode.toString(parsed.toString(), {
    type: 'svg', width: 320, margin: 1, errorCorrectionLevel: 'M',
    color: { dark: '#0f172a', light: '#ffffff' },
  })

  return new NextResponse(svg, {
    headers: {
      'Content-Type': 'image/svg+xml; charset=utf-8',
      'Cache-Control': 'private, max-age=300',
      'X-Content-Type-Options': 'nosniff',
    },
  })
}
