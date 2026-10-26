'use client'

import { useState, useEffect, useRef } from 'react'
import { useRouter, useParams } from 'next/navigation'
import { supabase } from '@/lib/supabase'
import { StudentAuthCoordinator } from '@/lib/student-auth-coordinator'

const PARTICIPANT_PROFILE_KEY = 'classaid_participant_profile_v1'

export default function SessionEnterPage() {
  const router = useRouter()
  const params = useParams()
  const entrySlug = typeof params?.entrySlug === 'string' ? params.entrySlug : ''

  const getStoredProfile = (): { displayName: string; participantId: string } => {
    if (typeof window === 'undefined') {
      return { displayName: '', participantId: '' }
    }
    try {
      const saved = window.localStorage.getItem(PARTICIPANT_PROFILE_KEY)
      if (!saved) return { displayName: '', participantId: '' }
      const parsed = JSON.parse(saved) as { displayName?: string; participantId?: string }
      return {
        displayName: typeof parsed.displayName === 'string' ? parsed.displayName : '',
        participantId: typeof parsed.participantId === 'string' ? parsed.participantId : '',
      }
    } catch {
      return { displayName: '', participantId: '' }
    }
  }

  const [displayName, setDisplayName] = useState('')
  const [forgotPreviousName, setForgotPreviousName] = useState(false)
  const [showForgotName, setShowForgotName] = useState(false)
  const [participantId, setParticipantId] = useState('')
  const [consented, setConsented] = useState<boolean | null>(null)
  const [loading, setLoading] = useState(false)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [authToken, setAuthToken] = useState<string | null>(null)
  const [isAuthInitializing, setIsAuthInitializing] = useState(true)
  const [authInitFailed, setAuthInitFailed] = useState(false)
  const [profileReady, setProfileReady] = useState(false)

  // 前回参加情報の事前確認状態

  // 以前の名前引き継ぎ確認モーダル用
  const [confirmClaimModal, setConfirmClaimModal] = useState<{ open: boolean; name: string }>({
    open: false,
    name: '',
  })

  useEffect(() => {
    const timer = window.setTimeout(() => {
      const saved = getStoredProfile()
      if (saved.displayName && saved.displayName.trim().length >= 2) {
        setDisplayName(saved.displayName.trim())
        setParticipantId(saved.participantId)
      }
      setProfileReady(true)
    }, 0)
    return () => window.clearTimeout(timer)
  }, [])

  const [coordinator] = useState(() => new StudentAuthCoordinator())

  const [retryCount, setRetryCount] = useState(0)
  const activeAttemptRef = useRef(0)

  const triggerRetry = () => {
    // 画面の待機タイマーを再起動（認証処理自体が未完了なら既存のPromiseを再利用）
    setIsAuthInitializing(true)
    setAuthInitFailed(false)
    setErrorMessage(null)
    setRetryCount((c) => c + 1)
  }


  useEffect(() => {
    let cancelled = false
    const attemptId = ++activeAttemptRef.current

    const timeoutMs = 5000
    let timerId: ReturnType<typeof setTimeout> | undefined

    const timeoutPromise = new Promise<never>((_, reject) => {
      timerId = setTimeout(() => {
        reject(new Error('認証の応答がタイムアウトしました。通信環境を確認してください。'))
      }, timeoutMs)
    })

    async function execute() {
      try {
        // 元の認証Promiseを保持し、未完了なら再試行でも同じ処理を共有
        const authPromise = coordinator.getOrInitToken(supabase).then(async (token) => {
          const response = await fetch('/api/enter', {
            headers: { Authorization: `Bearer ${token}` }, cache: 'no-store',
            signal: AbortSignal.timeout(5000),
          })
          if (!response.ok) throw new Error('登録名を確認できません。再試行してください。')
          return { token, profile: await response.json() }
        })
        const { token, profile } = await Promise.race([authPromise, timeoutPromise])
        if (cancelled || activeAttemptRef.current !== attemptId) return
        if (token) {
          if (typeof profile.displayName === 'string' && profile.displayName) {
            setDisplayName(profile.displayName)
            setParticipantId(profile.participantId)
            try { window.localStorage.setItem(PARTICIPANT_PROFILE_KEY, JSON.stringify(profile)) } catch {}
          }
          setAuthToken(token)
          setIsAuthInitializing(false)
          setAuthInitFailed(false)
        } else {
          throw new Error('認証トークンを取得できませんでした。')
        }
      } catch (err) {
        // 1. タイムアウト後や古い試行の結果で画面状態を上書きしない
        if (cancelled || activeAttemptRef.current !== attemptId) return

        console.error('[SessionEnterPage] initAuth failed:', err)
        setAuthInitFailed(true)
        setIsAuthInitializing(false)
      } finally {
        // 4. タイマーを終了時に解除（認証処理自体の寿命はcoordinator側で管理・継続）
        if (timerId) {
          clearTimeout(timerId)
          timerId = undefined
        }
      }
    }

    void execute()

    return () => {
      cancelled = true
      // 4. アンマウント/再実行時にも画面タイマーを解除
      if (timerId) {
        clearTimeout(timerId)
        timerId = undefined
      }
    }
  }, [retryCount, coordinator])

  async function submitEntry(claimExisting = false) {
    if (isAuthInitializing || !authToken) {
      setErrorMessage('入室準備中です。しばらくお待ちください。')
      return
    }

    if (consented === null) {
      setErrorMessage('研究利用について「同意する」または「同意しない」を選択してください。')
      return
    }

    const normalizedName = displayName.trim()
    if (normalizedName.length < 2 || normalizedName.length > 24) {
      setErrorMessage('名前は2文字以上24文字以内で入力してください。')
      return
    }

    if (!entrySlug) {
      setErrorMessage('授業コードが見つかりません。URLを再確認してください。')
      return
    }

    setLoading(true)
    setErrorMessage(null)

    try {
      let activeToken = authToken
      try {
        const { data: fresh } = await supabase.auth.getSession()
        if (fresh?.session?.access_token) {
          activeToken = fresh.session.access_token
        }
      } catch {}

      if (!activeToken) throw new Error('認証を確認できません。再読み込みしてください。')

      const res = await fetch('/api/enter', {
        method: 'POST', signal: AbortSignal.timeout(15000),
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          displayName: normalizedName,
          entrySlug,
          consented,
          authToken: activeToken,
          claimExisting,
          forgotPreviousName,
        }),
      })

      const data = await res.json()

      if (res.status === 409 && data.promptClaim) {
        // 名前登録済みでAuthリンクがない場合：自己申告確認モーダルを開く
        setConfirmClaimModal({ open: true, name: normalizedName })
        setLoading(false)
        return
      }

      if (!res.ok) {
        setErrorMessage(data.error || '入室処理に失敗しました。')
        setLoading(false)
        return
      }

      const nextParticipantId = typeof data.participantId === 'string' ? data.participantId : participantId
      if (nextParticipantId) {
        setParticipantId(nextParticipantId)
      }

      try {
        window.localStorage.setItem(
          PARTICIPANT_PROFILE_KEY,
          JSON.stringify({ displayName: data.displayName || normalizedName, participantId: nextParticipantId })
        )
      } catch {
        // 保存失敗時も参加は可能
      }

      const nextRoomSlug = typeof data.roomSlug === 'string' ? data.roomSlug : ''
      if (nextRoomSlug) {
        router.push(`/room/${nextRoomSlug}`)
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
    !profileReady ||
    isAuthInitializing ||
    authInitFailed ||
    !authToken ||
    consented === null ||
    !displayName.trim()

  return (
    <div className="min-h-screen bg-slate-50 flex flex-col items-center justify-center p-4">
      <div className="w-full max-w-md bg-white rounded-2xl shadow-sm border border-blue-100 p-6 sm:p-8 relative">
        <div className="text-center mb-5">
          <span className="inline-block px-3 py-1 bg-blue-100 text-blue-800 text-xs font-bold rounded-full mb-2 tracking-wide">
            SupporTalk
          </span>
          <h1 className="text-xl font-bold text-slate-800">授業チャットに参加</h1>
          
          <div className="bg-blue-50/70 border border-blue-200 rounded-xl p-3 mt-3 text-left">
            <p className="text-xs text-blue-950 font-medium leading-relaxed">
              📱 <strong>スマートフォンに最初から入っている「カメラ」アプリでQRコードを読み取ってください。</strong>次回も同じスマートフォンを使ってください。
            </p>
          </div>
        </div>

        {/* 前回参加情報の事前確認カード（前回情報がある場合、先に表示） */}
        {authInitFailed && (
          <div className="bg-amber-50 border border-amber-200 text-amber-800 text-xs rounded-xl p-3.5 mb-4 leading-relaxed flex items-center justify-between gap-3 shadow-xs">
            <div>
              <p className="font-semibold text-amber-900">入室準備に失敗しました</p>
              <p className="text-[11px] text-amber-800 mt-0.5">通信環境を確認し、もう一度お試しください。</p>
            </div>
            <button
              type="button"
              onClick={triggerRetry}
              className="px-3.5 py-1.5 bg-amber-600 hover:bg-amber-700 text-white font-bold text-xs rounded-lg transition-colors whitespace-nowrap shadow-xs cursor-pointer"
            >
              再試行
            </button>
          </div>
        )}

          <form onSubmit={(e) => { e.preventDefault(); void submitEntry(false) }} className="space-y-4">
            {/* 1枠にまとめた名前入力欄 */}
            <div className="bg-slate-50 border border-slate-200 rounded-xl p-4 space-y-2">
              <label htmlFor="display-name-input" className="block text-xs font-bold text-slate-800">
                チャットで使う名前
              </label>
              <input
                id="display-name-input"
                type="text"
                autoComplete="off"
                disabled={loading || (authInitFailed && !authToken)}
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                placeholder="あおぞら、たろう、さくら"
                className="w-full px-3.5 py-2.5 bg-white border border-slate-300 rounded-lg text-sm text-slate-800 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 transition-all disabled:opacity-60"
              />
              <p className="text-xs font-medium text-slate-700 leading-relaxed">
                以前参加した方は、必ず前回と同じ名前で入室してください。初めて参加する方は、新しい名前を入力してください。
              </p>
              <p className="text-[11px] text-slate-500">
                本名でなくてかまいません。
              </p>
              {!participantId && !forgotPreviousName && (
                <button type="button" disabled={loading} onClick={() => setShowForgotName(true)} className="text-xs text-blue-700 underline underline-offset-2">
                  前に使った名前がわからない
                </button>
              )}
              {showForgotName && !forgotPreviousName && (
                <div className="border border-amber-200 bg-amber-50 rounded-lg p-3 space-y-2 text-xs text-amber-950" role="status">
                  <p>前の参加記録を確認できないため、新しい名前での登録になります。以前の記録とは別の参加者として扱われます。</p>
                  <button type="button" disabled={loading} onClick={() => {
                    setForgotPreviousName(true)
                    setShowForgotName(false)
                    setDisplayName('')
                    setErrorMessage(null)
                  }} className="font-semibold underline underline-offset-2">新しい名前で参加する</button>
                  <button type="button" disabled={loading} onClick={() => setShowForgotName(false)} className="ml-3 underline underline-offset-2">戻る</button>
                </div>
              )}
              {forgotPreviousName && <p className="text-xs text-amber-900" role="status">名前不明による再登録です。前の記録とは別に登録します。未使用の新しい名前を入力してください。</p>}

            </div>

            {/* 研究データの利用について（統一・重複削除版） */}
            <div className="bg-slate-50 border border-slate-200 rounded-xl p-4 space-y-3">
              <div>
                <h2 className="text-xs font-bold text-slate-800 mb-1">
                  研究データの利用について
                </h2>
                <p className="text-xs text-slate-600 leading-relaxed">
                  投稿内容・投稿時刻・いいね・参加記録を、卒業研究の分析に使用することがあります。複数回の参加記録は、同じ参加者のものとして対応付けて分析します。
                </p>
              </div>

              <fieldset disabled={loading}>
                <legend className="text-xs font-semibold text-slate-700 mb-2">
                  上記の研究利用に同意しますか？
                </legend>
                <div className="grid grid-cols-2 gap-2">
                  <label className={`flex items-center justify-center gap-2 rounded-lg border px-3 py-2.5 cursor-pointer select-none text-xs font-semibold transition-colors ${
                    consented === true
                      ? 'border-blue-500 bg-blue-50 text-blue-800'
                      : 'border-slate-300 bg-white text-slate-600'
                  }`}>
                    <input
                      type="radio"
                      name="research-consent"
                      checked={consented === true}
                      onChange={() => setConsented(true)}
                      className="w-4 h-4 text-blue-600 border-slate-300 focus:ring-blue-500"
                    />
                    同意する
                  </label>
                  <label className={`flex items-center justify-center gap-2 rounded-lg border px-3 py-2.5 cursor-pointer select-none text-xs font-semibold transition-colors ${
                    consented === false
                      ? 'border-slate-500 bg-slate-100 text-slate-800'
                      : 'border-slate-300 bg-white text-slate-600'
                  }`}>
                    <input
                      type="radio"
                      name="research-consent"
                      checked={consented === false}
                      onChange={() => setConsented(false)}
                      className="w-4 h-4 text-slate-600 border-slate-300 focus:ring-slate-500"
                    />
                    同意しない
                  </label>
                </div>
                <p className="text-xs text-slate-500 mt-2">
                  どちらを選んでも、チャットに参加できます。
                </p>
              </fieldset>
            </div>

            {errorMessage && (
              <div className="bg-red-50 border border-red-200 text-red-700 text-xs rounded-lg p-3">
                {errorMessage}
              </div>
            )}

            <button
              type={authInitFailed && !authToken ? 'button' : 'submit'}
              onClick={authInitFailed && !authToken ? triggerRetry : undefined}
              disabled={(!authInitFailed || !!authToken) && isSubmitDisabled}
              className="w-full mt-2 py-3 px-4 bg-blue-600 hover:bg-blue-700 text-white font-semibold text-sm rounded-xl shadow-sm transition-all focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 disabled:bg-slate-300 disabled:cursor-not-allowed disabled:shadow-none flex items-center justify-center gap-2 cursor-pointer"
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
              ) : authInitFailed && !authToken ? (
                <span>再試行する</span>
              ) : (
                <span>授業チャットへ入室</span>
              )}
            </button>
          </form>

        <div className="mt-6 pt-4 border-t border-slate-100 text-center">
          <p className="text-[11px] text-slate-400">
            SupporTalk &copy; 2026
          </p>
        </div>

        {/* 既存名前の自己申告確認モーダル */}
        {confirmClaimModal.open && (
          <div className="fixed inset-0 bg-black/40 backdrop-blur-xs flex items-center justify-center p-4 z-50">
            <div role="alertdialog" aria-modal="true" aria-labelledby="claim-warning-title" className="bg-white rounded-2xl max-w-sm w-full p-6 shadow-xl border-2 border-amber-500 animate-in fade-in zoom-in-95 duration-150">
              <h2 id="claim-warning-title" className="text-base font-bold text-amber-950 mb-2">
                ⚠ この名前はすでに登録されています
              </h2>
              <p className="text-xs text-slate-600 leading-relaxed mb-4">
                「<strong>{confirmClaimModal.name}</strong>」が、あなた自身が以前登録した名前でなければ、引き継がないでください。別の方の名前で入ると、参加記録が混ざってしまいます。
              </p>
              <div className="flex flex-col gap-2">
                <button
                  type="button"
                  onClick={() => {
                    setConfirmClaimModal({ open: false, name: '' })
                    setDisplayName('')
                    setErrorMessage('未使用の別の名前を入力してください。')
                  }}
                  className="w-full py-2.5 px-4 bg-blue-600 hover:bg-blue-700 text-white font-semibold text-xs rounded-xl transition-colors shadow-sm"
                >
                  別の名前を入力する
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setConfirmClaimModal({ open: false, name: '' })
                    void submitEntry(true)
                  }}
                  className="w-full py-2.5 px-4 bg-white hover:bg-slate-50 border border-slate-300 text-slate-700 font-semibold text-xs rounded-xl transition-colors"
                >
                  自分が以前登録した名前として引き継ぐ
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
