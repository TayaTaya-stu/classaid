import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
const { PGlite } = await import(process.env.PGLITE_MODULE || '@electric-sql/pglite')
const db = new PGlite()
await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS; CREATE SCHEMA auth; CREATE TABLE auth.users(id uuid PRIMARY KEY); CREATE SCHEMA storage; CREATE TABLE storage.buckets(id text PRIMARY KEY,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);`)
const dir = new URL('../supabase/migrations/', import.meta.url)
const number = x => x.startsWith('000') ? 0 : Number(x.match(/(?:^|_)(\d{3})_/)[1])
const files = readdirSync(dir).filter(x=>x.endsWith('.sql')).sort((a,b)=>number(a)-number(b))
for (const f of files) await db.exec(readFileSync(new URL(f,dir),'utf8'))
const q = async (sql, args=[]) => (await db.query(sql,args)).rows
const makeSession = async () => {
 const [{id}] = await q('SELECT public.create_shared_session(1,now(),false) id')
 return (await q('SELECT * FROM public.sessions WHERE id=$1',[id]))[0]
}
const user = async () => (await q('INSERT INTO auth.users VALUES(gen_random_uuid()) RETURNING id'))[0].id
const enter = async (uid, s, name, consent = true, claimExisting = false) =>
  (await q(`SELECT public.enter_reaction_session($1,$2,$3,$4,$5,$6,$7) result`, [
    uid,
    s.entry_slug,
    name,
    name.toLowerCase(),
    `identity:${uid}`,
    consent,
    claimExisting,
  ]))[0].result
const control = async (sid, action, mode = null) =>
  (await q('SELECT public.control_reaction_session($1,$2,$3) result', [sid, action, mode]))[0].result
const s = await makeSession(), u = await user()
let a = await enter(u, s, 'Aoi', false)
assert.equal(a.isNew, true)
assert.equal((await q('SELECT is_consented FROM public.participants WHERE id=$1', [a.participantId]))[0].is_consented, false)
assert.equal((await q('SELECT research_consented,is_primary_analysis FROM public.session_attendances WHERE participant_id=$1', [a.participantId]))[0].is_primary_analysis, false)
let again = await enter(u, s, 'Aoi', false)
assert.equal(again.participantId, a.participantId)
const joined = (await q('SELECT joined_at FROM public.session_attendances WHERE participant_id=$1', [a.participantId]))[0].joined_at
await enter(u, s, 'Aoi', false)
assert.equal(String((await q('SELECT joined_at FROM public.session_attendances WHERE participant_id=$1', [a.participantId]))[0].joined_at), String(joined))
console.log('PASS registration, nonconsent, replay and first arrival preservation')
const before = (await q('SELECT count(*)::int n FROM public.participants'))[0].n

// 別Authからの重複名：確認なし（claimExisting=false）なら拒否
await assert.rejects(enter(await user(), s, 'Aoi', true, false), /name_exists_confirm_claim/)
assert.equal((await q('SELECT count(*)::int n FROM public.participants'))[0].n, before)

const s2 = await makeSession()
await assert.rejects(enter(await user(), s2, 'aoi', true, false), /name_exists_confirm_claim/)
console.log('PASS duplicate name across classes rejected with name_exists_confirm_claim; no orphan participant')

// 「はい、自分の名前です」（claimExisting=true）で自己申告引き継ぎ
const recoveredUser = await user()
const recovered = await enter(recoveredUser, s2, 'Aoi', true, true)
assert.equal(recovered.participantId, a.participantId)
assert.equal(recovered.isClaimed, true)
await assert.rejects(enter(u, s2, 'Changed'), /use_registered_name/)
console.log('PASS self-reported name claim restoration and name-mismatch protection')
// Inject a failure at the final write to prove the entire registration transaction rolls back.
await db.exec(`CREATE FUNCTION public.reject_test_attendance() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.display_name='Rollback' THEN RAISE EXCEPTION 'test_failure'; END IF; RETURN NEW; END; $$; CREATE TRIGGER reject_test_attendance BEFORE INSERT ON public.session_attendances FOR EACH ROW EXECUTE FUNCTION public.reject_test_attendance();`)
const failUser=await user()
await assert.rejects(enter(failUser,s,'Rollback'),/test_failure/)
for(const table of ['participant_auth_links','participant_entry_attempts']) assert.equal((await q(`SELECT count(*)::int n FROM public.${table} WHERE auth_user_id=$1`,[failUser]))[0].n,0)
assert.equal((await q('SELECT count(*)::int n FROM public.participants'))[0].n,before)
await db.exec('DROP TRIGGER reject_test_attendance ON public.session_attendances; DROP FUNCTION public.reject_test_attendance();')
await enter(failUser,s,'Rollback')
console.log('PASS late failure rolls back all registration records; retry succeeds')
const rateUser=await user()
for(let i=0;i<20;i++) assert.equal((await q('SELECT public.consume_participant_entry_attempt($1) ok',[rateUser]))[0].ok,true)
assert.equal((await q('SELECT public.consume_participant_entry_attempt($1) ok',[rateUser]))[0].ok,false)
assert.equal((await q('SELECT public.consume_participant_entry_attempt($1) ok',[u]))[0].ok,true)
await q(`UPDATE public.participant_entry_attempts SET window_started_at=now()-interval '16 minutes' WHERE auth_user_id=$1`,[rateUser])
assert.equal((await q('SELECT public.consume_participant_entry_attempt($1) ok',[rateUser]))[0].ok,true)
console.log('PASS durable rate window, expiry and no victim lockout')
await control(s.id,'configure','empathy'); await control(s.id,'configure','neutral')
assert.equal((await control(s.id,'start')).pipelineEnabled,true)
await assert.rejects(control(s.id,'configure','off'),/already_started/)
await assert.rejects(control(s.id,'start'),/already_started/)
await assert.rejects(q("UPDATE public.sessions SET reaction_ai_mode='off' WHERE id=$1",[s.id]),/condition_locked/)
console.log('PASS pre-start setting changes; post-start API and direct DB changes rejected')
const rid=(await q('SELECT id FROM public.rooms WHERE session_id=$1',[s.id]))[0].id
const post=async()=> (await q(`INSERT INTO public.posts(session_id,room_id,author_type,author_display_name,name,message,is_ai,reply_target_type,audience_type,is_deleted) VALUES($1,$2,'human','Aoi','Aoi','hello',false,'none','room',false) RETURNING id`,[s.id,rid]))[0].id
const pending=await post()
const j=(await q('SELECT * FROM public.claim_reaction_jobs(1,NULL)'))[0]
await control(s.id,'stop')
const finish=async j=>q(`SELECT public.finish_reaction_job($1,$2,'reply','mock',NULL,1,'{}',NULL)`,[j.id,j.lease_token])
await finish(j)
assert.equal((await q('SELECT event_type FROM public.projection_events WHERE human_post_id=$1',[pending])).length,0)
const next=await post();await finish((await q('SELECT * FROM public.claim_reaction_jobs(1,NULL)'))[0])
assert.equal((await q('SELECT event_type FROM public.projection_events WHERE human_post_id=$1',[next])).length,0)
console.log('PASS complete class stop prevents in-flight and later projection events')
await control(s2.id,'configure','off');await control(s2.id,'start')
const late=await enter(await user(),s2,'Late')
assert.equal((await q('SELECT is_primary_analysis FROM public.session_attendances WHERE participant_id=$1',[late.participantId]))[0].is_primary_analysis,false)
const rid2=(await q('SELECT id FROM public.rooms WHERE session_id=$1',[s2.id]))[0].id
const off=(await q(`INSERT INTO public.posts(session_id,room_id,author_type,author_display_name,name,message,is_ai,reply_target_type,audience_type,is_deleted) VALUES($1,$2,'human','Late','Late','hi',false,'none','room',false) RETURNING id`,[s2.id,rid2]))[0].id
await finish((await q('SELECT * FROM public.claim_reaction_jobs(1,NULL)'))[0])
assert.equal((await q('SELECT event_type FROM public.projection_events WHERE human_post_id=$1',[off]))[0].event_type,'human_only')
for(const signature of [
  'public.enter_reaction_session(uuid,text,text,text,text,boolean,boolean)',
  'public.control_reaction_session(uuid,text,text,boolean)',
  'public.consume_participant_entry_attempt(uuid)',
  'public.update_lecture_speech_context(uuid,jsonb,text,text[],text[],jsonb)',
  'public.update_lecture_pdf_context(uuid,jsonb)',
]) {
  assert.equal((await q("SELECT has_function_privilege('anon',$1,'EXECUTE') ok",[signature]))[0].ok,false)
  assert.equal((await q("SELECT has_function_privilege('service_role',$1,'EXECUTE') ok",[signature]))[0].ok,!signature.includes('update_lecture_speech_context'))
}
console.log(`PASS off projection, late entry and RPC grants; ${files.length} migrations execute`)
await db.close()
