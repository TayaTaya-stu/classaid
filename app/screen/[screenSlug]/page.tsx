'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useParams } from 'next/navigation'
import Image from 'next/image'

type ScreenPost = {
  id: number
  authorDisplayName: string
  authorType: 'human' | 'ai'
  message: string
  audienceType: 'room' | 'teacher'
  createdAt: string
}

export default function SharedCommentScreen() {
  const params = useParams()
  const screenSlug = typeof params.screenSlug === 'string' ? params.screenSlug : ''
  const [posts, setPosts] = useState<ScreenPost[]>([])
  const [entryUrl, setEntryUrl] = useState('')
  const [error, setError] = useState('')
  const [closed, setClosed] = useState(false)
  const postsRef = useRef<ScreenPost[]>([])
  const feedEndRef = useRef<HTMLDivElement>(null)
  const inFlightRef = useRef(false)

  useEffect(() => { postsRef.current = posts }, [posts])

  const loadPosts = useCallback(async () => {
    if (!screenSlug || inFlightRef.current) return
    inFlightRef.current = true
    try {
      const latestId = postsRef.current.at(-1)?.id
      const query = latestId ? `?afterId=${latestId}` : ''
      const response = await fetch(`/api/screen/${encodeURIComponent(screenSlug)}/posts${query}`, { cache: 'no-store' })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error || 'コメントを取得できませんでした。')
      const incoming = (data.posts || []) as ScreenPost[]
      setPosts((current) => data.resultMode === 'delta'
        ? [...current, ...incoming.filter((post) => !current.some((item) => item.id === post.id))].slice(-100)
        : incoming)
      if (!entryUrl && data.entryPath) setEntryUrl(`${window.location.origin}${data.entryPath}`)
      setClosed(Boolean(data.isSessionClosed))
      setError('')
      if (incoming.length) window.setTimeout(() => feedEndRef.current?.scrollIntoView({ behavior: 'smooth' }), 60)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'コメントを取得できませんでした。')
    } finally {
      inFlightRef.current = false
    }
  }, [entryUrl, screenSlug])

  useEffect(() => {
    void loadPosts()
    const timer = window.setInterval(() => void loadPosts(), 3000)
    return () => window.clearInterval(timer)
  }, [loadPosts])

  return (
    <main className="min-h-screen bg-slate-950 text-white p-5 md:p-8">
      <div className="mx-auto grid max-w-[1800px] grid-cols-1 gap-6 lg:grid-cols-[1fr_280px]">
        <section className="min-w-0">
          <header className="mb-5 flex items-end justify-between gap-4 border-b border-slate-700 pb-4">
            <div>
              <p className="text-sm font-bold tracking-[0.2em] text-cyan-300">LIVE COMMENTS</p>
              <h1 className="text-3xl font-black md:text-5xl">みんなのコメント</h1>
            </div>
            <span className="rounded-full bg-emerald-500/20 px-4 py-2 font-bold text-emerald-300">
              {closed ? '授業終了' : '● 更新中'}
            </span>
          </header>

          {error && <p className="mb-4 rounded-xl bg-red-950 p-4 text-red-200">{error}</p>}
          <div className="grid gap-3">
            {posts.length === 0 && !error && <p className="py-24 text-center text-2xl text-slate-400">コメントを待っています</p>}
            {posts.map((post) => (
              <article key={post.id} className={`rounded-2xl border p-4 shadow-lg md:p-5 ${post.authorType === 'ai' ? 'border-indigo-400/50 bg-indigo-950/60' : post.audienceType === 'teacher' ? 'border-amber-400/60 bg-amber-950/50' : 'border-slate-700 bg-slate-900'}`}>
                <div className="mb-2 flex flex-wrap items-center gap-2 text-lg font-bold">
                  <span>{post.authorDisplayName}</span>
                  {post.authorType === 'ai' && <span className="rounded-full bg-indigo-500 px-2 py-0.5 text-xs">AI</span>}
                  {post.audienceType === 'teacher' && <span className="rounded-full bg-amber-400 px-2 py-0.5 text-xs text-slate-950">先生への質問・感想</span>}
                  <time className="ml-auto text-sm font-normal text-slate-400">{new Date(post.createdAt).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })}</time>
                </div>
                <p className="whitespace-pre-wrap break-words text-2xl font-medium leading-relaxed md:text-3xl">{post.message}</p>
              </article>
            ))}
            <div ref={feedEndRef} />
          </div>
        </section>

        <aside className="h-fit rounded-2xl bg-white p-5 text-center text-slate-900 lg:sticky lg:top-8">
          <h2 className="text-xl font-black">スマホから参加</h2>
          <p className="mt-1 text-sm text-slate-600">QRコードを読み取ってください</p>
          {entryUrl && <Image className="mx-auto my-4 aspect-square w-full max-w-[240px]" src={`/api/screen/qr?target=${encodeURIComponent(entryUrl)}`} width={240} height={240} unoptimized alt="学生入室用QRコード" />}
          <p className="break-all text-xs text-slate-500">{entryUrl}</p>
        </aside>
      </div>
    </main>
  )
}
