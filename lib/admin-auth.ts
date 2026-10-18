import 'server-only'

import crypto from 'crypto'
import { cookies } from 'next/headers'

export const ADMIN_COOKIE_NAME = 'classaid_admin_session'
export const ADMIN_SESSION_MAX_AGE_SECONDS = 8 * 60 * 60

type AdminSessionPayload = {
  role: 'admin'
  issuedAt: number
  expiresAt: number
}

function getAdminSessionSecret(): string {
  const secret = process.env.ADMIN_SESSION_SECRET
  if (!secret || secret.trim().length < 32) {
    throw new Error('ADMIN_SESSION_SECRET must be configured with at least 32 characters.')
  }
  return secret
}

export function verifyAdminPassword(password: string): boolean {
  const configuredPassword = process.env.ADMIN_ACCESS_PASSWORD
  if (!configuredPassword || configuredPassword.length < 12 || typeof password !== 'string') {
    return false
  }
  const supplied = Buffer.from(password, 'utf8')
  const expected = Buffer.from(configuredPassword, 'utf8')
  return supplied.length === expected.length && crypto.timingSafeEqual(supplied, expected)
}

export function createAdminSessionToken(): string {
  const now = Date.now()
  const payload: AdminSessionPayload = {
    role: 'admin',
    issuedAt: now,
    expiresAt: now + ADMIN_SESSION_MAX_AGE_SECONDS * 1000,
  }
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
  const signature = crypto.createHmac('sha256', getAdminSessionSecret()).update(encoded).digest('base64url')
  return `${encoded}.${signature}`
}

function verifyAdminSessionToken(token: string): boolean {
  try {
    const [encoded, signature, extra] = token.split('.')
    if (!encoded || !signature || extra) return false
    const expectedSignature = crypto.createHmac('sha256', getAdminSessionSecret()).update(encoded).digest('base64url')
    const supplied = Buffer.from(signature)
    const expected = Buffer.from(expectedSignature)
    if (supplied.length !== expected.length || !crypto.timingSafeEqual(supplied, expected)) return false

    const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as Partial<AdminSessionPayload>
    const now = Date.now()
    return (
      payload.role === 'admin' &&
      typeof payload.issuedAt === 'number' && Number.isFinite(payload.issuedAt) &&
      typeof payload.expiresAt === 'number' && Number.isFinite(payload.expiresAt) &&
      payload.expiresAt > payload.issuedAt &&
      payload.expiresAt - payload.issuedAt <= ADMIN_SESSION_MAX_AGE_SECONDS * 1000 &&
      payload.issuedAt <= now + 60_000 && payload.expiresAt > now
    )
  } catch {
    return false
  }
}

export async function isAdminAuthenticated(): Promise<boolean> {
  const token = (await cookies()).get(ADMIN_COOKIE_NAME)?.value
  return Boolean(token && verifyAdminSessionToken(token))
}
