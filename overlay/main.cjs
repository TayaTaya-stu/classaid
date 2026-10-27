const { app, BrowserWindow, ipcMain, screen, shell, Tray, Menu, nativeImage, globalShortcut, safeStorage, session, powerMonitor, dialog } = require('electron')
const path = require('node:path')
const fs = require('node:fs')
const crypto = require('node:crypto')
// Isolate SupporTalk from legacy apps without deleting their settings.
const previousUserData = app.getPath('userData')
app.setName('SupporTalk')
const supportalkUserData = path.join(app.getPath('appData'), 'SupporTalk')
fs.mkdirSync(supportalkUserData, { recursive: true })
const previousConfig = path.join(previousUserData, 'overlay-config.json')
const newConfig = path.join(supportalkUserData, 'overlay-config.json')
if (!fs.existsSync(newConfig) && fs.existsSync(previousConfig)) fs.copyFileSync(previousConfig, newConfig)
app.setPath('userData', supportalkUserData)
// Chromium caches/cookies have their own path; isolate them before ready as well.
const supportalkSessionData = path.join(supportalkUserData, 'browser-session')
fs.mkdirSync(supportalkSessionData, { recursive: true })
app.setPath('sessionData', supportalkSessionData)
let controlShortcut = ''

const clientInstanceId = crypto.randomUUID()
let polling = false
let pollRequestController = null
const pendingDelivery = new Map()
let generation = 0
const sentEvents = new Map()

let controlWindow = null
let overlayWindow = null
let qrWindow = null
let tray = null
let isQuitting = false
let pollTimer = null
let deadlineTimer = null
let lastCursor = null
let activeConfig = null
let sessionExpiresAt = null
let sessionControlDeadline = null
let sessionControlTimer = null
let runtimePassword = ''
let audioCheckController = null
let audioRequestController = null
let stateSyncTimer = null
let stateSyncBusy = false

function sendControl(channel,payload){
  if(controlWindow&&!controlWindow.isDestroyed?.())controlWindow.webContents.send(channel,payload)
}

function acknowledgeDelivery(cursor) {
  const item=pendingDelivery.get(cursor)
  if(!item)return
  item.acked=true
  let advanced=false
  for(const [id,entry] of pendingDelivery){
    if(!entry.acked)break
    lastCursor=id;pendingDelivery.delete(id);advanced=true
  }
  if(advanced&&activeConfig){
    try {saveConfig({...readConfig(),projectionCheckpoint:{screenUrl:activeConfig.screenUrl,cursor:lastCursor}})}
    catch {sendControl('overlay:status',{running:true,message:'再開位置を保存できません。投影は継続します。'})}
  }
}

function appOrigin() {
  const cfg = readConfig()
  return cfg.serverOrigin || (cfg.screenUrl ? new URL(cfg.screenUrl).origin : 'http://localhost:3000')
}
function keepDeadline(expiresAt) {
  if (!Number.isFinite(expiresAt)) throw new Error('授業の終了時刻を取得できませんでした。')
  sessionControlDeadline = expiresAt
  if (!stateSyncTimer) stateSyncTimer = setInterval(() => void syncClassState(), 5000)
  if (sessionControlTimer) clearInterval(sessionControlTimer)
  sessionControlTimer = setInterval(() => {
    if (sessionControlDeadline && Date.now() >= sessionControlDeadline) {
      stopAudioCapture(); stopOverlay(); hideQrWindow()
      clearClassTimers()
      sendControl('overlay:status', { running: false, message: '120分経過により授業を停止しました。' })
    }
  }, 1000)
}


function clearClassTimers() {
  if (stateSyncTimer) clearInterval(stateSyncTimer)
  if (sessionControlTimer) clearInterval(sessionControlTimer)
  stateSyncTimer = null
  sessionControlTimer = null
  sessionControlDeadline = null
}

async function retryPendingStop(){
  const cfg=readConfig(),pending=cfg.pendingStop
  if(!pending)return
  if(pending.origin!==appOrigin())throw new Error('元の接続先で終了を確認してください。')
  const response=await fetch(`${pending.origin}/api/teacher/session-control`,{
    method:'POST',headers:{'Content-Type':'application/json','x-teacher-password':getTeacherPassword()},
    body:JSON.stringify({action:'stop',sessionId:pending.sessionId}),signal:AbortSignal.timeout(4000),
  })
  const result=await response.json().catch(()=>null)
  if(!response.ok||result?.success===false)throw new Error('授業終了を確認できません。')
  const latest=readConfig()
  if(latest.pendingStop?.sessionId===pending.sessionId)saveConfig({...latest,pendingStop:null})
  stopAudioCapture();stopOverlay();hideQrWindow();clearClassTimers()
  sendControl('overlay:status',{running:false,message:'授業終了を確認しました。'})
}

