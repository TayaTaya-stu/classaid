'use client'

import { type FormEvent, useCallback, useEffect, useState } from 'react'
import AdminSessionControl, { type SessionControlData } from './AdminSessionControl'

type SessionSummary = {
  id: string
  sessionNumber: number
  waveNumber: number
  scheduledAt: string
  status: string
  isLocked: boolean
  isDevelopment: boolean
}

type AdminPost = {
  id: number
  roomId: string
  roomLabel: string
  authorDisplayName: string
  authorType: 'human' | 'ai'
  message: string
  audienceType: 'room' | 'teacher'
  createdAt: string
}

type RoomFeed = {
  id: string
  groupLabel: string
  posts: AdminPost[]
}

type DashboardData = {
  sessions: SessionSummary[]
  selectedSessionId: string | null
  rooms: RoomFeed[]
  teacherPosts: AdminPost[]
  sessionControl: SessionControlData
}

function formatDateTime(value: string) {
  return new Intl.DateTimeFormat('ja-JP', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value))
}

function sessionLabel(session: SessionSummary) {
  const prefix = session.isDevelopment ? '開発テスト' : `第${session.sessionNumber}回`
  return `${prefix}（${formatDateTime(session.scheduledAt)}）`
}

function PostCard({ post, showRoom = false }: { post: AdminPost; showRoom?: boolean }) {
  return (
    <article style={{ border: '1px solid #dbe2ea', borderRadius: 10, padding: 12, background: '#fff' }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', fontSize: 13, color: '#536273' }}>
        {showRoom && <strong style={{ color: '#274c77' }}>ルーム{post.roomLabel}</strong>}
        <strong style={{ color: '#17212b' }}>{post.authorDisplayName}</strong>
        {post.authorType === 'ai' && <span style={{ color: '#5b4acb' }}>AI</span>}
        <time>{formatDateTime(post.createdAt)}</time>
      </div>
      <p style={{ margin: '8px 0 0', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', lineHeight: 1.6 }}>
        {post.message}
      </p>
    </article>
  )
}

export default function AdminPage() {
  const [authenticated, setAuthenticated] = useState<boolean | null>(null)
  const [password, setPassword] = useState('')
  const [loginError, setLoginError] = useState('')
  const [isLoggingIn, setIsLoggingIn] = useState(false)
  const [dashboard, setDashboard] = useState<DashboardData | null>(null)
  const [selectedSessionId, setSelectedSessionId] = useState('')
  const [loadError, setLoadError] = useState('')
  const [isLoading, setIsLoading] = useState(false)

  const loadDashboard = useCallback(async (sessionId?: string, quiet = false) => {
    if (!quiet) setIsLoading(true)
    const query = sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : ''
    try {
      const response = await fetch(`/api/admin/dashboard${query}`, { cache: 'no-store' })
      if (response.status === 401) {
        setAuthenticated(false)
        setDashboard(null)
        return
      }
      const data = (await response.json()) as DashboardData & { error?: string }
      if (!response.ok) throw new Error(data.error || '管理画面の読み込みに失敗しました。')
      setAuthenticated(true)
      setDashboard(data)
      setSelectedSessionId(data.selectedSessionId || '')
      setLoadError('')
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : '管理画面の読み込みに失敗しました。')
    } finally {
      if (!quiet) setIsLoading(false)
    }
  }, [])

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void loadDashboard()
    }, 0)
    return () => window.clearTimeout(timer)
  }, [loadDashboard])

  useEffect(() => {
    if (!authenticated || !selectedSessionId) return
    const timer = window.setInterval(() => {
      void loadDashboard(selectedSessionId, true)
    }, 3000)
    return () => window.clearInterval(timer)
  }, [authenticated, loadDashboard, selectedSessionId])

  async function handleLogin(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setIsLoggingIn(true)
    setLoginError('')
    try {
      const response = await fetch('/api/admin/auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      })
      const data = (await response.json()) as { error?: string }
      if (!response.ok) throw new Error(data.error || 'ログインに失敗しました。')
      setPassword('')
      await loadDashboard()
    } catch (error) {
      setLoginError(error instanceof Error ? error.message : 'ログインに失敗しました。')
    } finally {
      setIsLoggingIn(false)
    }
  }

  async function handleLogout() {
    await fetch('/api/admin/auth', { method: 'DELETE' })
    setAuthenticated(false)
    setDashboard(null)
  }

  if (authenticated === null) {
    return <main style={{ padding: 40, fontFamily: 'sans-serif' }}>管理画面を確認しています…</main>
  }

  if (!authenticated) {
    return (
      <main style={{ minHeight: '100vh', padding: '56px 20px', background: '#f3f6f9', fontFamily: 'sans-serif' }}>
        <form onSubmit={handleLogin} style={{ maxWidth: 420, margin: '0 auto', padding: 28, borderRadius: 16, background: '#fff', boxShadow: '0 10px 32px rgba(20, 35, 55, 0.10)' }}>
          <h1 style={{ marginTop: 0 }}>教授・実験者用管理画面</h1>
          <p style={{ color: '#536273', lineHeight: 1.6 }}>学生には公開されません。管理者パスワードを入力してください。</p>
          <label style={{ display: 'grid', gap: 8, fontWeight: 700 }}>
            管理者パスワード
            <input
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete="current-password"
              required
              style={{ padding: 12, border: '1px solid #b8c3cf', borderRadius: 8, fontSize: 16 }}
            />
          </label>
          {loginError && <p role="alert" style={{ color: '#b42318' }}>{loginError}</p>}
          <button type="submit" disabled={isLoggingIn} style={{ width: '100%', marginTop: 20, padding: 12, border: 0, borderRadius: 8, background: '#214f7b', color: '#fff', fontWeight: 700, cursor: 'pointer' }}>
            {isLoggingIn ? '確認中…' : 'ログイン'}
          </button>
        </form>
      </main>
    )
  }

  return (
    <main style={{ minHeight: '100vh', padding: 24, background: '#f3f6f9', color: '#17212b', fontFamily: 'sans-serif' }}>
      <header style={{ display: 'flex', justifyContent: 'space-between', gap: 16, alignItems: 'center', flexWrap: 'wrap', marginBottom: 20 }}>
        <div>
          <h1 style={{ margin: 0 }}>教授・実験者用管理画面</h1>
          <p style={{ margin: '6px 0 0', color: '#536273' }}>3秒ごとに各ルームの投稿を更新します。</p>
        </div>
        <button onClick={handleLogout} style={{ padding: '9px 14px', border: '1px solid #9aa8b6', borderRadius: 8, background: '#fff', cursor: 'pointer' }}>ログアウト</button>
      </header>

      <section style={{ display: 'flex', alignItems: 'end', gap: 12, flexWrap: 'wrap', marginBottom: 20 }}>
        <label style={{ display: 'grid', gap: 6, minWidth: 280, fontWeight: 700 }}>
          表示する授業回
          <select
            value={selectedSessionId}
            onChange={(event) => {
              const id = event.target.value
              setSelectedSessionId(id)
              void loadDashboard(id)
            }}
            style={{ padding: 10, border: '1px solid #b8c3cf', borderRadius: 8, background: '#fff' }}
          >
            {(dashboard?.sessions || []).map((session) => <option key={session.id} value={session.id}>{sessionLabel(session)}</option>)}
          </select>
        </label>
        <button onClick={() => void loadDashboard(selectedSessionId)} disabled={isLoading} style={{ padding: '10px 14px', border: '1px solid #9aa8b6', borderRadius: 8, background: '#fff', cursor: 'pointer' }}>
          {isLoading ? '更新中…' : '今すぐ更新'}
        </button>
      </section>

      {loadError && <p role="alert" style={{ color: '#b42318' }}>{loadError}</p>}

      {dashboard?.sessionControl && selectedSessionId && (
        <AdminSessionControl
          key={selectedSessionId}
          sessionId={selectedSessionId}
          control={dashboard.sessionControl}
          onUpdated={() => loadDashboard(selectedSessionId)}
        />
      )}

      <section style={{ marginBottom: 24, padding: 18, border: '1px solid #e7bd63', borderRadius: 14, background: '#fff8e7' }}>
        <h2 style={{ marginTop: 0 }}>先生への質問・感想</h2>
        <p style={{ color: '#6c5524' }}>3ルーム分を新しい順にまとめています。</p>
        <div style={{ display: 'grid', gap: 10, maxHeight: 360, overflowY: 'auto' }}>
          {dashboard?.teacherPosts.length ? dashboard.teacherPosts.map((post) => <PostCard key={post.id} post={post} showRoom />) : <p>まだ先生宛ての投稿はありません。</p>}
        </div>
      </section>

      <section style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: 16, alignItems: 'start' }}>
        {(dashboard?.rooms || []).map((room) => (
          <section key={room.id} style={{ padding: 16, borderRadius: 14, background: '#eaf0f6' }}>
            <h2 style={{ marginTop: 0 }}>ルーム{room.groupLabel}</h2>
            <div style={{ display: 'grid', gap: 10, maxHeight: '65vh', overflowY: 'auto' }}>
              {room.posts.length ? room.posts.map((post) => <PostCard key={post.id} post={post} />) : <p>まだ投稿はありません。</p>}
            </div>
          </section>
        ))}
      </section>
    </main>
  )
}
