import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import {createRequire} from 'node:module'
const require=createRequire(import.meta.url)
const handles={},ipcEvents={},windows=[],timers=new Map(),notices=[]
let cfg={serverOrigin:'http://localhost:3000',screenUrl:'http://localhost:3000/screen/screen-1234567890123456',displayId:'1'}
let fail=false,all=[1,2],tid=0
class Window {
 constructor(){this.events={};this.messages=[];this.webContents={isLoading:()=>false,on:(n,f)=>this.events[n]=f,send:(...args)=>this.messages.push(args)};windows.push(this)}
 on(n,f){this.events[n]=f} once(n,f){this.events[n]=f} isDestroyed(){return false} close(){this.closing=true}
 setAlwaysOnTop(){} setIgnoreMouseEvents(){} loadFile(){return Promise.resolve()} showInactive(){}
}
const screen={getPrimaryDisplay:()=>({id:1,bounds:{width:1920,height:1080},workArea:{width:1920,height:1080}}),getAllDisplays:()=>[{id:1,bounds:{width:1920,height:1080},workArea:{width:1920,height:1080}}]}
const electron={app:{getPath:()=>'/tmp/test',setName(){},setPath(){},requestSingleInstanceLock:()=>true,setAsDefaultProtocolClient(){},on(){},whenReady:()=>({then(){}})},BrowserWindow:Window,ipcMain:{handle:(n,f)=>handles[n]=f,on:(n,f)=>ipcEvents[n]=f},screen,safeStorage:{isEncryptionAvailable:()=>false}}
const start=new Date().toISOString()
const ctx={URL,Buffer,AbortController,AbortSignal,console,__dirname:'/test',process:{env:{TEACHER_ACCESS_PASSWORD:'test-password'},argv:[]},setTimeout:(f)=>{timers.set(++tid,f);return tid},clearTimeout:id=>timers.delete(id),setInterval:()=>++tid,clearInterval(){},require:n=>n==='electron'?electron:n==='node:fs'?{mkdirSync(){},existsSync:()=>false,readFileSync:()=>JSON.stringify(cfg),writeFileSync:(_p,text)=>{cfg=JSON.parse(text)},renameSync(){}}:require(n),fetch:async(url)=>{
 if(fail)throw new Error('offline')
 if(url.includes('/posts')){const after=Number(new URL(url).searchParams.get('afterCursor')||0);return {ok:true,json:async()=>({protocol:'reaction-events-v1',classStartedAt:start,expiresAt:new Date(Date.now()+7200000).toISOString(),events:all.filter(i=>i>after).map(i=>({cursor:i,eventType:'human_only',humanPost:{createdAt:start}})),cursor:all.at(-1)})}}
 return {ok:true,json:async()=>({})}
}}
vm.createContext(ctx)
vm.runInContext(fs.readFileSync('overlay/main.cjs','utf8')+'\nglobalThis.test={startOverlay,pollPosts,stopOverlay,getWindow:()=>overlayWindow,cursor:()=>lastCursor,setControl:w=>{controlWindow=w}};',ctx)
ctx.test.setControl({webContents:{send:(...a)=>notices.push(a)}})
await ctx.test.startOverlay(cfg)
assert.equal(ctx.test.cursor(),0,'Received events alone must not move the cursor')
const ack=async(id)=>ipcEvents['overlay:rendered']({sender:ctx.test.getWindow().webContents},{eventId:id,phase:'viewport_entered',renderedAt:Date.now()})
await ack(2);assert.equal(ctx.test.cursor(),0,'Later ACK cannot skip an unacknowledged earlier event')
await ack(1);assert.equal(ctx.test.cursor(),2);assert.equal(cfg.projectionCheckpoint.cursor,2)
const old=ctx.test.getWindow();all=[1,2,3]
await ctx.test.startOverlay(cfg)
const fresh=ctx.test.getWindow()
old.events.closed()
assert.equal(ctx.test.getWindow(),fresh,'Old close callback cannot clear the replacement window')
assert.equal(fresh.messages.filter(m=>m[0]==='overlay:events').at(-1)[1].events[0].cursor,3)
await ack(3);assert.equal(cfg.projectionCheckpoint.cursor,3)
fail=true;await ctx.test.pollPosts();assert.equal(ctx.test.cursor(),3)
fail=false;all=[1,2,3,4];await ctx.test.pollPosts();await ack(4);assert.equal(cfg.projectionCheckpoint.cursor,4)
console.log('PASS: actual main confirms contiguous viewport ACKs before checkpointing, resumes unread events, survives old-window callbacks and recovers after offline')
cfg={...cfg,serverOrigin:'https://configured.example',screenUrl:'https://configured.example/screen/screen-1234567890123456'}
const urls=[];ctx.fetch=async(url)=>{urls.push(url);return {ok:false,status:503}}
await assert.rejects(()=>handles['overlay:detect-latest']({},undefined))
assert.equal(urls.length,1);assert.ok(urls[0].startsWith('https://configured.example'));assert.equal(cfg.serverOrigin,'https://configured.example')
console.log('PASS: configured server failure does not send credentials to or switch to a different localhost server')
ctx.test.stopOverlay()
console.log('Native Windows focus, monitor removal and actual projector visibility still require real testing.')

// Failed server stop is retained locally and retried against the original origin.
cfg={...cfg,serverOrigin:'http://localhost:3000',screenUrl:'http://localhost:3000/screen/screen-1234567890123456'}
ctx.fetch=async()=>{throw new Error('offline')}
await assert.rejects(()=>handles['overlay:control-session']({},'stop','test-session'))
assert.equal(cfg.pendingStop.sessionId,'test-session')
vm.runInContext('globalThis.retryStop=retryPendingStop',ctx)
ctx.fetch=async()=>({ok:false,status:409,json:async()=>({error:'conflict'})})
await assert.rejects(()=>ctx.retryStop())
assert.ok(cfg.pendingStop,'An HTTP conflict is not proof of completed stop')
ctx.fetch=async()=>({ok:true,json:async()=>({success:true})})
await ctx.retryStop();assert.equal(cfg.pendingStop,null)
console.log('PASS: failed complete stop is retained, conflict is not called success, and a confirmed retry clears the intent')
