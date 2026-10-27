const $ = (id) => document.getElementById(id)
const api = window.classroomOverlay

// 状態管理
let preparedSessions = []
let currentSession = null
let isClassRunning = false
let isAiPaused = false
let isProjectionPaused = false
let isQrVisible = false

// 録音状態
let isAudioActive = false
let audioFailed = false
let projectionFailed = false
let audioStarting = false
let audioFailures = 0
let actionBusy = false

// 120分タイマー
let countdownInterval = null

// AIモードのラベルとCSSクラス
function getAiModeInfo(mode) {
  switch (mode) {
    case 'empathy':
      return { label: 'AI返信あり (共感・受容的)', badgeClass: 'badge-blue', isOff: false }
    case 'lecture_bridge':
      return { label: 'AI返信あり (講義接続・問いかけ)', badgeClass: 'badge-teal', isOff: false }
    case 'neutral':
      return { label: 'AI返信あり (標準・中立)', badgeClass: 'badge-cyan', isOff: false }
    case 'off':
    default:
      return { label: 'AI返信なし (音声・投影のみ)', badgeClass: 'badge-gray', isOff: true }
  }
}

function formatDate(isoStr) {
  if (!isoStr) return '日時未設定'
  try {
    const d = new Date(isoStr)
    const month = d.getMonth() + 1
    const date = d.getDate()
    const hours = String(d.getHours()).padStart(2, '0')
    const mins = String(d.getMinutes()).padStart(2, '0')
    return `${month}月${date}日 ${hours}:${mins}`
  } catch {
    return isoStr
  }
}

// フォーム設定取得（投影用）
function formConfig() {
  return {
    screenUrl: $('screenUrl').value.trim(),
    displayId: $('displayId').value,
    durationSeconds: Number($('durationSeconds').value) || 12,
    fontScale: Number($('fontScale').value) || 1,
  }
}

