'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import { useParams, useRouter } from 'next/navigation'
import Link from 'next/link'
import { groupPostsWithReplies, retainChatPairs } from '@/lib/chat-pairs'

interface PostItem {
  id: number
  authorDisplayName: string
  authorType: 'human' | 'ai'
  parentId?: number | null
  message: string
  createdAt: string
  likesCount: number
  isLiked: boolean
  audienceType: 'room' | 'teacher'
}

export default function RoomChatPage() {
  const params = useParams()
  const router = useRouter()
  const roomSlug = typeof params?.roomSlug === 'string' ? params.roomSlug : ''

  const [posts, setPosts] = useState<PostItem[]>([])
  const [displayName, setDisplayName] = useState<string>('')
  const [showAiReplies, setShowAiReplies] = useState(true)
  const [isSessionLocked, setIsSessionLocked] = useState(false)
  const [isLoading, setIsLoading] = useState(true)
  const [isSending, setIsSending] = useState(false)
  const [isLikingId, setIsLikingId] = useState<number | null>(null)
  const [messageText, setMessageText] = useState('')
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [syncErrorMessage, setSyncErrorMessage] = useState<string | null>(null)

  const feedEndRef = useRef<HTMLDivElement>(null)
  const inFlightFetchRef = useRef(false)
  const isInitialScrollDoneRef = useRef(false)
  const lastFullRefreshRef = useRef(0)
  const postsRef = useRef<PostItem[]>([])
  const sendRequestRef = useRef<{id:string;text:string}|null>(null)

  useEffect(() => {
    postsRef.current = posts
  }, [posts])

  // 投稿一覧を取得する関数
  const fetchPosts = useCallback(async (forceFull = false) => {
    if (!roomSlug || inFlightFetchRef.current) return
    inFlightFetchRef.current = true

    try {
      const currentPosts = postsRef.current
      const newestId = currentPosts.length > 0 ? currentPosts[currentPosts.length - 1].id : null
      const shouldFetchFull = forceFull || newestId === null || Date.now() - lastFullRefreshRef.current >= 60_000
      const query = shouldFetchFull ? '' : `?afterId=${newestId}&visibleIds=${currentPosts.map(p=>p.id).join(',')}`
      const res = await fetch(`/api/rooms/${encodeURIComponent(roomSlug)}/posts${query}`, {
        cache: 'no-store', signal: AbortSignal.timeout(10000),
      })

      if (res.status === 403 || res.status === 401) {
        // 認証切れまたは不正アクセスの場合は入室案内へ
        setPosts([]); setIsSessionLocked(true); router.replace('/join')
        return
      }

      if (!res.ok) {
        // 取得失敗時は現在の投稿リストを消去せず維持
        setSyncErrorMessage('最新の投稿を取得できませんでした。')
        setIsLoading(false)
        return
      }

      const data = await res.json()
      if (data.resultMode === 'delta') {
        setPosts((current) => {
          const updates=new Map<number,{likesCount:number;isLiked:boolean}>((data.likeUpdates||[]).map((x:{id:number;likesCount:number;isLiked:boolean})=>[x.id,x]))
          current=current.map(post=>({...post,...updates.get(post.id)}))
          const known = new Set(current.map((post) => post.id))
          return retainChatPairs([...current, ...(data.posts || []).filter((post: PostItem) => !known.has(post.id))])
        })
      } else {
        setPosts(retainChatPairs(data.posts || []))
        lastFullRefreshRef.current = Date.now()
      }
      setSyncErrorMessage(null)
      setIsSessionLocked(Boolean(data.isSessionLocked))
      if (data.currentUser?.displayName) {
        setDisplayName(data.currentUser.displayName)
      }
      setIsLoading(false)

      // 初回のみ最下部へスクロール
      if (!isInitialScrollDoneRef.current && (data.posts || []).length > 0) {
        isInitialScrollDoneRef.current = true
        setTimeout(() => {
          feedEndRef.current?.scrollIntoView({ behavior: 'auto' })
        }, 100)
      }
    } catch {
      // ネットワーク切断時は既存データを保持
      setSyncErrorMessage('通信を確認できません。接続を確認して再試行してください。')
      setIsLoading(false)
    } finally {
      inFlightFetchRef.current = false
    }
  }, [roomSlug, router])

  // 大人数授業を想定し、6秒ごとの差分取得＋60秒ごとの完全同期にする。
  useEffect(() => {
    let isCancelled = false

    const poll = async () => {
      if (!isCancelled) {
        await fetchPosts()
      }
    }

    const initialTimer = setTimeout(() => {
      void poll()
    }, 0)

    const timer = setInterval(() => {
      void poll()
    }, 6000)

    return () => {
      isCancelled = true
      clearTimeout(initialTimer)
      clearInterval(timer)
    }
  }, [fetchPosts])

  // 新規投稿の送信
  async function handleSendMessage(e: React.FormEvent) {
    e.preventDefault()

    if (!messageText.trim() || isSending || isSessionLocked) return

    setIsSending(true)
    setErrorMessage(null)
    try {
      const text = messageText.trim()
      if (!sendRequestRef.current || sendRequestRef.current.text !== text) {
        // getRandomValues is available on LAN HTTP too; randomUUID requires HTTPS.
        const bytes = new Uint8Array(16)
        globalThis.crypto.getRandomValues(bytes)
        bytes[6] = (bytes[6] & 0x0f) | 0x40
        bytes[8] = (bytes[8] & 0x3f) | 0x80
        const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
        const id = `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`
        sendRequestRef.current = { id, text }
      }
      const requestId = sendRequestRef.current.id
      const res = await fetch(`/api/rooms/${encodeURIComponent(roomSlug)}/posts`, {
        method: 'POST', signal: AbortSignal.timeout(10000),
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: text, requestId, clientSentAt: new Date().toISOString(),
        }),
      })

      const result = await res.json()

      if (!res.ok) {
        setErrorMessage(result.error || '投稿の送信に失敗しました。')
        setIsSending(false)
        return
      }

      // 送信成功
      setMessageText(''); sendRequestRef.current = null
      setIsSending(false)

      // 即座に最新リストを取得し最下部へスムーズスクロール
      await fetchPosts()
      setTimeout(() => {
        feedEndRef.current?.scrollIntoView({ behavior: 'smooth' })
      }, 50)
    } catch {
      setErrorMessage('通信エラーが発生しました。接続を確認してください。')
      setIsSending(false)
    }
  }

  // いいねのトグル
  async function handleToggleLike(postId: number) {
    if (isLikingId !== null) return
    setIsLikingId(postId)

    // 楽観的更新
    setPosts((prevPosts) =>
      prevPosts.map((post) => {
        if (post.id === postId) {
          const nextIsLiked = !post.isLiked
          return {
            ...post,
            isLiked: nextIsLiked,
            likesCount: nextIsLiked ? post.likesCount + 1 : Math.max(0, post.likesCount - 1),
          }
        }
        return post
      })
    )

    try {
      const res = await fetch(`/api/rooms/${encodeURIComponent(roomSlug)}/likes`, {
        method: 'POST', signal: AbortSignal.timeout(10000),
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ postId, liked: !postsRef.current.find(p=>p.id===postId)?.isLiked }),
      })

      if (!res.ok) {
        // 失敗時はサーバー側の正本を取得してロールバック
        await fetchPosts(true)
        return
      }

      const data = await res.json()
      setPosts((prevPosts) =>
        prevPosts.map((post) => {
          if (post.id === postId) {
            return {
              ...post,
              isLiked: data.isLiked,
              likesCount: data.likesCount,
            }
          }
          return post
        })
      )
    } catch {
      await fetchPosts(true)
    } finally {
      setIsLikingId(null)
    }
  }

  // 日時のフォーマット表示 (例: 14:05)
  function formatTime(isoString: string) {
    try {
      const date = new Date(isoString)
      return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    } catch {
      return ''
    }
  }

  const visiblePosts = showAiReplies ? posts : posts.filter(post => post.authorType === 'human')

  return (
    <div className="flex flex-col h-screen bg-slate-100 text-slate-800 antialiased font-sans">
      {/* 1. ヘッダー */}
      <header className="sticky top-0 z-20 bg-white/95 backdrop-blur-sm border-b border-slate-200 px-4 py-2.5 flex items-center justify-between shadow-xs">
        <div className="flex items-center gap-2.5 min-w-0">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="text-xs font-black tracking-wider text-blue-700 bg-blue-50 px-2 py-0.5 rounded border border-blue-200">SupporTalk</span>
              <h1 className="text-sm font-bold text-slate-900 truncate">授業チャット</h1>
            </div>
            <div className="flex items-center gap-2 text-[11px] text-slate-500 mt-0.5">
              <span>
                表示名: <strong className="text-blue-700 font-semibold">{displayName || '参加者'}</strong>
              </span>
            </div>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {isSessionLocked && (
            <span className="text-[11px] bg-slate-200 text-slate-700 font-medium px-2 py-0.5 rounded">
              終了 (閲覧のみ)
            </span>
          )}
          <Link
            href="/enter"
            className="text-xs text-slate-500 hover:text-slate-700 px-2 py-1 rounded hover:bg-slate-100 transition-colors"
          >
            退室
          </Link>
        </div>
      </header>

      <div role="group" aria-label="チャットの表示切替" className="flex shrink-0 gap-2 border-b border-slate-200 bg-white px-4 py-2">
        <button type="button" aria-pressed={showAiReplies} onClick={() => setShowAiReplies(true)} className={`rounded-full border px-4 py-1.5 text-xs font-semibold ${showAiReplies ? 'border-blue-600 bg-blue-600 text-white' : 'border-slate-200 bg-white text-slate-600'}`}>すべて</button>
        <button type="button" aria-pressed={!showAiReplies} onClick={() => setShowAiReplies(false)} className={`rounded-full border px-4 py-1.5 text-xs font-semibold ${!showAiReplies ? 'border-blue-600 bg-blue-600 text-white' : 'border-slate-200 bg-white text-slate-600'}`}>人間の投稿のみ</button>
      </div>

      {/* 2. 投稿一覧タイムライン */}
      <main className="flex-1 overflow-y-auto p-3 sm:p-4 space-y-3">
        {isLoading ? (
          <div className="flex flex-col items-center justify-center h-48 text-slate-400 gap-2">
            <div className="w-6 h-6 border-2 border-blue-600 border-t-transparent rounded-full animate-spin" />
            <p className="text-xs">タイムラインを読み込み中...</p>
          </div>
        ) : visiblePosts.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-48 text-center text-slate-400 p-4">
            <p className="text-sm font-medium mb-1">まだ投稿がありません</p>
            <p className="text-xs">授業中の気づきや質問を最初に投稿してみましょう！</p>
          </div>
        ) : (
          groupPostsWithReplies(visiblePosts).map((group) => (
            <section key={group.post.id} className="space-y-2" aria-label="投稿と返信">
            {[group.post, ...group.replies].map((post) => {
            const isAi = post.authorType === 'ai'
            const isSelf = post.authorDisplayName === displayName

            return (
              <div
                key={post.id}
                className={`rounded-xl p-3 sm:p-3.5 shadow-xs border transition-colors ${
                  isAi
                    ? 'relative ml-5 sm:ml-8 border-sky-200 bg-sky-50'
                    : isSelf
                    ? 'bg-white border-blue-200/90'
                    : 'bg-white border-slate-200/80'
                }`}
              >
                {isAi && group.post.authorType === 'human' && (
                  <svg aria-hidden="true" className="absolute -left-4 -top-3 h-7 w-4 text-sky-400" viewBox="0 0 16 28" fill="none">
                    <path d="M2 1v11q0 5 5 5h6m-4-4 4 4-4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                )}
                {/* 投稿ヘッダー: 投稿者名と時間 */}
                <div className="flex items-center justify-between gap-2 mb-1.5">
                  <div className="flex items-center gap-1.5">
                    <span
                      className={`text-xs font-bold tracking-tight ${
                        isAi ? 'text-indigo-700' : isSelf ? 'text-blue-700' : 'text-slate-800'
                      }`}
                    >
                      {post.authorDisplayName}
                    </span>
                    {isAi && (
                      <span className="bg-indigo-600 text-white text-[10px] font-semibold px-1.5 py-0.2 rounded-full uppercase tracking-wider">
                        AI
                      </span>
                    )}
                    {isSelf && !isAi && (
                      <span className="bg-blue-100 text-blue-700 text-[10px] font-medium px-1.5 py-0.2 rounded">
                        あなた
                      </span>
                    )}
                    {post.audienceType === 'teacher' && (
                      <span className="bg-amber-100 text-amber-800 text-[10px] font-semibold px-1.5 py-0.5 rounded">
                        先生への質問・感想

                      </span>
                    )}
                  </div>
                  <span className="text-[11px] text-slate-400 shrink-0">
                    {formatTime(post.createdAt)}
                  </span>
                </div>

                {/* 投稿本文と右側いいねボタンのコンテナ */}
                <div className="flex items-start justify-between gap-3">
                  {/* 本文（最大幅・XSS防止のため標準文字列描画） */}
                  <p className="text-[13px] text-slate-800 leading-relaxed break-words whitespace-pre-wrap flex-1 select-text">
                    {post.message}
                  </p>

                  {/* 右側アクション: いいねボタン */}
                  <div className="shrink-0 flex items-center pt-0.5">
                    <button
                      type="button"
                      disabled={isLikingId === post.id}
                      onClick={() => handleToggleLike(post.id)}
                      aria-label="いいね"
                      className={`flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-semibold transition-all select-none ${
                        post.isLiked
                          ? 'bg-rose-50 text-rose-600 border border-rose-200'
                          : 'bg-slate-50 hover:bg-slate-100 text-slate-600 border border-slate-200'
                      } ${isLikingId === post.id ? 'opacity-50 cursor-wait' : 'cursor-pointer active:scale-95'}`}
                    >
                      <span className={post.isLiked ? 'text-rose-500 scale-110 transition-transform' : 'text-slate-400'}>
                        {post.isLiked ? '♥' : '♡'}
                      </span>
                      <span>{post.likesCount}</span>
                    </button>
                  </div>
                </div>

              </div>
            )
          })}
            </section>
          ))
        )}
        <div ref={feedEndRef} />
      </main>

      {syncErrorMessage && (
        <div className="bg-amber-50 border-t border-amber-200 text-amber-900 text-xs px-4 py-2 flex items-center justify-between gap-3">
          <span>{syncErrorMessage}</span>
          <button
            type="button"
            onClick={() => void fetchPosts()}
            className="font-semibold text-amber-900 hover:text-amber-700 shrink-0"
          >
            再試行
          </button>
        </div>
      )}

      {/* 3. エラー通知バー */}
      {errorMessage && (
        <div className="bg-red-500 text-white text-xs px-4 py-2 flex items-center justify-between shadow-md">
          <span>{errorMessage}</span>
          <button
            type="button"
            onClick={() => setErrorMessage(null)}
            className="text-white hover:text-red-100 font-bold ml-2 text-sm"
          >
            ✕
          </button>
        </div>
      )}

      {/* 4. 入力エリア (固定下部) */}
      <footer className="sticky bottom-0 bg-white border-t border-slate-200 p-3 sm:p-4 shadow-lg">
        {isSessionLocked ? (
          <div className="bg-slate-100 text-slate-500 text-center py-2.5 px-4 rounded-xl text-xs font-medium">
            この授業セッションは終了しました。新たな投稿はできません。
          </div>
        ) : (
          <form onSubmit={handleSendMessage} className="space-y-2">
            <div className="text-xs text-slate-600 px-1">
              あなたの表示名：
              <strong className="text-blue-700 font-semibold">{displayName || '参加者'}</strong>
            </div>
            <div className="relative flex items-end gap-2">
              <textarea
                value={messageText}
                onChange={(e) => setMessageText(e.target.value)}
                placeholder="気づきや質問を投稿してみよう（500文字以内）"
                maxLength={500}
                rows={2}
                disabled={isSending}
                className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-[13px] text-slate-800 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:bg-white resize-none transition-all disabled:opacity-60"
              />
              <button
                type="submit"
                disabled={isSending || !messageText.trim()}
                className="h-10 px-4 bg-blue-600 hover:bg-blue-700 text-white font-semibold text-xs rounded-xl shadow-xs transition-all disabled:bg-slate-300 disabled:cursor-not-allowed shrink-0 flex items-center justify-center gap-1.5"
              >
                {isSending ? (
                  <div className="w-3.5 h-3.5 border-2 border-white border-t-transparent rounded-full animate-spin" />
                ) : (
                  <span>送信</span>
                )}
              </button>
            </div>

            <div className="flex justify-end items-center text-[10px] text-slate-400 px-1">

              <span className={messageText.length > 450 ? 'text-amber-600 font-semibold' : ''}>
                {messageText.length}/500
              </span>
            </div>
          </form>
        )}
      </footer>
    </div>
  )
}
