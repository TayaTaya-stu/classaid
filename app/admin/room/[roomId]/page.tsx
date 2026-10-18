'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'

type MonitorPost = { id: number; authorDisplayName: string; authorType: 'human' | 'ai'; message: string; audienceType: 'room' | 'teacher'; createdAt: string }
type MonitorData = { roomLabel: string; posts: MonitorPost[] }
function clock(value: string) { return new Intl.DateTimeFormat('ja-JP', { hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(new Date(value)) }

export default function AdminRoomMonitorPage() {
  const params = useParams(); const router = useRouter()
  const roomId = typeof params?.roomId === 'string' ? params.roomId : ''
  const [data, setData] = useState<MonitorData | null>(null)
  const [error, setError] = useState('')
  const [paused, setPaused] = useState(false)
  const endRef = useRef<HTMLDivElement>(null)

  const load = useCallback(async () => {
    if (!roomId) return
    try {
      const response = await fetch(`/api/admin/room-monitor?roomId=${encodeURIComponent(roomId)}`, { cache: 'no-store' })
      if (response.status === 401) { router.push('/admin'); return }
      const next = (await response.json()) as MonitorData & { error?: string }
      if (!response.ok) throw new Error(next.error || 'ルームを取得できませんでした。')
      setData(next); setError('')
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'ルームを取得できませんでした。') }
  }, [roomId, router])

  useEffect(() => { const timer = window.setTimeout(() => void load(), 0); return () => window.clearTimeout(timer) }, [load])
  useEffect(() => { if (paused) return; const timer = window.setInterval(() => void load(), 2500); return () => window.clearInterval(timer) }, [load, paused])
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: 'smooth' }) }, [data?.posts.length])

  return (
    <main style={{ minHeight: '100vh', padding: 20, background: '#eef3f7', color: '#17212b', fontFamily: 'sans-serif' }}>
      <header style={{ position: 'sticky', top: 0, zIndex: 2, display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap', padding: '14px 16px', marginBottom: 14, border: '1px solid #c7d3df', borderRadius: 12, background: '#fff' }}>
        <div><h1 style={{ margin: 0, fontSize: 24 }}>ルーム{data?.roomLabel || '…'}・閲覧専用</h1><span style={{ color: '#536273', fontSize: 13 }}>実験者の投稿操作はできません。</span></div>
        <div style={{ display: 'flex', gap: 8 }}><button onClick={() => setPaused((value) => !value)} style={{ padding: '9px 13px', border: '1px solid #7890a7', borderRadius: 8, background: paused ? '#fff1c9' : '#fff', fontWeight: 700 }}>{paused ? '自動更新を再開' : '自動更新を一時停止'}</button><button onClick={() => void load()} style={{ padding: '9px 13px', border: '1px solid #7890a7', borderRadius: 8, background: '#fff', fontWeight: 700 }}>更新</button></div>
      </header>
      {error && <p role="alert" style={{ color: '#b42318' }}>{error}</p>}
      <section style={{ display: 'grid', gap: 10, maxWidth: 900, margin: '0 auto' }}>
        {data?.posts.length ? data.posts.map((post) => <article key={post.id} style={{ padding: 14, border: `1px solid ${post.authorType === 'ai' ? '#aca4dc' : '#d5dee7'}`, borderRadius: 11, background: post.authorType === 'ai' ? '#f6f4ff' : '#fff' }}>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', fontSize: 13, color: '#536273' }}><strong style={{ color: '#17212b' }}>{post.authorDisplayName}</strong>{post.authorType === 'ai' && <span style={{ padding: '2px 7px', borderRadius: 99, background: '#6655c7', color: '#fff' }}>AI</span>}{post.audienceType === 'teacher' && <span style={{ padding: '2px 7px', borderRadius: 99, background: '#f4c96b', color: '#4b3810' }}>先生宛て</span>}<time>{clock(post.createdAt)}</time></div>
          <p style={{ margin: '8px 0 0', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', lineHeight: 1.6 }}>{post.message}</p>
        </article>) : <p style={{ padding: 18, background: '#fff', borderRadius: 11 }}>まだ投稿はありません。</p>}
        <div ref={endRef} />
      </section>
    </main>
  )
}