// ステータス表示の更新
function updateStatusUI() {
  if ($('btnAudioCheck')) $('btnAudioCheck').disabled = actionBusy || isClassRunning || audioStarting || isAudioActive || Boolean(audioCheck?.active)
  const dot = $('dotOverall')
  const statusText = $('statusText')
  const pillAi = $('pillAi')
  const pillAudio = $('pillAudio')
  const pillProj = $('pillProj')

  const aiInfo = getAiModeInfo(currentSession?.reactionAiMode || currentSession?.reactionMode)
  const classAfter = currentSession?.classStartedAt && Date.now() >= Date.parse(currentSession.classStartedAt) + 95 * 60000
  const classExpired = Boolean(currentSession?.classStartedAt) && Date.now() >= Date.parse(currentSession.classStartedAt) + 120 * 60000
  const classEnded = classExpired || currentSession?.autoExpiredAt || ['completed','closed','locked'].includes(currentSession?.status)
  $('classStateBadge').textContent = classEnded ? '終了' : isClassRunning ? classAfter ? '授業後' : '授業中' : '開始前'
  $('classStateBadge').classList.toggle('class-state-active', !classEnded && isClassRunning)
  $('classStateBadge').classList.toggle('class-state-ended', Boolean(classEnded))

  // Derive the start button from the currently selected class on every render.
  // endClass() may have left its old completion text in the same DOM element.
  if (!isClassRunning) {
    const button = $('btnStartClass')
    button.querySelector('.btn-start-title').textContent = classEnded ? (classExpired ? '授業終了（120分経過）' : '授業終了') : '授業を開始する'
    button.querySelector('.btn-start-subtitle').textContent = classEnded ? 'この授業回は完了しました' : '（設定済みAI・音声取得・透明投影を連動開始）'
    button.disabled = actionBusy || !currentSession || Boolean(classEnded)
    dot.className = 'dot dot-idle'
    const ended = classEnded
    statusText.textContent = ended ? '授業終了' : '未開始（授業回を確認して「授業を開始する」を押してください）'
    pillAi.className = 'pill'
    pillAi.textContent = ended ? 'AI: 停止中' : 'AI: 待機中'
    pillAudio.className = 'pill'
    pillAudio.textContent = ended ? '音声: 停止中' : '音声: 待機中'
    pillProj.className = 'pill'
    pillProj.textContent = ended ? '投影: 停止中' : '投影: 待機中'
    return
  }

  // 授業進行中のステータス判定
  if (audioFailed && projectionFailed) {
    dot.className = 'dot dot-error'
    statusText.textContent = '⚠️ 音声と投影の起動に失敗しました（個別再試行可能）'
  } else if (audioFailed) {
    dot.className = 'dot dot-paused'
    statusText.textContent = '⚠️ マイク取得のみ未完了（チャット・投影は稼働中）'
  } else if (projectionFailed) {
    dot.className = 'dot dot-paused'
    statusText.textContent = '⚠️ 投影のみ未完了（再試行可能）'
  } else if (audioStarting) {
    dot.className = 'dot dot-paused'
    statusText.textContent = '音声の起動を確認中です（マイクの使用を許可してください）'
  } else {
    dot.className = 'dot dot-active'
    statusText.textContent = classAfter ? '授業後（システム稼働中）' : '授業実施中（正常稼働中）'
  }

  // AIステータス
  if (aiInfo.isOff) {
    pillAi.className = 'pill'
    pillAi.textContent = 'AI: 条件OFF'
  } else if (isAiPaused) {
    pillAi.className = 'pill pill-paused'
    pillAi.textContent = 'AI: 一時停止中'
  } else {
    pillAi.className = 'pill pill-active'
    pillAi.textContent = 'AI: 稼働中'
  }

  // 音声ステータス
  if (audioFailed) {
    pillAudio.className = 'pill pill-error'
    pillAudio.textContent = '音声: エラー'
  } else if (audioStarting) {
    pillAudio.className = 'pill'
    pillAudio.textContent = '音声: マイク許可・起動を確認中'
  } else if (isAudioActive) {
    pillAudio.className = 'pill pill-active'
    pillAudio.textContent = '音声: 取得中'
  } else {
    pillAudio.className = 'pill pill-paused'
    pillAudio.textContent = '音声: 停止中'
  }

  // 投影ステータス
  if (projectionFailed) {
    pillProj.className = 'pill pill-error'
    pillProj.textContent = '投影: エラー'
  } else if (isProjectionPaused) {
    pillProj.className = 'pill pill-paused'
    pillProj.textContent = '投影: 一時停止中'
  } else {
    pillProj.className = 'pill pill-active'
    pillProj.textContent = '投影: 投影中'
  }
}

// 授業詳細の描画
function renderSessionDetails(session) {
  if (!session) return

  const aiInfo = getAiModeInfo(session.reactionAiMode || session.reactionMode)
  $('metaSchedule').textContent = formatDate(session.scheduledAt)
  $('metaAiMode').innerHTML = `<span class="badge ${aiInfo.badgeClass}">${aiInfo.label}</span>`

  if (session.pdfFilePath) {
    const filename = session.pdfFilePath.split('/').pop() || 'スライド登録済'
    $('metaPdf').textContent = filename
    $('metaPdf').className = 'meta-value'
  } else {
    $('metaPdf').textContent = '未設定'
    $('metaPdf').className = 'meta-value text-muted'
  }

  const isCompleted = session.status === 'completed' || session.status === 'closed'
  const isStarted = Boolean(session.classStartedAt)

  if (isCompleted) {
    $('metaStatus').textContent = '終了済み'
  } else if (isStarted) {
    $('metaStatus').textContent = Date.now() >= Date.parse(session.classStartedAt) + 95 * 60000 ? '授業後' : '実施中'
  } else {
    $('metaStatus').textContent = '準備完了（未開始）'
  }

  // 指定回バッジ
  if (session.isCurrentTarget) {
    $('targetBadge').style.display = 'inline-block'
  } else {
    $('targetBadge').style.display = 'none'
  }

  // 投影URL
  $('screenUrl').value = session.screenUrl || ''

  // AI停止ボタンのテキスト更新（AIなし条件時は「音声のみ停止」）
  if (aiInfo.isOff) {
    $('aiBtnText').textContent = isAudioActive ? '音声のみ停止' : '音声のみ再開'
  } else {
    $('aiBtnText').textContent = isAiPaused ? 'AIのみ再開' : 'AIのみ停止'
  }
}

