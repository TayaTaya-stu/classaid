'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'

type Post = { id: number; authorDisplayName: string; authorType: 'human' | 'ai'; message: string; audienceType: 'room' | 'teacher'; createdAt: string }
type Data = { roomLabel: string; posts: Post[] }
function clock(value: string) { return new Intl.DateTimeFormat('ja-JP', { hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(new Date(value)) }

export default function TeacherRoomPage() {
  const params = useParams(); const router = useRouter()
  const roomId = typeof params?.roomId === 'string' ? params.roomId : ''
  const [data, setData] = useState<Data | null>(null); const [error, setError] = useState(''); const endRef = useRef<HTMLDivElement>(null)
  const load = useCallback(async () => {
    if (!roomId) return
    try {
      const response = await fetch(`/api/teacher/room-monitor?roomId=${encodeURIComponent(roomId)}`, { cache: 'no-store' })
      if (response.status === 401) { router.push('/teacher'); return }
      const next = (await response.json()) as Data & { error?: string }
      if (!response.ok) throw new Error(next.error || 'ルームを取得できませんでした。')
      setData(next); setError('')
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'ルームを取得できませんでした。') }
  }, [roomId, router])
  useEffect(() => { const initial = window.setTimeout(() => void load(), 0); const timer = window.setInterval(() => void load(), 2500); return () => { window.clearTimeout(initial); window.clearInterval(timer) } }, [load])
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: 'smooth' }) }, [data?.posts.length])
  return <main style={{ minHeight: '100vh', padding: 20, background: '#f6f2e9', fontFamily: 'sans-serif' }}>
    <header style={{ position: 'sticky', top: 0, zIndex: 2, padding: 15, marginBottom: 14, border: '1px solid #d8c9aa', borderRadius: 12, background: '#fff' }}><h1 style={{ margin: 0, fontSize: 24 }}>ルーム{data?.roomLabel || '…'}</h1><span style={{ color: '#665d4b', fontSize: 13 }}>先生用・閲覧専用</span></header>
    {error && <p role="alert" style={{ color: '#b42318' }}>{error}</p>}
    <section style={{ display: 'grid', gap: 10, maxWidth: 900, margin: '0 auto' }}>
      {data?.posts.length ? data.posts.map((post) => <article key={post.id} style={{ padding: 14, border: `1px solid ${post.authorType === 'ai' ? '#aca4dc' : '#ddd2bb'}`, borderRadius: 11, background: post.authorType === 'ai' ? '#f6f4ff' : '#fff' }}>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', fontSize: 13, color: '#665d4b' }}><strong>{post.authorDisplayName}</strong>{post.authorType === 'ai' && <span style={{ padding: '2px 7px', borderRadius: 99, background: '#6655c7', color: '#fff' }}>AI</span>}{post.audienceType === 'teacher' && <span style={{ padding: '2px 7px', borderRadius: 99, background: '#f4c96b' }}>先生宛て</span>}<time>{clock(post.createdAt)}</time></div>
        <p style={{ margin: '8px 0 0', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', lineHeight: 1.6 }}>{post.message}</p>
      </article>) : <p style={{ padding: 18, borderRadius: 11, background: '#fff' }}>まだ投稿はありません。</p>}
      <div ref={endRef} />
    </section>
  </main>
}
