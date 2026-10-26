import assert from 'node:assert/strict'
import vm from 'node:vm'
import ts from 'typescript'
import {createRequire} from 'node:module'
const require=createRequire(import.meta.url)
import { PGlite } from '@electric-sql/pglite'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const rootDir = path.resolve(__dirname, '..')

console.log('=== Lecture transcript archive verification ===\n')

const db = new PGlite()
await db.exec(`
  CREATE ROLE anon;
  CREATE ROLE authenticated;
  CREATE ROLE service_role BYPASSRLS;
  CREATE SCHEMA auth;
  CREATE TABLE auth.users(id uuid PRIMARY KEY);
  CREATE SCHEMA storage;
  CREATE TABLE storage.buckets(id text PRIMARY KEY,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
`)

// Apply all migrations through 021
const migrationsDir = path.join(rootDir, 'supabase', 'migrations')
const number = (x) => x.startsWith('000') ? 0 : Number(x.match(/(?:^|_)(\d{3})_/)[1])
const files = fs.readdirSync(migrationsDir).filter(f => f.endsWith('.sql')).sort((a, b) => number(a) - number(b))

console.log(`Applying ${files.length} migrations...`)
for (const file of files) {
  const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8')
  await db.exec(sql)
}
console.log('PASS: All repository migrations applied successfully.\n')



const sid=(await db.query('SELECT create_shared_session(70,now(),true) id')).rows[0].id
await db.query('SELECT set_designated_session($1)',[sid])
await db.query("SELECT control_reaction_session($1,'configure','lecture_bridge',false)",[sid])
await db.query('SELECT start_designated_reaction_session($1)',[sid])
const admin={
 from(table){let selected='*',filters=[],params=[],insert=null;const q={select(columns){selected=columns;return q},eq(key,value){params.push(value);filters.push(`${key}=$${params.length}`);return q},in(key,values){params.push(values);filters.push(`${key}=ANY($${params.length})`);return q},insert(row){insert=row;return q},abortSignal(){return q},async maybeSingle(){const r=await run();return {...r,data:r.data?.[0]||null}},then(ok,bad){return run().then(ok,bad)}};
 async function run(){try {const r=insert?await db.query(`INSERT INTO ${table}(${Object.keys(insert).join(',')}) VALUES(${Object.keys(insert).map((_,i)=>'$'+(i+1)).join(',')}) RETURNING *`,Object.values(insert).map(v=>typeof v==='object'?JSON.stringify(v):v)):await db.query(`SELECT ${selected} FROM ${table} ${filters.length?'WHERE '+filters.join(' AND '):''}`,params);return {data:r.rows,error:null}}catch(error){return {data:null,error:{message:error.message,code:error.code}}}}
 return q
 },
 async rpc(name,p){const order={append_lecture_context_v2:['p_session_id','p_text','p_keywords','p_hashes','p_model','p_received_at'],reserve_reaction_generation:['p_session_id','p_limit','p_kind']};const keys=order[name];if(!keys)throw Error(name);try{const r=await db.query(`SELECT ${name}(${keys.map((_,i)=>'$'+(i+1)).join(',')}) result`,keys.map(k=>p[k]));return {data:r.rows[0].result,error:null}}catch(error){return {data:null,error:{message:error.message,code:error.code}}}}
}
function load(rel,deps){const c={exports:{},require:n=>n in deps?deps[n]:require(n),process,console,Date,AbortSignal,File,Response,Request,FormData,Buffer,setTimeout,clearTimeout};vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(rootDir,rel),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText,c);return c.exports}
const context=load('lib/reaction-ai/context.ts',{'server-only':{},'@/lib/supabase-admin':{supabaseAdmin:admin}})
let transcriptions=0
const route=load('app/api/teacher/lecture-context/route.ts',{'next/server':{NextResponse:Response},'@/lib/teacher-auth':{isTeacherAuthenticated:async()=>true},'@/lib/reaction-ai/context':context,'@/lib/reaction-ai/audio-transcription':{transcribeLectureAudio:async(_files,_signal,reserve)=>{assert.equal(await reserve(),true);transcriptions++;return {transcript:'カメラを使った参加の工夫を説明します。',modelUsed:'test-model'}}},'@/lib/supabase-admin':{supabaseAdmin:admin}})
const request=(content='audio-a')=>{const form=new FormData();form.set('sessionId',sid);form.append('audio',new File([content],'record.webm',{type:'audio/webm'}));return new Request('http://test/api/teacher/lecture-context',{method:'POST',body:form})}
assert.equal((await route.POST(request())).status,200)
let rows=(await db.query('SELECT * FROM lecture_transcript_segments WHERE session_id=$1',[sid])).rows
assert.equal(rows.length,1);assert.equal(rows[0].transcript_original,'カメラを使った参加の工夫を説明します。');assert.equal(rows[0].model_name,'test-model')
assert.equal((await route.POST(request())).status,200);assert.equal(transcriptions,1)
assert.equal((await db.query('SELECT count(*)::int n FROM lecture_transcript_segments WHERE session_id=$1',[sid])).rows[0].n,1)
await db.exec("CREATE FUNCTION fail_archive_test() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test_archive_failure'; END; $$; CREATE TRIGGER fail_archive_test BEFORE INSERT ON lecture_transcript_segments FOR EACH ROW EXECUTE FUNCTION fail_archive_test();")
assert.equal((await route.POST(request('audio-b'))).status,503)
assert.equal((await db.query("SELECT count(*)::int n FROM event_logs WHERE session_id=$1 AND event_type='lecture_audio_processing_failed'",[sid])).rows[0].n,1)
await db.exec('DROP TRIGGER fail_archive_test ON lecture_transcript_segments; DROP FUNCTION fail_archive_test()')
assert.equal((await route.POST(request('audio-b'))).status,200)
assert.equal((await db.query('SELECT count(*)::int n FROM lecture_transcript_segments WHERE session_id=$1',[sid])).rows[0].n,2)
console.log('PASS actual multipart endpoint -> actual context helper -> SQL archive: returned transcript saved, duplicate audio not transcribed twice, archive failure logged and not acknowledged, retry succeeds')
await db.close()
