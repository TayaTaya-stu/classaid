const params = new URLSearchParams(window.location.search)
const qrUrl = params.get('qrUrl') || ''
const entryUrl = params.get('entryUrl') || ''

document.getElementById('qr').src = qrUrl
document.getElementById('qr').title = entryUrl
document.getElementById('hide').addEventListener('click', () => {
  void window.classroomOverlay.hideQr()
})
