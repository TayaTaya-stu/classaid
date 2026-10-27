"use client"

import { useRef, useState } from 'react'

type Props = {
  sessionId: string
  label: string
  status: string
  isArchived: boolean
  isCurrentTarget: boolean
  classStartedAt: string | null
  onUpdated: () => Promise<void>
}
export default function AdminSessionOrganizer(props: Props) {
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const inFlight = useRef(false)
  const protectedSession = props.isCurrentTarget || props.status === 'in_progress'
  async function organize(action: 'archive' | 'restore' | 'delete_unused') {
    if (inFlight.current || protectedSession) return
    const description = action === 'delete_unused'
      ? '未使用の場合に限り、通常一覧・履歴・教授アプリからこの授業回を取り除きます。内部の作成履歴は保持します。記録がある回は削除されません。'
      : action === 'archive' ? '通常一覧と履歴の両方から隠します。記録は保持し、「非表示の回」から戻せます。' : '非表示を解除します。準備中の回は通常一覧、終了済みの回は履歴へ戻ります。'
    if (!window.confirm(`${props.label}（ID末尾: ${props.sessionId.slice(-8)}）\n${description}`)) return
    inFlight.current = true; setBusy(true); setMessage('')
    try {
      const res = await fetch('/api/admin/session-organization', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: props.sessionId, action, confirmation: action === 'delete_unused' ? 'delete-unused' : undefined }), signal: AbortSignal.timeout(15000) })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error || '整理を保存できませんでした。')
      setMessage(action === 'delete_unused' ? '未使用の授業回を削除しました。' : action === 'archive' ? '記録を保持して非表示にしました。' : '非表示を解除しました。')
      await props.onUpdated()
    } catch (error) { setMessage(error instanceof Error ? error.message : '整理を保存できませんでした。') }
    finally { inFlight.current = false; setBusy(false) }
  }
  const button = { padding: '8px 12px', borderRadius: 8, border: '1px solid #7890a7', background: '#fff', cursor: 'pointer' } as const
  return <section aria-label="授業回の整理" style={{ marginTop: 14, padding: 14, border: '1px solid #c7d3df', borderRadius: 10, background: '#f8fafc' }}>
    <strong>この授業回を整理</strong>
    <p style={{ fontSize: 12, color: '#536273' }}>不要な回は非表示にできます。記録は保持し、「非表示の回」から戻せます。一覧から削除できるのは、開始・参加・投稿・音声・資料などの記録がない回だけです。</p>
    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
      <button type="button" disabled={busy || protectedSession} onClick={() => void organize(props.isArchived ? 'restore' : 'archive')} style={button}>{props.isArchived ? '非表示を解除する' : '非表示にする（記録は保持）'}</button>
      <button type="button" disabled={busy || protectedSession || Boolean(props.classStartedAt)} onClick={() => void organize('delete_unused')} style={{ ...button, color: '#a52222', borderColor: '#c58b8b' }}>未使用の回を削除</button>
    </div>
    {protectedSession && <p style={{ fontSize: 12 }}>授業中・今回指定中の回は整理できません。終了後、別の回を今回使用する回に指定してください。</p>}
    {busy && <p role="status">保存中…</p>}
    {message && <p role="status">{message}</p>}
  </section>
}
