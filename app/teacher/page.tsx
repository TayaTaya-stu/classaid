'use client'

import { type FormEvent, useCallback, useEffect, useState } from 'react'

type Session = { id: string; sessionNumber: number; scheduledAt: string; isDevelopment: boolean }
type TeacherPost = { id: number; roomLabel: string; authorDisplayName: string; message: string; createdAt: string }
type TeacherData = { sessions: Session[]; selectedSessionId: string | null; posts: TeacherPost[] }

const buttonStyle = { padding: '10px 15px', border: '1px solid #8b7854', borderRadius: 9, background: '#fff', color: '#40351f', fontWeight: 700, cursor: 'pointer' } as const
function dateLabel(value: string) { return new Intl.DateTimeFormat('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(value)) }

export default function TeacherPage() {
  const [authenticated, setAuthenticated] = useState<boolean | null>(null)
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [data, setData] = useState<TeacherData | null>(null)
  const [sessionId, setSessionId] = useState('')
  const [busy, setBusy] = useState(false)

  const load = useCallback(async (selected?: string) => {
    try {
      const query = selected ? `?sessionId=${encodeURIComponent(selected)}` : ''
      const response = await fetch(`/api/teacher/dashboard${query}`, { cache: 'no-store' })
      if (response.status === 401) { setAuthenticated(false); setData(null); return }
      const next = (await response.json()) as TeacherData & { error?: string }
      if (!response.ok) throw new Error(next.error || '画面を更新できませんでした。')
      setAuthenticated(true); setData(next); setSessionId(next.selectedSessionId || ''); setError('')
    } catch (caught) { setError(caught instanceof Error ? caught.message : '画面を更新できませんでした。') }
  }, [])

  useEffect(() => { const timer = window.setTimeout(() => void load(), 0); return () => window.clearTimeout(timer) }, [load])
  useEffect(() => {
    if (!authenticated || !sessionId) return
    const timer = window.setInterval(() => void load(sessionId), 3000)
    return () => window.clearInterval(timer)
  }, [authenticated, load, sessionId])

  async function login(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError('')
    try {
      const response = await fetch('/api/teacher/auth', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password }) })
      const result = (await response.json()) as { error?: string }
      if (!response.ok) throw new Error(result.error || 'ログインに失敗しました。')
      setPassword(''); await load()
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'ログインに失敗しました。') }
    finally { setBusy(false) }
  }
  async function logout() { await fetch('/api/teacher/auth', { method: 'DELETE' }); setAuthenticated(false); setData(null) }

  if (authenticated === null) return <main style={{ padding: 40, fontFamily: 'sans-serif' }}>先生用画面を確認しています…</main>
  if (!authenticated) return (
    <main style={{ minHeight: '100vh', padding: '56px 20px', background: '#f6f2e9', fontFamily: 'sans-serif' }}>
      <form onSubmit={login} style={{ maxWidth: 420, margin: '0 auto', padding: 30, borderRadius: 18, background: '#fff', boxShadow: '0 12px 34px rgba(60,45,20,.12)' }}>
        <h1 style={{ marginTop: 0 }}>先生用画面</h1><p style={{ color: '#665d4b' }}>先生用パスワードを入力してください。</p>
        <label style={{ display: 'grid', gap: 8, fontWeight: 700 }}>先生用パスワード<input type="password" value={password} onChange={(event) => setPassword(event.target.value)} required style={{ padding: 12, border: '1px solid #aa9b7c', borderRadius: 9, fontSize: 16 }} /></label>
        {error && <p role="alert" style={{ color: '#b42318' }}>{error}</p>}
        <button type="submit" disabled={busy} style={{ ...buttonStyle, width: '100%', marginTop: 20, color: '#fff', background: '#735b2e' }}>{busy ? '確認中…' : 'ログイン'}</button>
      </form>
    </main>
  )

  return (
    <main style={{ minHeight: '100vh', padding: 24, background: '#f6f2e9', color: '#241f16', fontFamily: 'sans-serif' }}>
      <header style={{ display: 'flex', justifyContent: 'space-between', gap: 14, alignItems: 'center', flexWrap: 'wrap', marginBottom: 20 }}>
        <div><h1 style={{ margin: 0 }}>先生への質問・感想</h1><p style={{ margin: '6px 0 0', color: '#665d4b' }}>全ルームの先生宛て投稿を3秒ごとに更新します。</p></div>
        <button onClick={logout} style={buttonStyle}>ログアウト</button>
      </header>
      <section style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'end', marginBottom: 18 }}>
        <label style={{ display: 'grid', gap: 6, minWidth: 280, fontWeight: 700 }}>授業回
          <select value={sessionId} onChange={(event) => { setSessionId(event.target.value); void load(event.target.value) }} style={{ padding: 10, border: '1px solid #aa9b7c', borderRadius: 8, background: '#fff' }}>
            {(data?.sessions || []).map((session) => <option key={session.id} value={session.id}>{session.isDevelopment ? '開発テスト' : `第${session.sessionNumber}回`}（{dateLabel(session.scheduledAt)}）</option>)}
          </select>
        </label>
        <button onClick={() => void load(sessionId)} style={buttonStyle}>今すぐ更新</button>
      </section>
      {error && <p role="alert" style={{ color: '#b42318' }}>{error}</p>}
      <section style={{ display: 'grid', gap: 12 }}>
        {data?.posts.length ? data.posts.map((post) => (
          <article key={post.id} style={{ padding: 16, border: '1px solid #d8c9aa', borderRadius: 12, background: '#fff' }}>
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', color: '#665d4b', fontSize: 14 }}><strong style={{ color: '#735b2e' }}>ルーム{post.roomLabel}</strong><strong>{post.authorDisplayName}</strong><time>{dateLabel(post.createdAt)}</time></div>
            <p style={{ margin: '9px 0 0', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', lineHeight: 1.65 }}>{post.message}</p>
          </article>
        )) : <p style={{ padding: 20, borderRadius: 12, background: '#fff' }}>まだ先生宛ての投稿はありません。</p>}
      </section>
    </main>
  )
}