// 120分自動終了カウントダウン
function startCountdownTimer(startedAtIso) {
  if (countdownInterval) clearInterval(countdownInterval)
  if (!startedAtIso) return

  const startedAtMs = new Date(startedAtIso).getTime()
  const expiresAtMs = startedAtMs + 120 * 60 * 1000

  const updateCountdown = () => {
    const now = Date.now()
    const remainingMs = expiresAtMs - now

    if (remainingMs <= 0) {
      clearInterval(countdownInterval)
      countdownInterval = null
      $('countdownBadge').textContent = '終了'
      $('elapsedTime').textContent = '120分で自動停止'
      $('classStateBadge').textContent = '終了'
      $('countdownBadge').classList.remove('countdown-warning')
      void endClass(true)
      return
    }

    const totalMinutes = Math.ceil(remainingMs / 60000)
    const hours = Math.floor(totalMinutes / 60)
    const minutes = totalMinutes % 60
    const classLabel = now - startedAtMs >= 95 * 60000 ? '授業後' : '授業中'
    $('countdownBadge').textContent = classLabel
    $('classStateBadge').textContent = classLabel
    $('metaStatus').textContent = classLabel
    if (classLabel === '授業後' && $('statusText').textContent === '授業実施中（正常稼働中）') $('statusText').textContent = '授業後（システム稼働中）'
    $('elapsedTime').textContent = `開始から${Math.floor((now - startedAtMs) / 60000)}分`
    $('countdownTiming').classList.toggle('countdown-warning', remainingMs <= 10 * 60 * 1000)
    $('countdownTiming').textContent = `自動停止まで ${hours ? `${hours}時間` : ''}${minutes || !hours ? `${minutes}分` : ''}`
  }

  updateCountdown()
  countdownInterval = setInterval(updateCountdown, 1000)
}

const audioCheck = new window.SupporTalkAudioCheck({
  send: segment => api.checkAudio(segment),
  cancelSend: () => api.cancelAudioCheck(),
  onLevel: level => { $('audioCheckLevel').value = level },
  onState: (state, message) => {
    if (message) $('audioCheckStatus').textContent = message
    const busy = !['idle', 'done', 'error', 'stopped'].includes(state)
    $('btnAudioCheck').disabled = busy || actionBusy || isClassRunning || isAudioActive || audioStarting
    $('btnCancelAudioCheck').disabled = !busy
  },
  onResult: result => {
    $('audioCheckTranscript').textContent = result.transcript || '（認識された発話はありません）'
    $('audioCheckTranscript').hidden = false
    $('audioCheckTime').textContent = `確認時刻: ${new Date(result.checkedAt).toLocaleTimeString('ja-JP')} / ${result.modelUsed || ''}`
  },
})
$('btnAudioCheck').addEventListener('click', () => {
  if (actionBusy || isClassRunning || isAudioActive || audioStarting || audioCheck.active) return
  $('audioCheckTranscript').textContent = ''; $('audioCheckTranscript').hidden = true; $('audioCheckTime').textContent = ''
  void audioCheck.start()
})
$('btnCancelAudioCheck').addEventListener('click', () => audioCheck.stop())
api.onStopAudioCheck(() => audioCheck.stop())
window.addEventListener('beforeunload', () => audioCheck.stop())

