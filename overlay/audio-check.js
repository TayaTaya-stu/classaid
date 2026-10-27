// A one-shot pre-class microphone check. Independent of the lecture recorder.
class SupporTalkAudioCheck {
  constructor({ send, cancelSend, onState, onLevel, onResult, mediaDevices, Recorder, AudioContextClass, encode } = {}) {
    Object.assign(this, { send, cancelSend, onState, onLevel, onResult })
    this.mediaDevices = mediaDevices || globalThis.navigator?.mediaDevices
    this.Recorder = Recorder || globalThis.MediaRecorder
    this.AudioContextClass = AudioContextClass || globalThis.AudioContext || globalThis.webkitAudioContext
    this.encode = encode || (blob => new Promise((resolve, reject) => {
      const reader = new FileReader(); reader.onload = () => resolve(String(reader.result).split(',')[1]); reader.onerror = reject; reader.readAsDataURL(blob)
    }))
    this.generation = 0; this.active = false
  }
  release() {
    this.cancelWait?.(); this.cancelWait = null
    clearTimeout(this.permissionTimer); clearTimeout(this.captureTimer); clearInterval(this.meterTimer)
    this.permissionTimer = this.captureTimer = this.meterTimer = null
    if (this.recorder) {
      this.recorder.onstop = this.recorder.ondataavailable = this.recorder.onerror = null
      try { if (this.recorder.state !== 'inactive') this.recorder.stop() } catch {}
      this.recorder = null
    }
    this.stream?.getTracks().forEach(track => track.stop()); this.stream = null
    if (this.context) { void this.context.close().catch(() => {}); this.context = null }
    this.onLevel?.(0)
  }
  stop() {
    const wasActive = this.active
    this.generation++; this.active = false; this.release()
    if (wasActive) { void Promise.resolve(this.cancelSend?.()).catch(() => {}); this.onState?.('stopped', '音声チェックを停止しました。') }
  }
  async start() {
    if (this.active) return
    const generation = ++this.generation
    const current = () => this.active && generation === this.generation
    this.active = true
    this.onState?.('permission', 'マイクの許可を確認中…')
    try {
      if (!this.mediaDevices?.getUserMedia || !this.Recorder || !this.AudioContextClass) throw new Error('マイクの取得に対応していません。')
      const stream = await new Promise((resolve, reject) => {
        this.cancelWait = () => reject(new Error('音声チェックを停止しました。'))
        this.permissionTimer = setTimeout(() => reject(new Error('マイクの使用を許可して再試行してください。')), 30000)
        this.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } }).then(value => {
          if (!current()) { value.getTracks().forEach(track => track.stop()); resolve(null) } else resolve(value)
        }, reject)
      })
      this.cancelWait = null
      clearTimeout(this.permissionTimer)
      if (!stream || !current()) return
      this.stream = stream
      stream.getTracks().forEach(track => track.addEventListener('ended', () => { if (current()) this.stop() }, { once: true }))
      const context = this.context = new this.AudioContextClass()
      await context.resume()
      if (!current()) return
      const analyser = context.createAnalyser(); analyser.fftSize = 1024
      context.createMediaStreamSource(stream).connect(analyser)
      const samples = new Float32Array(analyser.fftSize)
      let audibleSamples = 0
      this.meterTimer = setInterval(() => {
        if (!current()) return
        analyser.getFloatTimeDomainData(samples)
        const rms = Math.sqrt(samples.reduce((sum, value) => sum + value * value, 0) / samples.length)
        if (rms >= 0.008) audibleSamples++
        this.onLevel?.(Math.min(100, Math.round(rms * 600)))
      }, 50)
      const type = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'].find(value => this.Recorder.isTypeSupported(value))
      const recorder = this.recorder = type ? new this.Recorder(stream, { mimeType: type }) : new this.Recorder(stream)
      const parts = []
      const blob = await new Promise((resolve, reject) => {
        this.cancelWait = () => reject(new Error('音声チェックを停止しました。'))
        recorder.ondataavailable = event => { if (event.data.size) parts.push(event.data) }
        recorder.onerror = () => reject(new Error('録音できませんでした。マイクを確認してください。'))
        recorder.onstop = () => resolve(new Blob(parts, { type: recorder.mimeType || 'audio/webm' }))
        recorder.start()
        this.onState?.('recording', '5秒録音中です。マイクに向かって話してください。')
        this.captureTimer = setTimeout(() => { if (current() && recorder.state === 'recording') recorder.stop() }, 5000)
      })
      this.cancelWait = null
      if (!current()) return
      this.release()
      if (audibleSamples < 4) throw new Error('十分な音を確認できませんでした。マイク・入力音量を確認して再試行してください。')
      if (!blob.size || blob.size > 900 * 1024) throw new Error('録音データが対象外です。再試行してください。')
      this.onState?.('transcribing', '録音終了。文字起こしを確認中…')
      const base64 = await this.encode(blob)
      if (!current()) return
      const result = await this.send({ base64, mimeType: blob.type })
      if (!current()) return
      if (!result.ok) throw new Error(result.error || '音声チェックに失敗しました。')
      this.onResult?.(result)
      this.onState?.('done', result.transcript ? '文字起こしを確認できました。' : '発話を認識できませんでした。もう一度、話して確認してください。')
    } catch (error) { if (current()) this.onState?.('error', error.message || '音声チェックに失敗しました。') }
    finally { if (generation === this.generation) { this.active = false; this.release(); this.onState?.('idle') } }
  }
}
globalThis.SupporTalkAudioCheck = SupporTalkAudioCheck
