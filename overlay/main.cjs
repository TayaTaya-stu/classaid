const { app, BrowserWindow, ipcMain, screen, shell, Tray, Menu, nativeImage, globalShortcut } = require('electron')
const path = require('node:path')
const fs = require('node:fs')

let controlWindow = null
let overlayWindow = null
let qrWindow = null
let tray = null
let isQuitting = false
let pollTimer = null
let lastCursor = null
let activeConfig = null

const configPath = () => path.join(app.getPath('userData'), 'overlay-config.json')
const hasSingleInstanceLock = app.requestSingleInstanceLock()

if (!hasSingleInstanceLock) app.quit()
app.on('second-instance', () => {
  if (app.isReady()) createControlWindow()
})

function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(configPath(), 'utf8'))
  } catch {
    return { screenUrl: '', displayId: '', durationSeconds: 12, fontScale: 1 }
  }
}

function saveConfig(config) {
  fs.writeFileSync(configPath(), JSON.stringify(config, null, 2), 'utf8')
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
    controlWindow.show()
    controlWindow.focus()
    return
  }
  controlWindow = new BrowserWindow({
    width: 520,
    height: 610,
    minWidth: 460,
    minHeight: 520,
    title: '授業コメント投影コントロール',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  })
  controlWindow.loadFile(path.join(__dirname, 'control.html'))
  controlWindow.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault()
      controlWindow.hide()
    }
  })
  controlWindow.on('closed', () => { controlWindow = null })
}

function createTray() {
  if (tray) return
  const icon = nativeImage.createFromBuffer(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAt0lEQVR4nO2WXQ7CIBCEt6SHqMdUPEbFY+It9MG0krIL0rKDJsxTkyEzX/gtUVdjDZIxnednzaLH/cp2GUR5KjMC0ChPZZvcAG0IIxkoCHYPINUB/gPAO0ve2are1wBhwDZsr1cEoK0swOlyY7+PeKHWBwJ5ERF9HqffX4IOAAOQ/lg0FHYZyUCURwDaEFw2uwc0IKTMbFHqgqoBuvsU1JqlsVXxoqIZQB5VInqvP/qRigCalaP0Ao3/VaTQPAbmAAAAAElFTkSuQmCC', 'base64'))
  tray = new Tray(icon.resize({ width: 20, height: 20 }))
  tray.setToolTip('授業コメント投影')
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
      sandbox: true,
    },
  })
  overlayWindow.setAlwaysOnTop(true, 'screen-saver')
  overlayWindow.setIgnoreMouseEvents(true, { forward: true })
  overlayWindow.loadFile(path.join(__dirname, 'overlay.html'))
  overlayWindow.once('ready-to-show', () => overlayWindow?.showInactive())
  overlayWindow.on('closed', () => { overlayWindow = null })
}

async function showQrWindow(value) {
  const parsed = parseScreenUrl(value)
  const response = await fetch(`${parsed.origin}/api/screen/${encodeURIComponent(parsed.screenSlug)}/posts`)
  const data = await response.json()
  if (!response.ok || !data.entryPath) throw new Error(data.error || '学生入室URLを取得できませんでした。')
  const entryUrl = `${parsed.origin}${data.entryPath}`
  const qrUrl = `${parsed.origin}/api/screen/qr?target=${encodeURIComponent(entryUrl)}`

  if (qrWindow && !qrWindow.isDestroyed()) {
    qrWindow.show()
    qrWindow.focus()
    return
  }

  const display = screen.getPrimaryDisplay()
  const width = 292
  const height = 350
  qrWindow = new BrowserWindow({
    width,
    height,
    x: display.workArea.x + display.workArea.width - width - 20,
    y: display.workArea.y + 20,
    minWidth: 250,
    minHeight: 300,
    frame: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: true,
    title: '学生入室QRコード',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  })
  qrWindow.setAlwaysOnTop(true, 'floating')
  await qrWindow.loadFile(path.join(__dirname, 'qr.html'), { query: { qrUrl, entryUrl } })
  qrWindow.on('closed', () => { qrWindow = null })
}

function hideQrWindow() {
  if (qrWindow && !qrWindow.isDestroyed()) qrWindow.hide()
}

