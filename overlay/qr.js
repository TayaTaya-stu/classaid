const params = new URLSearchParams(window.location.search)
const qrUrl = params.get('qrUrl') || ''
const entryUrl = params.get('entryUrl') || ''

document.getElementById('entryUrl').textContent = entryUrl
const image=document.getElementById('qr')
image.onerror=()=>{document.getElementById('entryUrl').textContent='QRを取得できません。接続を確認し、表示し直してください。URL: '+entryUrl}
image.src=qrUrl
document.getElementById('qr').title = entryUrl
document.getElementById('hide').addEventListener('click', () => {
  void window.classroomOverlay.hideQr()
})

function fitQr(){
  const main=document.querySelector('main')
  const fixed=['header','#entryUrl','#cameraHint','#resizeHint'].reduce((sum,selector)=>sum+document.querySelector(selector).getBoundingClientRect().height,0)
  const size=Math.max(32,Math.min(main.clientWidth-24,main.clientHeight-fixed-48))
  main.style.setProperty('--qr-size',`${Math.floor(size)}px`)
}
new ResizeObserver(fitQr).observe(document.querySelector('main'))
image.addEventListener('load',fitQr)
fitQr()