// The DB owns classroom state. Local flags only describe native device state.
async function syncClassState() {
  if(stateSyncBusy)return
  if(readConfig().pendingStop){stateSyncBusy=true;try{await retryPendingStop()}catch{sendControl('overlay:status',{running:false,message:'このPCの音声と投影は停止しています。サーバーの授業終了は再接続後に確認します。'})}finally{stateSyncBusy=false}return}
  if(!sessionControlDeadline||Date.now()>=sessionControlDeadline)return
  const sessionId = readConfig().activeSessionId
  if (!sessionId) return
  stateSyncBusy = true
  try {
    const response = await fetch(`${appOrigin()}/api/screen/latest?sessionId=${encodeURIComponent(sessionId)}`, {
      headers: { 'x-teacher-password': getTeacherPassword() }, signal: AbortSignal.timeout(4000),
    })
    if (!response.ok) throw new Error('Class state unavailable')
    const state = await response.json()
    if (readConfig().activeSessionId !== sessionId || state.sessionId !== sessionId) return
    const ended = Boolean(state.isCurrentTarget === false || state.autoExpiredAt || ['completed','closed','locked'].includes(state.status))
    if (ended || state.reactionStatus === 'stopped') stopAudioCapture()
    if (ended) { stopOverlay(); hideQrWindow(); clearClassTimers() }
    sendControl('overlay:status', {
      running: !ended, message: ended ? '授業終了' : '',
      classState: { sessionId, ended, reactionStatus: state.reactionStatus, projectionStatus: state.projectionStatus },
    })
  } catch {
    // Keep local devices and the fixed deadline intact while offline; never claim success.
    console.warn('授業状態の再確認に失敗しました。ローカルの終了期限は維持します。')
  } finally { stateSyncBusy = false }
}


function stopAudioCapture() {
  audioCheckController?.abort(); audioCheckController = null
  audioRequestController?.abort(); audioRequestController = null
  sendControl('overlay:stop-audio')
}

function getTeacherPassword() {
  if (runtimePassword) return runtimePassword
  const cfg = readConfig()
  if (cfg.encryptedTeacherPassword && safeStorage.isEncryptionAvailable()) {
    try { return safeStorage.decryptString(Buffer.from(cfg.encryptedTeacherPassword, 'base64')) } catch {}
  }
  if (cfg.teacherPassword) return cfg.teacherPassword
  try {
    const envFile = path.resolve(__dirname, '..', '.env.local')
    if (fs.existsSync(envFile)) {
      const content = fs.readFileSync(envFile, 'utf8')
      const m = content.match(/^TEACHER_ACCESS_PASSWORD=(.+)$/m)
      if (m) { const value=m[1].trim(); return (/^[\"']/.test(value)&&value.at(-1)===value[0])?value.slice(1,-1):value }
    }
  } catch {}
  return process.env.TEACHER_ACCESS_PASSWORD || ''
}

const configPath = () => path.join(app.getPath('userData'), 'overlay-config.json')
const hasSingleInstanceLock = app.requestSingleInstanceLock()

// A secondary process must not initialize Chromium windows or caches.
if (!hasSingleInstanceLock) app.exit(0)

if (process.defaultApp) {
  if (process.argv.length >= 2) {
    app.setAsDefaultProtocolClient('supportalk', process.execPath, [path.resolve(process.argv[1])])
  }
} else {
  app.setAsDefaultProtocolClient('supportalk')
}

function findProtocolArg(argv) {
  for (const raw of argv || []) {
    if (typeof raw !== 'string') continue
    const trimmed = raw.replace(/^["']|["']$/g, '').trim()
    if (trimmed.startsWith('supportalk://')) return trimmed
  }
  return null
}

async function handleProtocolUrl(urlStr) {
  try {
    const cleanUrl = (urlStr || '').replace(/^["']|["']$/g, '').trim()
    const url = new URL(cleanUrl)
    const target = url.searchParams.get('screenUrl')
    const autostart = url.searchParams.get('autostart') === 'true' || url.searchParams.get('autostart') === '1'
    const displayId = url.searchParams.get('displayId')
    if (target) {
      const targetOrigin = parseScreenUrl(target).origin
      const saved = readConfig()
      const trusted = saved.serverOrigin || (saved.screenUrl ? new URL(saved.screenUrl).origin : null)
      if (trusted ? targetOrigin !== trusted : !['http://localhost:3000','http://localhost:3001','http://127.0.0.1:3000','http://127.0.0.1:3001'].includes(targetOrigin)) throw new Error('接続設定で登録されたサーバーのみ開けます。')
      const cfg = { ...readConfig(), screenUrl: target }
      if (displayId) cfg.displayId = displayId
      saveConfig(cfg)
      if (controlWindow && !controlWindow.isDestroyed()) {
        controlWindow.webContents.send('overlay:set-screen-url', target)
      }
      if (autostart) {
        await startOverlay(cfg)
      } else {
        if (controlWindow && !controlWindow.isDestroyed()) {
          controlWindow.show()
          controlWindow.focus()
        }
      }
    }
  } catch (err) {
    console.error('Failed to parse protocol url:', err)
  }
}

app.on('open-url', (event, url) => {
  event.preventDefault()
  void handleProtocolUrl(url)
})

app.on('second-instance', (_event, commandLine) => {
  console.log('[SupporTalk] Second instance detected: restoring and focusing control window.')
  const protocolArg = findProtocolArg(commandLine)
  if (protocolArg) void handleProtocolUrl(protocolArg)
  if (app.isReady()) createControlWindow()
})

function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(configPath(), 'utf8'))
  } catch {
    if(fs.existsSync(configPath()))throw new Error('接続設定を読み取れません。実験者が設定ファイルを確認してください。')
    return { screenUrl: '', displayId: '', durationSeconds: 12, fontScale: 1, teacherPassword: '' }
  }
}

function saveConfig(config) {
  const clean={...config}
  if(clean.teacherPassword){
    runtimePassword=clean.teacherPassword
    if(safeStorage.isEncryptionAvailable())clean.encryptedTeacherPassword=safeStorage.encryptString(clean.teacherPassword).toString('base64')
    delete clean.teacherPassword
  }
  const temporary=configPath()+'.tmp'
  fs.writeFileSync(temporary,JSON.stringify(clean,null,2),{encoding:'utf8',mode:0o600})
  fs.renameSync(temporary,configPath())
}

function parseScreenUrl(value) {
  const url = new URL(value)
  const match = url.pathname.match(/^\/screen\/([a-zA-Z0-9_-]{16,128})\/?$/)
  if (!['http:', 'https:'].includes(url.protocol) || !match) {
    throw new Error('投影画面URL（/screen/…）を入力してください。')
  }
  return { origin: url.origin, screenSlug: match[1] }
}

function displayOptions() {
  const primaryId = screen.getPrimaryDisplay().id
  return screen.getAllDisplays().map((display, index) => ({
    id: String(display.id),
    label: `${display.id === primaryId ? 'メイン画面' : `画面${index + 1}`}（${display.bounds.width}×${display.bounds.height}）`,
  }))
}

function chosenDisplay(displayId) {
  return screen.getAllDisplays().find((display) => String(display.id) === String(displayId)) || screen.getPrimaryDisplay()
}

function createControlWindow() {
  if (controlWindow && !controlWindow.isDestroyed()) {
    if (controlWindow.isMinimized()) controlWindow.restore()
    controlWindow.show()
    controlWindow.focus()
    return
  }
  controlWindow = new BrowserWindow({
    width: 580,
    height: 740,
    minWidth: 500,
    minHeight: 660,
    title: 'SupporTalk 教授用アプリ',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true, backgroundThrottling: false,
    },
  })
  controlWindow.loadFile(path.join(__dirname, 'control.html'))
  controlWindow.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault()
      controlWindow.hide()
    }
  })
  const thisControl=controlWindow
  controlWindow.on('closed', () => { if(controlWindow===thisControl){controlWindow=null;stopAudioCapture()} })
}

