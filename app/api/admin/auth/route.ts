import { NextResponse } from 'next/server'
import { ADMIN_COOKIE_NAME, ADMIN_SESSION_MAX_AGE_SECONDS, createAdminSessionToken, isAdminAuthenticated, verifyAdminPassword } from '@/lib/admin-auth'

export async function GET() {
  return NextResponse.json({ authenticated: await isAdminAuthenticated() })
}

export async function POST(request: Request) {
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: '不正なリクエストです。' }, { status: 400 })
  }
  const password = body && typeof body === 'object' && 'password' in body
    ? (body as { password?: unknown }).password
    : undefined
  if (typeof password !== 'string' || !verifyAdminPassword(password)) {
    return NextResponse.json({ error: 'パスワードが正しくありません。' }, { status: 401 })
  }
  const response = NextResponse.json({ success: true })
  response.cookies.set(ADMIN_COOKIE_NAME, createAdminSessionToken(), {
    httpOnly: true,
    secure: new URL(request.url).protocol === 'https:',
    sameSite: 'strict',
    path: '/',
    maxAge: ADMIN_SESSION_MAX_AGE_SECONDS,
  })
  return response
}

export async function DELETE(request: Request) {
  const response = NextResponse.json({ success: true })
  response.cookies.set(ADMIN_COOKIE_NAME, '', {
    httpOnly: true,
    secure: new URL(request.url).protocol === 'https:',
    sameSite: 'strict',
    path: '/',
    maxAge: 0,
  })
  return response
}
