import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'

const source = fs.readFileSync(new URL('../app/enter/[entrySlug]/page.tsx', import.meta.url), 'utf8')
const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React, target: ts.ScriptTarget.ES2022 } }).outputText
for (const serverName of ['みも', '']) {
  const effects = [], states = [], writes = []
  let cursor = 0
  const profile = { displayName: 'みも', participantId: 'existing-participant' }
  const react = {
    useState(initial) { const index = cursor++; states[index] = typeof initial === 'function' ? initial() : initial; return [states[index], value => { states[index] = value; writes.push([index, value]) }] },
    useRef: value => ({ current: value }), useEffect: fn => effects.push(fn),
    createElement: (type, props, ...children) => ({ type, props, children }),
  }
  const context = { exports: {}, React: react, console, setTimeout, clearTimeout, AbortSignal,
    window: { setTimeout, clearTimeout, localStorage: { getItem: () => JSON.stringify(profile), setItem() {} } },
    fetch: async () => ({ ok: true, json: async () => ({ displayName: serverName, participantId: 'server-participant' }) }),
    require(name) {
      if (name === 'react') return react
      if (name === 'next/navigation') return { useRouter: () => ({}), useParams: () => ({ entrySlug: 'entry' }) }
      if (name === '@/lib/supabase') return { supabase: {} }
      if (name === '@/lib/student-auth-coordinator') return { StudentAuthCoordinator: class { getOrInitToken() { return Promise.resolve('token') } } }
      throw Error(name)
    },
  }
  vm.runInNewContext(code, context)
  const tree = context.exports.default()
  const cleanups = effects.map(fn => fn())
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(states[0], '', 'initial name must remain blank with saved and server profiles')
  assert.equal(writes.filter(([index, value]) => index === 0 && value !== '').length, 0)
  assert.ok(['server-participant', 'existing-participant'].includes(states[3]), 'participant identity retained')
  assert.equal(states[7], 'token', 'authentication remains functional')
  const nodes = []
  function walk(node) { if (!node || typeof node !== 'object') return; if (Array.isArray(node)) return node.forEach(walk); nodes.push(node); walk(node.children) }
  walk(tree)
  const help = nodes.find(node => node.props?.id === 'name-entry-help')
  assert.equal(help.type, 'ul')
  assert.equal(help.children.filter(node => node?.type === 'li').length, 3)
  assert.equal(nodes.find(node => node.props?.id === 'display-name-input').props.placeholder, '例：ぽむ、もふ、ぴよたろう')
  cleanups.forEach(fn => fn?.())
}
assert.match(source, /setConfirmClaimModal\(\{ open: true/)
assert.match(source, /forgotPreviousName,/)
console.log('PASS actual entry effects: stored/server names never autofill, identity/auth retained; three bullet instructions and approved examples; recovery retained')