function createTray() {
  if (tray) return
  const icon = nativeImage.createFromBuffer(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAt0lEQVR4nO2WXQ7CIBCEt6SHqMdUPEbFY+It9MG0krIL0rKDJsxTkyEzX/gtUVdjDZIxnednzaLH/cp2GUR5KjMC0ChPZZvcAG0IIxkoCHYPINUB/gPAO0ve2are1wBhwDZsr1cEoK0swOlyY7+PeKHWBwJ5ERF9HqffX4IOAAOQ/lg0FHYZyUCURwDaEFw2uwc0IKTMbFHqgqoBuvsU1JqlsVXxoqIZQB5VInqvP/qRigCalaP0Ao3/VaTQPAbmAAAAAElFTkSuQmCC', 'base64'))
  tray = new Tray(icon.resize({ width: 20, height: 20 }))
  tray.setToolTip('SupporTalk 授業投影')
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '操作画面を開く', click: () => createControlWindow() },
    { label: 'QRコードを表示', click: () => { void showQrWindow(readConfig().screenUrl).catch(() => createControlWindow()) } },
    { label: 'QRコードを隠す', click: () => hideQrWindow() },
    { label: 'コメント投影を停止', click: () => stopOverlay() },
    { type: 'separator' },
    { label: '完全に終了', click: () => { isQuitting = true; app.quit() } },
  ]))
  tray.on('double-click', () => createControlWindow())
}

function createOverlayWindow(config) {
  const display = chosenDisplay(config.displayId)
  if (overlayWindow && !overlayWindow.isDestroyed()) overlayWindow.close()
  overlayWindow = new BrowserWindow({
    ...display.bounds,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    alwaysOnTop: true,
    skipTaskbar: true,
    focusable: false,
    show: false,
    hasShadow: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true, backgroundThrottling: false,
    },
  })
  overlayWindow.setAlwaysOnTop(true, 'screen-saver')
  overlayWindow.setIgnoreMouseEvents(true, { forward: true })
  const thisOverlay=overlayWindow
  thisOverlay.once('ready-to-show', () => {if(!thisOverlay.isDestroyed())thisOverlay.showInactive()})
  thisOverlay.on('closed', () => { if(overlayWindow===thisOverlay)overlayWindow=null })
  thisOverlay.webContents.on('render-process-gone',()=>{
    if(overlayWindow!==thisOverlay||!activeConfig)return
    const cfg={...activeConfig}
    sendControl('overlay:status',{running:false,message:'投影画面を復旧しています。'})
    setTimeout(()=>{if(activeConfig?.screenUrl===cfg.screenUrl)void startOverlay(cfg).catch(()=>sendControl('overlay:status',{running:false,message:'投影を再試行してください。'}))},1000)
  })
  return overlayWindow.loadFile(path.join(__dirname, 'overlay.html'))
}

