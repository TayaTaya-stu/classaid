'use client'

import { type FormEvent, useCallback, useEffect, useState } from 'react'
import AdminSessionControl, { type SessionControlData } from './AdminSessionControl'

type SessionSummary = { id: string; sessionNumber: number; scheduledAt: string; isDevelopment: boolean }
type RoomSummary = { id: string; groupLabel: string; aiCondition: 'none' | 'standard' | 'damekko' }
type DashboardData = {
  sessions: SessionSummary[]
  selectedSessionId: string | null
  rooms: RoomSummary[]
  sessionControl: SessionControlData | null
  sharedWall: { screenSlug: string; entrySlug: string } | null
}

const buttonStyle = { padding: '10px 15px', border: '1px solid #7890a7', borderRadius: 9, background: '#fff', color: '#17324d', fontWeight: 700, cursor: 'pointer' } as const

function formatDateTime(value: string) {
  return new Intl.DateTimeFormat('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(value))
}
function sessionLabel(session: SessionSummary) {
  return `${session.isDevelopment ? '開発テスト' : `第${session.sessionNumber}回`}（${formatDateTime(session.scheduledAt)}）`
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
    try {
      const query = sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : ''
      const response = await fetch(`/api/admin/dashboard${query}`, { cache: 'no-store' })
      if (response.status === 401) { setAuthenticated(false); setDashboard(null); return }
      const data = (await response.json()) as DashboardData & { error?: string }
      if (!response.ok) throw new Error(data.error || '管理画面の読み込みに失敗しました。')
      setAuthenticated(true); setDashboard(data); setSelectedSessionId(data.selectedSessionId || ''); setLoadError('')
    } catch (error) { setLoadError(error instanceof Error ? error.message : '管理画面の読み込みに失敗しました。') }
    finally { if (!quiet) setIsLoading(false) }
  }, [])

  useEffect(() => { const timer = window.setTimeout(() => void loadDashboard(), 0); return () => window.clearTimeout(timer) }, [loadDashboard])
  useEffect(() => {
    if (!authenticated || !selectedSessionId) return
    const timer = window.setInterval(() => void loadDashboard(selectedSessionId, true), 5000)
    return () => window.clearInterval(timer)
  }, [authenticated, loadDashboard, selectedSessionId])

  async function handleLogin(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setIsLoggingIn(true); setLoginError('')
    try {
      const response = await fetch('/api/admin/auth', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password }) })
      const data = (await response.json()) as { error?: string }
      if (!response.ok) throw new Error(data.error || 'ログインに失敗しました。')
      setPassword(''); await loadDashboard()
    } catch (error) { setLoginError(error instanceof Error ? error.message : 'ログインに失敗しました。') }
    finally { setIsLoggingIn(false) }
  }
  async function handleLogout() { await fetch('/api/admin/auth', { method: 'DELETE' }); setAuthenticated(false); setDashboard(null) }

  if (authenticated === null) return <main style={{ padding: 40, fontFamily: 'sans-serif' }}>管理画面を確認しています…</main>
  if (!authenticated) return (
    <main style={{ minHeight: '100vh', padding: '56px 20px', background: '#eef3f7', fontFamily: 'sans-serif' }}>
      <form onSubmit={handleLogin} style={{ maxWidth: 420, margin: '0 auto', padding: 30, borderRadius: 18, background: '#fff', boxShadow: '0 12px 34px rgba(20,35,55,.12)' }}>
        <h1 style={{ marginTop: 0 }}>実験者用管理画面</h1>
        <p style={{ color: '#536273', lineHeight: 1.6 }}>実験者パスワードを入力してください。</p>
        <label style={{ display: 'grid', gap: 8, fontWeight: 700 }}>実験者パスワード
          <input type="password" value={password} onChange={(event) => setPassword(event.target.value)} required style={{ padding: 12, border: '1px solid #9bacbd', borderRadius: 9, fontSize: 16 }} />
        </label>
        {loginError && <p role="alert" style={{ color: '#b42318' }}>{loginError}</p>}
        <button type="submit" disabled={isLoggingIn} style={{ ...buttonStyle, width: '100%', marginTop: 20, background: '#214f7b', color: '#fff' }}>{isLoggingIn ? '確認中…' : 'ログイン'}</button>
      </form>
    </main>
  )

  return (
    <main style={{ minHeight: '100vh', padding: 24, background: '#eef3f7', color: '#17212b', fontFamily: 'sans-serif' }}>
      <header style={{ display: 'flex', justifyContent: 'space-between', gap: 16, alignItems: 'center', flexWrap: 'wrap', marginBottom: 22 }}>
        <div><h1 style={{ margin: 0 }}>実験者用管理画面</h1><p style={{ margin: '6px 0 0', color: '#536273' }}>授業進行とAI介入を操作します。</p></div>
        <button onClick={handleLogout} style={buttonStyle}>ログアウト</button>
      </header>
      <section style={{ padding: 18, borderRadius: 14, background: '#fff', border: '1px solid #c7d3df', marginBottom: 20 }}>
        <div style={{ display: 'flex', alignItems: 'end', gap: 12, flexWrap: 'wrap' }}>
          <label style={{ display: 'grid', gap: 6, minWidth: 280, fontWeight: 700 }}>表示する授業回
            <select value={selectedSessionId} onChange={(event) => { setSelectedSessionId(event.target.value); void loadDashboard(event.target.value) }} style={{ padding: 10, border: '1px solid #9bacbd', borderRadius: 8, background: '#fff' }}>
              {(dashboard?.sessions || []).map((session) => <option key={session.id} value={session.id}>{sessionLabel(session)}</option>)}
            </select>
          </label>
          <button onClick={() => void loadDashboard(selectedSessionId)} disabled={isLoading} style={buttonStyle}>{isLoading ? '更新中…' : '今すぐ更新'}</button>
        </div>
        {loadError && <p role="alert" style={{ color: '#b42318' }}>{loadError}</p>}
      </section>
      {dashboard?.sharedWall && (
        <section style={{ padding: 18, borderRadius: 14, background: '#e8f6ff', border: '1px solid #82b9d8', marginBottom: 20 }}>
          <h2 style={{ marginTop: 0 }}>共有コメントスクリーン</h2>
          <p style={{ color: '#365b70' }}>投影画面は閲覧専用です。QRコードから学生用入室画面へ進めます。</p>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            <a href={`/screen/${dashboard.sharedWall.screenSlug}`} target="_blank" rel="noreferrer" style={{ ...buttonStyle, background: '#135f89', color: '#fff', textDecoration: 'none' }}>投影画面を開く</a>
            <a href={`/enter/${dashboard.sharedWall.entrySlug}`} target="_blank" rel="noreferrer" style={{ ...buttonStyle, textDecoration: 'none' }}>学生入室画面を確認</a>
            {(dashboard?.rooms || []).length > 0 && (
              <a href={`/admin/room/${dashboard!.rooms[0].id}`} target="_blank" rel="noreferrer" style={{ ...buttonStyle, background: '#fff', borderColor: '#4f7894', textDecoration: 'none' }}>共有ルームの投稿を確認</a>
            )}
          </div>
        </section>
      )}
      {dashboard?.sessionControl && selectedSessionId && <AdminSessionControl key={selectedSessionId} sessionId={selectedSessionId} control={dashboard.sessionControl} onUpdated={() => loadDashboard(selectedSessionId)} />}
    </main>
  )
}
