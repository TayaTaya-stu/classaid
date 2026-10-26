import fs from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'
import assert from 'node:assert/strict'
const root=new URL('../',import.meta.url)
const load=(name,deps)=>{const c={exports:{},require:n=>{if(n in deps)return deps[n];throw Error(n)},AbortSignal};vm.runInNewContext(ts.transpileModule(fs.readFileSync(new URL(name,root),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,c);return c.exports}
let linked=true,fail=false;const filters=[]
const sb = {
  auth: { getUser: async token => ({ data: { user: token === 'good' ? { id: 'verified-user' } : null }, error: null }) },
  from(table) {
    return { select() { return { eq(key, value) { return { async maybeSingle() {
      filters.push([table, key, value])
      if (fail) return { error: new Error('db') }
      return { data: table === 'participant_auth_links' ? (linked ? { participant_id: 'own-id' } : null) : { display_name: '登録した名前' }, error: null }
    } } } } } }
  },
}
const route=load('app/api/enter/route.ts',{'next/server':{NextResponse:{json:(body,init)=>({body,status:init?.status||200,headers:init?.headers})}},'@/lib/student-entry':{},'@/lib/supabase-admin':{supabaseAdmin:sb},'@/lib/participant':{}})
const req=token=>({headers:new Headers(token?{Authorization:`Bearer ${token}`}:{})})
assert.equal((await route.GET(req())).status,401)
assert.equal((await route.GET(req('bad'))).status,401)
const own=await route.GET(req('good'));assert.equal(own.body.displayName,'登録した名前');assert.equal(own.headers['Cache-Control'],'no-store')
assert.equal(filters[0][2],'verified-user');assert.equal(filters[1][2],'own-id')
linked=false;assert.equal((await route.GET(req('good'))).body.displayName,'')
fail=true;assert.equal((await route.GET(req('good'))).status,503)
const replies=load('lib/reaction-ai/replies.ts',{})
assert.match(replies.getNaturalFallbackReply('empathy','こんちゃ').text,/こんちゃ|やっほ|こんにちは/)
const a=await replies.getSessionFallbackReply('s','empathy','こんちゃ'),b=await replies.getSessionFallbackReply('s','empathy','こんちゃ');assert.notEqual(a.id,b.id)
for(const pools of Object.values(replies.NATURAL_FALLBACK_MASTER)) {
 assert.ok(Object.values(pools).flat().length>=10)
 for(const x of Object.values(pools).flat())assert.doesNotMatch(x.text,/声が|一緒感|参加感|気軽に.*楽しもう|一緒に参加しよう|焦らずいこう/)
}
console.log('PASS actual profile route: verified identity only, new user blank, invalid auth rejected, DB failure recoverable; greeting replies and rotation, >=10 per mode, no voice/host fallback phrasing')
