import 'server-only'

import crypto from 'crypto'
import { cookies } from 'next/headers'

export const TEACHER_COOKIE_NAME = 'classaid_teacher_session'
export const TEACHER_SESSION_MAX_AGE_SECONDS = 8 * 60 * 60

function sign(value: string) {
  const secret = process.env.ADMIN_SESSION_SECRET
  if (!secret || secret.length < 32) throw new Error('ADMIN_SESSION_SECRET is not configured.')
  return crypto.createHmac('sha256', `${secret}:teacher`).update(value).digest('base64url')
}

export function verifyTeacherPassword(password: string) {
  const configured = process.env.TEACHER_ACCESS_PASSWORD
  if (!configured || configured.length < 12) return false
  const supplied = Buffer.from(password)
  const expected = Buffer.from(configured)
  return supplied.length === expected.length && crypto.timingSafeEqual(supplied, expected)
}

export function createTeacherToken() {
  const expiresAt = Date.now() + TEACHER_SESSION_MAX_AGE_SECONDS * 1000
  const value = Buffer.from(JSON.stringify({ role: 'teacher', expiresAt })).toString('base64url')
  return `${value}.${sign(value)}`
}

export async function isTeacherAuthenticated(request?: Request) {
  if (request) {
    const pwd = request.headers.get('x-teacher-password') || request.headers.get('x-projection-key')
    if (pwd) {
      if (verifyTeacherPassword(pwd)) return true
      const adminPwd = process.env.ADMIN_ACCESS_PASSWORD
      if (adminPwd && adminPwd.length >= 12) {
        const supplied = Buffer.from(pwd)
        const expected = Buffer.from(adminPwd)
        if (supplied.length === expected.length && crypto.timingSafeEqual(supplied, expected)) return true
      }
    }
  }

  try {
    const token = (await cookies()).get(TEACHER_COOKIE_NAME)?.value
    if (!token) return false
    const [value, signature, extra] = token.split('.')
    if (!value || !signature || extra) return false
    const expected = Buffer.from(sign(value)); const supplied = Buffer.from(signature)
    if (expected.length !== supplied.length || !crypto.timingSafeEqual(expected, supplied)) return false
    const payload = JSON.parse(Buffer.from(value, 'base64url').toString()) as { role?: unknown; expiresAt?: unknown }
    return payload.role === 'teacher' && typeof payload.expiresAt === 'number' && payload.expiresAt > Date.now()
  } catch { return false }
}
