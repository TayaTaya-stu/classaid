'use client'

import { type FormEvent, useEffect, useMemo, useRef, useState } from 'react'

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
    aiCondition: 'none' | 'standard' | 'damekko'
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

function conditionLabel(condition: 'none' | 'standard' | 'damekko') {
  if (condition === 'standard') return '標準AI'
  if (condition === 'damekko') return 'ダメっこAI'
  return 'AIなし'
}

export default function AdminSessionControl({ sessionId, control, onUpdated }: Props) {
  const [page, setPage] = useState(String(control.currentPage))
  const [pdf, setPdf] = useState<File | null>(null)
  const [busy, setBusy] = useState('')
  const [message, setMessage] = useState('')
  const [now, setNow] = useState<number | null>(null)
  const [selectedCandidates, setSelectedCandidates] = useState<Record<string, number>>({})
  const [editedMessages, setEditedMessages] = useState<Record<string, string>>({})
  const [audioStatus, setAudioStatus] = useState<'off' | 'starting' | 'recording' | 'error'>('off')
  const [audioError, setAudioError] = useState('')
  const recorderRef = useRef<MediaRecorder | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const audioChunksRef = useRef<Array<{ blob: Blob; capturedAt: number }>>([])
  const audioActiveRef = useRef(false)
  const segmentTimerRef = useRef<number | null>(null)
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

  useEffect(() => () => {
    audioActiveRef.current = false
    if (segmentTimerRef.current !== null) window.clearTimeout(segmentTimerRef.current)
    if (recorderRef.current?.state === 'recording') recorderRef.current.stop()
    streamRef.current?.getTracks().forEach((track) => track.stop())
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

  async function startAudioReference() {
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      setAudioStatus('error'); setAudioError('このブラウザでは音声参照を利用できません。'); return
    }
    setAudioStatus('starting'); setAudioError('')
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } })
      const preferred = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus']
        .find((type) => MediaRecorder.isTypeSupported(type))
      audioChunksRef.current = []
      audioActiveRef.current = true
      streamRef.current = stream

      const recordSegment = () => {
        if (!audioActiveRef.current) return
        const segmentParts: Blob[] = []
        const recorder = preferred ? new MediaRecorder(stream, { mimeType: preferred }) : new MediaRecorder(stream)
        recorderRef.current = recorder
        recorder.ondataavailable = (event) => { if (event.data.size) segmentParts.push(event.data) }
        recorder.onstop = () => {
          if (segmentParts.length) {
            const now = Date.now()
            audioChunksRef.current.push({ blob: new Blob(segmentParts, { type: recorder.mimeType || 'audio/webm' }), capturedAt: now })
            audioChunksRef.current = audioChunksRef.current.filter((chunk) => chunk.capturedAt >= now - 95_000)
          }
          if (audioActiveRef.current) recordSegment()
        }
        recorder.onerror = () => { setAudioStatus('error'); setAudioError('録音中にエラーが発生しました。') }
        recorder.start()
        segmentTimerRef.current = window.setTimeout(() => {
          if (recorder.state === 'recording') recorder.stop()
        }, 15_000)
      }
      recordSegment(); setAudioStatus('recording')
    } catch {
      setAudioStatus('error'); setAudioError('マイクを開始できませんでした。ブラウザのマイク許可を確認してください。')
    }
  }

  function stopAudioReference() {
    audioActiveRef.current = false
    if (segmentTimerRef.current !== null) window.clearTimeout(segmentTimerRef.current)
    if (recorderRef.current?.state === 'recording') recorderRef.current.stop()
    streamRef.current?.getTracks().forEach((track) => track.stop())
    recorderRef.current = null; streamRef.current = null; audioChunksRef.current = []
    setAudioStatus('off'); setAudioError('')
  }

  function recentAudioSegments(referenceTime: number) {
    const chunks = audioChunksRef.current.filter((chunk) => chunk.capturedAt >= referenceTime - 95_000)
    return chunks.map((chunk) => chunk.blob)
  }

  async function finishCurrentAudioSegment() {
    const recorder = recorderRef.current
    if (audioStatus !== 'recording' || !recorder || recorder.state !== 'recording') return
    await new Promise<void>((resolve) => {
      const fallback = window.setTimeout(resolve, 1_000)
      recorder.addEventListener('stop', () => { window.clearTimeout(fallback); resolve() }, { once: true })
      recorder.stop()
    })
  }

  async function generate(interventionId: string) {
    setBusy(`generate:${interventionId}`); setMessage('')
    try {
      const form = new FormData()
      form.append('interventionId', interventionId)
      await finishCurrentAudioSegment()
      const referenceTime = now ?? audioChunksRef.current.at(-1)?.capturedAt ?? 0
      const audioSegments = audioStatus === 'recording' ? recentAudioSegments(referenceTime) : []
      audioSegments.forEach((audio, index) => form.append('audio', audio, `recent-lecture-${index}.webm`))
      const response = await fetch('/api/admin/interventions/generate', {
        method: 'POST', body: form,
      })
      const data = (await response.json()) as { error?: string; audioUsed?: boolean; audioWarning?: string }
      if (!response.ok) throw new Error(data.error || '候補生成に失敗しました。')
      setMessage(data.audioUsed
        ? '直近音声・PDF・チャットを参照してAI候補を3件生成しました。'
        : `PDF・チャットを参照してAI候補を3件生成しました。${data.audioWarning ? ` ${data.audioWarning}` : ''}`)
      await onUpdated()
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

      <div style={{ padding: 14, marginBottom: 16, border: '1px solid #d8b15c', borderRadius: 10, background: '#fff8e7' }}>
        <strong>授業音声の参照（任意）</strong>
        <p style={{ margin: '7px 0', color: '#66552e', lineHeight: 1.55 }}>
          開始中は直近約90秒の音声だけをブラウザ内に保持し、候補生成時に文字起こしへ使用します。音声ファイル自体はデータベースへ保存しません。
        </p>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          {audioStatus === 'recording'
            ? <button type="button" onClick={stopAudioReference} style={{ ...actionButton, borderColor: '#b42318', color: '#b42318' }}>音声参照を停止</button>
            : <button type="button" onClick={() => void startAudioReference()} disabled={audioStatus === 'starting'} style={{ ...actionButton, background: '#735b2e', color: '#fff' }}>{audioStatus === 'starting' ? 'マイク確認中…' : '音声参照を開始'}</button>}
          <span style={{ fontWeight: 700, color: audioStatus === 'recording' ? '#16713c' : '#66552e' }}>
            {audioStatus === 'recording' ? '● 音声参照中' : '○ 音声参照なし'}
          </span>
        </div>
        {audioError && <p role="alert" style={{ color: '#b42318', marginBottom: 0 }}>{audioError}</p>}
      </div>

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
                      <span style={{ padding: '3px 8px', borderRadius: 999, background: slot.aiCondition === 'damekko' ? '#f4ddff' : '#dceafe', color: slot.aiCondition === 'damekko' ? '#70268f' : '#214f7b', fontWeight: 800 }}>
                        {conditionLabel(slot.aiCondition)}
                      </span>
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
