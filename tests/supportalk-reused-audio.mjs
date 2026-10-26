import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'

// Execute the shipped recorder; fake only hardware and transport boundaries.
let clock = 1000
const timers = new Map()
let timerId = 0
const instances = []
let trackStops = 0
class Recorder {
  static isTypeSupported() { return true }
  constructor(_stream, config) { this.mimeType = config.mimeType; this.state = 'inactive'; instances.push(this) }
  start() { this.state = 'recording' }
  stop() {
    this.state = 'inactive'
    this.ondataavailable?.({ data: new Blob(['segment-' + instances.indexOf(this)], { type: this.mimeType }) })
    this.onstop?.()
  }
}
const ctx = { Blob, console, Date: class extends Date { static now() { return clock } },
  setTimeout: (fn,ms) => { const id=++timerId; timers.set(id,{fn,ms}); return id },
  clearTimeout:id=>timers.delete(id),setInterval:()=>++timerId,clearInterval(){} }
vm.createContext(ctx)
vm.runInContext(fs.readFileSync('overlay/audio-reference.js','utf8'),ctx)
const sent=[], states=[]
let release
const audio = new ctx.SupporTalkAudioReference({
  Recorder,
  mediaDevices: { getUserMedia: async () => ({ getTracks:()=>[{stop:()=>trackStops++,addEventListener(){}}] }) },
  encode:async blob=>Buffer.from(await blob.arrayBuffer()).toString('base64'),
  send: async (sid, segments) => { sent.push({sid,segments}); return await new Promise(r=>{release=r}) },
  onState:state=>states.push(state),
})
await audio.start('session-a', clock+120000)
assert.equal(states.at(-1),'recording')
const first=instances.at(-1)
first.stop()
await new Promise(r=>setImmediate(r))
assert.equal(sent.length,1)
assert.notEqual(instances.at(-1),first,'Every segment is a fresh complete recorder/file, as in Shared Wall')
instances.at(-1).stop()
await new Promise(r=>setImmediate(r))
assert.equal(sent.length,1,'Only one transcription in flight')
release({ok:true,updated:true})
await new Promise(r=>setImmediate(r))
instances.at(-1).stop()
await new Promise(r=>setImmediate(r))
assert.equal(sent.length,2)
assert.equal(sent[1].segments.length,2,'Acknowledged segment is not resent; new segments retained')
assert.ok(sent.every(x=>x.sid==='session-a'))
const run=audio.run
clock+=96000
audio.prune(run)
assert.equal(run.chunks.length,0,'Raw audio older than 95 seconds is discarded')
audio.stop()
release({ok:true,updated:true})
await new Promise(r=>setImmediate(r))
assert.equal(audio.run,null)
assert.equal(trackStops,1,'Stop releases the microphone')
assert.equal(states.at(-1),'stopped','Late response cannot restart stopped audio')

// A delayed permission response after stop must release that stream immediately.
let grant
const delayed = new ctx.SupporTalkAudioReference({ Recorder,send:async()=>({ok:true,updated:true}),mediaDevices:{getUserMedia:()=>new Promise(r=>{grant=r})} })
const starting=delayed.start('session-b',clock+120000)
delayed.stop()
grant({getTracks:()=>[{stop:()=>trackStops++,addEventListener(){}}]})
assert.equal(await starting,false)
assert.equal(trackStops,2)
console.log('PASS: real recorder: independent files, bounded retention, one flight, acknowledgement, stop races')

