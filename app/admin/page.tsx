'use client'

import { type FormEvent, useCallback, useEffect, useRef, useState } from 'react'
import ClassStatus from './ClassStatus'
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

function getCurrentJstDateTimeLocal(): string {
  const now = new Date()
  const formatter = new Intl.DateTimeFormat('ja-JP', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
  const parts = formatter.formatToParts(now)
  const getPart = (type: string) => parts.find((p) => p.type === type)?.value || ''
  const year = getPart('year')
  const month = getPart('month')
  const day = getPart('day')
  let hour = getPart('hour')
  if (hour === '24') hour = '00'
  const minute = getPart('minute')
  return `${year}-${month}-${day}T${hour}:${minute}`
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
  const [showSessionCreator, setShowSessionCreator] = useState(false)
  const [newSessionNumber, setNewSessionNumber] = useState('1')
  const [newScheduledAt, setNewScheduledAt] = useState(getCurrentJstDateTimeLocal())
  const [newSessionIsDevelopment, setNewSessionIsDevelopment] = useState(true)
  const [isCreatingSession, setIsCreatingSession] = useState(false)
  const [createSessionMessage, setCreateSessionMessage] = useState('')
  const [reactionMode, setReactionMode] = useState<'off' | 'empathy' | 'lecture_bridge' | 'neutral'>('off')
  const [reactionConfigMessage, setReactionConfigMessage] = useState('')
  const [activeResearchTab, setActiveResearchTab] = useState<'none' | 'overview' | 'posts' | 'logs'>('none')
  const [researchData, setResearchData] = useState<unknown[] | null>(null)
  const [researchError,setResearchError]=useState('')
  const [researchHasMore,setResearchHasMore]=useState(false)
  const researchRequest=useRef(0)
  const dashboardRequest=useRef(0)
  const dashboardSelection=useRef('')
  const [isResearchLoading, setIsResearchLoading] = useState(false)

  const loadDashboard = useCallback(async (sessionId?: string, quiet = false) => {
    const request=++dashboardRequest.current
    if (!quiet) setIsLoading(true)
    try {
      const query = sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : ''
      const response = await fetch(`/api/admin/dashboard${query}`, { cache: 'no-store', signal:AbortSignal.timeout(10000) })
      if(request!==dashboardRequest.current)return
      if (response.status === 401) { setAuthenticated(false); setDashboard(null); return }
      const data = (await response.json()) as DashboardData & { error?: string }
      if(request!==dashboardRequest.current)return
      if (!response.ok) throw new Error(data.error || '管理画面の読み込みに失敗しました。')
      if(dashboardSelection.current!==(data.selectedSessionId||'')){
        dashboardSelection.current=data.selectedSessionId||'';researchRequest.current++;setResearchData(null);setResearchHasMore(false);setActiveResearchTab('none');setResearchError('')
      }
      setAuthenticated(true); setDashboard(data); setSelectedSessionId(data.selectedSessionId || ''); setLoadError('')
      const nextMode = data.sessionControl?.reactionConfig?.mode || 'off'
      const nextStatus = data.sessionControl?.reactionConfig?.status || 'active'
      const nextPipelineEnabled = Boolean(data.sessionControl?.reactionConfig?.pipelineEnabled)
      if (!quiet) setReactionMode(nextMode)
      if (nextStatus === 'stopped') {
        setReactionConfigMessage('返信AIは緊急停止中です（人間投稿のみ投影）。')
      } else if (nextPipelineEnabled) {
        setReactionConfigMessage('投稿ごとの自動返信投影が有効です。')
      }
    } catch (error) {
      if(request===dashboardRequest.current)setLoadError(error instanceof Error?error.message:'管理画面の読み込みに失敗しました。')
    } finally {
      if(request===dashboardRequest.current)setIsLoading(false)
    }
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

  async function updateReactionSettings() {
    if (!selectedSessionId) return
    try {
      const response = await fetch('/api/admin/session-control', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'set_reaction_mode',
          sessionId: selectedSessionId,
          mode: reactionMode,
        }),
      })
      const result = (await response.json()) as { error?: string }
      if (!response.ok) throw new Error(result.error || '返信AI設定の保存に失敗しました。')
      setReactionConfigMessage('自動返信モード設定を保存しました。')
      await loadDashboard(selectedSessionId)
    } catch (error) {
      setReactionConfigMessage(error instanceof Error ? error.message : '返信AI設定の保存に失敗しました。')
    }
  }

  async function emergencyStopReaction() {
    if (!selectedSessionId) return
    try {
      const response = await fetch('/api/admin/session-control', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'pause_ai', sessionId: selectedSessionId }),
      })
      const result = (await response.json()) as { error?: string }
      if (!response.ok) throw new Error(result.error || '緊急停止に失敗しました。')
      setReactionConfigMessage('AIと音声を一時停止しました。')
      await loadDashboard(selectedSessionId)
    } catch (error) {
      setReactionConfigMessage(error instanceof Error ? error.message : '緊急停止に失敗しました。')
    }
  }

  async function handleCreateSession(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setIsCreatingSession(true)
    setCreateSessionMessage('')

    const match = newScheduledAt.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/)
    if (!match) {
      setCreateSessionMessage('日時は年4桁・月2桁・日2桁（YYYY-MM-DDTHH:mm）で入力してください。')
      setIsCreatingSession(false)
      return
    }
    const [, yStr, mStr, dStr, hStr, minStr] = match
    const y = Number(yStr), m = Number(mStr), d = Number(dStr), h = Number(hStr), min = Number(minStr)
    if (y < 2020 || y > 2099 || m < 1 || m > 12 || d < 1 || d > 31 || h < 0 || h > 23 || min < 0 || min > 59) {
      setCreateSessionMessage('授業日時の数値範囲（年4桁: 2020-2099、月2桁: 01-12、日2桁: 01-31）を確認してください。')
      setIsCreatingSession(false)
      return
    }

    try {
      const response = await fetch('/api/admin/session-control', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'create_shared_session',
          sessionNumber: Number(newSessionNumber),
          scheduledAt: new Date(newScheduledAt).toISOString(),
          isDevelopment: newSessionIsDevelopment,
        }),
      })
      const data = (await response.json()) as { sessionId?: string; error?: string }
      if (!response.ok || !data.sessionId) throw new Error(data.error || '授業回の作成に失敗しました。')
      setShowSessionCreator(false)
      setCreateSessionMessage('新しい授業回を作成しました。今回使用する回に指定してください。')
      await loadDashboard(data.sessionId)
    } catch (error) {
      setCreateSessionMessage(error instanceof Error ? error.message : '授業回の作成に失敗しました。')
    } finally {
      setIsCreatingSession(false)
    }
  }

  async function loadResearchView(type:'overview'|'posts'|'logs',append=false) {
    const request=++researchRequest.current
    setActiveResearchTab(type);setIsResearchLoading(true);setResearchError('')
    try {
      const offset=append?(researchData||[]).length:0
      const res=await fetch(`/api/admin/research-views?type=${type}&sessionId=${encodeURIComponent(selectedSessionId)}&offset=${offset}`,{cache:'no-store',signal:AbortSignal.timeout(15000)})
      const json=await res.json()
      if(!res.ok)throw new Error(json.error||'取得に失敗しました。')
      if(request!==researchRequest.current)return
      setResearchData(current=>append?[...(current||[]),...json.data]:json.data)
      setResearchHasMore(Boolean(json.hasMore))
    }catch(error){if(request===researchRequest.current)setResearchError(error instanceof Error?error.message:'取得に失敗しました。')}
    finally{if(request===researchRequest.current)setIsResearchLoading(false)}
  }
  async function exportResearch() {
    if(activeResearchTab==='none')return
    setIsResearchLoading(true);setResearchError('')
    const type=activeResearchTab,sid=selectedSessionId
    try {
      const rows:Record<string,unknown>[]=[]
      let more=true
      while(more){
        const res=await fetch(`/api/admin/research-views?type=${type}&sessionId=${encodeURIComponent(sid)}&offset=${rows.length}`,{cache:'no-store',signal:AbortSignal.timeout(15000)})
        const json=await res.json();if(!res.ok)throw new Error(json.error||'出力に失敗しました。')
        rows.push(...json.data);more=Boolean(json.hasMore)
        if(more&&rows.length>=100000)throw new Error('10万件を超えます。授業回を分けて出力してください。')
      }
      const keys=Object.keys(rows[0]||{})
      const cell=(v:unknown)=>{let s=typeof v==='object'&&v!==null?JSON.stringify(v):String(v??'');if(/^[=+@\-]/.test(s))s="'"+s;return '"'+s.replaceAll('"','""')+'"'}
      const csv='\ufeff'+[keys.map(cell).join(','),...rows.map(row=>keys.map(k=>cell(row[k])).join(','))].join('\r\n')
      const url=URL.createObjectURL(new Blob([csv],{type:'text/csv;charset=utf-8'}));const a=document.createElement('a');a.href=url;a.download=`SupporTalk-${sid||"overview"}-${type}.csv`;a.click();URL.revokeObjectURL(url)
    }catch(error){setResearchError(error instanceof Error?error.message:'出力に失敗しました。')}
    finally{setIsResearchLoading(false)}
  }

  if (authenticated === null) return <main style={{ padding: 40, fontFamily: 'sans-serif' }}>管理画面を確認しています…</main>
  if (!authenticated) return (
    <main style={{ minHeight: '100vh', padding: '56px 20px', background: '#eef3f7', fontFamily: 'sans-serif' }}>
      <form onSubmit={handleLogin} style={{ maxWidth: 420, margin: '0 auto', padding: 30, borderRadius: 18, background: '#fff', boxShadow: '0 12px 34px rgba(20,35,55,.12)' }}>
        <h1 style={{ marginTop: 0 }}>SupporTalk 実験者用管理画面</h1>
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
    <main style={{ minHeight: '100vh', padding: '24px clamp(16px, 4vw, 48px)', maxWidth: 1180, margin: '0 auto', background: '#eef3f7', color: '#17212b', fontFamily: 'sans-serif' }}>
      <header style={{ display: 'flex', justifyContent: 'space-between', gap: 16, alignItems: 'center', flexWrap: 'wrap', marginBottom: 22 }}>
        <div><h1 style={{ margin: 0 }}>SupporTalk 実験者用管理画面</h1><p style={{ margin: '6px 0 0', color: '#536273' }}>授業回を準備し、AIと資料を設定してから、今回使う回を指定します。</p></div>
        <button onClick={handleLogout} style={buttonStyle}>ログアウト</button>
      </header>
      {dashboard?.sessionControl && <ClassStatus key={selectedSessionId} control={dashboard.sessionControl} />}
      <section style={{ padding: 18, borderRadius: 14, background: '#fff', border: '1px solid #c7d3df', marginBottom: 20 }}>
        <div style={{ display: 'flex', alignItems: 'end', gap: 12, flexWrap: 'wrap' }}>
          <label style={{ display: 'grid', gap: 6, minWidth: 280, fontWeight: 700 }}>1. 準備する授業回
            <select value={selectedSessionId} onChange={(event) => { setSelectedSessionId(event.target.value); void loadDashboard(event.target.value) }} style={{ padding: 10, border: '1px solid #9bacbd', borderRadius: 8, background: '#fff' }}>
              {(dashboard?.sessions || []).map((session) => <option key={session.id} value={session.id}>{sessionLabel(session)}</option>)}
            </select>
          </label>
          <button onClick={() => void loadDashboard(selectedSessionId)} disabled={isLoading} style={buttonStyle}>{isLoading ? '更新中…' : '今すぐ更新'}</button>
          <button onClick={() => { setShowSessionCreator((current) => !current); setNewScheduledAt(getCurrentJstDateTimeLocal()); setCreateSessionMessage('') }} style={{ ...buttonStyle, background: '#176b4d', color: '#fff', borderColor: '#176b4d' }}>
            {showSessionCreator ? '作成をやめる' : '新しい授業回を作成'}
          </button>
        </div>
        {showSessionCreator && (
          <form onSubmit={handleCreateSession} style={{ marginTop: 16, padding: 16, borderRadius: 10, background: '#f4faf7', border: '1px solid #a9cfbd', display: 'flex', gap: 12, alignItems: 'end', flexWrap: 'wrap' }}>
            <label style={{ display: 'grid', gap: 6, fontWeight: 700 }}>授業回
              <input type="number" min="0" max="999" required value={newSessionNumber} onChange={(event) => setNewSessionNumber(event.target.value)} style={{ padding: 10, width: 110, border: '1px solid #9bacbd', borderRadius: 8 }} />
            </label>
            <label style={{ display: 'grid', gap: 6, fontWeight: 700 }}>授業日時（日本時間: YYYY-MM-DDTHH:mm）
              <input type="datetime-local" min="2000-01-01T00:00" max="9999-12-31T23:59" required value={newScheduledAt} onChange={(event) => setNewScheduledAt(event.target.value)} style={{ padding: 10, border: '1px solid #9bacbd', borderRadius: 8 }} />
            </label>
            <label style={{ display: 'flex', gap: 7, alignItems: 'center', paddingBottom: 10, fontWeight: 700 }}>
              <input type="checkbox" checked={newSessionIsDevelopment} onChange={(event) => setNewSessionIsDevelopment(event.target.checked)} />
              試運転（主分析から除外）
            </label>
            <button type="submit" disabled={isCreatingSession} style={{ ...buttonStyle, background: '#176b4d', color: '#fff', borderColor: '#176b4d' }}>
              {isCreatingSession ? '作成中…' : '授業回を作成'}
            </button>
          </form>
        )}
        {createSessionMessage && <p role="status" style={{ color: createSessionMessage.includes('作成しました') ? '#176b4d' : '#b42318', fontWeight: 700 }}>{createSessionMessage}</p>}
        {loadError && <p role="alert" style={{ color: '#b42318' }}>{loadError}</p>}
      </section>
      {dashboard?.sharedWall && (
        <section style={{ padding: 18, borderRadius: 14, background: '#e8f6ff', border: '1px solid #82b9d8', marginBottom: 20 }}>
          <h2 style={{ marginTop: 0 }}>授業への入口</h2>
          <p style={{ color: '#365b70', marginBottom: 6 }}>
            授業開始・QR表示・コメント投影は教授アプリから操作します。
          </p>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            <a href={`supportalk://open?screenUrl=${encodeURIComponent(`${typeof window !== 'undefined' ? window.location.origin : ''}/screen/${dashboard.sharedWall.screenSlug}`)}`} target="_blank" rel="noreferrer" style={{ ...buttonStyle, background: '#135f89', color: '#fff', textDecoration: 'none' }}>教授アプリを開く ↗</a>
            <a href={`/enter/${dashboard.sharedWall.entrySlug}`} target="_blank" rel="noreferrer" style={{ ...buttonStyle, textDecoration: 'none' }}>学生入室画面を確認</a>
            {(dashboard?.rooms || []).length > 0 && (
              <a href={`/admin/room/${dashboard!.rooms[0].id}`} target="_blank" rel="noreferrer" style={{ ...buttonStyle, background: '#fff', borderColor: '#4f7894', textDecoration: 'none' }}>共有ルームの投稿を確認</a>
            )}
          </div>
        </section>
      )}
      {dashboard?.sessionControl && selectedSessionId && (
        <>


          <section style={{ padding: 18, borderRadius: 14, background: '#f7f9fb', border: '1px solid #c7d3df', marginTop: 20 }}>
            <h2 style={{ marginTop: 0 }}>2. AIの設定</h2>
            
            {dashboard.sessionControl.reactionConfig.mode !== 'off' && (
              dashboard.sessionControl.reactionConfig.hasAiKey ? (
                <div style={{ padding: '8px 12px', borderRadius: 8, background: '#e6f4ea', border: '1px solid #a8dab5', color: '#137333', fontSize: 13, marginBottom: 12 }}>
                  AIキー設定済み。接続結果は実際の投稿で確認できます。
                </div>
              ) : (
                <div style={{ padding: '8px 12px', borderRadius: 8, background: '#fef7e0', border: '1px solid #f9ab00', color: '#b06000', fontSize: 13, marginBottom: 12 }}>
                  AIキー未設定。設定するまでは予備返信を使用します。
                </div>
              )
            )}

            <p style={{ margin: '0 0 12px' }}>
              現在のモード：<strong>{
                dashboard.sessionControl.reactionConfig.mode === 'off' ? 'AIなし' :
                dashboard.sessionControl.reactionConfig.mode === 'empathy' ? '共感' :
                dashboard.sessionControl.reactionConfig.mode === 'lecture_bridge' ? '授業接続' :
                dashboard.sessionControl.reactionConfig.mode === 'neutral' ? '中立' : dashboard.sessionControl.reactionConfig.mode
              }</strong> ／ 状態：<strong>{
                dashboard.sessionControl.reactionConfig.status === 'stopped' ? 'AI停止中（人間のみ投影）' :
                dashboard.sessionControl.classStartedAt ? '授業中（モード固定）' : '開始前'
              }</strong>
            </p>

            <div style={{ display: 'grid', gap: 12, maxWidth: 700 }}>
              <label style={{ display: 'grid', gap: 6, fontWeight: 700 }}>AI返信モードの選択
                <select disabled={Boolean(dashboard.sessionControl.classStartedAt) || dashboard.sessionControl.isLocked} value={reactionMode} onChange={(event) => setReactionMode(event.target.value as 'off' | 'empathy' | 'lecture_bridge' | 'neutral')} style={{ padding: 10, border: '1px solid #9bacbd', borderRadius: 8, background: '#fff' }}>
                  <option value="off">AIなし（人間投稿のみ投影）</option>
                  <option value="empathy">共感（気持ち・着眼点の受け止め）</option>
                  <option value="lecture_bridge">授業接続（講義内容・専門話題への関連付け）</option>
                  <option value="neutral">中立（短い言い換え）</option>
                </select>
              </label>

              <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
                <button type="button" disabled={Boolean(dashboard.sessionControl.classStartedAt) || dashboard.sessionControl.isLocked} onClick={() => void updateReactionSettings()} style={{ ...buttonStyle, background: '#214f7b', color: '#fff', borderColor: '#214f7b' }}>
                  設定を保存
                </button>
                <button type="button" disabled={!dashboard.sessionControl.classStartedAt || dashboard.sessionControl.reactionConfig.status === 'stopped'} onClick={() => void emergencyStopReaction()} style={{ ...buttonStyle, background: '#9f1239', color: '#fff', borderColor: '#9f1239' }}>
                  AIと音声を停止
                </button>
                {dashboard.sessionControl.classStartedAt && (
                  <span style={{ fontSize: 13, color: '#536273' }}>
                    ※開始後は実験の公平性のためモードを変更できません（停止と再開は可能）。
                  </span>
                )}
              </div>
            </div>

            {reactionConfigMessage && <p role="status" style={{ color: '#1f5b53', marginTop: 12, fontWeight: 700 }}>{reactionConfigMessage}</p>}
          </section>

          <AdminSessionControl key={selectedSessionId}
            sessionId={selectedSessionId}
            control={dashboard.sessionControl}
            onUpdated={async () => { await loadDashboard(selectedSessionId) }}
          />
        </>
      )}

      <section style={{ padding: 18, borderRadius: 14, background: '#fff', border: '1px solid #c7d3df', marginTop: 20 }}>
        <h2 style={{ marginTop: 0 }}>4. ログ・分析</h2>
        <p style={{ color: '#536273', marginBottom: 12 }}>
          授業回を選んで記録を確認し、CSVで保存できます。学生には表示されません。
        </p>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 14 }}>
          <button
            type="button"
            onClick={() => void loadResearchView('overview')}
            style={{ ...buttonStyle, background: activeResearchTab === 'overview' ? '#17324d' : '#fff', color: activeResearchTab === 'overview' ? '#fff' : '#17324d' }}
          >
