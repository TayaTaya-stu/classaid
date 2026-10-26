import fs from 'node:fs'
import vm from 'node:vm'
import assert from 'node:assert/strict'
import ts from 'typescript'
import {PGlite} from '@electric-sql/pglite'
const db=new PGlite()
await db.exec('CREATE ROLE anon;CREATE ROLE authenticated;CREATE ROLE service_role BYPASSRLS;CREATE SCHEMA auth;CREATE TABLE auth.users(id uuid PRIMARY KEY);CREATE SCHEMA storage;CREATE TABLE storage.buckets(id text PRIMARY KEY,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);')
const num=f=>f.startsWith('000')?0:Number(f.match(/(?:^|_)(\d{3})_/)[1])
for(const f of fs.readdirSync('supabase/migrations').filter(f=>f.endsWith('.sql')).sort((a,b)=>num(a)-num(b)))await db.exec(fs.readFileSync('supabase/migrations/'+f,'utf8'))
const q=async(s,p=[])=>(await db.query(s,p)).rows
const [{sid}]=await q('SELECT create_shared_session(101,now(),false) sid')
const [{other}]=await q('SELECT create_shared_session(102,now(),false) other')
let fail=false
const deps={'@/lib/supabase-admin':{supabaseAdmin:{rpc:(_name,p)=>({abortSignal:async()=>fail?{data:null,error:new Error('offline')}:{data:(await q('SELECT choose_reaction_fallback($1,$2,$3) id',[p.p_session_id,p.p_mode,p.p_candidate_ids]))[0].id,error:null}})}}}
const source=fs.readFileSync('lib/reaction-ai/replies.ts','utf8')
function instance(){const ctx={exports:{},AbortSignal,require:n=>deps[n]};vm.runInNewContext(ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,ctx);return ctx.exports}
const a=instance(),b=instance()
for(const mode of ['empathy','lecture_bridge','neutral']){
 assert.ok(Object.values(a.NATURAL_FALLBACK_MASTER[mode]).flat().length>=10)
 const seen=new Set();let previous
 for(let i=0;i<25;i++){const result=await (i%2?a:b).getSessionFallbackReply(sid,mode,'ああ');assert.equal(result.selectionScope,'database');assert.notEqual(result.id,previous);previous=result.id;seen.add(result.id)}
 assert.equal(seen.size,10,'Ambiguous messages rotate through ten alternatives')
}
const first=await a.getSessionFallbackReply(other,'lecture_bridge','ああ');assert.equal(first.id,'brg-g-1')
fail=true
const one=await a.getSessionFallbackReply(sid,'lecture_bridge','ああ'),two=await a.getSessionFallbackReply(sid,'lecture_bridge','ああ');assert.equal(one.selectionScope,'process');assert.notEqual(one.id,two.id)
assert.equal((await q("SELECT has_function_privilege('anon','public.choose_reaction_fallback(uuid,text,text[])','EXECUTE') ok"))[0].ok,false)
console.log('PASS: actual module + SQL rotates ten ambiguous-message replies per mode, no adjacent duplicate selections across workers, class isolation, service-only access and explicit local degraded scope.')
await db.close()
