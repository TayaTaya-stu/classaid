'use client'

import { useCallback, useEffect, useState } from 'react'
import { useParams } from 'next/navigation'
import Image from 'next/image'

export default function SharedEntryScreen() {
  const params = useParams()
  const screenSlug = typeof params.screenSlug === 'string' ? params.screenSlug : ''
  const [entryUrl, setEntryUrl] = useState('')
  const [error, setError] = useState('')
  const [closed, setClosed] = useState(false)

  const loadEntry = useCallback(async () => {
    if (!screenSlug) return
    try {
      const response = await fetch(`/api/screen/${encodeURIComponent(screenSlug)}/posts`, { cache: 'no-store' })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error || '入室情報を取得できませんでした。')
      if (data.entryPath) setEntryUrl(`${window.location.origin}${data.entryPath}`)
      setClosed(Boolean(data.isSessionClosed))
      setError('')
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '入室情報を取得できませんでした。')
    }
  }, [screenSlug])

  useEffect(() => {
    const timer = window.setTimeout(() => { void loadEntry() }, 0)
    return () => window.clearTimeout(timer)
  }, [loadEntry])

  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-950 p-5 text-white">
      <section className="w-full max-w-md rounded-3xl bg-white p-7 text-center text-slate-900 shadow-2xl">
        <p className="text-sm font-black tracking-[0.18em] text-cyan-700">CLASSROOM BACKCHANNEL</p>
        <h1 className="mt-2 text-3xl font-black">スマホから参加</h1>
        <p className="mt-2 text-slate-600">QRコードを読み取ってください</p>
        {error && <p className="mt-5 rounded-xl bg-red-50 p-4 text-red-700">{error}</p>}
        {closed && <p className="mt-5 rounded-xl bg-amber-50 p-4 font-bold text-amber-800">この授業回は終了しています。</p>}
        {entryUrl && !closed && (
          <>
            <Image className="mx-auto my-5 aspect-square w-full max-w-[300px]" src={`/api/screen/qr?target=${encodeURIComponent(entryUrl)}`} width={300} height={300} unoptimized alt="学生入室用QRコード" />
            <p className="break-all text-xs text-slate-500">{entryUrl}</p>
          </>
        )}
      </section>
    </main>
  )
}
