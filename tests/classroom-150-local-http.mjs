// Local functional-volume rehearsal. NOT a Vercel/Supabase capacity benchmark.
// Uses real route handlers, signed entry cookies, job service and SQL functions.
// Replaces Supabase Auth, its HTTP transport, Next request context/after hosting, and external AI generation.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import crypto from 'node:crypto'
import {createRequire} from 'node:module'
import {createServer} from 'node:http'
import {AsyncLocalStorage} from 'node:async_hooks'
import {performance} from 'node:perf_hooks'
import {fileURLToPath} from 'node:url'
import ts from 'typescript'
import {PGlite} from '@electric-sql/pglite'
const require=createRequire(import.meta.url)
const root=fileURLToPath(new URL('../',import.meta.url))
const begun=performance.now()
const db=new PGlite()
const sql=async(query,args=[])=>(await db.query(query,args)).rows
const log=message=>console.log(message)
await db.exec('CREATE ROLE anon;CREATE ROLE authenticated;CREATE ROLE service_role BYPASSRLS;CREATE SCHEMA auth;CREATE TABLE auth.users(id uuid PRIMARY KEY);CREATE SCHEMA storage;CREATE TABLE storage.buckets(id text PRIMARY KEY,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);')
const migrationNumber=f=>f.startsWith('000')?0:Number(f.match(/(?:^|_)(\d{3})_/)[1])
for(const name of fs.readdirSync(path.join(root,'supabase/migrations')).filter(f=>f.endsWith('.sql')).sort((a,b)=>migrationNumber(a)-migrationNumber(b)))await db.exec(fs.readFileSync(path.join(root,'supabase/migrations',name),'utf8'))
const sid=(await sql('SELECT create_shared_session(150,now(),false) id'))[0].id
await sql('SELECT set_designated_session($1)',[sid])
await sql("SELECT control_reaction_session($1,'configure','lecture_bridge',false)",[sid])
const session=(await sql('SELECT * FROM sessions WHERE id=$1',[sid]))[0]
const authTokens=new Map()
for(let i=0;i<150;i++){const uid=crypto.randomUUID();await sql('INSERT INTO auth.users(id) VALUES($1)',[uid]);authTokens.set('local-only-auth-'+i,uid)}
const counts={http:0,sql:0,aiStub:0,droppedInitialKicks:0,asyncErrors:0}
let failParentRead=false
const identifier=s=>{if(!/^[a-z_][a-z0-9_]*$/i.test(s))throw Error('Bad test identifier');return '"'+s+'"'}
function transport(table){
 let columns='*',filters=[],args=[],orders=[],maximum=null,update=null,insert=null,promise,parentRead=false
 const value=v=>{args.push(v);return '$'+args.length}
 const q={
  select(s='*'){columns=s;return q},eq(k,v){filters.push(`${identifier(k)}=${value(v)}`);if(table==='posts'&&k==='author_type'&&v==='human')parentRead=true;return q},neq(k,v){filters.push(`${identifier(k)}<>${value(v)}`);return q},gt(k,v){filters.push(`${identifier(k)}>${value(v)}`);return q},
  in(k,v){filters.push(`${identifier(k)}=ANY(${value(v)})`);return q},order(k,o={}){orders.push(`${identifier(k)} ${o.ascending?'ASC':'DESC'}`);return q},limit(n){maximum=n;return q},abortSignal(){return q},
  update(row){update=row;return q},insert(row){insert=row;return q},
  async single(){const r=await run();return r.error?r:r.data.length===1?{data:r.data[0],error:null}:{data:null,error:{message:'single row expected'}}},
  async maybeSingle(){const r=await run();return r.error?r:r.data.length<=1?{data:r.data[0]||null,error:null}:{data:null,error:{message:'at most one row expected'}}},
  then(a,b){return run().then(a,b)},
 }
 function run(){return promise??=(async()=>{try{
  counts.sql++
  if(failParentRead&&parentRead)return {data:null,error:{message:'injected parent read failure'}}
  const fields=columns==='*'?'*':columns.split(',').map(s=>identifier(s.trim())).join(',')
  const where=()=>filters.length?' WHERE '+filters.join(' AND '):''
  let statement
  if(update){const setters=Object.entries(update).map(([k,v])=>`${identifier(k)}=${value(v)}`).join(',');statement=`UPDATE ${identifier(table)} SET ${setters}${where()} RETURNING ${fields}`}
  else if(insert){const keys=Object.keys(insert);statement=`INSERT INTO ${identifier(table)}(${keys.map(identifier).join(',')}) VALUES(${keys.map(k=>value(typeof insert[k]==='object'&&insert[k]!==null?JSON.stringify(insert[k]):insert[k])).join(',')}) RETURNING ${fields}`}
  else statement=`SELECT ${fields} FROM ${identifier(table)}${where()}${orders.length?' ORDER BY '+orders.join(','):''}${maximum===null?'':' LIMIT '+Number(maximum)}`
  return {data:await sql(statement,args),error:null}
 }catch(error){return {data:null,error:{message:error.message,code:error.code}}}})()}
 return q
}
const setReturning=new Set(['verify_reaction_room_access','claim_reaction_jobs','claim_session_reaction_jobs'])
const admin={from:transport,auth:{async getUser(token){const uid=authTokens.get(token);return uid?{data:{user:{id:uid}},error:null}:{data:{user:null},error:{message:'test auth invalid'}}}},rpc(name,p={}){
 const task=(async()=>{try{counts.sql++;const keys=Object.keys(p),args=keys.map(k=>typeof p[k]==='object'&&p[k]!==null&&!Array.isArray(p[k])?JSON.stringify(p[k]):p[k]);const call=`public.${identifier(name)}(${keys.map((k,i)=>identifier(k)+' => $'+(i+1)).join(',')})`;const rows=await sql(setReturning.has(name)?`SELECT * FROM ${call}`:`SELECT ${call} AS result`,args);return {data:setReturning.has(name)?rows:rows[0].result,error:null}}catch(error){return {data:null,error:{message:error.message,code:error.code}}}})()
 task.abortSignal=()=>task;return task
}}
const requestScope=new AsyncLocalStorage(),background=new Set(),backgroundErrors=[]
let allowInitialKicks=true
function after(callback){const scope=requestScope.getStore();if(!scope)throw Error('after outside request');scope.after.push(callback)}
function launch(callback){let task;task=Promise.resolve().then(callback).catch(error=>{counts.asyncErrors++;backgroundErrors.push(error.message)}).finally(()=>background.delete(task));background.add(task)}
async function settle(){while(background.size)await Promise.all([...background])}
const fakeEnv={PARTICIPANT_HMAC_SECRET:'local-test-secret-not-for-production-150',TEACHER_ACCESS_PASSWORD:'local-teacher-test-password'}
const loaded=new Map()
function load(relative){const filename=path.resolve(root,relative);if(loaded.has(filename))return loaded.get(filename);const testModule={exports:{}};loaded.set(filename,testModule.exports)
 const code=ts.transpileModule(fs.readFileSync(filename,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText
 const customRequire=n=>{
  if(n==='server-only')return {}
  if(n==='@/lib/supabase-admin')return {supabaseAdmin:admin}
  if(n==='next/server')return {...require('next/server'),after}
  if(n==='next/headers')return {cookies:async()=>({get:key=>{const raw=requestScope.getStore()?.cookie||'';const match=raw.split(';').map(s=>s.trim()).find(s=>s.startsWith(key+'='));return match?{value:match.slice(key.length+1)}:undefined}})}
  if(n==='./generator'&&relative.endsWith('service.ts'))return {generateReactionReply:async p=>{counts.aiStub++;await new Promise(r=>setTimeout(r,15));return {text:'local fixture reply: '+p.studentMessage,source:'generated',fallbackId:null,modelName:'local-stub-no-google',contextMetadata:{promptVersion:'local-rehearsal-only',archiveCutoff:p.postedAt}}}}
  if(n==='@google/genai')throw Error('This rehearsal must not call Google')
  if(n.startsWith('@/'))return load(n.slice(2)+(/\.[cm]?[jt]s$/.test(n)?'':'.ts'))
  if(n.startsWith('.'))return load(path.relative(root,path.resolve(path.dirname(filename),n+(/\.[cm]?[jt]s$/.test(n)?'':'.ts'))))
  return require(n)
 }
 vm.runInNewContext(code,{exports:testModule.exports,module:testModule,require:customRequire,process:{env:fakeEnv},console,Buffer,URL,Request,Response,File,FormData,AbortSignal,AbortController,Date,setTimeout,clearTimeout,setInterval,clearInterval,structuredClone,TextEncoder,TextDecoder},{filename})
 return testModule.exports
}
const enter=load('app/api/enter/route.ts'),posts=load('app/api/rooms/[roomSlug]/posts/route.ts'),likes=load('app/api/rooms/[roomSlug]/likes/route.ts'),screen=load('app/api/screen/[screenSlug]/posts/route.ts'),latest=load('app/api/screen/latest/route.ts')
load('lib/reaction-ai/service.ts')
const {retainChatPairs}=load('lib/chat-pairs.ts')
const server=createServer(async(req,res)=>{
 counts.http++
 const scope={cookie:req.headers.cookie||'',after:[]}
 await requestScope.run(scope,async()=>{try{
  const buffers=[];for await(const b of req)buffers.push(b)
  try{const message=JSON.parse(Buffer.concat(buffers).toString()).message;const match=typeof message==='string'?message.match(/^client:(\d+) round:/):null;scope.dropKick=Boolean(match&&Number(match[1])%10===9)}catch{scope.dropKick=false}
  const url='http://127.0.0.1'+req.url,request=new Request(url,{method:req.method,headers:req.headers,...(buffers.length?{body:Buffer.concat(buffers)}:{})})
  const pathname=new URL(url).pathname
  let result
  if(pathname==='/api/enter')result=await enter[req.method](request)
  else if(pathname==='/api/screen/latest')result=await latest.GET(request)
  else {
   const room=pathname.match(/^\/api\/rooms\/([^/]+)\/(posts|likes)$/),display=pathname.match(/^\/api\/screen\/([^/]+)\/posts$/)
   if(room)result=await (room[2]==='posts'?posts:likes)[req.method](request,{params:Promise.resolve({roomSlug:room[1]})})
   else if(display)result=await screen.GET(request,{params:Promise.resolve({screenSlug:display[1]})})
   else result=Response.json({error:'test route missing'},{status:404})
  }
  const body=Buffer.from(await result.arrayBuffer());res.writeHead(result.status,Object.fromEntries(result.headers));res.end(body)
  for(const callback of scope.after){if(allowInitialKicks&&scope.dropKick){counts.droppedInitialKicks++;continue}launch(callback)}
 }catch(error){res.writeHead(500,{'Content-Type':'application/json'});res.end(JSON.stringify({testHarnessError:error.message}));backgroundErrors.push(error.message)}})
})
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
const base='http://127.0.0.1:'+server.address().port
const timings={entry:[],post:[],read:[]}
async function http(client,endpoint,body,kind,extra={}){
 const at=performance.now();const response=await fetch(base+endpoint,{method:body===undefined?'GET':'POST',headers:{...(body===undefined?{}:{'Content-Type':'application/json'}),...(client?.cookie?{Cookie:client.cookie}:{}),...extra},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(60000)})
 const data=await response.json();if(kind)timings[kind].push(performance.now()-at)
 return {status:response.status,data,cookie:response.headers.get('set-cookie')?.split(';')[0]}
}
try{
 log('LOCAL ONLY: 150 virtual clients; actual routes/cookies/jobs/SQL; Auth+AI+hosting transports replaced; PGlite serializes DB commands.')
 const clients=Array.from({length:150},(_,i)=>({name:'試験参加者'+String(i).padStart(3,'0'),authToken:'local-only-auth-'+i,consented:i%5!==0,cookie:''}))
 await Promise.all(clients.map(async c=>{const r=await http(c,'/api/enter',{entrySlug:session.entry_slug,displayName:c.name,consented:c.consented,authToken:c.authToken,claimExisting:false},'entry');assert.equal(r.status,200,JSON.stringify(r.data));c.cookie=r.cookie;c.roomSlug=r.data.roomSlug;c.participantId=r.data.participantId}))
 assert.equal(new Set(clients.map(c=>c.participantId)).size,150)
 await Promise.all(clients.slice(0,10).map(async c=>{const r=await http(c,'/api/enter',{entrySlug:session.entry_slug,displayName:c.name,consented:c.consented,authToken:c.authToken,claimExisting:false});assert.equal(r.status,200);assert.equal(r.data.participantId,c.participantId)}))
 assert.equal((await sql('SELECT count(*)::int n FROM session_attendances WHERE session_id=$1',[sid]))[0].n,150)
 log('PASS 150 HTTP entries; 150 identities; 10 entry retries preserve identity.')
 await sql('SELECT start_designated_reaction_session($1)',[sid])
 const expected=new Map(),firstPosts=[]
 async function round(number){await Promise.all(clients.map(async(c,i)=>{const requestId=crypto.randomUUID(),message=`client:${i} round:${number}`,body={message,requestId,clientSentAt:new Date().toISOString()},endpoint=`/api/rooms/${c.roomSlug}/posts`;const responses=await Promise.all([http(c,endpoint,body,'post'),http(c,endpoint,body,'post')]);for(const r of responses)assert.equal(r.status,200,JSON.stringify(r.data));assert.equal(responses[0].data.post.id,responses[1].data.post.id);expected.set(responses[0].data.post.id,message);if(number===1)firstPosts.push(responses[0].data.post.id)}));await settle()}
 async function recoverAll(){allowInitialKicks=false;let polls=0;while((await sql("SELECT count(*)::int n FROM ai_reply_jobs WHERE session_id=$1 AND status<>'completed'",[sid]))[0].n){assert.ok(polls++<180,'recovery cannot drain');const r=await http(null,'/api/screen/latest',undefined,null,{'x-teacher-password':fakeEnv.TEACHER_ACCESS_PASSWORD});assert.equal(r.status,200);await settle()}return polls}
 await round(1);await round(2);await round(3)
 const strandedBeforeRecovery=(await sql("SELECT count(*)::int n FROM ai_reply_jobs WHERE session_id=$1 AND status='pending'",[sid]))[0].n
 assert.equal(strandedBeforeRecovery,45,'45 durable jobs must remain after suppressing both retry kicks')
 const recoveryPolls=await recoverAll();assert.ok(recoveryPolls>=12)
 const beforeFourth=(await sql('SELECT max(id)::int id FROM posts WHERE session_id=$1',[sid]))[0].id
 let fullSnapshot
 await Promise.all(clients.map(async c=>{const r=await http(c,`/api/rooms/${c.roomSlug}/posts`,undefined,'read');assert.equal(r.status,200,JSON.stringify(r.data));assert.equal(r.data.currentUser.displayName,c.name);assert.ok(r.data.posts.length>=100&&r.data.posts.length<=200);fullSnapshot=retainChatPairs(r.data.posts)}))
 const snapshotIds=new Set(fullSnapshot.map(p=>p.id));const orphanReplies=fullSnapshot.filter(p=>p.authorType==='ai'&&!snapshotIds.has(p.parentId)).length
 log('OBSERVATION full snapshot: '+JSON.stringify({human:fullSnapshot.filter(p=>p.authorType==='human').length,ai:fullSnapshot.filter(p=>p.authorType==='ai').length,orphanReplies}))
 assert.equal(orphanReplies,0,'Recent chat snapshot must include the human parent of every AI reply')
 const likeTarget=fullSnapshot.find(p=>p.authorType==='human').id
 failParentRead=true;assert.equal((await http(clients[0],`/api/rooms/${clients[0].roomSlug}/posts`)).status,503);failParentRead=false
 log('PASS 450 unique posts despite 900 POST requests; 150 signed-cookie readers see their own profile and latest history with reply parents.')
 await round(4);await recoverAll();await settle()
 assert.equal(expected.size,600)
 const visible=(await sql('SELECT id FROM posts WHERE session_id=$1 ORDER BY id DESC LIMIT 100',[sid])).map(r=>r.id)
 await Promise.all(clients.map(async c=>{let cursor=beforeFourth,seen=new Set(),clientState=fullSnapshot;for(let page=0;page<6;page++){const r=await http(c,`/api/rooms/${c.roomSlug}/posts?afterId=${cursor}&visibleIds=${visible.join(',')}`,undefined,'read');assert.equal(r.status,200,JSON.stringify(r.data));assert.equal(r.data.resultMode,'delta');assert.ok(r.data.likeUpdates.length<=400);if(!r.data.posts.length)break;const previousCursor=cursor;for(const p of r.data.posts){if(p.id>previousCursor){assert.ok(!seen.has(p.id));seen.add(p.id)}cursor=Math.max(cursor,p.id)}clientState=retainChatPairs([...clientState,...r.data.posts]);assert.ok(clientState.length<=200);const ids=new Set(clientState.map(p=>p.id));assert.ok(clientState.every(p=>p.authorType!=='ai'||ids.has(p.parentId)))}assert.equal(seen.size,300,'100-record pagination must drain 150 human + 150 AI posts')}))
 await Promise.all(clients.map(c=>Promise.all([http(c,`/api/rooms/${c.roomSlug}/likes`,{postId:likeTarget,liked:true}),http(c,`/api/rooms/${c.roomSlug}/likes`,{postId:likeTarget,liked:true})]).then(results=>{results.forEach(r=>assert.equal(r.status,200))})))
 assert.equal((await sql('SELECT count(*)::int n FROM post_likes WHERE post_id=$1',[likeTarget]))[0].n,150)
 assert.equal((await sql('SELECT likes FROM posts WHERE id=$1',[likeTarget]))[0].likes,150)
 const finalCursor=(await sql('SELECT max(id)::int id FROM posts WHERE session_id=$1',[sid]))[0].id
 const refreshed=await http(clients[0],`/api/rooms/${clients[0].roomSlug}/posts?afterId=${finalCursor}&visibleIds=${fullSnapshot.map(p=>p.id).join(',')}`)
 assert.equal(refreshed.status,200);assert.equal(refreshed.data.likeUpdates.find(p=>p.id===likeTarget)?.likesCount,150);assert.equal(refreshed.data.likeUpdates.find(p=>p.id===likeTarget)?.isLiked,true)
 log('PASS 150 readers drain 300 new records through capped delta pages; 300 duplicate likes produce 150 likes; 200-row parent like refresh and parent-read 503 verified.')
 const pairs=await sql('SELECT p.id,p.parent_id,p.message,h.message human_message FROM posts p JOIN posts h ON h.id=p.parent_id WHERE p.session_id=$1 AND p.author_type=\'ai\'',[sid])
 assert.equal(pairs.length,600);for(const p of pairs)assert.equal(p.message,'local fixture reply: '+expected.get(p.parent_id))
 const totals=(await sql("SELECT count(*) FILTER(WHERE author_type='human')::int human,count(*) FILTER(WHERE author_type='ai')::int ai FROM posts WHERE session_id=$1",[sid]))[0]
 assert.equal(totals.human,600);assert.equal(totals.ai,600)
 assert.equal((await sql('SELECT count(*)::int n FROM ai_reply_logs WHERE session_id=$1',[sid]))[0].n,600)
 assert.equal((await sql('SELECT count(*)::int n FROM projection_events WHERE session_id=$1',[sid]))[0].n,600)
 let cursor=0;const events=new Map()
 for(let page=0;page<20;page++){const r=await http(null,`/api/screen/${session.screen_slug}/posts?afterCursor=${cursor}`);assert.equal(r.status,200,JSON.stringify(r.data));if(!r.data.events.length)break;for(const ev of r.data.events){assert.ok(ev.cursor>cursor);assert.equal(ev.aiReply.message,'local fixture reply: '+expected.get(ev.humanPost.id));assert.ok(!events.has(ev.humanPost.id));events.set(ev.humanPost.id,ev);cursor=ev.cursor}}
 assert.equal(events.size,600)
 assert.equal((await sql('SELECT count(*)::int n FROM v_analysis_posts_and_replies WHERE session_id=$1',[sid]))[0].n,480)
 assert.equal((await http(null,`/api/rooms/${clients[0].roomSlug}/posts`)).status,403)
 // A wrong-room URL cannot reuse a valid cookie, even if the second room is a real one.
 const other=(await sql('SELECT create_shared_session(151,now(),false) id'))[0].id
 const otherRoom=(await sql('SELECT room_slug FROM rooms WHERE session_id=$1',[other]))[0].room_slug
 assert.equal((await http(clients[0],`/api/rooms/${otherRoom}/posts`)).status,403)
 await sql("SELECT control_reaction_session($1,'stop')",[sid])
 assert.equal((await http(clients[0],`/api/rooms/${clients[0].roomSlug}/posts`,{message:'after end',requestId:crypto.randomUUID()})).status,403)
 assert.equal(counts.aiStub,600);assert.equal(counts.asyncErrors,0,backgroundErrors.join('\n'))
 const metrics=Object.fromEntries(Object.entries(timings).map(([name,values])=>{const sorted=values.slice().sort((a,b)=>a-b);return [name,{requests:values.length,p50_ms:Math.round(sorted[Math.floor(sorted.length*.5)]||0),p95_ms:Math.round(sorted[Math.floor(sorted.length*.95)]||0),max_ms:Math.round(sorted.at(-1)||0)}]}))
 log('PASS 600 exact human/AI pairs; 600 ordered projection events; 120 consenting participants = 480 analysis rows; unauthorized/cross-room/end-of-class rejected.')
 log(JSON.stringify({scope:'LOCAL_FUNCTIONAL_VOLUME_NOT_PRODUCTION_CAPACITY',participants:150,humanPosts:600,aiReplies:600,postRequests:1200,projectionEvents:600,initialRecoveryPolls:recoveryPolls,strandedBeforeRecovery,orphanReplies,counts,metrics,seconds:Math.round(performance.now()-begun)/1000,limitations:['single-connection PGlite serializes SQL','Auth token checks replaced, no Supabase Auth rate test','external AI generator replaced, no Gemini quota/latency test','Next hosting/context simulated, not real Next/Vercel server','no browser render, Windows projector, university network or 120-minute endurance exercised']},null,2))
} finally {await settle();await new Promise(resolve=>server.close(resolve));server.closeAllConnections();await db.close()}