// Reuse Shared Wall's getUserMedia + independent 15-second MediaRecorder segments.
const audioReference = new window.SupporTalkAudioReference({
  send: (sessionId, segments) => api.sendAudioSegments(sessionId, segments),
  onState: (state, message) => {
    isAudioActive = state === 'recording'
    audioStarting = state === 'starting'
    if (message && state === 'recording') audioFailures += 1
    else if (state === 'recording') audioFailures = 0
    audioFailed = state === 'error' || audioFailures >= 3
    $('micErrorBanner').style.display = audioFailed ? 'flex' : 'none'
    if (audioFailed) $('micErrorMsg').textContent = message || 'マイクの取得を確認できません。再試行してください。'
    updateStatusUI()
  },
  onSaved: (result) => {
    if (typeof result.transcript === 'string') {
      $('audioCheckTranscript').textContent = result.transcript || '（認識された発話はありません）'
      $('audioCheckTranscript').hidden = false
      $('audioCheckTime').textContent = `授業音声の更新: ${new Date(result.checkedAt).toLocaleTimeString('ja-JP')} / ${result.modelUsed || ''}`
      $('audioCheckStatus').textContent = '授業音声の文字起こしを更新しました。'
    }
    $('pillAudio').title = `文脈更新: ${new Date().toLocaleTimeString('ja-JP')} / ${result.modelUsed || ''}`
  },
})
api.onStopAudio(() => { audioReference.stop(); audioCheck.stop() })
window.addEventListener('beforeunload', () => audioReference.stop())
async function startAudioReference() {
  audioCheck.stop()
  if (!currentSession) return false
  try {
    await api.stopAudioCapture()
    const expiresAt = Date.parse(currentSession.classStartedAt) + 120 * 60 * 1000
    return await audioReference.start(currentSession.sessionId, expiresAt)
  } catch (err) {
    isAudioActive = false; audioStarting = false; audioFailed = true
    $('micErrorBanner').style.display = 'flex'
    $('micErrorMsg').textContent = err.message || 'マイクの使用を許可して再試行してください。'
    updateStatusUI()
    return false
  }
}
async function stopAudioReference() { audioReference.stop(); await api.stopAudioCapture() }

// 授業開始処理
async function startClass() {
  audioCheck.stop()
  $('audioCheckTranscript').textContent = ''; $('audioCheckTranscript').hidden = true; $('audioCheckTime').textContent = ''
  $('audioCheckStatus').textContent = '授業開始後、最初の文字起こしを受信するとここに表示します。'
  if (!currentSession) return
  if (currentSession.autoExpiredAt || ['completed','closed','locked'].includes(currentSession.status) || (currentSession.classStartedAt && Date.now() >= Date.parse(currentSession.classStartedAt) + 120 * 60000)) { updateStatusUI(); return }
  $('btnStartClass').disabled = true

  audioFailed = false
  projectionFailed = false
  $('micErrorBanner').style.display = 'none'
  $('projectionErrorBanner').style.display = 'none'

  try {
    // 1. サーバー側で授業開始（class_started_at の記録・条件固定）
    const controlRes = await api.controlSession('start', currentSession.sessionId).catch(async (error) => {
      // A lost success response must resume the existing class, never start another timer.
      try {
        const existing=await api.detectLatest(currentSession.sessionId)
        if(existing.classStartedAt&&existing.isCurrentTarget&&!existing.autoExpiredAt&&!['completed','closed','locked'].includes(existing.status)){
          return {data:{classStartedAt:existing.classStartedAt,reactionAiStatus:existing.reactionStatus,projectionStatus:existing.projectionStatus}}
        }
      }catch{}
      throw error
    })

    const startedAt = controlRes?.data?.classStartedAt || controlRes?.classStartedAt || currentSession.classStartedAt
    if (!startedAt || !Number.isFinite(Date.parse(startedAt))) throw new Error('授業開始時刻を取得できませんでした。再接続してください。')
    currentSession.classStartedAt = startedAt
    isAiPaused=controlRes?.data?.reactionAiStatus==='stopped'
    isProjectionPaused=controlRes?.data?.projectionStatus==='paused'

    // 授業開始後は別の授業回への切り替えを無効化
    $('sessionSelect').disabled = true
    isClassRunning = true
    $('runningControls').style.display = 'block'
    $('btnStartClass').style.display = 'none'

    // 120分自動終了タイマー開始
    startCountdownTimer(startedAt)

    // 2. 透明投影の開始
    try {
      await api.start(formConfig())
      projectionFailed = false
    } catch (projErr) {
      console.error('[Projection] start failed:', projErr)
      projectionFailed = true
      $('projectionErrorMsg').textContent = `投影起動エラー: ${projErr.message || 'ウィンドウ作成に失敗しました'}`
      $('projectionErrorBanner').style.display = 'flex'
    }

    // 3. 音声取得の開始（アプリ内録音）
    if(!isAiPaused)await startAudioReference()

    updateStatusUI()
  } catch (err) {
    alert(`授業の開始に失敗しました: ${err.message}`)
    $('btnStartClass').disabled = false
    isClassRunning = false
    $('sessionSelect').disabled = false
    updateStatusUI()
  }
}

