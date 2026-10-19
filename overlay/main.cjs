const { app, BrowserWindow, ipcMain, screen, shell } = require('electron')
const path = require('node:path')
const fs = require('node:fs')

let controlWindow = null
let overlayWindow = null
let pollTimer = null
let lastPostId = null
let activeConfig = null

const configPath = () => path.join(app.getPath('userData'), 'overlay-config.json')

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
  controlWindow.on('closed', () => { controlWindow = null })
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

async function pollPosts() {
  if (!activeConfig || !overlayWindow || overlayWindow.isDestroyed()) return
  try {
    const parsed = parseScreenUrl(activeConfig.screenUrl)
    const suffix = lastPostId === null ? '' : `?afterId=${lastPostId}`
    const response = await fetch(`${parsed.origin}/api/screen/${encodeURIComponent(parsed.screenSlug)}/posts${suffix}`)
    const data = await response.json()
    if (!response.ok) throw new Error(data.error || '投稿を取得できませんでした。')
    const posts = Array.isArray(data.posts) ? data.posts : []
    if (lastPostId === null) {
      lastPostId = posts.at(-1)?.id ?? 0
    } else if (posts.length) {
      lastPostId = posts.at(-1).id
      overlayWindow.webContents.send('overlay:posts', {
        posts,
        durationSeconds: activeConfig.durationSeconds,
        fontScale: activeConfig.fontScale,
      })
    }
    controlWindow?.webContents.send('overlay:status', { running: true, message: '接続中', lastPostId })
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
  lastPostId = null
  createOverlayWindow(config)
  await pollPosts()
  pollTimer = setInterval(() => void pollPosts(), 3000)
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

app.whenReady().then(() => {
  createControlWindow()
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createControlWindow() })
})

app.on('window-all-closed', () => {
  stopOverlay()
  if (process.platform !== 'darwin') app.quit()
})
