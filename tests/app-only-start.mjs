import fs from 'node:fs'
import vm from 'node:vm'
import assert from 'node:assert/strict'
import ts from 'typescript'
let starts=0
const client={from:()=>({select(){return this},eq(){return this},maybeSingle:async()=>({data:{id:'s',is_locked:false,status:'scheduled'},error:null})})}
const response={json:(data,init)=>new Response(JSON.stringify(data),{status:init?.status||200,headers:{'Content-Type':'application/json'}})}
function load(file){const ctx={exports:{},Request,Response,File,TextDecoder,require:n=>n==='next/server'?{NextResponse:response}:n==='@/lib/admin-auth'?{isAdminAuthenticated:async()=>true}:n==='@/lib/teacher-auth'?{isTeacherAuthenticated:async()=>true}:n==='@/lib/reaction-ai/control'?{controlReaction:async()=>{starts++;return response.json({success:true})}}:n==='@/lib/supabase-admin'?{supabaseAdmin:client}:{} };vm.runInNewContext(ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,ctx);return ctx.exports.POST}
const admin=load('app/api/admin/session-control/route.ts')
const req=action=>new Request('http://localhost/api/control',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action,sessionId:'11111111-1111-1111-1111-111111111111'})})
assert.equal((await admin(req('start_experiment'))).status,410);assert.equal(starts,0)
const teacher=load('app/api/teacher/session-control/route.ts');assert.equal((await teacher(req('start'))).status,200);assert.equal(starts,1)
console.log('PASS: actual admin start route is disabled; authenticated professor app route still starts the class.')