async function showQrWindow(value) {
  const parsed = parseScreenUrl(value)
  const response = await fetch(`${parsed.origin}/api/screen/${encodeURIComponent(parsed.screenSlug)}/posts`,{signal:AbortSignal.timeout(5000)})
  const data = await response.json()
  if (!response.ok || !data.entryPath) throw new Error(data.error || '学生入室URLを取得できませんでした。')
  if (!data.isDesignatedSession) throw new Error('管理者画面でこの授業回を「今回使用する」に指定してください。')
  if (!data.fixedEntryUrl) throw new Error('学生向けURLが未設定です。実験者がSTUDENT_BASE_URLを設定してください。')
  const entryUrl = data.fixedEntryUrl
  const qrUrl = `${parsed.origin}/api/screen/qr?target=${encodeURIComponent(entryUrl)}`

  if (qrWindow && !qrWindow.isDestroyed()) {
    await qrWindow.loadFile(path.join(__dirname, 'qr.html'), { query: { qrUrl, entryUrl } })
    const display = chosenDisplay(readConfig().displayId)
    qrWindow.setPosition(display.workArea.x + display.workArea.width - qrWindow.getBounds().width - 20, display.workArea.y + 20)
    qrWindow.setAlwaysOnTop(true, 'screen-saver')
    qrWindow.showInactive()
    qrWindow.moveTop()
    return
  }

  const display = chosenDisplay(readConfig().displayId)
  const width = 340
  const height = 450
  qrWindow = new BrowserWindow({
    width,
    height,
    x: display.workArea.x + display.workArea.width - width - 20,
    y: display.workArea.y + 20,
    minWidth: 250,
    minHeight: 320,
    frame: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: true,
    title: 'SupporTalk 学生入室QRコード',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true, backgroundThrottling: false,
    },
  })
  qrWindow.setAlwaysOnTop(true, 'screen-saver')
  qrWindow.on('blur', () => {
    setTimeout(() => {
      if (qrWindow && !qrWindow.isDestroyed() && qrWindow.isVisible()) {
        qrWindow.setAlwaysOnTop(true, 'screen-saver')
        qrWindow.moveTop()
      }
    }, 0)
  })
  await qrWindow.loadFile(path.join(__dirname, 'qr.html'), { query: { qrUrl, entryUrl } })
  const thisQr=qrWindow
  qrWindow.on('closed', () => { if(qrWindow===thisQr)qrWindow=null })
}

function hideQrWindow() {
  if (qrWindow && !qrWindow.isDestroyed()) qrWindow.hide()
}

