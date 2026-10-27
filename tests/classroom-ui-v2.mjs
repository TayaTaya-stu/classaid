import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'
import { createRequire } from 'node:module'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
const require = createRequire(import.meta.url)
const read = name => fs.readFileSync(new URL('../' + name, import.meta.url), 'utf8')
function load(name, deps) {
  const c = { exports: {}, require: name => name in deps ? deps[name] : require(name) }
  vm.runInNewContext(ts.transpileModule(read(name), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true } }).outputText, c)
  return c.exports
}
const Entry = load('app/enter/[entrySlug]/page.tsx', {
  'next/navigation': { useParams: () => ({ entrySlug: 'test' }), useRouter: () => ({}) },
  '@/lib/supabase': { supabase: {} }, '@/lib/student-auth-coordinator': { StudentAuthCoordinator: class {} },
}).default
const markup = renderToStaticMarkup(React.createElement(Entry))
assert.ok(markup.indexOf('入力する名前を必ず覚えておいてください。') < markup.indexOf('id="display-name-input"'))
assert.ok(markup.indexOf('初めて参加する方は') > markup.indexOf('id="display-name-input"'))
assert.match(markup, /例：ぽむ、もふ、ぴよたろう/)
assert.match(markup, /前回と同じ名前/); assert.match(markup, /メモやスクリーンショット/)
assert.match(markup, /aria-describedby="remember-name-note name-entry-help"/)
assert.doesNotMatch(markup, /本名でなくて/)
assert.match(markup, /前に使った名前がわからない/)
console.log('PASS actual entry markup: warning above input, instructions below, approved examples, accessible association, name recovery retained')

// Execute the real control script; replace DOM and capture/transport boundaries only.
const nodes = new Map()
function node(id) {
  if (!nodes.has(id)) nodes.set(id, { value: '', style: {}, listeners: {}, classList: { toggle() {}, remove() {} }, textContent: '', disabled: false,
    addEventListener(name, callback) { this.listeners[name] = callback }, appendChild() {}, querySelector: selector => node(id + selector) })
  return nodes.get(id)
}
let checkOptions, checkStops = 0, quitCalls = 0
const api = new Proxy({ getInitialState: async () => ({ config: { pendingStop: true }, displays: [] }), quitApp: async () => { quitCalls++; return { cancelled: true } } }, { get: (t, key) => t[key] || (() => {}) })
const ui = { console, document: { getElementById: node, createElement: () => node('option') },
  window: { classroomOverlay: api, addEventListener() {}, SupporTalkAudioReference: class {}, SupporTalkAudioCheck: class { constructor(options) { checkOptions = options } stop() { checkStops++ } } },
  setInterval: () => 1, clearInterval() {}, Date, alert() {},
}
vm.createContext(ui); vm.runInContext(read('overlay/control.js'), ui)
for (const state of ['permission', 'recording', 'transcribing']) {
  checkOptions.onState(state, state)
  assert.equal(node('btnCancelAudioCheck').disabled, false)
  assert.equal(node('btnAudioCheck').disabled, true)
  node('btnCancelAudioCheck').listeners.click()
}
assert.equal(checkStops, 3)
checkOptions.onState('stopped', 'stop')
assert.equal(node('btnCancelAudioCheck').disabled, true)
assert.equal(node('btnAudioCheck').disabled, false)
await node('btnQuitApp').listeners.click()
assert.equal(quitCalls, 1); assert.equal(node('btnQuitApp').disabled, false)
const html = read('overlay/control.html')
assert.doesNotMatch(html.match(/<button id="btnCancelAudioCheck"[^>]*>/)[0], /hidden/)
assert.match(html, /アプリを完全終了/)
console.log('PASS actual control listeners: check stop enabled during permission/recording/transcribing; idle disabled, visible labels, quit action recovers on cancellation')

// Execute the real Electron main handlers with OS/network boundaries replaced.
let cfg = { serverOrigin: 'https://supportalk.vercel.app', teacherPassword: 'test-only-teacher-password' }, decision = 0, quits = 0, network = 0
const handlers = new Map(), events = new Map(), sent = []
const contents = { send: name => sent.push(name) }
const app = { getPath: () => '/tmp/test', setName() {}, setPath() {}, requestSingleInstanceLock: () => true, setAsDefaultProtocolClient() {}, on: (name, fn) => events.set(name, fn), whenReady: () => ({ then() {} }), quit() { quits++; events.get('before-quit')?.() } }
const native = { app, ipcMain: { handle: (name, fn) => handlers.set(name, fn), on() {} }, safeStorage: { isEncryptionAvailable: () => false }, globalShortcut: { unregisterAll() {} }, dialog: { showMessageBox: async (_window, options) => { assert.equal(options.defaultId, 0); assert.match(options.detail, /サーバーの授業は終了しません/); return { response: decision } } } }
const desktop = { __dirname: '/tmp/test', process: { argv: [], env: {}, platform: 'linux' }, console, Buffer, URL, FormData, Blob, AbortSignal, AbortController, Date,
  setInterval: () => 1, clearInterval() {},
  require(name) { if (name === 'electron') return native; if (name === 'node:fs') return { mkdirSync() {}, existsSync: () => false, readFileSync: () => JSON.stringify(cfg), writeFileSync: (_p, text) => { cfg = JSON.parse(text) }, renameSync() {} }; return require(name) },
  fetch: async () => { network++; return { ok: true, json: async () => ({ screenUrl: 'https://supportalk.vercel.app/screen/screen-1234567890123456', sessionId: 'test-session', classStartedAt: new Date().toISOString(), status: 'completed', isCurrentTarget: true }) } },
}
vm.createContext(desktop)
vm.runInContext(read('overlay/main.cjs') + '\ncontrolWindow={webContents:globalThis.contents};globalThis.deadline=()=>sessionControlDeadline;', Object.assign(desktop, { contents }))
await assert.rejects(handlers.get('overlay:quit-app')({ sender: {} }))
assert.equal((await handlers.get('overlay:quit-app')({ sender: contents })).cancelled, true); assert.equal(quits, 0); assert.equal(network, 0)
// A recently completed class can still have a future 120-minute deadline.
await handlers.get('overlay:detect-latest')({}, undefined)
assert.equal(desktop.deadline(), null, 'Completed class must not block a pre-class check merely because its deadline is in the future')
const countBeforeQuit = network
decision = 1
assert.equal((await handlers.get('overlay:quit-app')({ sender: contents })).ok, true)
assert.equal(quits, 1); assert.ok(sent.includes('overlay:stop-audio')); assert.equal(network, countBeforeQuit)
console.log('PASS actual desktop handlers: unauthorized exit rejected, cancel keeps app open, confirmed quit stops local capture, no server mutation, completed-class deadline cleared')

const replies = load('lib/reaction-ai/replies.ts', {})
const candidates = replies.NATURAL_FALLBACK_MASTER.lecture_bridge.general
assert.equal(candidates.length, 10)
assert.equal(new Set(candidates.map(item => item.text)).size, 10)
for (const item of candidates) {
  assert.match(item.text, /IT|情報技術/)
  assert.doesNotMatch(item.text, /壊れ|暴走|誤入力|予測変換|送ったら|投稿しやす/)
}
assert.equal(replies.detectPostIntent('スマホの予測変換ってどういう仕組み？'), 'question')
assert.equal(replies.fallbackCandidates('lecture_bridge', 'スマホの予測変換ってどういう仕組み？')[0].id, 'brg-q-1')
console.log('PASS ten IT-learning fallbacks; meaningful technical questions retain their own intent path. Actual generated tone requires real message checks.')
