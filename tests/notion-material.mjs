import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'
import {createRequire} from 'node:module'
import {PGlite} from '@electric-sql/pglite'
import React from 'react'
import {renderToStaticMarkup} from 'react-dom/server'
const require=createRequire(import.meta.url)
function load(file,deps={}){const c={exports:{},require:n=>deps[n]??require(n),console,process,URL,Response,Request,AbortSignal,TextDecoder,Uint8Array,Date,fetch,setTimeout,clearTimeout};vm.runInNewContext(ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX,esModuleInterop:true}}).outputText,c);return c.exports}
const helper=load('lib/reaction-ai/notion-material.ts')
const url='https://www.notion.so/5-IT-24f98319bee680f89fb7c127bdefa2f4?source=copy_link'
const text='公開鍵暗号\n\n暗号化と復号で異なる鍵を使います。\n<script>alert(1)</script>'
const snapshot=helper.preparePastedMaterial({text,url,title:'第5回 アート×IT'},new Date('2026-10-27T00:00:00Z'))
assert.equal(snapshot.sections.map(s=>s.text).join(''),text)
assert.equal(snapshot.sections[0].sourceType,'pasted_text');assert.equal(snapshot.sections[0].blockId,undefined)
assert.equal(snapshot.sourceUrl,'https://www.notion.so/24f98319bee680f89fb7c127bdefa2f4')
assert.equal(snapshot.importedAt,'2026-10-27T00:00:00.000Z')
assert.equal(helper.preparePastedMaterial({text}).sourceUrl,undefined)
const long='公開鍵'.repeat(1400)
assert.equal(helper.preparePastedMaterial({text:long}).sections.map(s=>s.text).join(''),long)
for(const body of [{text:''},{text:'  '},{text:'x'.repeat(200001)},{text:'x\0y'},{text:'valid',url:'javascript:alert(1)'},{text:'valid',url:'https://user@www.notion.so/24f98319bee680f89fb7c127bdefa2f4'},{text:'valid',title:'x'.repeat(101)}])assert.throws(()=>helper.preparePastedMaterial(body))

const db=new PGlite()
await db.exec('CREATE ROLE anon;CREATE ROLE authenticated;CREATE ROLE service_role BYPASSRLS;CREATE SCHEMA auth;CREATE TABLE auth.users(id uuid PRIMARY KEY);CREATE SCHEMA storage;CREATE TABLE storage.buckets(id text PRIMARY KEY,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);')
const number=f=>f.startsWith('000')?0:Number(f.match(/(?:^|_)(\d{3})_/)[1])
for(const file of fs.readdirSync('supabase/migrations').filter(f=>f.endsWith('.sql')).sort((a,b)=>number(a)-number(b)))await db.exec(fs.readFileSync('supabase/migrations/'+file,'utf8'))
const sid=(await db.query('SELECT create_shared_session(82,now(),false) id')).rows[0].id
let authenticated=true,race=false
const admin={from:()=>({select(){return this},eq(_key,id){this.id=id;return this},async single(){return {data:(await db.query('SELECT * FROM sessions WHERE id=$1',[this.id])).rows[0],error:null}}}),async rpc(name,p){assert.equal(name,'register_lecture_pdf');try{
 if(race){race=false;await db.query('SELECT set_designated_session($1)',[sid]);await db.query('SELECT start_designated_reaction_session($1)',[sid])}
 await db.query('SELECT register_lecture_pdf($1,$2,$3)',[p.p_session_id,JSON.stringify(p.p_pdf_topics),p.p_path]);return {error:null}
 }catch(error){return {error}}},storage:{from:()=>({createSignedUploadUrl:async path=>({data:{path,token:'test-only'},error:null}),download:async()=>({data:new Blob(['%PDF-fixture']),error:null})})}}
const context=load('lib/reaction-ai/context.ts',{'server-only':{},'@/lib/supabase-admin':{supabaseAdmin:admin}})
const route=load('app/api/admin/materials/route.ts',{'next/server':{NextResponse:{json:(v,o)=>Response.json(v,o)}},'@/lib/admin-auth':{isAdminAuthenticated:async()=>authenticated},'@/lib/supabase-admin':{supabaseAdmin:admin},'@/lib/reaction-ai/pdf':{extractTextFromPdf:async()=>[{page:1,text:'PDF本文'}]},'@/lib/reaction-ai/context':context,'@/lib/reaction-ai/notion-material':helper})
const request=body=>new Request('http://localhost/api/admin/materials',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sessionId:sid,...body})})
const saved=async()=>(await db.query('SELECT pdf_topics FROM lecture_contexts WHERE session_id=$1',[sid])).rows[0].pdf_topics
let r=await route.POST(request({action:'register_text',text,url,title:'講義資料'}));assert.equal(r.status,200)
let savedText=await saved();assert.equal(savedText[0].text,text);assert.equal(savedText[0].sourceUrl,snapshot.sourceUrl);assert.ok(savedText[0].importedAt);assert.equal(savedText[0].materialTitle,'講義資料')
const prior=JSON.stringify(savedText)
r=await route.POST(request({action:'register_text',text:' '}));assert.equal(r.status,400);assert.equal(JSON.stringify(await saved()),prior)
r=await route.POST(request({action:'import_notion',url}));assert.equal(r.status,410);assert.equal(JSON.stringify(await saved()),prior)
authenticated=false;r=await route.POST(request({action:'register_text',text:'別の本文'}));assert.equal(r.status,401);assert.equal(JSON.stringify(await saved()),prior);authenticated=true
// Existing PDF flow still uses the same atomic persistence; parser is the only PDF fixture here.
r=await route.POST(request({action:'prepare',name:'lecture.pdf',size:100}));assert.equal(r.status,200)
r=await route.POST(request({action:'register',path:sid+'/lecture.pdf'}));assert.equal(r.status,200);assert.equal((await saved())[0].text,'PDF本文')
r=await route.POST(request({action:'register_text',text:'データベースは情報を保存します。'}));assert.equal(r.status,200)
assert.equal((await db.query('SELECT pdf_file_url FROM sessions WHERE id=$1',[sid])).rows[0].pdf_file_url,'text:manual')
const beforeRace=JSON.stringify(await saved());race=true
r=await route.POST(request({action:'register_text',text:'競合中の書き換え'}));assert.equal(r.status,503);assert.equal(JSON.stringify(await saved()),beforeRace)
r=await route.POST(request({action:'register_text',text:'開始後の書き換え'}));assert.equal(r.status,409);assert.equal(JSON.stringify(await saved()),beforeRace)

const ui=load('app/admin/AdminSessionControl.tsx',{'@/lib/supabase':{supabase:{}}}).default
const markup=renderToStaticMarkup(React.createElement(ui,{sessionId:sid,control:{status:'scheduled',isLocked:false,pdfFilePath:'text:manual',classStartedAt:null,reactionConfig:{mode:'off',status:'stopped',isMockAi:false,pipelineEnabled:false}},onUpdated:async()=>{}}))
assert.match(markup,/textarea/);assert.match(markup,/本文を登録/);assert.match(markup,/元URL/);assert.match(markup,/URLへの自動アクセスは行いません/);assert.doesNotMatch(markup,/Notion本文を登録|本文を取り込み中/)
assert.equal(fs.readFileSync('lib/reaction-ai/notion-material.ts','utf8').includes('fetch('),false)
await db.close()
console.log('PASS actual manual-text helper + admin route + context + local SQL: text/source metadata, no network fetch, invalid/unauthenticated preservation, deprecated URL 410, PDF flow, atomic start-race refusal, and rendered admin form.')
