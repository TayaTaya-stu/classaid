const $ = (id) => document.getElementById(id)
const api = window.classroomOverlay

function formConfig() {
  return {
    screenUrl: $('screenUrl').value.trim(),
    displayId: $('displayId').value,
    durationSeconds: Number($('durationSeconds').value),
    fontScale: Number($('fontScale').value),
  }
}

function showStatus(message, type = '') {
  $('status').textContent = message
  $('status').className = `status ${type}`
}

function setBusy(busy) {
  document.querySelectorAll('button').forEach((button) => { button.disabled = busy })
}

async function run(action) {
  setBusy(true)
  try {
    await action()
  } catch (error) {
    showStatus(error?.message || '操作に失敗しました。', 'error')
  } finally {
    setBusy(false)
  }
}

api.getInitialState().then(({ config, displays, running }) => {
  $('screenUrl').value = config.screenUrl || ''
  $('durationSeconds').value = config.durationSeconds || 12
  $('fontScale').value = String(config.fontScale || 1)
  displays.forEach((display) => {
    const option = document.createElement('option')
    option.value = display.id
    option.textContent = display.label
    option.selected = String(config.displayId) === display.id
    $('displayId').append(option)
  })
  showStatus(running ? '接続中' : '停止中', running ? 'running' : '')
})

$('start').addEventListener('click', () => run(async () => {
  await api.start(formConfig())
  showStatus('接続中', 'running')
}))
$('stop').addEventListener('click', () => run(async () => {
  await api.stop()
  showStatus('停止中')
}))
$('test').addEventListener('click', () => run(() => api.test()))
$('openScreen').addEventListener('click', () => run(() => api.openScreen($('screenUrl').value.trim())))
api.onStatus(({ running, message }) => showStatus(message, running ? (message === '接続中' ? 'running' : 'error') : ''))
