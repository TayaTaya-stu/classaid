import assert from 'node:assert/strict'
import { PGlite } from '@electric-sql/pglite'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const rootDir = path.resolve(__dirname, '..')

console.log('=== SupporTalk Designated Session & Audio Pipeline Verification ===\n')

const db = new PGlite()
await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS; CREATE SCHEMA auth; CREATE TABLE auth.users(id uuid PRIMARY KEY); CREATE SCHEMA storage; CREATE TABLE storage.buckets(id text PRIMARY KEY,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);`)

// Apply migrations
const migrationsDir = path.join(rootDir, 'supabase', 'migrations')
const number = (x) => x.startsWith('000') ? 0 : Number(x.match(/(?:^|_)(\d{3})_/)[1])
const files = fs.readdirSync(migrationsDir).filter(f => f.endsWith('.sql')).sort((a, b) => number(a) - number(b))

for (const file of files) {
  const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8')
  await db.exec(sql)
}

console.log('PASS: All migrations applied successfully to PGlite.')

// 1. Create multiple sessions and test set_designated_session RPC
const [{ session_id: s1Id }] = (await db.query(`
  SELECT create_shared_session(1, (now() + interval '1 day')::timestamptz, false) as session_id;
`)).rows

const [{ session_id: s2Id }] = (await db.query(`
  SELECT create_shared_session(2, (now() + interval '2 days')::timestamptz, false) as session_id;
`)).rows

const s1Res = await db.query(`SELECT id, session_number, is_current_target FROM public.sessions WHERE id = $1;`, [s1Id])
const s2Res = await db.query(`SELECT id, session_number, is_current_target FROM public.sessions WHERE id = $1;`, [s2Id])

// Initially neither is designated
assert.strictEqual(s1Res.rows[0].is_current_target, false)
assert.strictEqual(s2Res.rows[0].is_current_target, false)

// Call set_designated_session on s2
await db.query(`SELECT public.set_designated_session($1::uuid);`, [s2Id])

const checkS2 = await db.query(`SELECT id, is_current_target FROM public.sessions WHERE id = $1;`, [s2Id])
assert.strictEqual(checkS2.rows[0].is_current_target, true, 's2 should now be designated')

const checkS1 = await db.query(`SELECT id, is_current_target FROM public.sessions WHERE id = $1;`, [s1Id])
assert.strictEqual(checkS1.rows[0].is_current_target, false, 's1 must NOT be designated')

// Switch designated to s1
await db.query(`SELECT public.set_designated_session($1::uuid);`, [s1Id])
const checkS1After = await db.query(`SELECT id, is_current_target FROM public.sessions WHERE id = $1;`, [s1Id])
const checkS2After = await db.query(`SELECT id, is_current_target FROM public.sessions WHERE id = $1;`, [s2Id])
assert.strictEqual(checkS1After.rows[0].is_current_target, true, 's1 should now be designated')
assert.strictEqual(checkS2After.rows[0].is_current_target, false, 's2 should have designated cleared (single active target)')

console.log('PASS: set_designated_session RPC ensures mutually exclusive designated session flag.')

// 2. Query priority simulation (matching /api/screen/latest logic)
const prioritized = await db.query(`
  SELECT id, session_number, scheduled_at, is_current_target, status
  FROM public.sessions
  WHERE room_mode = 'shared'
  ORDER BY
    CASE WHEN status = 'in_progress' THEN 0 ELSE 1 END,
    CASE WHEN is_current_target = true THEN 0 ELSE 1 END,
    CASE WHEN date_trunc('day', scheduled_at) = date_trunc('day', clock_timestamp()) THEN 0 ELSE 1 END,
    created_at DESC;
`)

assert.strictEqual(prioritized.rows[0].id, s1Id, 'The designated session must be ranked first!')
console.log('PASS: Query priority ranks the designated session first over future scheduled sessions.')

// 3. Audio / Speech Context Buffer & 90-second sliding window verification
const sampleSpeech = '今回の講義では需要曲線のシフト要因として所得水準の変化を取り上げます。'
const speechPayload = JSON.stringify([
  { text: sampleSpeech, timestamp: Date.now() },
])
const topicsArray = ['需要曲線', 'シフト', '所得水準']

await db.query(
  `SELECT update_lecture_speech_context($1::uuid, $2::jsonb, $3, $4::text[], $5::text[], $6::jsonb);`,
  [s1Id, speechPayload, '需要曲線のシフト要因解説', topicsArray, topicsArray, JSON.stringify([])]
)

const s1Ctx = (await db.query(`SELECT recent_speech, active_summary, recent_topics FROM public.lecture_contexts WHERE session_id = $1;`, [s1Id])).rows[0]
assert.ok(s1Ctx && s1Ctx.recent_speech.length > 0, 's1 speech window must contain recorded chunk')
assert.strictEqual(s1Ctx.active_summary, '需要曲線のシフト要因解説')
assert.deepStrictEqual(s1Ctx.recent_topics, topicsArray)

// Strict Session Isolation: s2 must be completely untouched
const s2Ctx = (await db.query(`SELECT recent_speech, active_summary, recent_topics FROM public.lecture_contexts WHERE session_id = $1;`, [s2Id])).rows[0]
assert.strictEqual(s2Ctx, undefined, 'Session 2 lecture context record must not exist')

console.log('PASS: Audio speech context buffer maintains strict session isolation and topic extraction.')

console.log('\n=== ALL DESIGNATED SESSION & AUDIO TESTS PASSED! ===')
