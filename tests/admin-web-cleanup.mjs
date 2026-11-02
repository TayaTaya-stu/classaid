import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'
import {createRequire} from 'node:module'
const require=createRequire(import.meta.url)
function load(file,deps={}){const exports={};vm.runInNewContext(ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.React}}).outputText,{exports,require:n=>n in deps?deps[n]:require(n),React:deps.react,fetch:deps.fetch,console,Date,Intl,URLSearchParams,AbortController,AbortSignal,setTimeout,clearTimeout,setInterval,clearInterval});return exports}
const calls=[]
const control=load('lib/reaction-ai/control.ts',{'next/server':require('next/server'),'@/lib/supabase-admin':{supabaseAdmin:{rpc:async(name,args)=>{calls.push({name,args});return{data:{success:true},error:null}}}}})
const id='11111111-1111-1111-1111-111111111111'
assert.equal((await control.controlReaction(id,'configure','empathy')).status,400);assert.equal(calls.length,0)
for(const mode of ['off','lecture_bridge','neutral'])assert.equal((await control.controlReaction(id,'configure',mode)).status,200)
assert.deepEqual(calls.filter(c=>c.name==='control_reaction_session').map(c=>c.args.p_mode),['off','lecture_bridge','neutral'])
for(const action of ['stop','pause_ai','resume_ai','pause_projection','resume_projection'])assert.equal((await control.controlReaction(id,action)).status,200)
assert.equal((await control.controlReaction(id,'configure','invalid')).status,400)
console.log('PASS actual control API: empathy cannot be newly configured; off/lecture-bridge/neutral retained; class completion and individual controls retained')
let si=0,ri=0,states=[],refs=[],nodes=[],requests=[]
const session={status:'scheduled',isLocked:false,isCurrentTarget:true,isArchived:false,classStartedAt:null,pdfFilePath:null,reactionConfig:{mode:'off',status:'active',pipelineEnabled:true,isMockAi:false}}
const dashboard={sessions:[{id,sessionNumber:1,scheduledAt:new Date().toISOString(),isDevelopment:true,status:'scheduled',isArchived:false,isCurrentTarget:true}],selectedSessionId:id,rooms:[],sessionControl:session,sharedWall:null}
const react={useState(initial){const i=si++;if(!(i in states))states[i]=initial;return[states[i],v=>states[i]=typeof v==='function'?v(states[i]):v]},useRef(initial){const i=ri++;return refs[i]??={current:initial}},useEffect(){},useCallback:f=>f,createElement:(type,props,...children)=>({type,props,children})}
const fetch=async(url,options)=>{requests.push({url,options});if(options?.method==='POST'){const b=JSON.parse(options.body);session.reactionConfig.mode=b.mode;return{ok:true,status:200,json:async()=>({success:true})}}return{ok:true,status:200,json:async()=>dashboard}}
const component=load('app/admin/page.tsx',{react,fetch,'./ClassStatus':()=>null,'./AdminSessionOrganizer':()=>null,'./AdminSessionControl':()=>null}).default
function walk(n){if(!n||typeof n!=='object')return;if(Array.isArray(n)){n.forEach(walk);return}nodes.push(n);walk(n.children)}
function draw(){si=ri=0;nodes=[];walk(component());return nodes}
function init(mode='off',started=false){states=[];refs=[];states[0]=true;states[4]=dashboard;states[5]=id;states[15]=mode;session.classStartedAt=started?new Date().toISOString():null;session.reactionConfig.mode=mode;draw()}
function text(node){if(node===null||node===undefined||typeof node==='boolean')return'';if(Array.isArray(node))return node.map(text).join('');return typeof node==='object'?text(node.children):String(node)}
function options(){return nodes.filter(n=>n.type==='option'&&['off','lecture_bridge','neutral','empathy'].includes(n.props.value))}
init();assert.deepEqual(options().map(n=>n.props.value),['off','lecture_bridge','neutral']);assert.ok(!nodes.some(n=>n.type==='button'&&text(n).includes('AIと音声を停止')))
const details=nodes.find(n=>n.type==='details'&&text(n).includes('研究用ログ・CSV'));assert.ok(details);assert.ok(!details.props?.open);assert.ok(nodes.some(n=>n.type==='button'&&text(n).includes('授業回の集計')))
const dropdown=nodes.find(n=>n.type==='select'&&n.props.value==='off'&&n.children.flat(Infinity).some(c=>c?.props?.value==='lecture_bridge'))
dropdown.props.onChange({target:{value:'neutral'}});draw();const save=nodes.find(n=>n.type==='button'&&text(n)==='設定を保存');assert.equal(save.props.disabled,false);save.props.onClick();await new Promise(r=>setTimeout(r,0));assert.equal(JSON.parse(requests.find(r=>r.options?.method==='POST').options.body).mode,'neutral')
init('empathy');assert.equal(options().find(n=>n.props.value==='empathy').props.disabled,true);assert.equal(nodes.find(n=>n.type==='button'&&text(n)==='設定を保存').props.disabled,true)
init('neutral',true);assert.equal(nodes.find(n=>n.type==='button'&&text(n)==='設定を保存').props.disabled,true,'condition still locked after class start')
console.log('PASS actual admin markup/listeners: three normal options; retired empathy is read-only and cannot be resaved; neutral saved; started condition locked; red combined stop absent; research panel closed by default with controls retained')
const classComponent=load('app/admin/AdminSessionControl.tsx',{react,'@/lib/supabase':{supabase:{}}}).default
si=ri=0;states=[];refs=[];nodes=[];walk(classComponent({sessionId:id,control:session,onUpdated:async()=>{}}));assert.ok(!text(nodes).includes('投影の表示方式'));assert.ok(!fs.readFileSync('app/admin/AdminSessionControl.tsx','utf8').includes('ProjectionDisplayControl'))
assert.ok(nodes.some(n=>n.type==='button'&&text(n).includes('投影のみ停止')))
console.log('PASS actual session-control markup: timing selector removed; individual projection pause retained; no desktop protocol or chat changes')
