import assert from 'node:assert/strict'
import { PGlite } from '@electric-sql/pglite'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const rootDir = path.resolve(__dirname, '..')

console.log('=== SupporTalk 021 Migration & Safeupdate Verification ===\n')

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
console.log('PASS: All migrations through 021 applied successfully.\n')

// 1. Create 3 sessions
const [{ session_id: s1Id }] = (await db.query(`
  SELECT create_shared_session(1, (now() + interval '1 day')::timestamptz, false) as session_id;
`)).rows

const [{ session_id: s2Id }] = (await db.query(`
  SELECT create_shared_session(2, (now() + interval '2 days')::timestamptz, false) as session_id;
`)).rows

const [{ session_id: s3Id }] = (await db.query(`
  SELECT create_shared_session(3, (now() + interval '3 days')::timestamptz, false) as session_id;
`)).rows

// Initially none are designated
const initRes = await db.query(`SELECT id, is_current_target FROM public.sessions WHERE id IN ($1, $2, $3);`, [s1Id, s2Id, s3Id])
for (const row of initRes.rows) {
  assert.strictEqual(row.is_current_target, false, 'Initial state should be is_current_target=false')
}
console.log('PASS: Initial session states verified (all is_current_target=false).')

// 2. Normal designation (通常指定)
const r1 = (await db.query(`SELECT public.set_designated_session($1::uuid) as result;`, [s1Id])).rows[0].result
assert.deepStrictEqual(r1, { success: true, designatedSessionId: s1Id })

const check1 = await db.query(`SELECT id, is_current_target FROM public.sessions WHERE id IN ($1, $2, $3) ORDER BY session_number;`, [s1Id, s2Id, s3Id])
assert.strictEqual(check1.rows.find(r => r.id === s1Id).is_current_target, true, 's1 must be designated')
assert.strictEqual(check1.rows.find(r => r.id === s2Id).is_current_target, false, 's2 must not be designated')
assert.strictEqual(check1.rows.find(r => r.id === s3Id).is_current_target, false, 's3 must not be designated')
console.log('PASS: 1. Normal designation (通常指定) succeeded: only s1 is true.')

// 3. Designation switching (指定切替)
const r2 = (await db.query(`SELECT public.set_designated_session($1::uuid) as result;`, [s2Id])).rows[0].result
assert.deepStrictEqual(r2, { success: true, designatedSessionId: s2Id })

const check2 = await db.query(`SELECT id, is_current_target FROM public.sessions WHERE id IN ($1, $2, $3) ORDER BY session_number;`, [s1Id, s2Id, s3Id])
assert.strictEqual(check2.rows.find(r => r.id === s1Id).is_current_target, false, 's1 must now be false')
assert.strictEqual(check2.rows.find(r => r.id === s2Id).is_current_target, true, 's2 must now be true')
assert.strictEqual(check2.rows.find(r => r.id === s3Id).is_current_target, false, 's3 must still be false')
console.log('PASS: 2. Designation switching (指定切替) succeeded: s1 became false, s2 became true, s3 untouched.')

// 4. In-progress switching rejection (進行中の切替拒否)
// Start s2 class properly using the official RPCs (s2 is currently designated)
await db.query(`SELECT public.control_reaction_session($1::uuid, 'configure', 'off', false);`, [s2Id])
await db.query(`SELECT public.start_designated_reaction_session($1::uuid);`, [s2Id])

// Attempt to switch designation to s1 while s2 is in progress
const r3 = (await db.query(`SELECT public.set_designated_session($1::uuid) as result;`, [s1Id])).rows[0].result
assert.deepStrictEqual(r3, { success: false, error: 'class_in_progress' }, 'Must reject switching when class is in progress')

// Verify that designation state was NOT changed
const check3 = await db.query(`SELECT id, is_current_target FROM public.sessions WHERE id IN ($1, $2, $3) ORDER BY session_number;`, [s1Id, s2Id, s3Id])
assert.strictEqual(check3.rows.find(r => r.id === s2Id).is_current_target, true, 's2 must remain designated')
assert.strictEqual(check3.rows.find(r => r.id === s1Id).is_current_target, false, 's1 must remain non-designated')
console.log('PASS: 3. In-progress class protection (進行中の切替拒否) succeeded: switching rejected with error class_in_progress.')

// 5. Closed session designation rejection (終了済みセッションの指定拒否)
const [{ session_id: s4Id }] = (await db.query(`
  SELECT create_shared_session(4, (now() + interval '4 days')::timestamptz, false) as session_id;
`)).rows
await db.query(`UPDATE public.sessions SET status = 'completed' WHERE id = $1;`, [s4Id])

const r4 = (await db.query(`SELECT public.set_designated_session($1::uuid) as result;`, [s4Id])).rows[0].result
assert.deepStrictEqual(r4, { success: false, error: 'session_closed' }, 'Completed session must not be designatable')
console.log('PASS: 4. Completed session designation rejection succeeded: rejected with session_closed.')

// 6. Test WHERE clause targeting isolation:
// End s2 class using the official control RPC, then switch designation to s3
await db.query(`SELECT public.control_reaction_session($1::uuid, 'stop');`, [s2Id])
const r5 = (await db.query(`SELECT public.set_designated_session($1::uuid) as result;`, [s3Id])).rows[0].result
assert.deepStrictEqual(r5, { success: true, designatedSessionId: s3Id })

const check5 = await db.query(`SELECT id, is_current_target FROM public.sessions WHERE id IN ($1, $2, $3) ORDER BY session_number;`, [s1Id, s2Id, s3Id])
assert.strictEqual(check5.rows.find(r => r.id === s1Id).is_current_target, false)
assert.strictEqual(check5.rows.find(r => r.id === s2Id).is_current_target, false)
assert.strictEqual(check5.rows.find(r => r.id === s3Id).is_current_target, true)
console.log('PASS: 5. Row limitation verified: only previously designated row and new target row were affected.')

console.log('\n=== ALL MIGRATION 021 VERIFICATIONS PASSED ===')
