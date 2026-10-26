import { NextResponse } from 'next/server'

export async function GET() {
  return NextResponse.json({ error: 'この旧画面は使用しません。設定は管理者画面、授業操作はSupporTalkアプリをご利用ください。' }, { status: 410 })
}
