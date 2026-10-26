// Shared Wall startAudioReference adapted to automatic background submission.
// Each 15s segment is a complete MediaRecorder file; never split a WebM stream.
class SupporTalkAudioReference {
  constructor({ send, onState, onSaved, encode, mediaDevices, Recorder } = {}) {
    this.send = send
    this.onState = onState || (() => {})
    this.onSaved = onSaved || (() => {})
    this.encode = encode || ((blob) => new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(String(reader.result).split(',')[1])
      reader.onerror = reject
      reader.readAsDataURL(blob)
    }))
    this.mediaDevices = mediaDevices || globalThis.navigator?.mediaDevices
    this.Recorder = Recorder || globalThis.MediaRecorder
    this.run = null
    this.generation = 0
  }
  stop() {
    this.generation += 1
    const run = this.run
    this.run = null
    if (run) {
      clearTimeout(run.segmentTimer); clearTimeout(run.deadlineTimer); clearInterval(run.purgeTimer)
      run.chunks = []
      if (run.recorder) {
        run.recorder.onstop = null; run.recorder.ondataavailable = null; run.recorder.onerror = null
        try { if (run.recorder.state === 'recording') run.recorder.stop() } catch {}
      }
      run.stream?.getTracks().forEach(track => track.stop())
    }
    this.onState('stopped')
  }
  async start(sessionId, expiresAt) {
    this.stop()
    const generation = this.generation
    if (!Number.isFinite(expiresAt) || Date.now() >= expiresAt) throw new Error('授業の終了時刻を確認してください。')
    if (!this.mediaDevices?.getUserMedia || !this.Recorder) throw new Error('マイクの取得に対応していません。')
    this.onState('starting')
    let permissionTimer
    let stream
    try {
      stream=await new Promise((resolve,reject)=>{
        permissionTimer=setTimeout(()=>{if(generation===this.generation)this.stop();reject(new Error('マイク許可を確認できません。許可してから再試行してください。'))},30000)
        this.mediaDevices.getUserMedia({audio:{echoCancellation:true,noiseSuppression:true}}).then(value=>{
          if(generation!==this.generation||Date.now()>=expiresAt){value.getTracks().forEach(track=>track.stop());resolve(null)}else resolve(value)
        },reject)
      })
    } catch(error){this.onState('error',error.message);throw error}
    finally{clearTimeout(permissionTimer)}
    if(!stream)return false
    if (generation !== this.generation || Date.now() >= expiresAt) { stream.getTracks().forEach(track => track.stop()); return false }
    const run = { sessionId, expiresAt, stream, chunks: [], serial: 0, sending: false }
    this.run = run
    const active = () => this.run === run && Date.now() < run.expiresAt
    const fail = () => { if (this.run === run) { this.stop(); this.onState('error', 'マイク接続を確認して再試行してください。') } }
    stream.getTracks().forEach(track => track.addEventListener('ended', fail, { once: true }))
    const preferred = ['audio/webm;codecs=opus','audio/webm','audio/ogg;codecs=opus'].find(type => this.Recorder.isTypeSupported(type))
    const recordSegment = () => {
      if (!active()) { this.stop(); return }
      const parts = []
      const recorder = preferred ? new this.Recorder(stream, { mimeType: preferred }) : new this.Recorder(stream)
      run.recorder = recorder
      recorder.ondataavailable = event => { if (event.data.size && active()) parts.push(event.data) }
      recorder.onerror = fail
      recorder.onstop = () => {
        if (!active()) return
        if (parts.length) {
          const blob = new Blob(parts, { type: recorder.mimeType || 'audio/webm' })
          if (blob.size <= 4 * 1024 * 1024) run.chunks.push({ id: ++run.serial, blob, capturedAt: Date.now() })
          else this.onState('recording', '音声サイズが大きいため、この区間の送信を省略しました。')
          this.prune(run)
        }
        try { recordSegment(); void this.flush(run) } catch { fail() }
      }
      recorder.start()
      run.segmentTimer = setTimeout(() => { if (active() && recorder.state === 'recording') recorder.stop() }, 15000)
    }
    run.deadlineTimer = setTimeout(() => { if (this.run === run) this.stop() }, expiresAt - Date.now())
    run.purgeTimer = setInterval(() => { if (!active()) { if (this.run === run) this.stop(); return } this.prune(run) }, 5000)
    try { recordSegment(); this.onState('recording'); return true } catch (err) { fail(); throw err }
  }
  prune(run) {
    run.chunks = run.chunks.filter(chunk => chunk.capturedAt >= Date.now() - 95000).slice(-7)
    while (run.chunks.reduce((n,c) => n + c.blob.size, 0) > 12 * 1024 * 1024) run.chunks.shift()
  }
  async flush(run) {
    if (this.run !== run || run.sending || Date.now() >= run.expiresAt) return
    this.prune(run)
    const chunks = run.chunks.slice()
    if (!chunks.length) return
    run.sending = true
    try {
      const segments = []
      for (const chunk of chunks) segments.push({ base64: await this.encode(chunk.blob), mimeType: chunk.blob.type })
      if (this.run !== run || Date.now() >= run.expiresAt) return
      const result = await this.send(run.sessionId, segments)
      if (this.run !== run) return
      if (result.status === 409 || result.status === 401 || result.status === 403) { this.stop(); return }
      if (!result.ok || !result.updated) throw new Error(result.error || '音声の文字起こしを更新できませんでした。')
      const sent = new Set(chunks.map(chunk => chunk.id))
      run.chunks = run.chunks.filter(chunk => !sent.has(chunk.id))
      this.onSaved(result)
      this.onState('recording')
    } catch {
      if (this.run === run) this.onState('recording', '音声文脈の更新が遅れています。投稿・投影は継続します。')
    } finally { run.sending = false }
  }
}
globalThis.SupporTalkAudioReference = SupporTalkAudioReference