// 授業終了処理
async function endClass(isAutoExpire = false, remoteEnded = false) {
  if (!currentSession) return
  if (!isAutoExpire && !remoteEnded) {
    const ok = confirm('本当に授業を終了しますか？\n（AI返信・音声取得・コメント投影がすべて停止します）')
    if (!ok) return
  }

  await api.hideQr().catch(()=>{});isQrVisible=false
  // 音声停止
  await stopAudioReference()

  // 投影停止
  try { await api.stop() } catch {}

  // Local stop is immediate; do not pretend that an offline server acknowledged it.
  let serverConfirmed=true
  try{await api.controlSession('stop',currentSession.sessionId)}catch{serverConfirmed=false}

  isClassRunning = false
  currentSession.status = 'completed'
  if (countdownInterval) {
    clearInterval(countdownInterval)
    countdownInterval = null
  }

  $('runningControls').style.display = 'none'
  $('btnStartClass').style.display = 'flex'
  $('btnStartClass').disabled = true
  $('btnStartClass').querySelector('.btn-start-title').textContent = isAutoExpire ? '授業終了（120分経過）' : '授業終了'
  $('btnStartClass').querySelector('.btn-start-subtitle').textContent = 'この授業回は完了しました'
  $('sessionSelect').disabled = false

  updateStatusUI()
  if(!serverConfirmed){$('statusText').textContent='このPCは停止しました。サーバーの授業終了を再確認しています。'}
}

// AI・音声停止/再開の切り替え
async function toggleAiOrAudio() {
  if (!currentSession || !isClassRunning) return
  const aiInfo = getAiModeInfo(currentSession.reactionAiMode || currentSession.reactionMode)

  if (aiInfo.isOff) {
    // AIなし条件: 音声のみ停止 / 再開
    if (isAudioActive) {
      await stopAudioReference()
      $('aiBtnText').textContent = '音声のみ再開'
    } else {
      await startAudioReference()
      $('aiBtnText').textContent = '音声のみ停止'
    }
  } else {
    // AIあり条件: AIのみ停止 / 再開（停止時は音声取得も連動停止）
    if (isAiPaused) {
      try {
        await api.controlSession('resume_ai', currentSession.sessionId)
        isAiPaused = false
        await startAudioReference()
        $('aiBtnText').textContent = 'AIのみ停止'
      } catch (err) {
        alert(`AI再開に失敗しました: ${err.message}`)
      }
    } else {
      try {
        await api.controlSession('pause_ai', currentSession.sessionId)
        isAiPaused = true
        await stopAudioReference()
        $('aiBtnText').textContent = 'AIのみ再開'
      } catch (err) {
        alert(`AI停止に失敗しました: ${err.message}`)
      }
    }
  }
  updateStatusUI()
}

// 投影停止/再開の切り替え
async function toggleProjection() {
  if (!currentSession || !isClassRunning) return
  if (isProjectionPaused) {
    try {
      await api.controlSession('resume_projection', currentSession.sessionId)
      await api.start(formConfig())
      projectionFailed=false
      isProjectionPaused = false
      $('projBtnText').textContent = '投影のみ停止'
    } catch (err) {
      alert(`投影再開に失敗しました: ${err.message}`)
    }
  } else {
    try {
      await api.controlSession('pause_projection', currentSession.sessionId)
      isProjectionPaused = true
      $('projBtnText').textContent = '投影のみ再開'
    } catch (err) {
      alert(`投影一時停止に失敗しました: ${err.message}`)
    }
  }
  updateStatusUI()
}

// QRコード表示/非表示切り替え
async function toggleQr() {
  if (!currentSession) return
  try {
    if (isQrVisible) {
      await api.hideQr()
      isQrVisible = false
      $('qrBtnText').textContent = '学生入室QRコードを表示'
    } else {
      await api.showQr($('screenUrl').value.trim(), $('displayId').value)
      isQrVisible = true
      $('qrBtnText').textContent = '学生入室QRコードを隠す'
    }
  } catch (err) {
    alert(`QRコードの表示切り替えに失敗しました: ${err.message}`)
  }
}

