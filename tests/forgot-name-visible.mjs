import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'
const source = fs.readFileSync(new URL('../app/enter/[entrySlug]/page.tsx', import.meta.url), 'utf8')
const compile = text => ts.transpileModule(text, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React, target: ts.ScriptTarget.ES2022 } }).outputText
const coordinatorModule = { exports: {} }
vm.runInNewContext(compile(fs.readFileSync(new URL('../lib/student-auth-coordinator.ts', import.meta.url), 'utf8')), coordinatorModule)
const { StudentAuthCoordinator } = coordinatorModule.exports
for (const existing of [true, false]) {
 for (const failSignOut of [false, true]) {
  for (const fromConfirmation of [false, true]) {
  const hooks = [], effects = [], storage = new Map(), requests = [], events = []
  let cursor = 0, first = true, currentToken = 'original-token'
  const react = {
   useState(initial) { const index = cursor++; if (!(index in hooks)) hooks[index] = typeof initial === 'function' ? initial() : initial; return [hooks[index], value => { hooks[index] = typeof value === 'function' ? value(hooks[index]) : value }] },
   useRef(value) { const index = cursor++; if (!(index in hooks)) hooks[index] = { current: value }; return hooks[index] },
   useEffect(fn) { if (first) effects.push(fn) },
   createElement: (type, props, ...children) => ({ type, props, children }),
  }
  if (existing) storage.set('classaid_participant_profile_v1', JSON.stringify({ displayName: 'みも', participantId: 'old-id' }))
  const client = { auth: {
   getSession: async () => ({ data: { session: currentToken ? { access_token: currentToken } : null }, error: null }),
   signOut: async () => { events.push('signOut'); if (failSignOut) return { error: new Error('offline') }; currentToken = null; return { error: null } },
   signInAnonymously: async () => { events.push('newAuth'); currentToken = 'new-token'; return { data: { session: { access_token: currentToken } }, error: null } },
  } }
  const routes = []
  const context = { exports: {}, React: react, console, setTimeout, clearTimeout, AbortSignal,
   window: { setTimeout, clearTimeout, localStorage: { getItem: key => storage.get(key) || null, setItem: (key,value) => storage.set(key,value), removeItem: key => storage.delete(key) } },
   fetch: async (_url, options) => {
    if (options.method === 'POST') { requests.push(JSON.parse(options.body)); return { ok: true, status: 200, json: async () => ({ participantId: 'new-id', displayName: '新しい名', roomSlug: 'test-room' }) } }
    return { ok: true, json: async () => existing ? { displayName: 'みも', participantId: 'old-id' } : {} }
   },
   require(name) {
    if (name === 'react') return react
    if (name === 'next/navigation') return { useRouter: () => ({ push: path => routes.push(path) }), useParams: () => ({ entrySlug: 'entry' }) }
    if (name === '@/lib/supabase') return { supabase: client }
    if (name === '@/lib/student-auth-coordinator') return { StudentAuthCoordinator }
    throw Error(name)
   },
  }
  vm.runInNewContext(compile(source), context)
  let nodes
  function render() {
   cursor = 0; nodes = []
   function walk(node) { if (!node || typeof node !== 'object') return; if (Array.isArray(node)) return node.forEach(walk); nodes.push(node); walk(node.children) }
   walk(context.exports.default()); first = false
  }
  function text(node) { if (node == null || node === false) return ''; if (typeof node !== 'object') return String(node); if (Array.isArray(node)) return node.map(text).join(''); return text(node.children) }
  function button(label) { const found = nodes.find(node => node.type === 'button' && text(node) === label); assert.ok(found, label); return found }
  render(); const cleanups = effects.map(fn => fn()); await new Promise(resolve => setTimeout(resolve, 15)); render()
  assert.equal(nodes.find(node => node.props?.id === 'display-name-input').props.value, '')
  if (fromConfirmation) {
   nodes.find(node => node.props?.id === 'display-name-input').props.onChange({ target: { value: '確認する名' } })
   nodes.find(node => node.type === 'input' && node.props?.type === 'radio').props.onChange()
   render(); nodes.find(node => node.type === 'form').props.onSubmit({ preventDefault() {} }); render()
   assert.equal(requests.length, 0)
   assert.ok(nodes.some(node => node.props?.id === 'entry-name-confirmation-title'))
  }
  button('前に使った名前がわからない').props.onClick(); render()
  assert.ok(nodes.some(node => text(node) === '名前を忘れた場合は、新しい名前で参加できます。以前の参加記録とは別の参加者として登録されます。'))
  button('戻る').props.onClick(); render()
  assert.deepEqual(events, [], 'opening/cancelling guidance never signs out')
  button('前に使った名前がわからない').props.onClick(); render()
  const confirm = button('新しい名前で参加する'); confirm.props.onClick(); confirm.props.onClick()
  await new Promise(resolve => setTimeout(resolve, 15)); render()
  if (failSignOut) {
   assert.deepEqual(events, ['signOut'])
   assert.ok(nodes.some(node => text(node).includes('新しい名前で参加する準備ができませんでした。')))
   assert.equal(requests.length, 0)
   if (existing) assert.ok(storage.has('classaid_participant_profile_v1'))
  } else {
   assert.deepEqual(events, ['signOut', 'newAuth'], 'one serialized switch despite repeated click')
   assert.equal(storage.has('classaid_participant_profile_v1'), false)
   nodes.find(node => node.props?.id === 'display-name-input').props.onChange({ target: { value: '新しい名' } })
   const radio = nodes.find(node => node.type === 'input' && node.props?.type === 'radio'); assert.ok(radio); radio.props.onChange()
   render(); nodes.find(node => node.type === 'form').props.onSubmit({ preventDefault() {} })
   render(); assert.equal(requests.length, 0)
   button('この名前で入室する').props.onClick()
   await new Promise(resolve => setTimeout(resolve, 15))
   assert.equal(requests.length, 1)
   assert.equal(requests[0].authToken, 'new-token')
   assert.equal(requests[0].forgotPreviousName, true)
   assert.equal(requests[0].claimExisting, false)
   assert.equal(routes[0], '/room/test-room')
  }
  cleanups.forEach(fn => fn?.())
  }
 }
}
console.log('PASS actual entry recovery: prominent help works from input AND confirmation with/without saved identity; cancel preserves identity; confirmed switch serialized; sign-out failure blocks registration; forgotten-name request uses new token without claiming old records')
