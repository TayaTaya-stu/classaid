import assert from 'node:assert/strict'
import { PGlite } from '@electric-sql/pglite'
import fs from 'node:fs'
const db = new PGlite()
await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS; CREATE SCHEMA auth; CREATE TABLE auth.users(id uuid PRIMARY KEY); CREATE SCHEMA storage; CREATE TABLE storage.buckets(id text PRIMARY KEY,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);`)
const dir = new URL('../supabase/migrations/', import.meta.url)
const num = name => name.startsWith('000') ? 0 : Number(name.match(/(?:^|_)(\d{3})_/)[1])
for (const name of fs.readdirSync(dir).filter(name => name.endsWith('.sql')).sort((a,b) => num(a)-num(b))) await db.exec(fs.readFileSync(new URL(name, dir), 'utf8'))
const create = async () => (await db.query('SELECT create_shared_session(9,now(),true) id')).rows[0].id
const act = async (id, action) => (await db.query('SELECT organize_admin_session($1,$2) result',[id,action])).rows[0].result
const state = async id => (await db.query('SELECT * FROM sessions WHERE id=$1',[id])).rows[0]
const unused = await create(), untouched = await create()
const before = (await db.query('SELECT count(*)::int n FROM event_logs')).rows[0].n
assert.equal((await act(unused,'delete_unused')).success,true)
assert.ok((await state(unused)).admin_deleted_at)
assert.equal((await db.query('SELECT count(*)::int n FROM event_logs')).rows[0].n,before,'immutable creation event preserved')
assert.equal((await state(untouched)).admin_deleted_at,null)
assert.equal((await act(unused,'restore')).error,'session_not_found')
await assert.rejects(db.query('SELECT set_designated_session($1)',[unused]),/archived_session_unavailable/)
const target = await create()
await db.query('SELECT set_designated_session($1)',[target])
for (const action of ['archive','delete_unused','restore']) assert.equal((await act(target,action)).error,'session_in_use')
await db.query("SELECT control_reaction_session($1,'configure','lecture_bridge',false)",[target])
await db.query('SELECT start_designated_reaction_session($1)',[target])
assert.equal((await act(target,'archive')).error,'session_in_use')
await db.query("SELECT control_reaction_session($1,'stop')",[target])
await db.query('SELECT set_designated_session($1)',[untouched])
assert.equal((await act(target,'delete_unused')).error,'session_has_records')
const counts = (await db.query('SELECT count(*)::int n FROM event_logs WHERE session_id=$1',[target])).rows[0].n
assert.equal((await act(target,'archive')).success,true)
assert.equal((await state(target)).is_archived,true)
assert.equal((await db.query('SELECT count(*)::int n FROM event_logs WHERE session_id=$1',[target])).rows[0].n,counts)
assert.equal((await act(target,'restore')).success,true)
assert.equal((await state(target)).status,'completed','restore never reopens completed class')
// Any future FK record, even ON DELETE CASCADE, blocks unused deletion.
await db.exec('CREATE TABLE future_session_notes(session_id uuid REFERENCES sessions(id) ON DELETE CASCADE, body text); CREATE TABLE future_room_notes(room_id uuid REFERENCES rooms(id), body text);')
for (const kind of ['session','room','audio','context','participant','material','event']) {
 const id = await create()
 if (kind === 'session') await db.query("INSERT INTO future_session_notes VALUES($1,'keep')",[id])
 if (kind === 'room') await db.query("INSERT INTO future_room_notes SELECT id,'keep' FROM rooms WHERE session_id=$1",[id])
 if (kind === 'audio') await db.query("INSERT INTO lecture_transcript_segments(session_id,batch_key,transcript_original,transcript_search,keywords,keyword_contexts,received_at,saved_at,source_hashes,recognition_status) VALUES($1,'one','記録','記録','{}','[]',now(),now(),'{}','transcribed')",[id])
 if (kind === 'context') await db.query("INSERT INTO lecture_contexts(session_id,active_summary) VALUES($1,'授業記録')",[id])
 if (kind === 'participant') await db.query("INSERT INTO participants(identity_hash,assigned_group,first_session_id) VALUES($1,'A',$2)",['test-'+id,id])
 if (kind === 'material') await db.query("UPDATE sessions SET pdf_file_url='text:material' WHERE id=$1",[id])
 if (kind === 'event') await db.query("INSERT INTO event_logs(session_id,event_type) VALUES($1,'student_test')",[id])
 assert.equal((await act(id,'delete_unused')).error,'session_has_records',kind)
 assert.equal((await state(id)).admin_deleted_at,null,kind)
 assert.equal((await act(id,'archive')).success,true,kind)
 assert.equal((await act(id,'restore')).success,true,kind)
}
// Archived scheduled classes cannot be designated or started behind the UI.
const archived = await create()
await act(archived,'archive')
await assert.rejects(db.query('SELECT set_designated_session($1)',[archived]),/archived_session_unavailable/)
await assert.rejects(db.query("UPDATE sessions SET status='in_progress' WHERE id=$1",[archived]),/archived_session_unavailable/)
assert.equal((await act(archived,'delete_unused')).success,true)
assert.equal((await act('00000000-0000-0000-0000-000000000001','delete_unused')).error,'session_not_found')
assert.equal((await act(untouched,'unknown')).error,'invalid_action')
for (const role of ['anon','authenticated']) assert.equal((await db.query("SELECT has_function_privilege($1,'organize_admin_session(uuid,text)','EXECUTE') ok",[role])).rows[0].ok,false)
assert.equal((await db.query("SELECT has_function_privilege('service_role','organize_admin_session(uuid,text)','EXECUTE') ok")).rows[0].ok,true)
console.log('PASS SQL 026: unused removal retains immutable audit; recorded sessions never removed; archive/restore preserves data; active/designated protected; archived/deleted cannot be designated; unknown CASCADE children protected; RPC service-role only')
await db.close()