function renderDisplays(displays,preferred){
  $('displayId').innerHTML=''
  displays.forEach(display=>{const option=document.createElement('option');option.value=display.id;option.textContent=display.label;option.selected=String(preferred)===display.id;$('displayId').appendChild(option)})
}
api.onDisplays(({displays})=>renderDisplays(displays,$('displayId').value))

// 初期化フロー
let initialStateBusy = false
async function init() {
  if (initialStateBusy || actionBusy) return
  initialStateBusy = true
  try {
    const { config, displays, controlShortcut } = await api.getInitialState()
    $('shortcutNote').textContent = controlShortcut ? `操作画面を開く: ${controlShortcut.replace('CommandOrControl', 'Ctrl')}` : 'ショートカットを登録できませんでした。タスクトレイから操作画面を開いてください。'

    $('serverOrigin').value = config.serverOrigin || 'http://localhost:3000'
    // ディスプレイ選択の生成
    renderDisplays(displays,config.displayId)

    $('durationSeconds').value = config.durationSeconds || 12
    $('fontScale').value = String(config.fontScale || 1)

    if(config.pendingStop){$('statusText').textContent='前回の授業はこのPCでは停止済みです。サーバーへ終了確認を再試行しています。';$('btnStartClass').disabled=true;$('sessionSelect').disabled=true;return}
    // 最新または指定授業回の検出
    const latestRes = await api.detectLatest()
    if (latestRes?.sessions && latestRes.sessions.length > 0) {
      preparedSessions = latestRes.sessions
      const previousId = currentSession?.sessionId
      if (previousId !== latestRes.sessionId && isQrVisible) {
        await api.hideQr()
        isQrVisible = false
        $('qrBtnText').textContent = '学生入室QRコードを表示'
      }
      isClassRunning = false
      if (countdownInterval) { clearInterval(countdownInterval); countdownInterval = null }
      $('sessionSelect').disabled = false
      $('runningControls').style.display = 'none'
      $('btnStartClass').style.display = ''
      $('btnStartClass').disabled = false
      currentSession = latestRes
      isAiPaused = latestRes.reactionStatus === 'stopped'
      isProjectionPaused = latestRes.projectionStatus === 'paused'

      // セレクトボックスの生成
      $('sessionSelect').innerHTML = ''
      preparedSessions.forEach((s) => {
        const opt = document.createElement('option')
        opt.value = s.sessionId
        const aiInfo = getAiModeInfo(s.reactionAiMode)
        const targetMarker = s.isCurrentTarget ? ' ★今回指定' : ''
        opt.textContent = `第${s.sessionNumber}回 (${formatDate(s.scheduledAt)})${targetMarker} [${aiInfo.label.split(' ')[0]}]`
        if (s.sessionId === latestRes.sessionId) {
          opt.selected = true
        }
        $('sessionSelect').appendChild(opt)
      })

      renderSessionDetails(latestRes)

      // 授業がすでに開始されているか判定（リロード・再起動時の復帰）
      if (latestRes.classStartedAt && !latestRes.autoExpiredAt && !['completed','closed'].includes(latestRes.status) && latestRes.projectionStatus !== 'stopped') {
        const startedAtMs = new Date(latestRes.classStartedAt).getTime()
        const now = Date.now()
        if (now - startedAtMs < 120 * 60 * 1000) {
          isClassRunning = true
          $('sessionSelect').disabled = true
          $('runningControls').style.display = 'block'
          $('btnStartClass').style.display = 'none'
          startCountdownTimer(latestRes.classStartedAt)
          // 投影再接続
          void api.start(formConfig()).catch(() => { projectionFailed = true })
          // 音声再接続
          if (!isAiPaused) void startAudioReference()
        }
      }
    }

    updateStatusUI()
  } catch (err) {
    console.error('Initialization error:', err)
    $('statusText').textContent = `初期化エラー: ${err.message}（接続設定を確認してください）`
    $('connectionSettings').open = true
  } finally { initialStateBusy = false }
}

// 授業回切り替えイベント
$('sessionSelect').addEventListener('change', async (e) => {
  if (isClassRunning) return
  const selectedId = e.target.value
  try {
    const details = await api.detectLatest(selectedId)
    if (isQrVisible) { await api.hideQr(); isQrVisible = false; $('qrBtnText').textContent = '学生入室QRコードを表示' }
    currentSession = details
    renderSessionDetails(details)
    updateStatusUI()
  } catch (err) {
    alert(`授業回情報の取得に失敗しました: ${err.message}`)
  }
})