授業回の集計
          </button>
          <button
            type="button"
            onClick={() => void loadResearchView('posts')}
            style={{ ...buttonStyle, background: activeResearchTab === 'posts' ? '#17324d' : '#fff', color: activeResearchTab === 'posts' ? '#fff' : '#17324d' }}
          >
投稿とAI返信
          </button>
          <button
            type="button"
            onClick={() => void loadResearchView('logs')}
            style={{ ...buttonStyle, background: activeResearchTab === 'logs' ? '#17324d' : '#fff', color: activeResearchTab === 'logs' ? '#fff' : '#17324d' }}
          >
参加・操作ログ
          </button>
        </div>

        <p style={{fontSize:12}}>研究集計は同意済みの主分析対象です。非同意・開始後入室・試運転を含む運用記録とは区別します。</p>
        {researchError && <p role="alert" style={{color:'#b42318'}}>{researchError}</p>}
        {activeResearchTab!=='none' && <button type="button" disabled={isResearchLoading} onClick={()=>void exportResearch()} style={buttonStyle}>全件CSVを保存</button>}
        {researchHasMore && activeResearchTab!=='none' && <button type="button" disabled={isResearchLoading} onClick={()=>void loadResearchView(activeResearchTab,true)} style={buttonStyle}>続きを表示</button>}
        {isResearchLoading && <p style={{ color: '#66557a' }}>ビューデータを読み込み中…</p>}
        {!isResearchLoading && activeResearchTab !== 'none' && researchData && (
          <div style={{ overflowX: 'auto', maxHeight: 400, border: '1px solid #d0d7de', borderRadius: 8 }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
              <thead>
                <tr style={{ background: '#f6f8fa', borderBottom: '2px solid #d0d7de' }}>
                  {researchData.length > 0 ? (
                    Object.keys(researchData[0] as object).map((key) => (
                      <th key={key} style={{ padding: '8px 10px', textAlign: 'left', whiteSpace: 'nowrap' }}>{key}</th>
                    ))
                  ) : (
                    <th style={{ padding: 10 }}>データなし</th>
                  )}
                </tr>
              </thead>
              <tbody>
                {researchData.map((row, idx) => (
                  <tr key={idx} style={{ borderBottom: '1px solid #eaeef2', background: idx % 2 === 0 ? '#fff' : '#fcfdfe' }}>
                    {Object.values(row as object).map((val, cIdx) => (
                      <td key={cIdx} style={{ padding: '6px 10px', whiteSpace: 'nowrap', maxWidth: 300, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                        {val === null || val === undefined ? '-' : typeof val === 'object' ? JSON.stringify(val) : String(val)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </main>
  )
}
