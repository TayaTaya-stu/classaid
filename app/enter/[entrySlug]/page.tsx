'use client'

import { useState, useEffect } from 'react'
import { useRouter, useParams } from 'next/navigation'
import { supabase } from '@/lib/supabase'

export default function SessionEnterPage() {
  const router = useRouter()
  const params = useParams()
  const entrySlug = typeof params?.entrySlug === 'string' ? params.entrySlug : ''

  const [studentId, setStudentId] = useState('')
  const [consented, setConsented] = useState(false)
  const [loading, setLoading] = useState(false)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [authToken, setAuthToken] = useState<string | null>(null)
  const [isAuthInitializing, setIsAuthInitializing] = useState(true)
  const [authInitFailed, setAuthInitFailed] = useState(false)

  // 匿名ログインの初期化（有効なauthTokenが取得できるまで待機）
  useEffect(() => {
    let isMounted = true

    async function initAuth() {
      setIsAuthInitializing(true)
      setAuthInitFailed(false)

      try {
        const { data: sessionData, error: sessionError } = await supabase.auth.getSession()
        if (sessionError) {
          throw sessionError
        }

        let token = sessionData.session?.access_token

        if (!token) {
          const { data: signInData, error: signInError } =
            await supabase.auth.signInAnonymously()
          if (signInError || !signInData.session) {
            throw signInError || new Error('Anonymous sign-in failed')
          }
          token = signInData.session.access_token
        }

        if (isMounted) {
          if (token) {
            setAuthToken(token)
            setIsAuthInitializing(false)
          } else {
            setAuthInitFailed(true)
            setIsAuthInitializing(false)
          }
        }
      } catch {
        if (isMounted) {
          setAuthInitFailed(true)
          setIsAuthInitializing(false)
        }
      }
    }

    initAuth()

    return () => {
      isMounted = false
    }
  }, [])

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()

    if (isAuthInitializing || !authToken) {
      setErrorMessage('入室準備中です。しばらくお待ちください。')
      return
    }

    if (!consented) {
      setErrorMessage('研究参加への同意が必要です。')
      return
    }

    if (!studentId.trim()) {
      setErrorMessage('学籍番号を入力してください。')
      return
    }

    if (!entrySlug) {
      setErrorMessage('授業コードが見つかりません。URLを再確認してください。')
      return
    }

    setLoading(true)
    setErrorMessage(null)

    try {
      const res = await fetch('/api/enter', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          studentId: studentId.trim(),
          entrySlug,
          consented,
          authToken,
        }),
      })

      const data = await res.json()

      if (!res.ok) {
        // エラーメッセージに学籍番号は一切含めない
        setErrorMessage(data.error || '入室処理に失敗しました。')
        setLoading(false)
        return
      }

      // 入室成功: 指定されたルームへ遷移
      if (data.roomSlug) {
        router.push(`/room/${data.roomSlug}`)
      } else {
        setErrorMessage('ルームの割り当てに失敗しました。管理者に連絡してください。')
        setLoading(false)
      }
    } catch {
      setErrorMessage('通信エラーが発生しました。接続を確認してください。')
      setLoading(false)
    }
  }

  const isSubmitDisabled =
    loading ||
    isAuthInitializing ||
    authInitFailed ||
    !authToken ||
    !consented ||
    !studentId.trim()

  return (
    <div className="min-h-screen bg-slate-50 flex flex-col items-center justify-center p-4">
      <div className="w-full max-w-md bg-white rounded-2xl shadow-sm border border-blue-100 p-6 sm:p-8">
        {/* ヘッダー */}
        <div className="text-center mb-6">
          <div className="inline-flex items-center justify-center w-12 h-12 bg-blue-600 text-white font-bold rounded-xl mb-3 shadow-md shadow-blue-200">
            C
          </div>
          <h1 className="text-xl font-bold text-slate-800">ClassAid 講義ルーム入室</h1>
          <p className="text-xs text-slate-500 mt-1">
            授業中の気づき・質問・感想をリアルタイムで共有
          </p>
        </div>

        {/* 研究参加とプライバシーに関する注意書き */}
        <div className="bg-blue-50/70 border border-blue-200/60 rounded-xl p-3.5 mb-5 text-xs text-blue-900 leading-relaxed">
          <p className="font-semibold text-blue-950 mb-1">【参加者識別とプライバシーについて】</p>
          <p>
            入力した学籍番号は、本人を直接識別できない文字列へサーバー上で変換されます。
            <strong className="font-bold underline decoration-blue-400 underline-offset-2 ml-1">
              学籍番号そのものは保存されず、成績にも一切影響しません。
            </strong>
          </p>
        </div>

        {/* 認証初期化エラー */}
        {authInitFailed && (
          <div className="bg-amber-50 border border-amber-200 text-amber-800 text-xs rounded-lg p-3 mb-4 leading-relaxed">
            入室準備に失敗しました。ページを再読み込みしてください。
          </div>
        )}

        {/* 入室フォーム */}
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label htmlFor="student-id-input" className="block text-xs font-semibold text-slate-700 mb-1.5">
              学籍番号
            </label>
            <input
              id="student-id-input"
              type="text"
              autoComplete="off"
              disabled={loading || authInitFailed}
              value={studentId}
              onChange={(e) => setStudentId(e.target.value)}
              placeholder="例: 1234567"
              className="w-full px-3.5 py-2.5 bg-slate-50 border border-slate-200 rounded-lg text-sm text-slate-800 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:bg-white transition-all disabled:opacity-60"
            />
            <p className="text-[11px] text-slate-400 mt-1">
              ※全角・半角やハイフンの有無は自動で調整されます。
            </p>
          </div>

          {/* 実験同意チェック */}
          <div className="pt-2">
            <label className="flex items-start gap-2.5 cursor-pointer select-none">
              <input
                type="checkbox"
                disabled={loading || authInitFailed}
                checked={consented}
                onChange={(e) => setConsented(e.target.checked)}
                className="mt-0.5 w-4 h-4 text-blue-600 rounded border-slate-300 focus:ring-blue-500 disabled:opacity-60"
              />
              <span className="text-xs text-slate-600 leading-snug">
                上記のプライバシー方針および授業研究におけるデータ利用の説明を確認し、参加に同意します。
              </span>
            </label>
          </div>

          {/* エラーメッセージ（学籍番号は一切表示しない） */}
          {errorMessage && (
            <div className="bg-red-50 border border-red-200 text-red-700 text-xs rounded-lg p-3">
              {errorMessage}
            </div>
          )}

          {/* 送信ボタン */}
          <button
            type="submit"
            disabled={isSubmitDisabled}
            className="w-full mt-2 py-3 px-4 bg-blue-600 hover:bg-blue-700 text-white font-semibold text-sm rounded-xl shadow-sm transition-all focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 disabled:bg-slate-300 disabled:cursor-not-allowed disabled:shadow-none flex items-center justify-center gap-2"
          >
            {loading ? (
              <>
                <svg className="animate-spin h-4 w-4 text-white" viewBox="0 0 24 24" fill="none">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                </svg>
                <span>参加確認中...</span>
              </>
            ) : isAuthInitializing ? (
              <span>入室準備中...</span>
            ) : (
              <span>講義ルームへ入室</span>
            )}
          </button>
        </form>

        {/* フッター */}
        <div className="mt-6 pt-4 border-t border-slate-100 text-center">
          <p className="text-[11px] text-slate-400">
            ClassAid Research Platform &copy; 2026
          </p>
        </div>
      </div>
    </div>
  )
}
