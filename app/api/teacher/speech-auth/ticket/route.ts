import { NextResponse } from 'next/server'

export async function POST() {
  return NextResponse.json({ error: '音声は教授用アプリから取得します。この経路は使用しません。' }, { status: 410 })
}
