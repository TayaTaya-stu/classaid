import { NextResponse } from 'next/server'
import { isAdminAuthenticated } from '@/lib/admin-auth'

export async function POST() {
  if (!(await isAdminAuthenticated())) {
    return NextResponse.json({ error: '管理者認証が必要です。' }, { status: 401 })
  }

  return NextResponse.json(
    { error: '旧AI投稿機能は停止中です。研究用AI介入画面を使用してください。' },
    { status: 410 },
  )
}
