import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import { createRequire } from 'node:module'
import ts from 'typescript'
const require = createRequire(import.meta.url)
let sessions = []
const admin = { from:()=>({ select:()=>({eq:()=>({eq:()=>({limit:async()=>({data:sessions,error:null})})})})}) }
function loadTs(file, extra, env={}) {
 const exports={}
 const code=ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText
 vm.runInNewContext(code,{exports,Request,Response,URL,Date,process:{env},require:spec=>{
  if(spec==='server-only')return {}
  if(spec==='@/lib/supabase-admin')return {supabaseAdmin:admin}
  if(spec in extra)return extra[spec]
  return require(spec)
 }})
 return exports
}
const env={STUDENT_BASE_URL:'http://192.168.11.12:3000'}
const entry=loadTs('lib/student-entry.ts',{},env)
assert.equal(entry.studentEntryUrl(new Request('http://localhost:3000/api')), 'http://192.168.11.12:3000/join')
assert.throws(()=>loadTs('lib/student-entry.ts',{}).studentEntryUrl(new Request('http://localhost:3000/api')))
const route=loadTs('app/join/route.ts',{'@/lib/student-entry':entry})
const request=new Request('http://192.168.11.12:3000/join')
assert.equal((await route.GET(request)).status,409)
const active={id:'session-a',entry_slug:'entry-a',status:'not_started',is_locked:false,class_started_at:null,auto_expired_at:null}
sessions=[active]
let response=await route.GET(request)
assert.equal(response.status,303)
assert.equal(response.headers.get('location'),'http://192.168.11.12:3000/enter/entry-a')
assert.match(response.headers.get('cache-control'),/no-store/)

// Regression test: Even if request.url is localhost, Location header must be LAN address
const localhostReq = new Request('http://localhost:3000/join')
const localhostResp = await route.GET(localhostReq)
assert.equal(localhostResp.status, 303)
assert.equal(localhostResp.headers.get('location'), 'http://192.168.11.12:3000/enter/entry-a')

// Error handling: If student entry URL is invalid (e.g. localhost or unset), stop with 503
const invalidEntry = loadTs('lib/student-entry.ts', {}, { STUDENT_BASE_URL: 'http://localhost:3000' })
const invalidRoute = loadTs('app/join/route.ts', { '@/lib/student-entry': invalidEntry })
const errResp = await invalidRoute.GET(localhostReq)
assert.equal(errResp.status, 503)
assert.match(await errResp.text(), /授業情報を確認できません/)

sessions=[{...active,id:'session-b',entry_slug:'entry-b'}]
assert.match((await route.GET(request)).headers.get('location'),/entry-b$/)
sessions=[{...active,status:'completed'}]
assert.equal((await route.GET(request)).status,409)
sessions=[{...active,class_started_at:new Date(Date.now()-121*60000).toISOString()}]
assert.equal((await route.GET(request)).status,409)
sessions=[active,active]
assert.equal((await route.GET(request)).status,409)
const qr=loadTs('app/api/screen/qr/route.ts',{'@/lib/student-entry':entry},env)
response=await qr.GET(new Request('http://localhost:3000/api/screen/qr?target='+encodeURIComponent(env.STUDENT_BASE_URL+'/join')))
assert.equal(response.status,200)
assert.match(await response.text(),/<svg/)
assert.equal((await qr.GET(new Request('http://localhost:3000/api/screen/qr?target='+encodeURIComponent('http://localhost:3000/enter/old')))).status,400)
console.log('PASS: actual join/QR routes: stable LAN URL, no cache, designation switch, ended/expired/ambiguous refusal')

// Execute the actual QR window and shortcut functions with native boundaries replaced.
const created=[],registered=[]
let initial={displayId:'1',serverOrigin:'http://localhost:3000'}
class Window {
 constructor(){created.push(this);this.webContents={};this.events={}}
 isDestroyed(){return false} isVisible(){return true}
 setAlwaysOnTop(...args){this.top=args} moveTop(){this.raised=true}
 loadFile(_file,options){this.options=options;return Promise.resolve()}
 on(key,fn){this.events[key]=fn} setPosition(){} showInactive(){} getBounds(){return {width:340}}
}
const display={id:1,workArea:{x:0,y:0,width:1920,height:1080},bounds:{width:1920,height:1080}}
const electron={app:{getPath:()=>'/tmp/test',setName(){},setPath(){},requestSingleInstanceLock:()=>true,setAsDefaultProtocolClient(){},on(){},whenReady:()=>({then(){}})},BrowserWindow:Window,ipcMain:{handle(){},on(){}},screen:{getAllDisplays:()=>[display],getPrimaryDisplay:()=>display},globalShortcut:{register:key=>{registered.push(key);return registered.length===2}},safeStorage:{isEncryptionAvailable:()=>false}}
const context={URL,Buffer,AbortSignal,console,__dirname:'/tmp/test',process:{argv:[],env:{}},setTimeout:fn=>{fn();return 1},require:spec=>{
 if(spec==='electron')return electron
 if(spec==='node:fs')return {existsSync:()=>false,mkdirSync(){},renameSync(){},readFileSync:()=>JSON.stringify(initial),writeFileSync:(_p,text)=>{initial=JSON.parse(text)}}
 return require(spec)
},fetch:async()=>({ok:true,json:async()=>({entryPath:'/enter/entry-b',fixedEntryUrl:env.STUDENT_BASE_URL+'/join',isDesignatedSession:true})})}
vm.createContext(context)
vm.runInContext(fs.readFileSync('overlay/main.cjs','utf8')+'\nglobalThis.test={showQrWindow,registerControlShortcuts};',context)
await context.test.showQrWindow('http://localhost:3000/screen/screen-1234567890123456')
assert.deepEqual(created[0].top, [true,'screen-saver'])
assert.equal(created[0].options.query.entryUrl,env.STUDENT_BASE_URL+'/join')
created[0].events.blur()
assert.equal(created[0].raised,true)
assert.equal(context.test.registerControlShortcuts(),'CommandOrControl+Alt+T')
assert.equal(registered.includes('CommandOrControl+Shift+O'),false)
console.log('PASS: real QR window uses high topmost level, restores stacking, exposes URL; shortcut checks/fallback')
console.log('Native Windows focus/fullscreen behavior and smartphone connectivity still require real testing.')