async function pollPosts() {
  if (!activeConfig || !overlayWindow || overlayWindow.isDestroyed()) return
  try {
    const parsed = parseScreenUrl(activeConfig.screenUrl)
    const suffix = lastCursor === null ? '' : `?afterCursor=${lastCursor}`
    const fetchStart = Date.now()
    const response = await fetch(`${parsed.origin}/api/screen/${encodeURIComponent(parsed.screenSlug)}/posts${suffix}`)
    const data = await response.json()
    if (!response.ok) throw new Error(data.error || '投稿を取得できませんでした。')

    const events = Array.isArray(data.events) ? data.events : []
    const posts = Array.isArray(data.posts) ? data.posts : []
    const nextCursor = data.cursor ?? posts.at(-1)?.id ?? 0

    if (lastCursor === null) {
      // 意図した仕様: 起動前の古い投稿は一斉に流さず、初期カーソルのみ設定
      lastCursor = nextCursor
    } else if (events.length || posts.length) {
      lastCursor = nextCursor

      // 送出遅延（投稿作成時刻からIPC送出完了までの時間）の計測
      const now = Date.now()
      events.forEach((ev) => {
        const postTime = new Date(ev.humanPost.createdAt).getTime()
        const dispatchLatencyMs = now - postTime
        console.log(`[Overlay Dispatch] Event #${ev.cursor} (${ev.eventType}) 送出遅延(dispatch latency): ${dispatchLatencyMs}ms (API fetch: ${now - fetchStart}ms)`)
      })

      // 新基盤: ペアイベント送信
      overlayWindow.webContents.send('overlay:events', {
        events,
        posts, // 後方互換用
        durationSeconds: activeConfig.durationSeconds,
        fontScale: activeConfig.fontScale,
      })

      // 互換用チャンネル
      overlayWindow.webContents.send('overlay:posts', {
        posts,
        durationSeconds: activeConfig.durationSeconds,
        fontScale: activeConfig.fontScale,
      })
    }
    controlWindow?.webContents.send('overlay:status', { running: true, message: '接続中', lastPostId: lastCursor })
  } catch (error) {
    controlWindow?.webContents.send('overlay:status', {
      running: true,
      message: error instanceof Error ? error.message : '接続に失敗しました。',
    })
  }
}

function stopOverlay() {
  if (pollTimer) clearInterval(pollTimer)
  pollTimer = null
  activeConfig = null
  lastCursor = null
  lastPostId = null
  if (overlayWindow && !overlayWindow.isDestroyed()) overlayWindow.close()
  overlayWindow = null
  controlWindow?.webContents.send('overlay:status', { running: false, message: '停止中' })
}

ipcMain.handle('overlay:get-initial-state', () => ({
  config: readConfig(),
  displays: displayOptions(),
  running: Boolean(activeConfig),
}))

ipcMain.handle('overlay:start', async (_event, rawConfig) => {
  const parsed = parseScreenUrl(rawConfig?.screenUrl || '')
  const config = {
    screenUrl: `${parsed.origin}/screen/${parsed.screenSlug}`,
    displayId: String(rawConfig?.displayId || ''),
    durationSeconds: Math.min(30, Math.max(5, Number(rawConfig?.durationSeconds) || 12)),
    fontScale: Math.min(1.6, Math.max(0.7, Number(rawConfig?.fontScale) || 1)),
  }
  saveConfig(config)
  stopOverlay()
  activeConfig = config
  lastCursor = null
  createOverlayWindow(config)
  await pollPosts()
  // 3秒目標に向けてポーリング間隔を1.5秒（1500ms）に最適化
  pollTimer = setInterval(() => void pollPosts(), 1500)
  return { ok: true }
})

ipcMain.handle('overlay:stop', () => { stopOverlay(); return { ok: true } })
ipcMain.handle('overlay:test', () => {
  if (!overlayWindow || overlayWindow.isDestroyed()) throw new Error('先に投影を開始してください。')
  overlayWindow.webContents.send('overlay:posts', {
    posts: [{ id: `test-${Date.now()}`, authorDisplayName: 'テスト学生', authorType: 'human', audienceType: 'room', message: 'コメントはこのように画面上へ流れます' }],
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
ipcMain.handle('overlay:show-qr', async (_event, value) => {
  await showQrWindow(value)
  return { ok: true }
})
ipcMain.handle('overlay:hide-qr', () => {
  hideQrWindow()
  return { ok: true }
})

// rendererプロセスで実際にDOM追加・描画が開始された時刻の通知
ipcMain.on('overlay:rendered', (_event, data) => {
  if (!data || !data.eventId) return
  const postTime = data.humanPostCreatedAt ? new Date(data.humanPostCreatedAt).getTime() : 0
  const renderLatencyMs = postTime > 0 ? (data.renderedAt - postTime) : null
  const latencyLabel = renderLatencyMs !== null ? `${renderLatencyMs}ms` : '不明'
  console.log(`[Overlay Render] Event #${data.eventId} 実描画開始(rendered). 投稿から実描画開始までの遅延: ${latencyLabel} (※端末時計差を含む参考値)`)
})

app.whenReady().then(() => {
  createTray()
  createControlWindow()
  globalShortcut.register('CommandOrControl+Shift+O', () => createControlWindow())
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createControlWindow() })
})

app.on('window-all-closed', () => {
  // 操作画面を閉じてもタスクトレイで投影を継続する。
})

app.on('before-quit', () => {
  isQuitting = true
  globalShortcut.unregisterAll()
  if (pollTimer) clearInterval(pollTimer)
})
