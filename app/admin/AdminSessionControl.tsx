'use client'

import { type FormEvent, useEffect, useState } from 'react'
import { supabase } from '@/lib/supabase'

export type SessionControlData = {
  status: string
  isLocked: boolean
  isCurrentTarget?: boolean
  pdfFilePath: string | null
  classStartedAt: string | null
  reactionConfig: {
    mode: 'off' | 'empathy' | 'lecture_bridge' | 'neutral'
    status: 'active' | 'stopped'
    projectionStatus?: 'active' | 'paused'
    isMockAi: boolean
    pipelineEnabled: boolean
    hasAiKey?: boolean
    demoProjectedAt?: string | null
    autoExpiredAt?: string | null
  }

}

type Props = {
  sessionId: string
  control: SessionControlData
  onUpdated: () => Promise<void>
}

export default function AdminSessionControl({ sessionId, control, onUpdated }: Props) {
  const [pdf, setPdf] = useState<File | null>(null)
  const [notionUrl, setNotionUrl] = useState('')
  const [materialText, setMaterialText] = useState('')
  const [materialTitle, setMaterialTitle] = useState('')
  const [busy, setBusy] = useState('')
  const [message, setMessage] = useState('')
  const actionButton = { padding: '9px 13px', border: '1px solid #7890a7', borderRadius: 8, background: '#fff', color: '#17324d', fontWeight: 700, cursor: 'pointer' } as const

  const isClassStarted = Boolean(control.classStartedAt)
  const classStartTime = control.classStartedAt ? new Date(control.classStartedAt).getTime() : null
  const expireTime = classStartTime ? classStartTime + 120 * 60 * 1000 : null

  const [isPastDeadline, setIsPastDeadline] = useState(false)
  useEffect(() => {
    if (!expireTime) return
    const checkExpiry = () => {
      setIsPastDeadline(Date.now() >= expireTime)
    }
    const timer = setInterval(checkExpiry, 10000)
    const timeout = setTimeout(checkExpiry, 0)
    return () => {
      clearInterval(timer)
      clearTimeout(timeout)
    }
  }, [expireTime])

  const isExpired = Boolean(control.reactionConfig?.autoExpiredAt || (expireTime ? isPastDeadline : false))

  async function uploadPdf(event: FormEvent) {
    event.preventDefault()
    if (!pdf) return
    setBusy('pdf'); setMessage('')
    try {
      const prepared=await fetch('/api/admin/materials',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'prepare',sessionId,name:pdf.name,size:pdf.size}),signal:AbortSignal.timeout(15000)})
      const ticket=await prepared.json()
      if(!prepared.ok)throw new Error(ticket.error||'アップロードを準備できません。')
      const {error:uploadError}=await supabase.storage.from('lecture-materials').uploadToSignedUrl(ticket.path,ticket.token,pdf,{contentType:'application/pdf'})
      if(uploadError)throw new Error('PDFのアップロードに失敗しました。')
      const response=await fetch('/api/admin/materials',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'register',sessionId,path:ticket.path}),signal:AbortSignal.timeout(60000)})
      const data=await response.json()
      if(!response.ok)throw new Error(data.error||'PDFの登録に失敗しました。')
      setMessage('PDF資料を登録しました。'); setPdf(null); await onUpdated()
    } catch (error) { setMessage(error instanceof Error ? error.message : 'PDFの登録に失敗しました。') }
    finally { setBusy('') }
  }

  async function sendAction(action: string, successMsg: string) {
    setBusy(action)
    setMessage('')
    try {
      const response = await fetch('/api/admin/session-control', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, sessionId }),
      })
      const data = (await response.json()) as { error?: string }
      if (!response.ok) throw new Error(data.error || '操作に失敗しました。')
      setMessage(successMsg)
      await onUpdated()
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '操作に失敗しました。')
    } finally {
      setBusy('')
    }
  }

  async function registerText(event: FormEvent) {
    event.preventDefault()
    if (busy || !materialText.trim()) return
    setBusy('text'); setMessage('')
    try {
      const response = await fetch('/api/admin/materials', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({action:'register_text',sessionId,url:notionUrl.trim(),title:materialTitle.trim(),text:materialText}),signal:AbortSignal.timeout(15000)})
      const data = await response.json()
      if (!response.ok) throw new Error(data.error || '本文を登録できませんでした。')
      setMessage(`「${data.title}」の本文${data.characterCount.toLocaleString()}文字を保存しました。`)
      await onUpdated()
    } catch(error) { setMessage(error instanceof Error ? error.message : '本文を登録できませんでした。') }
    finally { setBusy('') }
  }

  async function designateSession() {
    await sendAction('set_designated', 'この授業回を「今回使用する授業回」に指定しました。教授用アプリの初期表示に設定されます。')
  }

  return (
    <section style={{ marginTop: 20, marginBottom: 24, padding: 18, border: '1px solid #9db4c9', borderRadius: 14, background: '#fff' }}>
      <h2 style={{ marginTop: 0 }}>3. 資料と使用回の指定</h2>
      <p style={{ color: '#536273', marginBottom: 12 }}>
        資料は任意です。音声を主な根拠にし、資料は用語の照合に使います。準備した回を「今回使用する回」に指定してください。
      </p>

      <div style={{ display: 'grid', gap: 10, padding: '12px 14px', marginBottom: 14, border: '1px solid #b8a2dc', borderRadius: 10, background: '#f8f5ff' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <strong>授業指定</strong>
          {control.isCurrentTarget ? (
            <span style={{ fontSize: 13, color: '#136a3d', fontWeight: 700, padding: '5px 12px', background: '#e6f4ea', borderRadius: 6, border: '1px solid #a8dab5' }}>
              ★ 今回使用する指定回（教授用アプリで優先表示）
            </span>
          ) : (
            <button
              type="button"
              onClick={() => void designateSession()}
              disabled={Boolean(busy) || control.isLocked}
              style={{ ...actionButton, background: '#fff', borderColor: '#214f7b', color: '#214f7b', fontSize: 12 }}
            >
              {busy === 'set_designated' ? '指定中…' : 'この授業回を「今回使用する回」に指定'}
            </button>
          )}
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', paddingTop: 6, borderTop: '1px dashed #d0c2e8' }}>
          <strong>授業状態</strong>
          <span style={{fontSize:13,fontWeight:700,color:'#265e3d'}}>開始は教授アプリから行います</span>
          <span style={{ color: '#66557a', fontSize: 13 }}>
            {control.classStartedAt ? `開始時刻: ${new Date(control.classStartedAt).toLocaleTimeString('ja-JP')}（開始から120分で自動終了）` : '当日の開始操作で、投稿受付・音声・投影が一緒に動きます。'}
          </span>
        </div>

        {isClassStarted && !isExpired && (
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', paddingTop: 6, borderTop: '1px dashed #d0c2e8' }}>
            <span style={{ fontSize: 12, fontWeight: 700, color: '#4d3a66' }}>個別制御：</span>
            {control.reactionConfig?.mode !== 'off' && (
              <button
                type="button"
                onClick={() => void sendAction(control.reactionConfig?.status === 'stopped' ? 'resume_ai' : 'pause_ai', control.reactionConfig?.status === 'stopped' ? 'AIを再開しました。' : 'AIを一時停止しました。')}
                disabled={Boolean(busy)}
                style={{ ...actionButton, padding: '6px 10px', fontSize: 12, background: control.reactionConfig?.status === 'stopped' ? '#176b4d' : '#8c3d19', color: '#fff' }}
              >
                {control.reactionConfig?.status === 'stopped' ? 'AIを再開' : 'AIのみ停止'}
              </button>
            )}
            <button
              type="button"
              onClick={() => void sendAction(control.reactionConfig?.projectionStatus === 'paused' ? 'resume_projection' : 'pause_projection', control.reactionConfig?.projectionStatus === 'paused' ? '投影を再開しました。' : '投影を一時停止しました。')}
              disabled={Boolean(busy)}
              style={{ ...actionButton, padding: '6px 10px', fontSize: 12, background: control.reactionConfig?.projectionStatus === 'paused' ? '#176b4d' : '#8c3d19', color: '#fff' }}
            >
              {control.reactionConfig?.projectionStatus === 'paused' ? '投影を再開' : '投影のみ停止'}
            </button>
            {control.reactionConfig?.demoProjectedAt ? (
              <span style={{ fontSize: 12, color: '#176b4d', fontWeight: 700, padding: '4px 8px', background: '#e8f5ec', borderRadius: 6 }}>
                ✅ デモ実投影確認済み: {new Date(control.reactionConfig.demoProjectedAt).toLocaleTimeString('ja-JP')}（投影アプリの描画通知から記録）
              </span>
            ) : (
              <span style={{ fontSize: 11, color: '#6d624f', padding: '4px 8px', background: '#f5f0e6', borderRadius: 6 }}>
                ℹ️ デモ実投影: 未投影（投影アプリの「テスト表示」実行時に画面描画から自動記録）
              </span>
            )}
          </div>
        )}
      </div>

      <div style={{ display: 'flex', gap: 10, alignItems: 'stretch', flexWrap: 'wrap' }}>
        <form onSubmit={uploadPdf} style={{ padding: 12, background: '#f3f6f9', borderRadius: 10, flex: '1 1 300px', maxWidth: 500 }}>
          <strong>講義スライド・授業資料（PDF）</strong>
          <p style={{ margin: '5px 0 7px', fontSize: 12, overflowWrap: 'anywhere', color: '#445' }}>
            {control.pdfFilePath ? (/^(notion:|text:)/.test(control.pdfFilePath) ? '授業資料の本文を登録済み（PDFを登録すると置き換わります）' : `登録済み：${control.pdfFilePath.split('/').pop()}`) : '資料未登録（音声だけでも利用できます）'}
          </p>
          <div style={{ display: 'flex', gap: 7, alignItems: 'center', flexWrap: 'wrap' }}>
            <input type="file" accept="application/pdf,.pdf" onChange={(event) => setPdf(event.target.files?.[0] || null)} disabled={control.isLocked || isClassStarted} style={{ maxWidth: 260, fontSize: 12 }} />
            <button type="submit" disabled={!pdf || Boolean(busy) || control.isLocked || isClassStarted} style={{ ...actionButton, padding: '7px 12px' }}>
              {busy === 'pdf' ? '登録中…' : 'PDFを登録'}
            </button>
          </div>
        </form>
        <form onSubmit={registerText} style={{padding:12,background:'#f3f6f9',borderRadius:10,flex:'1 1 300px',maxWidth:500}}>
          <strong>授業資料（本文を貼り付けて登録）</strong>
          <p style={{fontSize:12,color:'#445'}}>Notionで授業に使う文章をコピーし、下の欄へ貼り付けてください。登録すると、この授業回の資料を置き換えます。</p>
          <label style={{display:'block',fontSize:12}}>資料名（任意）
            <input value={materialTitle} maxLength={100} onChange={event=>setMaterialTitle(event.target.value)} placeholder="第5回 アート×IT" disabled={Boolean(busy)||control.isLocked||isClassStarted} style={{display:'block',width:'100%',boxSizing:'border-box',margin:'5px 0 8px',padding:8}} />
          </label>
          <label style={{display:'block',fontSize:12}}>Notionの元URL（任意・出典の記録用）
            <input type="url" value={notionUrl} maxLength={2000} onChange={event=>setNotionUrl(event.target.value)} placeholder="https://www.notion.so/…" disabled={Boolean(busy)||control.isLocked||isClassStarted} style={{display:'block',width:'100%',boxSizing:'border-box',margin:'5px 0 8px',padding:8}} />
          </label>
          <label style={{display:'block',fontSize:12}}>授業資料の本文
            <textarea value={materialText} onChange={event=>setMaterialText(event.target.value)} maxLength={200000} rows={9} required disabled={Boolean(busy)||control.isLocked||isClassStarted} placeholder="授業に使う文章をここに貼り付け" style={{display:'block',width:'100%',boxSizing:'border-box',margin:'5px 0',padding:8,resize:'vertical'}} />
          </label>
          <p style={{fontSize:12,color:'#536273'}}>{materialText.length.toLocaleString()} / 200,000文字。貼り付けた範囲だけ保存します。画像・動画は対象外です。</p>
          <button type="submit" disabled={!materialText.trim()||Boolean(busy)||control.isLocked||isClassStarted} style={{...actionButton,padding:'7px 12px'}}>{busy==='text'?'保存中…':'本文を登録'}</button>
          <p style={{fontSize:12,color:'#536273'}}>URLへの自動アクセスは行いません。授業開始前に登録し、元資料を変更した場合は貼り付け直してください。</p>
        </form>
      </div>

      {message && <p role="status" style={{ fontWeight: 700, marginTop: 10, color: '#176b4d' }}>{message}</p>}
    </section>
  )
}
