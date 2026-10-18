import { cookies } from 'next/headers'
import { redirect } from 'next/navigation'
import Link from 'next/link'
import { verifySessionToken } from '@/lib/participant'

interface RoomPageProps {
  params: Promise<{
    roomSlug: string
  }>
}

export default async function RoomPage({ params }: RoomPageProps) {
  const { roomSlug } = await params
  const cookieStore = await cookies()
  const sessionCookie = cookieStore.get('classaid_session')?.value

  // Cookieがない場合は入室案内へリダイレクト
  if (!sessionCookie) {
    redirect('/enter')
  }

  // 署名・期限・改ざんの検証
  const payload = verifySessionToken(sessionCookie)

  // 署名不正、期限切れ、またはURLのroomSlugとCookie情報が一致しない場合は入室案内へ
  if (!payload || payload.roomSlug !== roomSlug) {
    redirect('/enter')
  }

  const { displayName } = payload

  return (
    <div className="min-h-screen bg-slate-50 flex flex-col items-center justify-center p-4">
      <div className="w-full max-w-lg bg-white rounded-2xl shadow-sm border border-blue-100 p-6 sm:p-8 text-center">
        <div className="inline-flex items-center justify-center w-14 h-14 bg-blue-50 text-blue-600 rounded-full mb-4">
          <svg className="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
          </svg>
        </div>

        <h1 className="text-xl font-bold text-slate-800 mb-2">講義ルームに入室しました</h1>
        
        <div className="bg-slate-50 rounded-xl p-4 my-5 border border-slate-200">
          <p className="text-xs text-slate-500 mb-1">あなたの本日の表示名</p>
          <p className="text-lg font-bold text-blue-700 tracking-wide">{displayName}</p>
        </div>

        <p className="text-xs text-slate-500 leading-relaxed mb-6">
          講義および対話セッションの準備中です。<br />
          実験進行に合わせて、この画面または講義タイムラインから投稿・閲覧ができるようになります。
        </p>

        <div className="flex flex-col sm:flex-row gap-3 justify-center">
          <Link
            href="/enter"
            className="px-4 py-2 text-xs text-slate-600 hover:text-slate-800 bg-slate-100 hover:bg-slate-200 rounded-lg transition-colors"
          >
            ← 入室案内画面
          </Link>
          <Link
            href="/"
            className="px-4 py-2 text-xs text-blue-600 hover:text-blue-800 bg-blue-50 hover:bg-blue-100 rounded-lg transition-colors"
          >
            従来の投稿画面（開発プレビュー）を開く →
          </Link>
        </div>
      </div>
    </div>
  )
}
