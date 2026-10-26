import fs from 'node:fs'
import vm from 'node:vm'
import assert from 'node:assert/strict'
import ts from 'typescript'
const groupCode=ts.transpileModule(fs.readFileSync('lib/chat-pairs.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText
const c={exports:{}};vm.runInNewContext(groupCode,c)
const posts=[{id:1,authorType:'human'},{id:2,authorType:'human'},{id:3,authorType:'ai',parentId:1},{id:4,authorType:'ai',parentId:2},{id:5,authorType:'ai',parentId:999}]
const groups=c.exports.groupPostsWithReplies(posts)
assert.equal(JSON.stringify(groups.map(g=>[g.post.id,...g.replies.map(p=>p.id)])),JSON.stringify([[1,3],[2,4],[5]]));assert.equal(posts[1].id,2)
const control=fs.readFileSync('overlay/control.js','utf8');const source=ts.createSourceFile('control.js',control,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS)
const timer=source.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name.text==='startCountdownTimer').getText(source)
const started=Date.parse('2026-10-26T03:05:00Z');let now=started,tick,ended=0
const badge={textContent:'',classList:{toggle:(_name,on)=>badge.warning=on,remove:()=>badge.warning=false}},timing={textContent:'',classList:{toggle:(_n,on)=>timing.warning=on}},elapsed={textContent:''}
class Clock extends Date{static now(){return now}}
const ctx={Date:Clock,countdownInterval:null,$:id=>id==='countdownBadge'?badge:id==='elapsedTime'?elapsed:timing,clearInterval(){},setInterval:f=>{tick=f;return 1},endClass:async()=>{ended++}}
vm.createContext(ctx);vm.runInContext(timer+';globalThis.start=startCountdownTimer',ctx)
ctx.start(new Date(started).toISOString());assert.equal(badge.textContent,'授業中');assert.ok(timing.textContent.includes('自動停止まで 2時間'))
now+=18*60000;tick();assert.equal(badge.textContent,'授業中');assert.equal(elapsed.textContent,'開始から18分');assert.equal(timing.warning,false)
now=started+94*60000;tick();assert.equal(badge.textContent,'授業中');assert.equal(ended,0);
now=started+95*60000;tick();assert.equal(badge.textContent,'授業後');assert.equal(ended,0);
now=started+111*60000;tick();assert.equal(timing.warning,true);assert.equal(timing.textContent,'自動停止まで 9分')
now=started+120*60000;tick();assert.equal(ended,1)
const html=fs.readFileSync('overlay/control.html','utf8');assert.ok(html.indexOf('id="displayId"')>html.indexOf('投影ディスプレイ・表示詳細設定'))
console.log('PASS: actual grouping preserves parent/reply pairs and orphan posts; class status stays primary with elapsed minutes and a smaller countdown, warns at ten minutes and retains fixed 120-minute termination; screen selector is in details. Native projector/resize confirmation remains required.')

const stateContext={exports:{}}
vm.runInNewContext(ts.transpileModule(fs.readFileSync('lib/class-state.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText,stateContext)
const state=stateContext.exports.classState
const config={status:'scheduled',isLocked:false,classStartedAt:null,reactionConfig:{}}
assert.equal(state(config,started).label,'開始前')
assert.equal(state({...config,classStartedAt:new Date(started).toISOString()},started+18*60000).label,'授業中')
assert.equal(state({...config,classStartedAt:new Date(started).toISOString()},started+120*60000).label,'終了')
assert.equal(state({...config,status:'completed'},started).label,'終了')
assert.equal(state({...config,classStartedAt:new Date(started).toISOString()},started+95*60000).label,'授業後')
assert.equal(state({...config,classStartedAt:new Date(started).toISOString()},started+95*60000).active,true)
const entry=fs.readFileSync('app/enter/[entrySlug]/page.tsx','utf8')
assert.doesNotMatch(entry,/pendingPreviousConfirmation|handleSwitchNewParticipant|switchNewParticipant|signOut/)
assert.match(entry,/setDisplayName\(saved.displayName.trim\(\)\)/)
console.log('PASS admin pre-start/running/ended/expiry states; entry restores saved name without a confirmation screen or auth reset.')
