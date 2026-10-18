'use client'

import { type FormEvent, useEffect, useMemo, useState } from 'react'

export type SessionControlData = {
  status: string
  isLocked: boolean
  pdfFilePath: string | null
  currentPage: number
  interventionStartedAt: string | null
  cycleCount: number
  cycleDurationMinutes: number
  slotMinutes: number[]
  cycles: Array<{ id: string; cycleNumber: number; status: string; startedAt: string | null; endedAt: string | null }>
  interventions: Array<{
    id: string
    cycleId: string
    roomId: string
    roomLabel: string
    slotIndex: number
    scheduledAt: string
    status: string
    plannedMessageType: string | null
    latestAttempt: { id: string; attemptIndex: number; candidates: string[] } | null
  }>
}

type Props = {
  sessionId: string
  control: SessionControlData
  onUpdated: () => Promise<void>
}

function formatClock(value: string) {
  return new Intl.DateTimeFormat('ja-JP', { hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(new Date(value))
}

export default function AdminSessionControl({ sessionId, control, onUpdated }: Props) {
  const [page, setPage] = useState(String(control.currentPage))
  const [pdf, setPdf] = useState<File | null>(null)
  const [busy, setBusy] = useState('')
  const [message, setMessage] = useState('')
  const [now, setNow] = useState<number | null>(null)
  const [selectedCandidates, setSelectedCandidates] = useState<Record<string, number>>({})
  const [editedMessages, setEditedMessages] = useState<Record<string, string>>({})
  const actionButton = { padding: '9px 13px', border: '1px solid #7890a7', borderRadius: 8, background: '#fff', color: '#17324d', fontWeight: 700, cursor: 'pointer' } as const

  useEffect(() => {
    const updateClock = () => setNow(Date.now())
    const initialTimer = window.setTimeout(updateClock, 0)
    const timer = window.setInterval(updateClock, 1000)
    return () => {
      window.clearTimeout(initialTimer)
      window.clearInterval(timer)
    }
  }, [])

  const elapsedMinutes = useMemo(() => control.interventionStartedAt && now !== null
    ? Math.max(0, (now - new Date(control.interventionStartedAt).getTime()) / 60_000)
    : 0, [control.interventionStartedAt, now])
  const currentCycle = control.interventionStartedAt
    ? Math.min(control.cycleCount, Math.floor(elapsedMinutes / control.cycleDurationMinutes) + 1)
    : null

  async function request(body: Record<string, unknown>) {
    const response = await fetch('/api/admin/session-control', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    })
    const data = (await response.json()) as { error?: string }
    if (!response.ok) throw new Error(data.error || '操作に失敗しました。')
  }

  async function uploadPdf(event: FormEvent) {
    event.preventDefault()
    if (!pdf) return
    setBusy('pdf'); setMessage('')
    try {
      const form = new FormData()
      form.append('sessionId', sessionId); form.append('file', pdf)
      const response = await fetch('/api/admin/session-control', { method: 'POST', body: form })
      const data = (await response.json()) as { error?: string }
      if (!response.ok) throw new Error(data.error || 'PDFの登録に失敗しました。')
      setMessage('PDFを登録しました。'); setPdf(null); await onUpdated()
    } catch (error) { setMessage(error instanceof Error ? error.message : 'PDFの登録に失敗しました。') }
    finally { setBusy('') }
  }

  async function savePage() {
    setBusy('page'); setMessage('')
    try {
      await request({ action: 'set_page', sessionId, currentPage: Number(page) })
      setMessage(`現在ページを${Number(page)}ページに更新しました。`); await onUpdated()
    } catch (error) { setMessage(error instanceof Error ? error.message : 'ページの更新に失敗しました。') }
    finally { setBusy('') }
  }

  async function startProtocol() {
    if (!window.confirm('20分×3サイクルを開始します。開始後は予定時刻を作り直せません。開始しますか？')) return
    setBusy('start'); setMessage('')
    try {
      await request({ action: 'start_protocol', sessionId })
      setMessage('授業サイクルを開始しました。'); await onUpdated()
    } catch (error) { setMessage(error instanceof Error ? error.message : '開始に失敗しました。') }
    finally { setBusy('') }
  }

  async function generate(interventionId: string) {
    setBusy(`generate:${interventionId}`); setMessage('')
    try {
      const response = await fetch('/api/admin/interventions/generate', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ interventionId }),
      })
      const data = (await response.json()) as { error?: string }
      if (!response.ok) throw new Error(data.error || '候補生成に失敗しました。')
      setMessage('AI候補を3件生成しました。'); await onUpdated()
    } catch (error) { setMessage(error instanceof Error ? error.message : '候補生成に失敗しました。') }
    finally { setBusy('') }
  }

  async function approve(intervention: SessionControlData['interventions'][number]) {
    if (!intervention.latestAttempt) return
    const candidateIndex = selectedCandidates[intervention.id] ?? 0
    const original = intervention.latestAttempt.candidates[candidateIndex] || ''
    const finalMessage = editedMessages[intervention.id] ?? original
    if (!window.confirm(`この内容をルーム${intervention.roomLabel}へ投稿しますか？\n\n${finalMessage}`)) return
    setBusy(`approve:${intervention.id}`); setMessage('')
    try {
      const response = await fetch('/api/admin/interventions/approve', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ interventionId: intervention.id, attemptId: intervention.latestAttempt.id, candidateIndex, finalMessage }),
      })
      const data = (await response.json()) as { error?: string }
      if (!response.ok) throw new Error(data.error || '投稿に失敗しました。')
      setMessage(`ルーム${intervention.roomLabel}へ学生AIとして投稿しました。`); await onUpdated()
    } catch (error) { setMessage(error instanceof Error ? error.message : '投稿に失敗しました。') }
    finally { setBusy('') }
  }

  const grouped = control.cycles.map((cycle) => ({
    ...cycle,
    slots: control.interventions.filter((item) => item.cycleId === cycle.id),
  }))

  return (
    <section style={{ marginBottom: 24, padding: 18, border: '1px solid #9db4c9', borderRadius: 14, background: '#fff' }}>
      <h2 style={{ marginTop: 0 }}>授業進行コントロール</h2>
      <p style={{ color: '#536273' }}>PDFと現在ページはA・B・Cすべてのルームに共通です。</p>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 16 }}>
        <form onSubmit={uploadPdf} style={{ padding: 14, background: '#f3f6f9', borderRadius: 10 }}>
          <strong>授業PDF</strong>
          <p style={{ fontSize: 13, overflowWrap: 'anywhere' }}>{control.pdfFilePath ? `登録済み：${control.pdfFilePath.split('/').pop()}` : '未登録'}</p>
          <input type="file" accept="application/pdf,.pdf" onChange={(event) => setPdf(event.target.files?.[0] || null)} disabled={control.isLocked} />
          <button type="submit" disabled={!pdf || Boolean(busy) || control.isLocked} style={{ ...actionButton, display: 'block', marginTop: 10 }}>
            {busy === 'pdf' ? '登録中…' : 'PDFを登録'}
          </button>
        </form>

        <div style={{ padding: 14, background: '#f3f6f9', borderRadius: 10 }}>
          <strong>現在の授業ページ</strong>
          <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
            <input type="number" min={1} max={9999} value={page} onChange={(event) => setPage(event.target.value)} style={{ width: 90, padding: 8 }} />
            <button onClick={savePage} disabled={Boolean(busy) || control.isLocked} style={actionButton}>{busy === 'page' ? '更新中…' : '更新'}</button>
          </div>
        </div>

        <div style={{ padding: 14, background: '#edf6ed', borderRadius: 10 }}>
          <strong>介入サイクル</strong>
          <p>{control.interventionStartedAt ? `開始：${formatClock(control.interventionStartedAt)}` : '未開始'}</p>
          {control.interventionStartedAt
            ? <p>経過 約{Math.floor(elapsedMinutes)}分／現在サイクル {currentCycle}</p>
            : <button onClick={startProtocol} disabled={Boolean(busy) || control.isLocked} style={{ ...actionButton, background: '#265e3d', color: '#fff' }}>{busy === 'start' ? '開始中…' : '20分×3サイクルを開始'}</button>}
        </div>
      </div>

      {message && <p role="status" style={{ fontWeight: 700 }}>{message}</p>}

      {control.interventionStartedAt && grouped.length > 0 && (
        <div style={{ display: 'grid', gap: 10, marginTop: 16 }}>
          {grouped.map((cycle) => (
            <div key={cycle.id} style={{ padding: 12, border: '1px solid #dbe2ea', borderRadius: 10 }}>
              <strong>サイクル{cycle.cycleNumber}</strong>
              <div style={{ display: 'grid', gap: 8, marginTop: 8 }}>
                {cycle.slots.map((slot) => (
                  <div key={slot.id} style={{ padding: 10, borderRadius: 10, background: slot.status === 'posted' ? '#d8f2dc' : '#e8edf3', fontSize: 13 }}>
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                      <strong>ルーム{slot.roomLabel}・枠{slot.slotIndex}</strong>
                      <span>{formatClock(slot.scheduledAt)}</span>
                      <span>{slot.plannedMessageType}</span>
                      <span>{slot.status}</span>
                      {slot.status !== 'posted' && (
                        <button onClick={() => void generate(slot.id)} disabled={Boolean(busy)} style={actionButton}>
                          {busy === `generate:${slot.id}` ? '生成中…' : slot.latestAttempt ? '再生成' : '候補を生成'}
                        </button>
                      )}
                    </div>
                    {slot.latestAttempt && slot.status !== 'posted' && (
                      <div style={{ display: 'grid', gap: 8, marginTop: 10 }}>
                        {slot.latestAttempt.candidates.map((candidate, index) => (
                          <label key={`${slot.latestAttempt?.id}-${index}`} style={{ display: 'flex', gap: 8, alignItems: 'start' }}>
                            <input
                              type="radio"
                              name={`candidate-${slot.id}`}
                              checked={(selectedCandidates[slot.id] ?? 0) === index}
                              onChange={() => {
                                setSelectedCandidates((current) => ({ ...current, [slot.id]: index }))
                                setEditedMessages((current) => ({ ...current, [slot.id]: candidate }))
                              }}
                            />
                            <span>{candidate}</span>
                          </label>
                        ))}
                        <textarea
                          maxLength={100}
                          value={editedMessages[slot.id] ?? slot.latestAttempt.candidates[selectedCandidates[slot.id] ?? 0] ?? ''}
                          onChange={(event) => setEditedMessages((current) => ({ ...current, [slot.id]: event.target.value }))}
                          style={{ width: '100%', minHeight: 58, padding: 8 }}
                        />
                        <button onClick={() => void approve(slot)} disabled={Boolean(busy)} style={{ ...actionButton, justifySelf: 'start', background: '#214f7b', color: '#fff' }}>
                          {busy === `approve:${slot.id}` ? '投稿中…' : '選択した候補を承認・投稿'}
                        </button>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  )
}
