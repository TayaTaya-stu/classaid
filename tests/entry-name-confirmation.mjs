import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'
const source = fs.readFileSync(new URL('../app/enter/[entrySlug]/page.tsx', import.meta.url), 'utf8')
const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React, target: ts.ScriptTarget.ES2022 } }).outputText
const tick = () => new Promise(resolve => setTimeout(resolve, 15))
for (const existing of [false, true]) {
 for (const consent of [false, true]) {
  const states = [], effects = [], storage = new Map(), requests = [], routes = []
  let cursor = 0, first = true, releasePost
  const oldProfile = { displayName: '前の名前', participantId: 'old-participant' }
  if (existing) storage.set('classaid_participant_profile_v1', JSON.stringify(oldProfile))
  const react = {
   useState(initial) { const i = cursor++; if (!(i in states)) states[i] = typeof initial === 'function' ? initial() : initial; return [states[i], value => { states[i] = typeof value === 'function' ? value(states[i]) : value }] },
   useRef(initial) { const i = cursor++; if (!(i in states)) states[i] = { current: initial }; return states[i] },
   useEffect(fn) { if (first) effects.push(fn) },
   createElement: (type, props, ...children) => ({ type, props, children }),
  }
  const context = { exports: {}, React: react, console, setTimeout, clearTimeout, AbortSignal,
   window: { setTimeout, clearTimeout, localStorage: { getItem: key => storage.get(key) || null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) } },
   fetch: async (_url, options) => {
    if (options.method !== 'POST') return { ok: true, json: async () => existing ? oldProfile : {} }
    requests.push(JSON.parse(options.body))
    return await new Promise(resolve => { releasePost = resolve })
   },
   require(name) {
    if (name === 'react') return react
    if (name === 'next/navigation') return { useRouter: () => ({ push: path => routes.push(path) }), useParams: () => ({ entrySlug: 'entry' }) }
    if (name === '@/lib/supabase') return { supabase: { auth: { getSession: async () => ({ data: { session: { access_token: 'token' } } }) } } }
    if (name === '@/lib/student-auth-coordinator') return { StudentAuthCoordinator: class { getOrInitToken() { return Promise.resolve('token') } } }
    throw Error(name)
   },
  }
  vm.runInNewContext(code, context)
  let nodes
  const text = node => node == null || node === false ? '' : typeof node !== 'object' ? String(node) : Array.isArray(node) ? node.map(text).join('') : text(node.children)
  function render() {
   cursor = 0; nodes = []
   const walk = node => { if (!node || typeof node !== 'object') return; if (Array.isArray(node)) return node.forEach(walk); nodes.push(node); walk(node.children) }
   walk(context.exports.default()); first = false
  }
  function button(label) { const node = nodes.find(n => n.type === 'button' && text(n) === label); assert.ok(node, label); return node }
  const submit = () => nodes.find(n => n.type === 'form').props.onSubmit({ preventDefault() {} })
  const name = value => nodes.find(n => n.props?.id === 'display-name-input').props.onChange({ target: { value } })
  render(); const cleanups = effects.map(fn => fn()); await tick(); render()
  assert.ok(nodes.some(n => n.type === 'h1' && text(n) === '授業チャットに参加'))
  assert.ok(nodes.some(n => text(n).includes('カメラ」アプリでQRコード')))
  assert.match(button('前に使った名前がわからない').props.className, /border-blue-600 bg-blue-50/)
  name('ぽむ'); render(); submit(); render()
  assert.ok(nodes.some(n => text(n).includes('同意する」または「同意しない')))
  assert.equal(requests.length, 0, 'missing consent must not enter confirmation or submit')
  nodes.filter(n => n.type === 'input' && n.props?.type === 'radio')[consent ? 0 : 1].props.onChange(); render()
  submit(); render()
  assert.equal(requests.length, 0, 'initial entry click only confirms, with and without browser identity')
  assert.ok(nodes.some(n => n.props?.id === 'entry-name-confirmation-title' && text(n) === '前回と同じ名前ですか？'))
  assert.equal(nodes.some(n => n.type === 'form'), false)
  assert.equal(nodes.some(n => n.type === 'h1' && text(n) === '授業チャットに参加'), false)
  assert.equal(nodes.some(n => text(n).includes('カメラ」アプリでQRコード')), false)
  assert.equal(nodes.some(n => text(n).includes('SupporTalk')), false)
  assert.ok(nodes.some(n => n.type === 'p' && text(n).includes('入室前に確認してください')))
  assert.ok(nodes.some(n => n.type === 'div' && /max-w-sm/.test(n.props?.className || '') && /border-amber-400/.test(n.props.className)))
  assert.match(button('前に使った名前がわからない').props.className, /border-blue-600 bg-blue-50/)
  assert.ok(nodes.some(n => n.type === 'p' && text(n) === 'ぽむ'))
  assert.match(button('前に使った名前がわからない').props.className, /border-2/)
  button('名前を入力し直す').props.onClick(); render()
  assert.equal(requests.length, 0)
  assert.equal(nodes.find(n => n.props?.id === 'display-name-input').props.value, 'ぽむ')
  assert.equal(nodes.filter(n => n.type === 'input' && n.props?.type === 'radio')[consent ? 0 : 1].props.checked, true)
  name(' もふ '); render(); submit(); render()
  assert.ok(nodes.some(n => n.type === 'p' && text(n) === 'もふ'), 'confirmed name follows edits and trimming')
  const confirm = button('この名前で入室する')
  confirm.props.onClick(); confirm.props.onClick(); await tick(); render()
  assert.equal(requests.length, 1, 'rapid confirmation cannot double submit')
  assert.equal(requests[0].displayName, 'もふ'); assert.equal(requests[0].consented, consent); assert.equal(requests[0].claimExisting, false)
  releasePost({ ok: false, status: 400, json: async () => ({ error: '初回に登録した名前を入力してください。' }) }); await tick(); render()
  assert.ok(nodes.some(n => n.props?.role === 'alert' && text(n).includes('初回に登録した名前')))
  assert.ok(button('前に使った名前がわからない'), 'recovery remains reachable after identity rejection')
  button('この名前で入室する').props.onClick(); await tick()
  releasePost({ ok: false, status: 409, json: async () => ({ promptClaim: true }) }); await tick(); render()
  assert.ok(nodes.some(n => n.props?.role === 'alertdialog'), 'existing ownership warning remains a separate explicit decision')
  assert.equal(requests.length, 2)
  button('自分が以前登録した名前として引き継ぐ').props.onClick(); await tick()
  assert.equal(requests.length, 3); assert.equal(requests[2].claimExisting, true)
  releasePost({ ok: true, status: 200, json: async () => ({ displayName: 'もふ', participantId: 'participant', roomSlug: 'room' }) }); await tick()
  assert.equal(routes[0], '/room/room')
  cleanups.forEach(fn => fn?.())
 }
}
console.log('PASS actual entry confirmation: new/returning users and either consent, compact warning without repeated header, blue recovery buttons on both screens, no POST before confirmation, edit preserves consent, trimmed snapshot, rapid-click guard, API errors/recovery and ownership warning retained')
