import assert from 'node:assert/strict'
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


const sid=(await db.query("SELECT create_shared_session(99,now(),true) id")).rows[0].id
await db.query('SELECT set_designated_session($1)',[sid])
await db.query("SELECT control_reaction_session($1,'configure','lecture_bridge',false)",[sid])
await db.query('SELECT start_designated_reaction_session($1)',[sid])
const transcript='公開鍵暗号は鍵を分けます。'+ '前後の説明を保持します。'.repeat(100)
const args=[sid,transcript,['公開鍵暗号'],['hash-full-1'],'test-model',new Date().toISOString()]
let saved=(await db.query('SELECT append_lecture_context_v2($1,$2,$3,$4,$5,$6) result',args)).rows[0].result
assert.equal(saved.inserted,true)
let row=(await db.query('SELECT * FROM lecture_transcript_segments WHERE session_id=$1',[sid])).rows[0]
assert.equal(row.transcript_original,transcript);assert.ok(row.transcript_original.length>500);assert.equal(row.keyword_contexts[0].keyword,'公開鍵暗号')
saved=(await db.query('SELECT append_lecture_context_v2($1,$2,$3,$4,$5,$6) result',args)).rows[0].result
assert.equal(saved.inserted,false);assert.equal((await db.query('SELECT count(*)::int n FROM lecture_transcript_segments WHERE session_id=$1',[sid])).rows[0].n,1)
await db.query("UPDATE lecture_transcript_segments SET saved_at=now()-interval '15 minutes' WHERE id=$1",[row.id])
await db.query(`INSERT INTO lecture_transcript_segments(session_id,batch_key,transcript_original,transcript_search,keywords,keyword_contexts,received_at,saved_at,source_hashes,recognition_status)
SELECT $1,'filler-'||i,'後続の説明です','後続の説明です',ARRAY['後続'],'[]',now(),now()-interval '9 minutes'+i*interval '0.5 seconds',ARRAY['filler-'||i],'transcribed' FROM generate_series(1,650) i`,[sid])
await db.query(`INSERT INTO lecture_transcript_segments(session_id,batch_key,transcript_original,transcript_search,keywords,received_at,saved_at,source_hashes,recognition_status)
VALUES($1,'later','チャットを説明します','チャットを説明します',ARRAY['チャット'],now(),now(),ARRAY['later'],'transcribed')`,[sid])
const cutoff=new Date(Date.now()-60000).toISOString()
const found=(await db.query('SELECT find_lecture_evidence($1,$2,$3,$4) result',[sid,cutoff,['公開鍵暗号'],['公開鍵暗号','チャット']])).rows[0].result
assert.ok(found.records.some(x=>x.id===row.id));assert.ok(found.records.length<=18)
assert.ok(found.spokenTerms.some(x=>x.term==='公開鍵暗号'));assert.ok(!found.spokenTerms.some(x=>x.term==='チャット'))
assert.ok(found.records.every(x=>Date.parse(x.saved_at)<=Date.parse(cutoff)))
const other=(await db.query('SELECT find_lecture_evidence($1,now(),$2,$3) result',['00000000-0000-0000-0000-000000000000',['公開鍵暗号'],['公開鍵暗号']])).rows[0].result
assert.equal(other.records.length,0)
assert.equal((await db.query("SELECT has_table_privilege('anon','lecture_transcript_segments','SELECT') ok")).rows[0].ok,false)
await db.exec(`CREATE FUNCTION archive_test_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test_archive_failure'; END; $$; CREATE TRIGGER archive_test_failure BEFORE INSERT ON lecture_transcript_segments FOR EACH ROW EXECUTE FUNCTION archive_test_failure();`)
await assert.rejects(db.query('SELECT append_lecture_context_v2($1,$2,$3,$4,$5,now())',[sid,'保存失敗の確認',['保存失敗'],['rollback-hash'],'test-model']),/test_archive_failure/)
assert.equal((await db.query("SELECT count(*)::int n FROM lecture_audio_deliveries WHERE session_id=$1 AND segment_hash='rollback-hash'",[sid])).rows[0].n,0)
await db.exec('DROP TRIGGER archive_test_failure ON lecture_transcript_segments; DROP FUNCTION archive_test_failure()')
const plan=(await db.query('EXPLAIN SELECT * FROM lecture_transcript_segments WHERE session_id=$1 AND saved_at<=$2',[sid,cutoff])).rows
assert.ok(plan.length>0)
console.log('PASS full transcript >500 chars, keyword context, deduplication, earliest keyword after 650 records, bounded lookup, temporal cutoff, class isolation, private access, and rollback on archive failure')
await db.close()