// イベントリスナーの登録
$('btnQuitApp').addEventListener('click', async () => {
  $('btnQuitApp').disabled = true
  $('quitAppMessage').textContent = ''
  try { await api.quitApp() }
  catch { $('quitAppMessage').textContent = 'アプリを終了できませんでした。もう一度押してください。' }
  finally { $('btnQuitApp').disabled = false }
})
$('btnOpenAdmin').addEventListener('click', () => api.openAdmin())
$('btnToggleQr').addEventListener('click', toggleQr)
$('btnStartClass').addEventListener('click', () => runAction(startClass))
$('btnToggleAi').addEventListener('click', () => runAction(toggleAiOrAudio))
$('btnToggleProjection').addEventListener('click', () => runAction(toggleProjection))
$('btnDemoTest').addEventListener('click', async () => {
  try {
    await api.test()
  } catch (err) {
    alert(err.message)
  }
})
$('btnEndClass').addEventListener('click', () => runAction(() => endClass(false)))

// 再試行ボタン
$('btnRetryMic').addEventListener('click', async () => {
  $('btnRetryMic').disabled = true
  await startAudioReference()
  $('btnRetryMic').disabled = false
})

$('btnRetryProjection').addEventListener('click', async () => {
  $('btnRetryProjection').disabled = true
  try {
    await api.start(formConfig())
    projectionFailed = false
    $('projectionErrorBanner').style.display = 'none'
  } catch (err) {
    alert(`投影再試行エラー: ${err.message}`)
  } finally {
    $('btnRetryProjection').disabled = false
    updateStatusUI()
  }
})

// 外部からのステータス通知（main.cjsからの通知）
api.onStatus(({ running, message, classState }) => {
  if(message==='授業終了を確認しました。'){void init();return}
  if(!running&&isClassRunning&&message==='停止中'){projectionFailed=true;updateStatusUI()}
  if(message==='接続中'){
    $('projectionErrorBanner').style.display='none'
  }else if(message&&!classState&&!message.includes('120分')&&!['停止中','投影一時停止中（教授画面から再開可能）'].includes(message)){
    $('projectionErrorMsg').textContent=message
    $('projectionErrorBanner').style.display='flex'
  }
  if (classState && currentSession?.sessionId === classState.sessionId && isClassRunning) {
    if (classState.ended) { void endClass(false, true); return }
    const wasPaused = isAiPaused
    isAiPaused = classState.reactionStatus === 'stopped'
    isProjectionPaused = classState.projectionStatus === 'paused'
    if (isAiPaused) audioReference.stop()
    else if (wasPaused && !actionBusy) void startAudioReference()
    updateStatusUI()
  }
  if (!running && isClassRunning && message?.includes('120分')) void endClass(true)
})

async function runAction(action) {
  if (actionBusy) return
  actionBusy = true
  const buttons = ['btnStartClass','btnToggleAi','btnToggleProjection','btnEndClass','btnRetryMic','btnRetryProjection']
  buttons.forEach(id => { $(id).disabled = true })
  try { await action() } finally {
    actionBusy = false
    buttons.forEach(id => { $(id).disabled = false })
    updateStatusUI()
  }
}
$('btnSaveConnection').addEventListener('click', async () => {
  $('connectionMessage').textContent = '接続を確認中…'
  $('btnSaveConnection').disabled = true
  try {
    await api.configureConnection({ origin: $('serverOrigin').value.trim(), password: $('teacherPassword').value })
    $('teacherPassword').value = ''
    $('connectionMessage').textContent = ''
    $('connectionSettings').open = false
    await init()
  } catch (err) { $('connectionMessage').textContent = err.message }
  finally { $('btnSaveConnection').disabled = false }
})
void init()
// Refresh preparation state without interrupting an ongoing class.
setInterval(() => { if (!isClassRunning && !actionBusy) void init() }, 5000)
window.addEventListener('focus', () => { if (!isClassRunning && !actionBusy) void init() })