// Execute the real transcription helper with a stub Google transport.
const source=fs.readFileSync('lib/experiment-config.ts','utf8')
const model=source.match(/model: '([^']+)'/)[1]
const fallbackModels=[...source.match(/fallbackModels: \[([^\]]+)\]/)[1].matchAll(/'([^']+)'/g)].map(x=>x[1])
const calls=[]
let failFirst=true
const exports={}
const code=ts.transpileModule(fs.readFileSync('lib/reaction-ai/audio-transcription.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText
vm.runInNewContext(code,{exports,Buffer,AbortSignal,process:{env:{GEMINI_API_KEY:'test-only'}},require:spec=>{
  if(spec==='server-only')return {}
  if(spec==='@/lib/experiment-config')return {EXPERIMENT_AI_CONFIG:{model,fallbackModels}}
  if(spec==='@google/genai')return {GoogleGenAI:class {models={generateContent:async p=>{calls.push(p);if(failFirst){failFirst=false;throw new Error('first unavailable')}return {text:'データベースのトランザクションについて説明します。'}}}}}
  throw new Error(spec)
}})
const file=new File(['real-segment-test'],'lecture.webm',{type:'audio/webm;codecs=opus'})
const result=await exports.transcribeLectureAudio([file])
assert.equal(result.modelUsed,fallbackModels[0])
assert.deepEqual(calls.map(p=>p.model),[model,fallbackModels[0]])
assert.equal(calls[1].contents[0].parts[0].inlineData.mimeType,'audio/webm')
assert.match(calls[1].contents[0].parts[1].text,/説明や推測を加えない/)
assert.ok(calls.every(p=>p.config.abortSignal))
await assert.rejects(exports.transcribeLectureAudio([new File(['x'],'x.txt',{type:'text/plain'})]))
await assert.rejects(exports.transcribeLectureAudio(Array(8).fill(file)))
console.log('PASS: actual transcription helper preserves old model order/prompt, validates files, uses abort signals')
console.log('No real microphone, Google billing API, or Windows projector was exercised.')

// Run actual Electron handlers with platform/network boundaries replaced.
const { createRequire } = await import('node:module')
const require = createRequire(import.meta.url)
const handlers = new Map(), requests = [], notifications = []
let cfg = { serverOrigin: 'http://localhost:3001', screenUrl: 'http://localhost:3001/screen/screen-1234567890123456', teacherPassword: 'test-teacher-password' }
const contents = { send: (name) => notifications.push(name) }
const electron = {
 app: { getPath: () => '/tmp/app', setName(){}, setPath(){}, requestSingleInstanceLock: () => true, setAsDefaultProtocolClient(){}, on(){}, whenReady: () => ({ then(){} }) },
 ipcMain: { handle: (key, handler) => handlers.set(key, handler), on(){} },
 safeStorage: { isEncryptionAvailable: () => false },
}
const desktop = { __dirname: '/tmp/app/overlay', process: { argv: [], env: {}, platform: 'linux', defaultApp: false },
 console, Buffer, URL, AbortSignal, AbortController, FormData, Blob,
 setInterval: () => 1, clearInterval(){}, require: spec => {
   if (spec === 'electron') return electron
   if (spec === 'node:fs') return { existsSync:()=>false,mkdirSync(){},renameSync(){},copyFileSync(){},readFileSync: () => JSON.stringify(cfg), writeFileSync: (_p,value) => { cfg = JSON.parse(value) } }
   if (spec === 'node:child_process') throw new Error('No Chrome child process should be required')
   return require(spec)
 },
 fetch: async (url, options) => {
   requests.push({ url, options })
   return { ok: true, status: 200, json: async () => url.includes('session-control') ? { success: true, classStartedAt: new Date().toISOString() } : { updated: true } }
 },
}
vm.createContext(desktop)
vm.runInContext(fs.readFileSync('overlay/main.cjs','utf8')+'\nglobalThis.test={setControl(w){controlWindow=w},stopOverlay};', desktop)
desktop.test.setControl({ webContents: contents })
const sid = '11111111-2222-4333-8444-555555555555'
await handlers.get('overlay:control-session')(null, 'start', sid)
assert.equal(cfg.activeSessionId, sid)
assert.equal(cfg.serverOrigin, 'http://localhost:3001')
const response = await handlers.get('overlay:send-audio-segments')({ sender: contents }, sid, [{ base64: Buffer.from('audio').toString('base64'), mimeType: 'audio/webm' }])
assert.equal(response.updated, true)
assert.equal(requests.at(-1).url, 'http://localhost:3001/api/teacher/lecture-context')
assert.ok(requests.at(-1).options.body instanceof FormData)
assert.equal(requests.at(-1).options.headers['x-teacher-password'], 'test-teacher-password')
await assert.rejects(handlers.get('overlay:send-audio-segments')({ sender: {} }, sid, []))
notifications.length = 0
desktop.test.stopOverlay()
assert.equal(notifications.includes('overlay:stop-audio'), false, 'Projection stop cannot stop audio')
await handlers.get('overlay:control-session')(null, 'pause_ai', sid)
assert.ok(notifications.includes('overlay:stop-audio'))
assert.equal(handlers.has('overlay:start-speech-worker'), false)
console.log('PASS: real Electron handlers: same app, multipart audio, 3001 origin, authenticated transport, independent stops')
