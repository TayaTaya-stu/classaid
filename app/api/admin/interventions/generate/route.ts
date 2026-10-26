import { NextResponse } from 'next/server'

export async function POST() {
  return NextResponse.json(
    { error: '旧来の介入候補生成APIは無効化されています。新しい自動返信フローを利用してください。' },
    { status: 410 }
  )
}
