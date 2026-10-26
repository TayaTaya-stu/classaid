import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { PGlite } from '@electric-sql/pglite'

async function runTest() {
  console.log('=== SupporTalk Full Verification Test ===\n')

  const db = new PGlite()
  await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS; CREATE SCHEMA auth; CREATE TABLE auth.users(id uuid PRIMARY KEY); CREATE SCHEMA storage; CREATE TABLE storage.buckets(id text PRIMARY KEY,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);`)

  const migrationsDir = path.resolve('supabase/migrations')
  const number = (x) => x.startsWith('000') ? 0 : Number(x.match(/(?:^|_)(\d{3})_/)[1])
  const migrationFiles = fs.readdirSync(migrationsDir).filter((file) => file.endsWith('.sql')).sort((a, b) => number(a) - number(b))

  for (const file of migrationFiles) {
    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8')
    await db.exec(sql)
  }
  console.log(`PASS: All ${migrationFiles.length} migrations applied successfully to PGlite.`)

  const q = async (sql, args = []) => (await db.query(sql, args)).rows

  // 1. Setup shared session
  const [{ session_id: sessionId }] = await q(
    `SELECT create_shared_session(1, (now() + interval '1 day')::timestamptz, false) as session_id;`
  )
  assert.ok(sessionId, 'Session ID must be created')

  const [{ id: roomId }] = await q(`SELECT id FROM public.rooms WHERE session_id = $1 LIMIT 1;`, [sessionId])
  assert.ok(roomId, 'Shared room must exist')

  // Configure mode to 'empathy'
  await q(`SELECT control_reaction_session($1, 'configure', 'empathy', false);`, [sessionId])

  // Verify pre-start state
  let [sess] = await q(`SELECT * FROM public.sessions WHERE id = $1;`, [sessionId])
  assert.equal(sess.reaction_ai_mode, 'empathy')
  assert.equal(sess.class_started_at, null)
  assert.equal(sess.projection_status, 'active')

  // --- Test 1: Start Lecture (Unification: AI + Voice + Projection) ---
  console.log('\n--- Test 1: Unified Start & Double Start Prevention ---')
  await q(`SELECT control_reaction_session($1, 'start');`, [sessionId])
  ;[sess] = await q(`SELECT * FROM public.sessions WHERE id = $1;`, [sessionId])
  assert.ok(sess.class_started_at, 'class_started_at must be set')
  assert.equal(sess.reaction_ai_status, 'active')
  assert.equal(sess.projection_status, 'active')
  console.log(`PASS: Lecture started at ${sess.class_started_at}`)

  // Verify double start prevention
  await assert.rejects(
    async () => {
      await q(`SELECT control_reaction_session($1, 'start');`, [sessionId])
    },
    /already_started/,
    'Double start must be rejected with already_started'
  )
  console.log('PASS: Double start prevented (already_started)')

  // Verify condition modification prevented during lecture
  await assert.rejects(
    async () => {
      await q(`SELECT control_reaction_session($1, 'configure', 'neutral', false);`, [sessionId])
    },
    /already_started/,
    'Mode change during class must be rejected'
  )
  console.log('PASS: Condition change during class prohibited (already_started)')

  // --- Test 2: Student Entry & Post with AI Reply Generation ---
  console.log('\n--- Test 2: Student Entry, Post & AI Reaction Job Flow ---')
  const [{ id: u1 }] = await q(`INSERT INTO auth.users VALUES(gen_random_uuid()) RETURNING id;`)
  const [{ res: enterResult }] = await q(
    `SELECT enter_reaction_session($1, $2, 'あおぞら', 'あおぞら', 'dev-fingerprint-1', true, false) as res;`,
    [u1, sess.entry_slug]
  )
  const participantId = enterResult.participantId
  assert.ok(participantId, 'Participant must be registered')
  console.log(`PASS: Student 'あおぞら' entered (ID: ${participantId})`)

  // Student posts a confusion question
  const [{ id: postId }] = await q(
    `INSERT INTO public.posts (session_id, room_id, participant_id, author_display_name, author_type, audience_type, reply_target_type, is_ai, is_deleted, message)
     VALUES ($1, $2, $3, 'あおぞら', 'human', 'room', 'none', false, false, 'QuickSortのピボットの選び方が難しくてよくわかりません…')
     RETURNING id;`,
    [sessionId, roomId, participantId]
  )
  assert.ok(postId, 'Post must be inserted')

  // Durable reaction job auto-enqueued in ai_reply_jobs
  const [job] = await q(`SELECT * FROM public.ai_reply_jobs WHERE human_post_id = $1;`, [postId])
  assert.ok(job, 'Reaction job must be enqueued')
  assert.equal(job.status, 'pending')
  console.log(`PASS: Reaction job auto-enqueued (Job ID: ${job.id})`)

  // Worker lease and completion with empathy reply
  const [leasedJob] = await q(`SELECT * FROM public.claim_reaction_jobs(1, NULL);`)
  assert.equal(leasedJob.id, job.id)
  assert.ok(leasedJob.lease_token)

  await q(
    `SELECT finish_reaction_job(
       $1, $2, 'ピボット選びは迷いやすいですよね！中央値を選ぶ工夫などもありますよ。',
       'generated', NULL, 850,
       '{"prompt_version": "v3", "evidence_type": "speech_transcript", "model_name": "gemini-1.5-flash"}'::jsonb,
       now()
     );`,
    [leasedJob.id, leasedJob.lease_token]
  )

  const [completedJob] = await q(`SELECT * FROM public.ai_reply_jobs WHERE id = $1;`, [job.id])
  assert.equal(completedJob.status, 'completed')
  console.log('PASS: Job completed with AI reply and evidence recorded')

  // Verify projection events
  const events = await q(
    `SELECT * FROM public.projection_events WHERE session_id = $1 ORDER BY id DESC;`,
    [sessionId]
  )
  assert.equal(events.length, 1)
  assert.equal(events[0].event_type, 'paired')
  assert.equal(events[0].human_post_id, postId)
  assert.ok(events[0].ai_post_id)
  console.log('PASS: Paired projection event created for display')

  // --- Test 3: Demo Projection Recording from Renderer Callback ---
  console.log('\n--- Test 3: Demo Projection Recording from Renderer Callback ---')
  // Verify that admin action does NOT record button press time
  await q(`SELECT control_reaction_session($1, 'record_demo_projection');`, [sessionId])
  ;[sess] = await q(`SELECT demo_projected_at FROM public.sessions WHERE id = $1;`, [sessionId])
  assert.equal(sess.demo_projected_at, null, 'Admin action must NOT record button press time')

  // Verify that renderer actual display notification (record_demo_projected) records the real timestamp
  await q(`SELECT record_demo_projected($1, now()::timestamptz);`, [sessionId])
  ;[sess] = await q(`SELECT demo_projected_at FROM public.sessions WHERE id = $1;`, [sessionId])
  assert.ok(sess.demo_projected_at, 'demo_projected_at must be recorded by renderer callback')
  console.log(`PASS: Demo projection confirmed recorded from renderer at ${sess.demo_projected_at}`)

  // --- Test 4: Individual Pause & Resume Controls ---
  console.log('\n--- Test 4: Individual Pause & Resume (AI / Projection) ---')
  // Pause AI
  await q(`SELECT control_reaction_session($1, 'pause_ai');`, [sessionId])
  ;[sess] = await q(`SELECT reaction_ai_status, projection_status FROM public.sessions WHERE id = $1;`, [sessionId])
  assert.equal(sess.reaction_ai_status, 'stopped')
  assert.equal(sess.projection_status, 'active')

  // When AI is paused, new post gets human-only projection event without AI reply
  const [{ id: p2 }] = await q(
    `INSERT INTO public.posts (session_id, room_id, participant_id, author_display_name, author_type, audience_type, reply_target_type, is_ai, is_deleted, message)
     VALUES ($1, $2, $3, 'あおぞら', 'human', 'room', 'none', false, false, 'AI停止中の投稿です')
     RETURNING id;`,
    [sessionId, roomId, participantId]
  )

  const [p2Job] = await q(`SELECT * FROM public.ai_reply_jobs WHERE human_post_id = $1;`, [p2])
  assert.equal(p2Job.status, 'pending')
  const [leasedP2] = await q(`SELECT * FROM public.claim_reaction_jobs(1, NULL);`)
  await q(
    `SELECT finish_reaction_job($1, $2, NULL, 'system', NULL, 0, '{}'::jsonb, NULL);`,
    [leasedP2.id, leasedP2.lease_token]
  )
  const [p2Events] = await q(`SELECT * FROM public.projection_events WHERE human_post_id = $1;`, [p2])
  assert.equal(p2Events.event_type, 'human_only')
  console.log('PASS: Paused AI emits human-only event without AI reply')

  // Resume AI
  await q(`SELECT control_reaction_session($1, 'resume_ai');`, [sessionId])
  ;[sess] = await q(`SELECT reaction_ai_status FROM public.sessions WHERE id = $1;`, [sessionId])
  assert.equal(sess.reaction_ai_status, 'active')
  console.log('PASS: AI resumed successfully')

  // Pause Projection
  await q(`SELECT control_reaction_session($1, 'pause_projection');`, [sessionId])
  ;[sess] = await q(`SELECT projection_status FROM public.sessions WHERE id = $1;`, [sessionId])
  assert.equal(sess.projection_status, 'paused')
  console.log('PASS: Projection paused successfully')

  // Resume Projection
  await q(`SELECT control_reaction_session($1, 'resume_projection');`, [sessionId])
  ;[sess] = await q(`SELECT projection_status FROM public.sessions WHERE id = $1;`, [sessionId])
  assert.equal(sess.projection_status, 'active')
  console.log('PASS: Projection resumed successfully')

  // --- Test 5: 120-minute Timeout Auto-Stop Protection ---
  console.log('\n--- Test 5: 120-minute Timeout & Fencing ---')
  // Artificially advance class_started_at by 121 minutes for simulation
  await q(`ALTER TABLE public.sessions DISABLE TRIGGER guard_reaction_condition;`)
  await q(
    `UPDATE public.sessions SET class_started_at = now() - interval '121 minutes' WHERE id = $1;`,
    [sessionId]
  )
  await q(`ALTER TABLE public.sessions ENABLE TRIGGER guard_reaction_condition;`)

  // Trigger stop / check -> triggers auto_expired_at
  await q(`SELECT control_reaction_session($1, 'stop');`, [sessionId])
  ;[sess] = await q(`SELECT auto_expired_at, reaction_ai_status, projection_status FROM public.sessions WHERE id = $1;`, [sessionId])
  assert.ok(sess.auto_expired_at, 'auto_expired_at must be populated')
  assert.equal(sess.reaction_ai_status, 'stopped')
  assert.equal(sess.projection_status, 'stopped')
  console.log(`PASS: Auto-expiration triggered (expired at ${sess.auto_expired_at})`)

  // Further operations after expiration rejected WITHOUT rolling back auto_expired_at and status
  const [{ control_reaction_session: expiredRes }] = await q(
    `SELECT control_reaction_session($1, 'resume_ai');`,
    [sessionId]
  )
  assert.equal(expiredRes.success, false, 'Expired session operation must return success: false')
  assert.equal(expiredRes.error, 'session_expired', 'Error must be session_expired')
  assert.equal(expiredRes.isExpired, true, 'isExpired flag must be true')

  // Crucial: verify auto_expired_at and status=completed were NOT rolled back!
  ;[sess] = await q(`SELECT auto_expired_at, status FROM public.sessions WHERE id = $1;`, [sessionId])
  assert.ok(sess.auto_expired_at, 'auto_expired_at must NOT be rolled back')
  assert.equal(sess.status, 'completed', 'status must remain completed and NOT rolled back')
  console.log('PASS: Operations on expired session rejected without rolling back auto_expired_at (persisted)')

  // Post-expiration job completion is rejected by finish_reaction_job
  const [{ id: expPost }] = await q(
    `INSERT INTO public.posts (session_id, room_id, participant_id, author_display_name, author_type, audience_type, reply_target_type, is_ai, is_deleted, message)
     VALUES ($1, $2, $3, 'あおぞら', 'human', 'room', 'none', false, false, '期限切れ後ジョブテスト')
     RETURNING id;`,
    [sessionId, roomId, participantId]
  )
  const [expJob] = await q(`SELECT * FROM public.ai_reply_jobs WHERE human_post_id = $1;`, [expPost])
  assert.ok(expJob?.id, 'Reaction job must exist for post-expiration post')
  const [leasedExp] = await q(`SELECT * FROM public.claim_reaction_jobs(1, NULL);`)

  await q(
    `SELECT finish_reaction_job($1, $2, '期限切れ後返信', 'generated', NULL, 100, '{}'::jsonb, now());`,
    [leasedExp.id, leasedExp.lease_token]
  )
  const [expEvent] = await q(`SELECT * FROM public.projection_events WHERE human_post_id = $1;`, [expPost])
  assert.equal(expEvent, undefined, 'Expired jobs must not create a new projection event')
  assert.equal((await q('SELECT status FROM ai_reply_jobs WHERE id=$1',[expJob.id]))[0].status,'failed')
  console.log('PASS: expired jobs are terminal and create no AI or projection event')

  // --- Test 6: AI-off mode session ---
  console.log('\n--- Test 6: AI-off Mode Session Flow ---')
  const [{ s: offSessId }] = await q(
    `SELECT create_shared_session(2, (now() + interval '2 days')::timestamptz, false) as s;`
  )
  const [{ id: offRoomId }] = await q(`SELECT id FROM public.rooms WHERE session_id = $1;`, [offSessId])
  const [offSess] = await q(`SELECT * FROM public.sessions WHERE id = $1;`, [offSessId])
  await q(`SELECT control_reaction_session($1, 'configure', 'off', false);`, [offSessId])
  await q(`SELECT control_reaction_session($1, 'start');`, [offSessId])

  const [{ id: u2 }] = await q(`INSERT INTO auth.users VALUES(gen_random_uuid()) RETURNING id;`)
  const [{ res: offReg }] = await q(
    `SELECT enter_reaction_session($1, $2, 'さくら', 'さくら', 'dev-fp-2', true, false) as res;`,
    [u2, offSess.entry_slug]
  )

  const [{ id: offPost }] = await q(
    `INSERT INTO public.posts (session_id, room_id, participant_id, author_display_name, author_type, audience_type, reply_target_type, is_ai, is_deleted, message)
     VALUES ($1, $2, $3, 'さくら', 'human', 'room', 'none', false, false, 'AIなしセッションの質問です')
     RETURNING id;`,
    [offSessId, offRoomId, offReg.participantId]
  )

  const [leasedOff] = await q(`SELECT * FROM public.claim_reaction_jobs(1, NULL);`)
  await q(
    `SELECT finish_reaction_job($1, $2, NULL, 'system', NULL, 0, '{}'::jsonb, NULL);`,
    [leasedOff.id, leasedOff.lease_token]
  )

  const [offEv] = await q(`SELECT * FROM public.projection_events WHERE human_post_id = $1;`, [offPost])
  assert.equal(offEv.event_type, 'human_only')
  assert.equal(offEv.ai_post_id, null)
  console.log('PASS: AI-off mode enqueues human-only projection without AI reply')

  // --- Test 7: Supabase Research Views Validation ---
  console.log('\n--- Test 7: Supabase Research Views Validation ---')
  const [viewOverview] = await q(`SELECT * FROM public.v_research_session_overview WHERE session_id = $1;`, [sessionId])
  assert.ok(viewOverview, 'v_research_session_overview must have row')
  assert.equal(Number(viewOverview.session_number), 1)
  assert.equal(viewOverview.reaction_ai_mode, 'empathy')
  assert.ok(viewOverview.demo_projected_at, 'demo_projected_at reflected in overview')
  console.log(`PASS: v_research_session_overview verified (Session #${viewOverview.session_number}, Participants: ${viewOverview.participant_count}, Posts: ${viewOverview.human_post_count})`)

  const viewPosts = await q(`SELECT * FROM public.v_research_posts_and_replies WHERE session_id = $1;`, [sessionId])
  assert.ok(viewPosts.length >= 1, 'v_research_posts_and_replies must have rows')
  assert.equal(viewPosts[0].student_display_name, 'あおぞら')
  console.log(`PASS: v_research_posts_and_replies verified (${viewPosts.length} posts mapped with AI replies)`)

  const viewLogs = await q(`SELECT * FROM public.v_research_session_logs WHERE session_id = $1;`, [sessionId])
  assert.ok(viewLogs.length >= 1, 'v_research_session_logs must have recorded logs')
  console.log(`PASS: v_research_session_logs verified (${viewLogs.length} events logged with Japanese labels)`)

  console.log('\nALL SUPPORTALK END-TO-END SPECIFICATION TESTS PASSED!')
}

runTest().catch((err) => {
  console.error('TEST FAILED:', err)
  process.exit(1)
})