async function reportOverlayStatus(screenUrl, status) {
  try {
    const parsed = parseScreenUrl(screenUrl)
    const display = chosenDisplay(readConfig().displayId)
    const response=await fetch(`${parsed.origin}/api/screen/${encodeURIComponent(parsed.screenSlug)}/overlay-status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        status,
        displayLabel: display?.label || 'デフォルト画面',
        clientInstanceId,
      }),
      signal: AbortSignal.timeout(3000),
    })
    if(!response.ok)throw new Error('Status log rejected')
  } catch {console.warn('投影状態ログを保存できませんでした。')}
}

let currentReactionAiMode = 'off'
let currentReactionAiStatus = 'active'

async function pollPosts(throwOnError = false) {
  if (polling || !activeConfig || !overlayWindow || overlayWindow.isDestroyed()) {
    if (throwOnError) throw new Error('投影の初期取得を開始できませんでした。投影を再試行してください。')
    return
  }
  // loadFile has already completed before the initial poll. Do not silently skip
  // the required API handshake because Electron still reports a loading state.
  if (!throwOnError && overlayWindow.webContents.isLoading()) return
  polling = true
  const runGeneration = generation
  try {
    // 3. ローカル終了予定時刻による停止保証（通信断・スリープ復帰時も期限後に投影しない）
    if (sessionExpiresAt && Date.now() >= sessionExpiresAt) {
      stopOverlay()
      sendControl('overlay:status', {
        running: false,
        message: '授業終了（120分経過により自動停止しました）',
      })
      return
    }

    const parsed = parseScreenUrl(activeConfig.screenUrl)
    const suffix = lastCursor === null ? '' : `?afterCursor=${lastCursor}`
    const requestController=new AbortController()
    pollRequestController=requestController
    const response = await fetch(`${parsed.origin}/api/screen/${encodeURIComponent(parsed.screenSlug)}/posts${suffix}`, {
      signal: AbortSignal.any([requestController.signal,AbortSignal.timeout(5000)]),
    })
    const data = await response.json()
    if (!response.ok) throw new Error(data.error || '投稿を取得できませんでした。')

    if (runGeneration !== generation || !activeConfig || !overlayWindow || overlayWindow.isDestroyed()) return

    // 授業AI条件および終了予定時刻の更新保持
    if(data.reactionAiStatus)currentReactionAiStatus=data.reactionAiStatus
    if (data.reactionAiMode) {
      currentReactionAiMode = data.reactionAiMode
    }
    if (data.expiresAt) {
      sessionExpiresAt = new Date(data.expiresAt).getTime()
    } else if (data.classStartedAt) {
      sessionExpiresAt = new Date(data.classStartedAt).getTime() + 120 * 60 * 1000
    }

    if (data.isSessionClosed || (sessionExpiresAt && Date.now() >= sessionExpiresAt)) {
      stopOverlay()
      sendControl('overlay:status', {
        running: false,
        message: data.isExpired || (sessionExpiresAt && Date.now() >= sessionExpiresAt)
          ? '授業終了（120分経過により自動停止しました）'
          : '授業終了（終了操作が行われました）',
      })
      return
    }

    // 4. 投影一時停止時: 画面上の字幕を即座に消去し、カーソルは維持（再開時に停止中の投稿を配信）
    if (data.isProjectionPaused) {
      if (overlayWindow && !overlayWindow.isDestroyed()) {
        overlayWindow.webContents.send('overlay:clear')
      }
      sendControl('overlay:status', {
        running: true,
        message: '投影一時停止中（教授画面から再開可能）',
        lastPostId: lastCursor,
      })
      return
    }

    if (data.protocol !== 'reaction-events-v1') throw new Error('投影アプリとAPIの版が一致しません。')
    const events = Array.isArray(data.events) ? data.events : []
    const posts = Array.isArray(data.posts) ? data.posts : []
    const nextCursor = data.cursor ?? posts.at(-1)?.id ?? 0

    const valid=events.filter(ev=>Number.isSafeInteger(ev.cursor)&&ev.cursor>0)
    for(const ev of valid){
      if(!pendingDelivery.has(ev.cursor))pendingDelivery.set(ev.cursor,{event:ev,acked:false})
      if(!sentEvents.has(ev.cursor))sentEvents.set(ev.cursor,{dispatchedAt:Date.now(),parsed})
    }
    if(sentEvents.size>2000){for(const id of sentEvents.keys()){if(!pendingDelivery.has(id))sentEvents.delete(id);if(sentEvents.size<=1000)break}}
    if(valid.length){
      overlayWindow.webContents.send('overlay:events',{events:valid,durationSeconds:activeConfig.durationSeconds,fontScale:activeConfig.fontScale})
    }else if(!pendingDelivery.size&&Number.isSafeInteger(nextCursor)&&nextCursor>lastCursor){
      lastCursor=nextCursor
      saveConfig({...readConfig(),projectionCheckpoint:{screenUrl:activeConfig.screenUrl,cursor:lastCursor}})
    }
    sendControl('overlay:status', { running: true, message: '接続中', lastPostId: lastCursor })
  } catch (error) {
    if(runGeneration!==generation)return
    sendControl('overlay:status', {
      running: true,
      message: error instanceof Error ? error.message : '接続に失敗しました。',
    })
    if (throwOnError) throw error
  } finally {
    if(runGeneration===generation){polling=false;pollRequestController=null}
  }
}

function stopOverlay() {
  pollRequestController?.abort();pollRequestController=null;polling=false
  pendingDelivery.clear()
  generation += 1
  sentEvents.clear()
  if (pollTimer) clearInterval(pollTimer)
  pollTimer = null
  if (deadlineTimer) clearInterval(deadlineTimer)
  deadlineTimer = null

  if (activeConfig?.screenUrl) {
    void reportOverlayStatus(activeConfig.screenUrl, 'stopped')
  }

  activeConfig = null
  lastCursor = null
  sessionExpiresAt = null
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.webContents.send('overlay:clear')
    overlayWindow.close()
  }
  overlayWindow = null
  sendControl('overlay:status', { running: false, message: '停止中' })
}

async function startOverlay(rawConfig) {
  const parsed = parseScreenUrl(rawConfig?.screenUrl || '')
  const config = {
    screenUrl: `${parsed.origin}/screen/${parsed.screenSlug}`,
    displayId: String(rawConfig?.displayId || ''),
    durationSeconds: Math.min(30, Math.max(5, Number(rawConfig?.durationSeconds) || 12)),
    fontScale: Math.min(1.6, Math.max(0.7, Number(rawConfig?.fontScale) || 1)),
  }
  saveConfig({ ...readConfig(), ...config })
  stopOverlay()
  activeConfig = config
  const checkpoint=readConfig().projectionCheckpoint
  lastCursor=checkpoint?.screenUrl===config.screenUrl&&Number.isSafeInteger(checkpoint.cursor)?checkpoint.cursor:0

  // 1. rendererの準備完了（ウィンドウ作成・HTML読み込み完了）を待機
  try { await createOverlayWindow(config) } catch(error){stopOverlay();throw error}

  // 2. 初回API通信で期限と設定を確定
  try {
    await pollPosts(true)
  } catch (err) {
    stopOverlay()
    throw err
  }

  // 3. renderer準備完了および初回API成功を確認した後に初めてサーバーへ「active」を報告
  if (!activeConfig || !overlayWindow || !Number.isFinite(sessionExpiresAt)) {
    stopOverlay()
    throw new Error('投影用の授業時刻を確認できませんでした。接続先と今回の授業回を確認してください。')
  }
  keepDeadline(sessionExpiresAt)
  await reportOverlayStatus(config.screenUrl, 'active')

  pollTimer = setInterval(() => void pollPosts(), 1500)

  // 4. ローカル期限切れ判定タイマー（通信断・スリープ復帰時も120分期限で確実に自動停止）
  deadlineTimer = setInterval(() => {
    if (activeConfig && sessionExpiresAt && Date.now() >= sessionExpiresAt) {
      stopOverlay()
      sendControl('overlay:status', {
        running: false,
        message: '授業終了（120分経過により自動停止しました）',
      })
    }
  }, 3000)

  return { ok: true }
}

ipcMain.handle('overlay:get-initial-state', async () => {
  if (readConfig().pendingStop && !stateSyncBusy) {
    stateSyncBusy = true
    try { await retryPendingStop() } catch (error) {
      console.warn('[SupporTalk] Pending stop confirmation:', error.message)
    } finally { stateSyncBusy = false }
  }
  return {
    config: { ...readConfig(), teacherPassword: undefined, encryptedTeacherPassword: undefined },
    displays: displayOptions(),
    running: Boolean(activeConfig),
    controlShortcut,
  }
})

ipcMain.handle('overlay:detect-latest', async (_event, requestedSessionId) => {
  const cfg = readConfig()
  const origin = cfg.serverOrigin || (cfg.screenUrl ? new URL(cfg.screenUrl).origin : null)
  const targets = origin ? [origin] : ['http://localhost:3000','http://localhost:3001']
  const unique = [...new Set(targets)]
  const teacherPwd = getTeacherPassword()
  const headers = {}
  if (teacherPwd) {
    headers['x-teacher-password'] = teacherPwd
  }

  const query = requestedSessionId ? `?sessionId=${encodeURIComponent(requestedSessionId)}` : ''

  for (const baseUrl of unique) {
    try {
      const res = await fetch(`${baseUrl}/api/screen/latest${query}`, { headers, signal: AbortSignal.timeout(4000) })
      if (res.ok) {
        const json = await res.json()
        if (json.screenUrl) {
          const slug=parseScreenUrl(json.screenUrl).screenSlug
          const screenUrl=`${baseUrl}/screen/${slug}`
          saveConfig({ ...readConfig(), serverOrigin: baseUrl, screenUrl, activeSessionId: json.sessionId })
          const deadline = json.classStartedAt ? Date.parse(json.classStartedAt) + 120 * 60 * 1000 : NaN
          const runningClass = json.status === 'in_progress' && json.isCurrentTarget !== false && !json.autoExpiredAt && Number.isFinite(deadline) && Date.now() < deadline
          if (runningClass) keepDeadline(deadline)
          else clearClassTimers()
          return {
            ok: true,
            baseUrl,
            sessionId: json.sessionId,
            status: json.status,
            autoExpiredAt: json.autoExpiredAt,
            sessionNumber: json.sessionNumber,
            scheduledAt: json.scheduledAt,
            screenUrl,
            entryUrl: json.entryUrl,
            classStartedAt: json.classStartedAt,
            projectionStatus: json.projectionStatus,
            reactionMode: json.reactionMode,
            reactionStatus: json.reactionStatus,
            pdfFilePath: json.pdfFilePath,
            isCurrentTarget: json.isCurrentTarget,
            sessions: json.sessions || [],
          }
        }
      }
    } catch {}
  }
  throw new Error('利用可能な授業回を自動検出できませんでした。')
})

// Exit only this PC's app. Ending a classroom remains an explicit separate operation.
let quitDialogOpen = false
ipcMain.handle('overlay:quit-app', async (event) => {
  if (!controlWindow || event.sender !== controlWindow.webContents) throw new Error('Invalid control sender')
  if (quitDialogOpen) return { ok: false, cancelled: true }
  quitDialogOpen = true
  try {
    const result = await dialog.showMessageBox(controlWindow, {
      type: 'question', title: 'SupporTalkを完全終了',
      message: 'このPCのSupporTalkアプリを終了しますか？',
      detail: 'このPCの音声取得・コメント投影・QR表示を停止します。サーバーの授業は終了しません。授業も終える場合は「戻る」を選び、先に「授業を完全終了」を押してください。',
      buttons: ['戻る', 'アプリを終了'], defaultId: 0, cancelId: 0, noLink: true,
    })
    if (result.response !== 1) return { ok: false, cancelled: true }
    isQuitting = true
    stopAudioCapture(); stopOverlay(); hideQrWindow(); clearClassTimers()
    app.quit()
    return { ok: true }
  } finally { quitDialogOpen = false }
})

ipcMain.handle('overlay:open-admin', async () => {
  const origin = appOrigin()
  await shell.openExternal(`${origin}/admin`)
  return { ok: true }
})

ipcMain.handle('overlay:control-session', async (_event, action, sessionId) => {
  if(action==='start'){audioCheckController?.abort();sendControl('overlay:stop-audio-check')}
  if(action==='stop'){saveConfig({...readConfig(),pendingStop:{sessionId,origin:appOrigin()}});stopAudioCapture();stopOverlay();hideQrWindow()}
  const origin = appOrigin()
  const teacherPwd = getTeacherPassword()
  const headers = { 'Content-Type': 'application/json' }
  if (teacherPwd) headers['x-teacher-password'] = teacherPwd

  const res = await fetch(`${origin}/api/teacher/session-control`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ action, sessionId }),
    signal: AbortSignal.timeout(5000),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    throw new Error(data.error || `操作に失敗しました (HTTP ${res.status})`)
  }

  if (data.success === false) throw new Error(data.error || '操作を実行できませんでした。')
  saveConfig({ ...readConfig(), activeSessionId: sessionId, ...(action==='stop'?{pendingStop:null}:{}) })
  if (data.classStartedAt) keepDeadline(Date.parse(data.classStartedAt) + 120 * 60 * 1000)
  if (action === 'pause_ai' || action === 'stop') stopAudioCapture()
  if (action === 'stop') { stopOverlay(); hideQrWindow(); clearClassTimers() }

  return { ok: true, data }
})

ipcMain.handle('overlay:stop-audio', () => { stopAudioCapture(); return { ok: true } })

ipcMain.handle('overlay:cancel-audio-check', (event) => {
  if (!controlWindow || event.sender !== controlWindow.webContents) throw new Error('Invalid audio sender')
  audioCheckController?.abort()
  return { ok: true }
})
ipcMain.handle('overlay:check-audio', async (event, segment) => {
  if (!controlWindow || event.sender !== controlWindow.webContents) throw new Error('Invalid audio sender')
  if (sessionControlDeadline && Date.now() < sessionControlDeadline) return { ok: false, error: '授業中は本番の音声取得を使用します。' }
  if (audioCheckController) return { ok: false, error: '音声チェックの終了を待ってください。' }
  if (!segment || typeof segment.base64 !== 'string' || segment.base64.length > 1250000 || !/^[A-Za-z0-9+/]*={0,2}$/.test(segment.base64) || !['audio/webm','audio/ogg','audio/mp4'].includes(segment.mimeType?.split(';')[0])) throw new Error('Invalid check audio')
  const bytes = Buffer.from(segment.base64, 'base64')
  if (!bytes.length || bytes.length > 900 * 1024) throw new Error('Invalid check audio size')
  const controller = new AbortController()
  audioCheckController = controller
  try {
    const form = new FormData()
    form.append('audio', new Blob([bytes], { type: segment.mimeType }), 'microphone-check.webm')
    const response = await fetch(`${appOrigin()}/api/teacher/audio-check`, {
      method: 'POST', headers: { 'x-teacher-password': getTeacherPassword() }, body: form,
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(35000)]),
    })
    const data = await response.json().catch(() => ({}))
    return { ...data, ok: response.ok, status: response.status }
  } catch { return { ok: false, error: '音声チェックを完了できませんでした。接続を確認して再試行してください。' } }
  finally { if (audioCheckController === controller) audioCheckController = null }
})

ipcMain.handle('overlay:send-audio-segments', async (event, sessionId, segments) => {
  if (!controlWindow || event.sender !== controlWindow.webContents) throw new Error('Invalid audio sender')
  if (!/^[0-9a-f-]{36}$/i.test(sessionId) || !Array.isArray(segments) || segments.length < 1 || segments.length > 7) throw new Error('Invalid audio request')
  const cfg = readConfig()
  if (cfg.activeSessionId !== sessionId) throw new Error('音声の授業回が一致しません。')
  if (!sessionControlDeadline || Date.now() >= sessionControlDeadline) {
    stopAudioCapture()
    return { ok: false, status: 409, error: '授業の音声取得は終了しました。' }
  }
  const origin = appOrigin()
  const form = new FormData()
  form.append('sessionId', sessionId)
  let total = 0
  for (const seg of segments) {
    if (typeof seg.base64 !== 'string' || seg.base64.length > 8 * 1024 * 1024 || !/^[A-Za-z0-9+/]*={0,2}$/.test(seg.base64) || !['audio/webm','audio/ogg','audio/mp4'].includes(seg.mimeType?.split(';')[0])) throw new Error('Invalid audio segment')
    const bytes = Buffer.from(seg.base64, 'base64')
    total += bytes.length
    if (!bytes.length || total > 15 * 1024 * 1024) throw new Error('音声データが大きすぎます。')
    form.append('audio', new Blob([bytes], { type: seg.mimeType }), 'recent-lecture.webm')
  }
  if (audioRequestController) return { ok: false, error: '音声処理中です。' }
  const controller = new AbortController()
  audioRequestController = controller
  try {
    const response = await fetch(`${origin}/api/teacher/lecture-context`, {
      method: 'POST', headers: { 'x-teacher-password': getTeacherPassword() }, body: form,
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(35000)]),
    })
    const data = await response.json().catch(() => ({}))
    return { ok: response.ok, status: response.status, ...data }
  } catch { return { ok: false, error: '音声を送信できませんでした。投影と投稿受付は継続します。' } }
  finally { if (audioRequestController === controller) audioRequestController = null }
})

ipcMain.handle('overlay:configure-connection', async (_event, input) => {
  const origin = new URL(input.origin).origin
  const url = new URL(origin)
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost','127.0.0.1'].includes(url.hostname))) throw new Error('公開環境はHTTPSで接続してください。')
  const pwd = (typeof input?.password === 'string' && input.password.trim().length >= 12) ? input.password.trim() : getTeacherPassword()
  if (!pwd || pwd.length < 12) throw new Error('教授用パスワードを確認してください。')
  const res = await fetch(`${origin}/api/screen/latest`, { headers: { 'x-teacher-password': pwd }, signal: AbortSignal.timeout(5000) })
  if (res.status === 401) throw new Error('教授用パスワードが違います。')
  if (!res.ok) {
    const errData = await res.json().catch(() => ({}))
    throw new Error(errData.error || '接続先・019のDB反映・授業回の準備を確認してください。')
  }
  runtimePassword = pwd
  const cfg = { ...readConfig(), serverOrigin: origin }
  delete cfg.teacherPassword
  if (safeStorage.isEncryptionAvailable()) cfg.encryptedTeacherPassword = safeStorage.encryptString(pwd).toString('base64')
  saveConfig(cfg)
  return { ok: true }
})

ipcMain.handle('overlay:start', async (_event, rawConfig) => {
  return await startOverlay(rawConfig)
})

ipcMain.handle('overlay:stop', () => { stopOverlay(); return { ok: true } })

ipcMain.handle('overlay:test', () => {
  if (!overlayWindow || overlayWindow.isDestroyed()) throw new Error('先に投影を開始してください。')
  // 4. 設定されたAI条件に従わせる（AIなし条件時はAI返信なしのhuman_onlyテスト投稿）
  const isAiOff = currentReactionAiMode === 'off' || currentReactionAiStatus === 'stopped'
  const testEvent = {
    cursor: -1,
    isDemo: true,
    eventType: isAiOff ? 'human_only' : 'paired',
    humanPost: {
      id: -1,
      authorDisplayName: '研究デモ',
      authorType: 'human',
      message: isAiOff ? '研究用デモ投稿（AIなし条件）: スクリーン上に字幕が流れています' : '研究用デモ投稿: スクリーン上に字幕が流れています',
      createdAt: new Date().toISOString(),
    },
    aiReply: isAiOff ? null : {
      id: -2,
      authorDisplayName: 'SupporTalk AI',
      authorType: 'ai',
      message: 'AI返信もこのようにペアで従属表示されます',
      createdAt: new Date().toISOString(),
    },
    createdAt: new Date().toISOString(),
  }

  // レンダラーに送信（描画後に renderer から overlay:rendered が返る）
  overlayWindow.webContents.send('overlay:events', {
    events: [testEvent],
    posts: [],
    durationSeconds: activeConfig?.durationSeconds || 12,
    fontScale: activeConfig?.fontScale || 1,
  })
  return { ok: true }
})

ipcMain.handle('overlay:open-screen', async (_event, value) => {
  const parsed = parseScreenUrl(value)
  await shell.openExternal(`${parsed.origin}/screen/${parsed.screenSlug}`)
  return { ok: true }
})

ipcMain.handle('overlay:show-qr', async (_event, value, displayId) => {
  if (displayId !== undefined) saveConfig({ ...readConfig(), displayId: String(displayId) })
  await showQrWindow(value)
  return { ok: true }
})

ipcMain.handle('overlay:hide-qr', () => {
  hideQrWindow()
  return { ok: true }
})

// 5. rendererからの実描画コールバック
ipcMain.on('overlay:rendered', async (ipcEvent, data) => {
  if (!overlayWindow || ipcEvent.sender !== overlayWindow.webContents || !data) return

  // デモ投稿の実描画通知（viewport_entered 時にサーバーへ記録）
  if (data.isDemo && activeConfig) {
    try {
      const parsed = parseScreenUrl(activeConfig.screenUrl)
      const res = await fetch(`${parsed.origin}/api/screen/${encodeURIComponent(parsed.screenSlug)}/render`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          isDemo: true,
          phase: 'demo_viewport_entered',
          renderedAt: data.renderedAt || Date.now(),
        }),
        signal: AbortSignal.timeout(5000),
      })
      if (!res.ok) {
        const errJson = await res.json().catch(() => ({}))
        throw new Error(errJson.error || `HTTP ${res.status}`)
      }
      console.log('[Overlay Demo] Actual demo projection timestamp recorded by renderer callback!')
    } catch (err) {
      console.warn('デモ実投影時刻の保存に失敗しました:', err)
    }
    return
  }

  if (!Number.isSafeInteger(data.eventId)) return
  const sent = sentEvents.get(data.eventId)
  if (!sent || !['dom_added', 'viewport_entered'].includes(data.phase) || !Number.isFinite(data.renderedAt)) return

  if(data.phase==='viewport_entered')acknowledgeDelivery(data.eventId)

  try {
    const response = await fetch(`${sent.parsed.origin}/api/screen/${encodeURIComponent(sent.parsed.screenSlug)}/render`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        eventId: data.eventId,
        clientInstanceId,
        phase: data.phase,
        renderedAt: data.renderedAt,
        dispatchedAt: sent.dispatchedAt,
      }),
      signal: AbortSignal.timeout(5000),
    })
    if (!response.ok) throw new Error(`Render log HTTP ${response.status}`)
  } catch {
    console.warn('投影は継続中ですが、表示ログの保存に失敗しました。')
  }
})

function registerControlShortcuts() {
  for (const key of ['CommandOrControl+Alt+S','CommandOrControl+Alt+T']) {
    if (globalShortcut.register(key, () => {
      console.log(`[SupporTalk] Global shortcut ${key} triggered: showing control window.`)
      createControlWindow()
    })) {
      controlShortcut = key
      console.log(`[SupporTalk] Successfully registered global shortcut: ${key}`)
      break
    }
  }
  return controlShortcut
}

app.whenReady().then(() => {
  // Only our local control window may request an audio device. No Chrome worker.
  session.defaultSession.setPermissionRequestHandler((contents, permission, callback, details) => {
    callback(permission === 'media' && contents === controlWindow?.webContents &&
      (!details.mediaTypes || details.mediaTypes.every(type => type === 'audio')))
  })
  session.defaultSession.setPermissionCheckHandler((contents, permission) =>
    permission === 'media' && contents === controlWindow?.webContents)
  powerMonitor?.on('resume',()=>{if(sessionControlDeadline&&Date.now()>=sessionControlDeadline){stopAudioCapture();stopOverlay();hideQrWindow();clearClassTimers()}else void syncClassState()})
  const displaysChanged=()=>sendControl('overlay:displays',{displays:displayOptions()})
  screen.on?.('display-added',displaysChanged)
  screen.on?.('display-removed',(_event,display)=>{
    if(activeConfig&&String(activeConfig.displayId)===String(display.id)){
      stopOverlay();hideQrWindow()
      sendControl('overlay:status',{running:false,message:'投影先の接続が外れました。表示する画面を選び、投影を再試行してください。'})
    }
    displaysChanged()
  })
  try{if(readConfig().pendingStop){stateSyncTimer=setInterval(()=>void syncClassState(),5000);void syncClassState()}}catch{console.warn('保存された接続設定を確認してください。')}
  registerControlShortcuts()
  createTray()
  createControlWindow()

  // 初回起動時の引数処理（supportalk:// プロトコル起動）
  const startupProtocolUrl = findProtocolArg(process.argv)
  if (startupProtocolUrl) {
    void handleProtocolUrl(startupProtocolUrl)
  }

  app.on('activate', () => createControlWindow())
})

app.on('window-all-closed', () => {
  // 操作画面を閉じてもタスクトレイで投影を継続する。
})

app.on('before-quit', () => {
  isQuitting = true
  globalShortcut.unregisterAll()
  if (pollTimer) clearInterval(pollTimer)
  if (deadlineTimer) clearInterval(deadlineTimer)
  if (sessionControlTimer) clearInterval(sessionControlTimer)
  if (stateSyncTimer) clearInterval(stateSyncTimer)
  stopAudioCapture()
})
