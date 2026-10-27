import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'
const source = fs.readFileSync(new URL('../overlay/audio-check.js', import.meta.url), 'utf8')
const tick = () => new Promise(resolve => setImmediate(resolve))
function hardware() {
  const timers = new Map(), meters = new Map(), states = [], results = [], levels = []
  let seq = 0, stops = 0, closed = 0, sent = 0, cancelled = 0, amplitude = 0.05, resolveSend, grant
  let delayed = false
  const stream = { getTracks: () => [{ stop() { stops++ }, addEventListener() {} }] }
  class Recorder {
    static isTypeSupported() { return true }
    constructor(_stream, config) { this.mimeType = config.mimeType; this.state = 'inactive' }
    start() { this.state = 'recording' }
    stop() { this.state = 'inactive'; this.ondataavailable?.({ data: new Blob(['test-audio'], { type: this.mimeType }) }); this.onstop?.() }
  }
  class Context {
    resume() { return Promise.resolve() }
    close() { closed++; return Promise.resolve() }
    createMediaStreamSource() { return { connect() {} } }
    createAnalyser() { return { fftSize: 1024, getFloatTimeDomainData(samples) { samples.fill(amplitude) } } }
  }
  const c = { Blob, Float32Array, console, setTimeout(fn, ms) { const id = ++seq; timers.set(id, { fn, ms }); return id }, clearTimeout(id) { timers.delete(id) }, setInterval(fn) { const id = ++seq; meters.set(id, fn); return id }, clearInterval(id) { meters.delete(id) } }
  vm.createContext(c); vm.runInContext(source, c)
  const check = new c.SupporTalkAudioCheck({ Recorder, AudioContextClass: Context,
    mediaDevices: { getUserMedia: () => delayed ? new Promise(resolve => { grant = resolve }) : Promise.resolve(stream) },
    encode: async blob => Buffer.from(await blob.arrayBuffer()).toString('base64'),
    send() { sent++; return new Promise(resolve => { resolveSend = resolve }) }, cancelSend() { cancelled++ },
    onState: (state, message) => states.push({ state, message }), onLevel: level => levels.push(level), onResult: result => results.push(result),
  })
  return { check, timers, meters, states, results, levels, stream,
    counts: () => ({ stops, closed, sent, cancelled }), silence() { amplitude = 0 }, delayPermission() { delayed = true }, grant() { grant(stream) },
    complete(result = { ok: true, transcript: '情報の仕組みについて説明します。' }) { resolveSend(result) },
    finishCapture() { for (let i = 0; i < 8; i++) for (const fn of meters.values()) fn(); const timer = [...timers.values()].find(t => t.ms === 5000); assert.ok(timer); timer.fn() },
  }
}
// Execute the actual capture controller with hardware/timers/network replaced.
const h = hardware(), first = h.check.start(); await tick()
await h.check.start(); h.finishCapture(); await tick()
assert.equal(h.counts().sent, 1); assert.equal(h.counts().stops, 1); assert.equal(h.counts().closed, 1)
assert.equal(h.results.length, 0); assert.ok(h.levels.some(level => level > 0))
h.complete(); await first
assert.equal(h.results[0].transcript, '情報の仕組みについて説明します。'); assert.equal(h.check.active, false)
assert.equal(h.meters.size, 0); assert.equal(h.timers.size, 0)
const silent = hardware(); silent.silence(); const silentTask = silent.check.start(); await tick(); silent.finishCapture(); await silentTask
assert.equal(silent.counts().sent, 0); assert.ok(silent.states.some(s => s.state === 'error'))
const stopped = hardware(); const stoppedTask = stopped.check.start(); await tick(); stopped.check.stop(); await stoppedTask
assert.equal(stopped.counts().sent, 0); assert.equal(stopped.counts().stops, 1)
const late = hardware(); late.delayPermission(); const lateTask = late.check.start(); late.check.stop(); late.grant(); await lateTask
assert.equal(late.counts().stops, 1); assert.equal(late.counts().sent, 0)
const timeout = hardware(); timeout.delayPermission(); const timedTask = timeout.check.start(); [...timeout.timers.values()].find(t => t.ms === 30000).fn(); await timedTask; timeout.grant(); await tick()
assert.equal(timeout.counts().stops, 1); assert.equal(timeout.check.active, false)
const delayed = hardware(); const delayedTask = delayed.check.start(); await tick(); delayed.finishCapture(); await tick(); delayed.check.stop(); delayed.complete(); await delayedTask
assert.equal(delayed.results.length, 0); assert.equal(delayed.counts().cancelled, 1)
console.log('PASS actual check recorder: one flight, five-second capture, meter, silent input not sent, stop/late permission/permission timeout cleanup, stale result rejected')

// The real diagnostic route is forbidden from touching any database module.
let auth = false, calls = 0
const exports = {}
vm.runInNewContext(ts.transpileModule(fs.readFileSync(new URL('../app/api/teacher/audio-check/route.ts', import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, {
  exports, Buffer, File, Response, Date,
  require(name) {
    if (name === 'next/server') return { NextResponse: Response }
    if (name === '@/lib/teacher-auth') return { isTeacherAuthenticated: async () => auth }
    if (name === '@/lib/reaction-ai/audio-transcription') return { transcribeLectureAudio: async () => { calls++; return { transcript: 'マイクの確認です。', modelUsed: 'stub-no-google' } } }
    throw new Error('Unexpected dependency (database writes forbidden): ' + name)
  },
})
function request(files = [new File(['audio'], 'check.webm', { type: 'audio/webm' })]) {
  const form = new FormData(); files.forEach(file => form.append('audio', file))
  return new Request('http://test/api/teacher/audio-check', { method: 'POST', body: form })
}
assert.equal((await exports.POST(request())).status, 401); assert.equal(calls, 0)
auth = true
const response = await exports.POST(request()), body = await response.json()
assert.equal(response.status, 200); assert.equal(body.transcript, 'マイクの確認です。'); assert.ok(body.checkedAt)
assert.equal(response.headers.get('cache-control'), 'no-store')
assert.equal((await exports.POST(request([]))).status, 400)
assert.equal((await exports.POST(request([new File(['bad'], 'bad.txt', { type: 'text/plain' })]))).status, 400)
const oversized = new Request('http://test/api/teacher/audio-check', { method: 'POST', headers: { 'Content-Type': 'multipart/form-data; boundary=test' }, body: new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(1024 * 1024 + 1)); controller.close() } }), duplex: 'half' })
assert.equal((await exports.POST(oversized)).status, 413)
assert.equal(calls, 1)
console.log('PASS actual diagnostic endpoint: auth, bounded upload, one file, MIME, transcript/time/no-store response, no DB imports or writes. No real microphone or Google API exercised.')
