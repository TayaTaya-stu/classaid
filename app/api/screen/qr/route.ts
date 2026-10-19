import { NextResponse } from 'next/server'
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

  const forwardedHost = request.headers.get('x-forwarded-host')?.split(',')[0]?.trim()
  const requestHost = forwardedHost || request.headers.get('host')
  const forwardedProtocol = request.headers.get('x-forwarded-proto')?.split(',')[0]?.trim()
  const requestProtocol = forwardedProtocol || new URL(request.url).protocol.replace(':', '')
  if (
    !requestHost ||
    parsed.host !== requestHost ||
    parsed.protocol !== `${requestProtocol}:` ||
    !parsed.pathname.startsWith('/enter/')
  ) {
    return NextResponse.json({ error: '許可されていないURLです。' }, { status: 400 })
  }

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
