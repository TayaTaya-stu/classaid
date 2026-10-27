import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const compile = file => ts.transpileModule(fs.readFileSync(file,'utf8'), { compilerOptions: { module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.React,esModuleInterop:true } }).outputText
function load(file,deps,extra={}) { const context={exports:{},Request,Response,URL,URLSearchParams,AbortSignal,Date,console,process:{env:{}},...extra,require:name=>name in deps?deps[name]:require(name)};vm.runInNewContext(compile(file),context);return context.exports }
let authenticated=true, calls=[], answer={data:{success:true},error:null}
const deps={'next/server':require('next/server'),'@/lib/admin-auth':{isAdminAuthenticated:async()=>authenticated},'@/lib/supabase-admin':{supabaseAdmin:{rpc:async(...args)=>{calls.push(args);return answer}}}}
const route=load('app/api/admin/session-organization/route.ts',deps)
const id='11111111-1111-1111-1111-111111111111'
const request=body=>route.POST(new Request('https://test/api',{method:'POST',body:JSON.stringify(body)}))
authenticated=false;assert.equal((await request({sessionId:id,action:'archive'})).status,401);assert.equal(calls.length,0)
authenticated=true
for(const body of [null,{sessionId:'bad',action:'archive'},{sessionId:id,action:'delete_unused'},{sessionId:id,action:'unknown'}]) assert.equal((await request(body)).status,400)
assert.equal(calls.length,0)
for (const action of ['archive','restore','delete_unused']) assert.equal((await request({sessionId:id,action,confirmation:'delete-unused'})).status,200)
for (const [error,status] of [['session_has_records',409],['session_in_use',409],['session_not_found',404],['unexpected',503]]) {answer={data:{success:false,error},error:null};assert.equal((await request({sessionId:id,action:'delete_unused',confirmation:'delete-unused'})).status,status)}
answer={data:null,error:{code:'missing_function'}};assert.equal((await request({sessionId:id,action:'archive'})).status,503)
// Actual dashboard route: default vs history, empty list, archived data remains inspectable.
const rows=[{id,session_number:1,scheduled_at:'2026-10-27T01:00:00Z',status:'scheduled',is_current_target:true},
 {id:'22222222-2222-2222-2222-222222222222',status:'completed',is_archived:false},
 {id:'33333333-3333-3333-3333-333333333333',status:'scheduled',is_archived:true},
 {id:'44444444-4444-4444-4444-444444444444',status:'scheduled',admin_deleted_at:'2026-10-27'}]
let dbRows=rows
const fakeDb={from(table){let selected=table==='sessions'?dbRows.slice():[];const q={select(){return q},neq(k,v){selected=selected.filter(s=>s[k]!==v);return q},eq(k,v){selected=selected.filter(s=>s[k]===v);return q},order(){return Promise.resolve({data:selected,error:null})}};return q}}
const dash=load('app/api/admin/dashboard/route.ts',{'next/server':require('next/server'),'@/lib/admin-auth':{isAdminAuthenticated:async()=>true},'@/lib/supabase-admin':{supabaseAdmin:fakeDb}})
let json=await (await dash.GET(new Request('https://test/api/admin/dashboard'))).json()
assert.deepEqual(json.sessions.map(s=>s.id),[id]);assert.equal(json.selectedSessionId,id)
json=await (await dash.GET(new Request('https://test/api/admin/dashboard?view=history'))).json()
assert.equal(json.sessions.length,2);assert.ok(json.sessions.some(s=>s.isArchived));assert.equal(json.sessions.some(s=>s.id===rows[3].id),false)
json=await (await dash.GET(new Request('https://test/api/admin/dashboard?view=history&sessionId='+rows[2].id))).json();assert.equal(json.sessionControl.isArchived,true)
dbRows=[];json=await (await dash.GET(new Request('https://test/api/admin/dashboard'))).json();assert.equal(json.selectedSessionId,null);assert.equal(json.sessionControl,null)
// Thirty archived histories must not hide an older explicitly designated class.
const latestRows = [...Array.from({length:30},(_,i)=>({id:'archived-'+i,room_mode:'shared',is_archived:true,is_current_target:false})),
 {id,room_mode:'shared',is_archived:false,is_current_target:true,screen_slug:'screen',entry_slug:'entry',status:'scheduled'}]
const latestDb={from(){let selected=latestRows.slice();const q={select(){return q},eq(k,v){selected=selected.filter(s=>s[k]===v);return q},neq(k,v){selected=selected.filter(s=>s[k]!==v);return q},order(){return q},limit:async n=>({data:selected.slice(0,n),error:null})};return q}}
const latest=load('app/api/screen/latest/route.ts',{'next/server':{...require('next/server'),after:()=>{}},'@/lib/teacher-auth':{isTeacherAuthenticated:async()=>true},'@/lib/admin-auth':{isAdminAuthenticated:async()=>false},'@/lib/supabase-admin':{supabaseAdmin:latestDb}})
json=await(await latest.GET(new Request('https://test/api/screen/latest'))).json()
assert.equal(json.sessionId,id);assert.equal(json.sessions.length,1)
assert.equal((await latest.GET(new Request('https://test/api/screen/latest?sessionId=archived-0'))).status,404)
// Actual organizer handlers: cancellation, protection, exact target and single request.
for(const protect of [true,false]) {
 let sent=[], updated=0, confirm=false, stateIndex=0
 const states=[],refs=[];let refIndex=0
 const react={useState(initial){const n=stateIndex++;if(!(n in states))states[n]=initial;return[states[n],v=>{states[n]=v}]},useRef(initial){const n=refIndex++;return refs[n] ||= {current:initial}},createElement:(type,props,...children)=>({type,props,children})}
 const component=load('app/admin/AdminSessionOrganizer.tsx',{'react':react},{React:react,window:{confirm:()=>confirm},fetch:async(_url,options)=>{sent.push(JSON.parse(options.body));return{ok:true,json:async()=>({success:true})}}}).default
 const props={sessionId:id,label:'第1回',status:'scheduled',isArchived:false,isCurrentTarget:protect,classStartedAt:null,onUpdated:async()=>{updated++}}
 let nodes=[];function render(){stateIndex=0;refIndex=0;nodes=[];function walk(n){if(!n||typeof n!=='object')return;if(Array.isArray(n))return n.forEach(walk);nodes.push(n);walk(n.children)}walk(component(props))}
 render();const buttons=nodes.filter(n=>n.type==='button')
 assert.equal(buttons[0].props.disabled,protect)
 await buttons[1].props.onClick();assert.equal(sent.length,0,'cancel never sends')
 confirm=true;buttons[1].props.onClick();buttons[1].props.onClick();await new Promise(r=>setTimeout(r,0))
 assert.equal(sent.length,protect?0:1)
 if(!protect){assert.equal(sent[0].sessionId,id);assert.equal(sent[0].confirmation,'delete-unused');assert.equal(updated,1)}
}
const page=fs.readFileSync('app/admin/page.tsx','utf8')
assert.match(page,/sessionViewRef.current = view/)
assert.match(page,/key=\{selectedSessionId\} sessionId=\{selectedSessionId\}/)
assert.match(page,/ログ・分析/)
console.log('PASS actual admin routes/UI: auth and delete confirmation required; DB conflicts shown; normal/history lists isolated; removed sessions hidden; archived logs selectable; cancel/protection/duplicate-click guard/exact target verified')
