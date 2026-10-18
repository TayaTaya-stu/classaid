import { NextResponse } from 'next/server'
import { createTeacherToken, isTeacherAuthenticated, TEACHER_COOKIE_NAME, TEACHER_SESSION_MAX_AGE_SECONDS, verifyTeacherPassword } from '@/lib/teacher-auth'

export async function GET() { return NextResponse.json({ authenticated: await isTeacherAuthenticated() }) }
export async function POST(request: Request) {
  const body = await request.json().catch(() => null) as { password?: unknown } | null
  if (!body || typeof body.password !== 'string' || !verifyTeacherPassword(body.password)) {
    return NextResponse.json({ error: 'パスワードが正しくありません。' }, { status: 401 })
  }
  const response = NextResponse.json({ success: true })
  response.cookies.set(TEACHER_COOKIE_NAME, createTeacherToken(), {
    httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'strict', path: '/', maxAge: TEACHER_SESSION_MAX_AGE_SECONDS,
  })
  return response
}
export async function DELETE() {
  const response = NextResponse.json({ success: true })
  response.cookies.set(TEACHER_COOKIE_NAME, '', { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'strict', path: '/', maxAge: 0 })
  return response
}
