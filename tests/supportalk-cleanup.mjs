import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import path from 'node:path'
import { createRequire } from 'node:module'
import ts from 'typescript'
const require = createRequire(import.meta.url)
const source = fs.readFileSync('overlay/main.cjs','utf8')
function main(primary) {
 const messages=[]
 const paths={appData:'/app-data',userData:'/legacy',sessionData:'/legacy-cache'}, events={}, order=[], windows=[]
 let ready, calls=0
 const electron={app:{getPath:n=>paths[n],setName(){},setPath(n,p){paths[n]=p;order.push(n)},requestSingleInstanceLock(){order.push('lock');return primary},exit(){throw new Error('SECONDARY_EXIT')},on(n,f){events[n]=f},isReady:()=>true,setAsDefaultProtocolClient(){},whenReady:()=>({then:f=>{ready=f}})},
 BrowserWindow:class {constructor(){windows.push(this);this.webContents={on(){},send:(...args)=>messages.push(args)}} isDestroyed(){return false} isMinimized(){return true} restore(){calls++} show(){calls++} focus(){calls++} loadFile(){return Promise.resolve()} on(){}},
 ipcMain:{handle(){},on(){}},safeStorage:{isEncryptionAvailable:()=>false},globalShortcut:{register:()=>true}}
 const ctx={URL,Buffer,AbortSignal,console,__dirname:'/app/overlay',process:{argv:[],env:{}},require:n=>n==='electron'?electron:n==='node:fs'?{mkdirSync(){},renameSync(){},existsSync:()=>false,readFileSync:()=>'{"screenUrl":"","activeSessionId":"session-a"}',writeFileSync(){}}:require(n)}
 vm.createContext(ctx)
 try {vm.runInContext(source+'\nglobalThis.helpers={createControlWindow,registerControlShortcuts};',ctx)} catch(e){assert.equal(e.message,'SECONDARY_EXIT');return {events,order,paths,windows}}
 return {ctx,events,order,paths,windows,messages,get calls(){return calls},ready}
}
const secondary=main(false)
assert.equal(secondary.windows.length,0)
assert.equal(secondary.events['second-instance'],undefined,'Secondary must exit before registering runtime handlers')
const primary=main(true)
assert.equal(primary.paths.userData,path.join('/app-data','SupporTalk'))
assert.equal(primary.paths.sessionData,path.join(primary.paths.userData,'browser-session'))
assert.ok(primary.order.indexOf('sessionData')<primary.order.indexOf('lock'))
primary.ctx.helpers.createControlWindow()
primary.events['second-instance']({},[])
assert.equal(primary.windows.length,1)
assert.equal(primary.calls,3,'Second invocation restores, shows and focuses existing control')
assert.equal(primary.ctx.helpers.registerControlShortcuts(),'CommandOrControl+Alt+S')
primary.ctx.fetch=async()=>({ok:true,json:async()=>({sessionId:'session-a',reactionStatus:'stopped',projectionStatus:'paused'})})
vm.runInContext('sessionControlDeadline = Date.now() + 60000',primary.ctx)
await vm.runInContext('syncClassState()',primary.ctx)
assert.equal(primary.messages.some(m=>m[0]==='overlay:stop-audio'),true)
assert.equal(primary.messages.at(-1)[1].classState.projectionStatus,'paused')
const count=primary.messages.length
primary.ctx.fetch=async()=>({ok:true,json:async()=>({sessionId:'different-class',reactionStatus:'active'})})
await vm.runInContext('syncClassState()',primary.ctx)
assert.equal(primary.messages.length,count,'Wrong-class responses do not affect native devices')
console.log('PASS: actual main: separate browser storage, secondary early exit, second-instance reuses and restores one window, three-key shortcut')

function load(file,deps){const exports={};vm.runInNewContext(ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText,{exports,Request,Response,URL,Date,process:{env:{}},require:n=>n in deps?deps[n]:require(n)});return exports}
let calls=[]
let rpcError=null
const control=load('lib/reaction-ai/control.ts',{'@/lib/supabase-admin':{supabaseAdmin:{from:()=>({select:()=>({limit:async()=>({error:null}),eq:()=>({maybeSingle:async()=>({data:{is_current_target:true},error:null})})})}),rpc:async(n)=>{calls.push(n);return {data:{success:true},error:rpcError}}}}})
const id='11111111-1111-1111-1111-111111111111'
rpcError={message:'offline'}
assert.equal((await control.controlReaction(id,'start')).status,503)
assert.deepEqual(calls,['check_or_expire_120m'],'No mutation if expiry validation failed')
calls=[];rpcError=null
assert.equal((await control.controlReaction(id,'start')).status,200)
assert.deepEqual(calls,['check_or_expire_120m','start_designated_reaction_session'])
const teacher=load('app/api/teacher/session-control/route.ts',{'@/lib/teacher-auth':{isTeacherAuthenticated:async()=>true},'@/lib/reaction-ai/control':control})
assert.equal((await teacher.POST(new Request('http://local/api',{method:'POST',body:JSON.stringify({sessionId:id,action:'typo',mode:'off'})}))).status,400)
console.log('PASS: actual control routes: expiry DB failure blocks mutation, unknown teacher action rejected')

let rows=[],queries=[]
const admin={from(name){queries.push(name);let selected=rows.slice();const q={select(){return q},neq(k,v){selected=selected.filter(row=>row[k]!==v);return q},eq(k,v){selected=selected.filter(row=>row[k]===v);return q},order(){return q},limit:async n=>({data:selected.slice(0,n),error:null})};return q}}
const latest=load('app/api/screen/latest/route.ts',{'next/server':{...require('next/server'),after:()=>{}},'@/lib/supabase-admin':{supabaseAdmin:admin},'@/lib/teacher-auth':{isTeacherAuthenticated:async()=>true},'@/lib/admin-auth':{isAdminAuthenticated:async()=>false}})
const old={id:'old',room_mode:'shared',is_current_target:false,class_started_at:new Date().toISOString()}
rows=[old]
assert.equal((await latest.GET(new Request('http://localhost:3000/api/screen/latest'))).status,409)
rows=[old,{id:'chosen',room_mode:'shared',is_current_target:true,screen_slug:'screen-x'}]
let res=await latest.GET(new Request('http://192.168.11.12:3000/api/screen/latest'))
let data=await res.json()
assert.equal(data.sessionId,'chosen');assert.equal(data.screenUrl,'http://192.168.11.12:3000/screen/screen-x')
rows=[{...old,is_current_target:true},...rows]
assert.equal((await latest.GET(new Request('http://local/api'))).status,409)
for(const file of ['app/teacher/page.tsx','app/teacher/room/[roomId]/page.tsx','app/teacher/speech-worker/page.tsx']) {
 let target
 const page=load(file,{'next/navigation':{redirect:p=>{target=p}}})
 page.default();assert.equal(target,'/admin')
}
for(const file of ['app/api/teacher/dashboard/route.ts','app/api/teacher/room-monitor/route.ts']) assert.equal((await load(file,{}).GET()).status,410)
console.log('PASS: actual latest route uses explicit designation only; old web controls redirect and legacy APIs are retired')
console.log('No native Windows process, microphone, projector, remote database or paid Gemini was exercised.')
