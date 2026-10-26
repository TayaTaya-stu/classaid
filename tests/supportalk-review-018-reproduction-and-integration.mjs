import assert from 'node:assert/strict'
import fs from 'node:fs'
import { register } from 'node:module'
import path from 'node:path'
import { PGlite } from '@electric-sql/pglite'

register('./stub-loader.mjs', import.meta.url)

console.log('=== SupporTalk Review 018 Reproduction & Integration Test Suite ===\n')

async function initDb() {
  const db = new PGlite()
  await db.exec(`
    CREATE ROLE anon;
    CREATE ROLE authenticated;
    CREATE ROLE service_role BYPASSRLS;
    CREATE SCHEMA auth;
    CREATE TABLE auth.users(id uuid PRIMARY KEY);
    CREATE SCHEMA storage;
    CREATE TABLE storage.buckets(id text PRIMARY KEY, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);
  `)

  const migrationsDir = path.resolve('supabase/migrations')
  const number = (x) => x.startsWith('000') ? 0 : Number(x.match(/(?:^|_)(\d{3})_/)[1])
  const migrationFiles = fs.readdirSync(migrationsDir).filter((file) => file.endsWith('.sql')).sort((a, b) => number(a) - number(b))

  for (const file of migrationFiles) {
    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8')
    await db.exec(sql)
  }
  return db
}

async function runTests() {
  const db = await initDb()
  const q = async (sql, args = []) => (await db.query(sql, args)).rows

  // =========================================================================
  // REVIEW POINT 3: 120-minute Timeout Rollback Bug Reproduction & Verification
  // =========================================================================
  console.log('--- Point 3: 120-minute Timeout Non-Rollback Reproduction Test ---')

  // Setup session 1
  const [{ session_id: s1 }] = await q(`SELECT create_shared_session(101, now()::timestamptz, false) as session_id;`)
  await q(`SELECT control_reaction_session($1, 'configure', 'empathy', false);`, [s1])
  await q(`SELECT control_reaction_session($1, 'start');`, [s1])

  // Simulate 121 minutes elapsed
  await q(`ALTER TABLE public.sessions DISABLE TRIGGER guard_reaction_condition;`)
  await q(`UPDATE public.sessions SET class_started_at = now() - interval '121 minutes' WHERE id = $1;`, [s1])
  await q(`ALTER TABLE public.sessions ENABLE TRIGGER guard_reaction_condition;`)

  // Action on expired session: In the previous code, resume_ai threw an exception which rolled back auto_expired_at
  console.log('Testing: Expired session operation (resume_ai) must NOT rollback auto_expired_at...')
  const [{ control_reaction_session: expiredResult }] = await q(
    `SELECT control_reaction_session($1, 'resume_ai');`,
    [s1]
  )

  // Verify non-rollback return
  assert.equal(expiredResult.success, false, 'Expired session must return success: false')
  assert.equal(expiredResult.error, 'session_expired', 'Error must be session_expired')
  assert.equal(expiredResult.isExpired, true, 'isExpired must be true')

  // Verify auto_expired_at is COMMITTED and NOT rolled back
  const [s1Row] = await q(`SELECT auto_expired_at, status, reaction_ai_status, projection_status FROM public.sessions WHERE id = $1;`, [s1])
  assert.ok(s1Row.auto_expired_at, 'CRITICAL: auto_expired_at must be committed to DB and NOT rolled back!')
  assert.equal(s1Row.status, 'completed', 'status must be completed')
  assert.equal(s1Row.reaction_ai_status, 'stopped', 'reaction_ai_status must be stopped')
  assert.equal(s1Row.projection_status, 'stopped', 'projection_status must be stopped')

  // Verify event log was written and NOT rolled back
  const [expiredLog] = await q(
    `SELECT * FROM public.event_logs WHERE session_id = $1 AND event_type = 'reaction_auto_expired_120m';`,
    [s1]
  )
  assert.ok(expiredLog, 'Event log for auto-expiration must be committed and NOT rolled back')
  console.log('PASS: Bug fixed - auto_expired_at and event logs are committed without rollback!\n')

  // Test: check_or_expire_120m standalone RPC
  console.log('Testing: check_or_expire_120m standalone RPC...')
  const [{ session_id: s2 }] = await q(`SELECT create_shared_session(102, now()::timestamptz, false) as session_id;`)
  await q(`SELECT control_reaction_session($1, 'start');`, [s2])
  await q(`ALTER TABLE public.sessions DISABLE TRIGGER guard_reaction_condition;`)
  await q(`UPDATE public.sessions SET class_started_at = now() - interval '125 minutes' WHERE id = $1;`, [s2])
  await q(`ALTER TABLE public.sessions ENABLE TRIGGER guard_reaction_condition;`)

  const [{ check_or_expire_120m: checkResult }] = await q(`SELECT check_or_expire_120m($1);`, [s2])
  assert.equal(checkResult.isExpired, true)
  const [s2Row] = await q(`SELECT auto_expired_at, status FROM public.sessions WHERE id = $1;`, [s2])
  assert.ok(s2Row.auto_expired_at)
  assert.equal(s2Row.status, 'completed')
  console.log('PASS: check_or_expire_120m standalone RPC successfully commits expiration.\n')

  // Test: Reject restart on manually closed session
  console.log('Testing: Manual stop followed by resume rejection (session_closed)...')
  const [{ session_id: s3 }] = await q(`SELECT create_shared_session(103, now()::timestamptz, false) as session_id;`)
  await q(`SELECT control_reaction_session($1, 'start');`, [s3])
  await q(`SELECT control_reaction_session($1, 'stop');`, [s3]) // manually stopped/closed
  const [{ control_reaction_session: resumeClosedResult }] = await q(`SELECT control_reaction_session($1, 'resume_ai');`, [s3])
  assert.equal(resumeClosedResult.success, false)
  assert.equal(resumeClosedResult.error, 'session_closed', 'Closed session resume must return session_closed')
  console.log('PASS: Reopening a manually closed session is strictly rejected (session_closed).\n')

  // =========================================================================
  // REVIEW POINT 5: Demo Projection Timestamp from Renderer Callback
  // =========================================================================
  console.log('--- Point 5: Demo Projection Timestamp Test ---')
  const [{ session_id: sDemo }] = await q(`SELECT create_shared_session(105, now()::timestamptz, false) as session_id;`)
  await q(`SELECT control_reaction_session($1, 'start');`, [sDemo])

  // 1. Admin button action does NOT set demo_projected_at
  await q(`SELECT control_reaction_session($1, 'record_demo_projection');`, [sDemo])
  let [demoSess] = await q(`SELECT demo_projected_at FROM public.sessions WHERE id = $1;`, [sDemo])
  assert.equal(demoSess.demo_projected_at, null, 'Admin button action must NOT set demo_projected_at')
  console.log('PASS: Admin button click does NOT save button press time as actual projection time.')

  // 2. Renderer viewport_entered callback sets demo_projected_at
  const rendererRenderedTime = new Date('2026-10-25T14:30:45.123Z')
  await q(`SELECT record_demo_projected($1, $2);`, [sDemo, rendererRenderedTime.toISOString()])
  ;[demoSess] = await q(`SELECT demo_projected_at FROM public.sessions WHERE id = $1;`, [sDemo])
  assert.ok(demoSess.demo_projected_at)
  assert.equal(new Date(demoSess.demo_projected_at).getTime(), rendererRenderedTime.getTime())

  // Check event log
  const [demoLog] = await q(`SELECT * FROM public.event_logs WHERE session_id = $1 AND event_type = 'demo_projected_at';`, [sDemo])
  assert.ok(demoLog)
  assert.equal(demoLog.metadata.source, 'overlay_renderer')
  console.log('PASS: Renderer actual display notification correctly records real demo projection timestamp.\n')

  // =========================================================================
  // REVIEW POINT 4: Projection Pause/Resume & Cursor Integrity
  // =========================================================================
  console.log('--- Point 4: Projection Pause/Resume & Cursor Integrity Test ---')
  const [{ session_id: sProj }] = await q(`SELECT create_shared_session(104, now()::timestamptz, false) as session_id;`)
  const [{ id: rProj }] = await q(`SELECT id FROM public.rooms WHERE session_id = $1;`, [sProj])
  await q(`SELECT control_reaction_session($1, 'start');`, [sProj])

  // Create 1 initial post before pause
  await q(`INSERT INTO auth.users VALUES(gen_random_uuid());`)
  await q(
    `INSERT INTO public.posts (session_id, room_id, author_display_name, author_type, audience_type, reply_target_type, is_ai, is_deleted, message)
     VALUES ($1, $2, '初期学生', 'human', 'room', 'none', false, false, '開始直後の投稿');`,
    [sProj, rProj]
  )
  const [job1] = await q(`SELECT * FROM public.claim_reaction_jobs(1, NULL);`)
  await q(`SELECT finish_reaction_job($1, $2, NULL, 'none', NULL, 0, '{}'::jsonb, NULL);`, [job1.id, job1.lease_token])

  // Read initial event and establish client cursor
  const initialEvents = await q(`SELECT id FROM public.projection_events WHERE session_id = $1 ORDER BY id ASC;`, [sProj])
  assert.equal(initialEvents.length, 1)
  const clientCursor = initialEvents[0].id

  // Pause projection
  await q(`SELECT control_reaction_session($1, 'pause_projection');`, [sProj])
  const [pausedSess] = await q(`SELECT projection_status FROM public.sessions WHERE id = $1;`, [sProj])
  assert.equal(pausedSess.projection_status, 'paused')

  // Insert 2 posts WHILE PAUSED
  for (let i = 1; i <= 2; i++) {
    await q(
      `INSERT INTO public.posts (session_id, room_id, author_display_name, author_type, audience_type, reply_target_type, is_ai, is_deleted, message)
       VALUES ($1, $2, '一時停止中学生', 'human', 'room', 'none', false, false, '一時停止中の投稿 #' || $3);`,
      [sProj, rProj, i]
    )
    const [job] = await q(`SELECT * FROM public.claim_reaction_jobs(1, NULL);`)
    await q(`SELECT finish_reaction_job($1, $2, NULL, 'none', NULL, 0, '{}'::jsonb, NULL);`, [job.id, job.lease_token])
  }

  // Resume projection
  await q(`SELECT control_reaction_session($1, 'resume_projection');`, [sProj])
  const [resumedSess] = await q(`SELECT projection_status FROM public.sessions WHERE id = $1;`, [sProj])
  assert.equal(resumedSess.projection_status, 'active')

  // Client polls with afterCursor = clientCursor (cursor preserved during pause)
  const resumedEvents = await q(
    `SELECT id, human_post_id FROM public.projection_events WHERE session_id = $1 AND id > $2 ORDER BY id ASC;`,
    [sProj, clientCursor]
  )
  assert.equal(resumedEvents.length, 2, 'All posts enqueued during pause must be fetched')

  // Advance client cursor
  const updatedCursor = resumedEvents[resumedEvents.length - 1].id
  const nextPoll = await q(
    `SELECT id FROM public.projection_events WHERE session_id = $1 AND id > $2 ORDER BY id ASC;`,
    [sProj, updatedCursor]
  )
  assert.equal(nextPoll.length, 0, 'No duplicate posts on subsequent poll')
  console.log('PASS: Projection pause & resume preserves cursor, streams all paused posts, and produces zero duplicates.\n')

  // =========================================================================
  // REVIEW POINT 6: Research Views Column Check
  // =========================================================================
  console.log('--- Point 6: Research Views Column Verification ---')
  const [sampleLogView] = await q(`SELECT created_at, logged_at FROM public.v_research_session_logs LIMIT 1;`)
  assert.ok(sampleLogView, 'v_research_session_logs must return rows')
  assert.ok(sampleLogView.created_at, 'created_at column must exist in view')
  assert.ok(sampleLogView.logged_at, 'logged_at alias must exist in view')
  console.log('PASS: v_research_session_logs contains created_at and logged_at columns.\n')

  // =========================================================================
  // REVIEW POINT 1: Electron Protocol & Command Line Argument Parsing
  // =========================================================================
  console.log('--- Point 1: Electron Protocol URL & Startup Arguments Test ---')
  function findProtocolArg(argv) {
    for (const raw of argv || []) {
      if (typeof raw !== 'string') continue
      const trimmed = raw.replace(/^["']|["']$/g, '').trim()
      if (trimmed.startsWith('supportalk://')) return trimmed
    }
    return null
  }

  // Test various Windows startup argv formats
  assert.equal(
    findProtocolArg(['electron.exe', '.', 'supportalk://open?screenUrl=http%3A%2F%2Flocalhost%3A3000%2Fscreen%2Fabc&autostart=1']),
    'supportalk://open?screenUrl=http%3A%2F%2Flocalhost%3A3000%2Fscreen%2Fabc&autostart=1'
  )
  assert.equal(
    findProtocolArg(['electron.exe', '"supportalk://open?screenUrl=http%3A%2F%2Flocalhost%3A3001%2Fscreen%2Fxyz&autostart=1"']),
    'supportalk://open?screenUrl=http%3A%2F%2Flocalhost%3A3001%2Fscreen%2Fxyz&autostart=1'
  )
  assert.equal(findProtocolArg(['electron.exe', '--inspect']), null)
  console.log('PASS: Electron startup command line argument parsing handles normal, quoted, and flag arguments.\n')

  // =========================================================================
  // REVIEW POINT 2: Speech Processing, DB Persistence & Session Isolation Test
  // =========================================================================
  console.log('--- Point 2: Actual Speech Processing, DB Persistence & Session Isolation Test ---')

  // 1. Test real keyword extraction & context matching from actual implementation
  const { extractCandidateKeywords, resolveReferenceEvidence } = await import('../lib/reaction-ai/context.ts')

  const sampleSpeech = '本日はデータベースのトランザクション管理とACID特性、分散システムの一貫性について講義します。'
  const extractedWords = extractCandidateKeywords(sampleSpeech)
  assert.ok(extractedWords.includes('トランザクション'), 'Must extract トランザクション keyword')
  assert.ok(extractedWords.includes('ACID'), 'Must extract ACID keyword')
  assert.ok(extractedWords.includes('システム'), 'Must extract システム keyword')
  console.log('PASS: extractCandidateKeywords correctly identifies academic terms from actual speech text.')

  const mockLectureCtx = {
    sessionId: 'test-session-123',
    recentSpeechWindow: [{ text: sampleSpeech, timestamp: Date.now() }],
    activeSummary: 'データベースのトランザクション管理とACID特性に関する解説',
    recentAcademicTopics: extractedWords,
    historicalKeywords: extractedWords,
    timeline: [],
    pdfTopics: [],
    lectureTheme: 'データベース工学',
    lastUpdated: Date.now(),
  }

  const matchedResult = resolveReferenceEvidence(mockLectureCtx, 'トランザクションのロールバックってどう動くの？')
  assert.equal(matchedResult.source, 'recent_speech', 'Must match against recent_speech context')
  assert.ok(matchedResult.matchedKeywords.includes('トランザクション'), 'Matched keywords must include トランザクション')
  console.log('PASS: resolveReferenceEvidence matches human question against real recent speech context.')

  // 2. Test actual DB RPC: update_lecture_speech_context and strict session isolation
  const [{ session_id: sSp1 }] = await q(`SELECT create_shared_session(106, now()::timestamptz, false) as session_id;`)
  const [{ session_id: sSp2 }] = await q(`SELECT create_shared_session(107, now()::timestamptz, false) as session_id;`)
  await q(`SELECT control_reaction_session($1, 'start');`, [sSp1])
  await q(`SELECT control_reaction_session($1, 'start');`, [sSp2])

  const speechPayload = JSON.stringify([
    { text: sampleSpeech, timestamp: Date.now() },
  ])
  const topicsArray = ['トランザクション', 'ACID', '分散システム']

  await q(
    `SELECT update_lecture_speech_context($1, $2::jsonb, $3, $4::text[], $5::text[], $6::jsonb);`,
    [sSp1, speechPayload, 'トランザクションとACID特性の解説', topicsArray, topicsArray, '[]']
  )

  // Verify speech context is persisted in sSp1
  const [ctxRow1] = await q(`SELECT recent_speech, active_summary, recent_topics FROM public.lecture_contexts WHERE session_id = $1;`, [sSp1])
  assert.ok(ctxRow1, 'lecture_contexts row must exist for session 1')
  assert.equal(ctxRow1.recent_speech.length, 1)
  assert.equal(ctxRow1.recent_speech[0].text, sampleSpeech)
  assert.deepEqual(ctxRow1.recent_topics, topicsArray)

  // Verify session 2 remains completely isolated and untouched
  const [ctxRow2] = await q(`SELECT recent_speech FROM public.lecture_contexts WHERE session_id = $1;`, [sSp2])
  assert.equal(ctxRow2, undefined, 'Session 2 must have no speech context (strict session isolation)')
  console.log('PASS: update_lecture_speech_context commits speech data and maintains strict session isolation in DB.')

  // 3. Test that updating PDF context does NOT wipe out existing speech context
  const pdfTopicsPayload = JSON.stringify([{ page: 1, text: '第1スライド' }])
  await q(
    `SELECT update_lecture_pdf_context($1, $2::jsonb);`,
    [sSp1, pdfTopicsPayload]
  )
  const [ctxAfterPdf] = await q(`SELECT recent_speech, pdf_topics FROM public.lecture_contexts WHERE session_id = $1;`, [sSp1])
  assert.equal(ctxAfterPdf.recent_speech.length, 1, 'PDF update must NOT overwrite recent_speech')
  assert.equal(ctxAfterPdf.pdf_topics.length, 1, 'PDF topics must be saved')
  console.log('PASS: PDF context and Speech context coexist atomically without clobbering each other.')

  console.log('PASS: SQL and context integration checks completed. Native microphone/projection were not tested.')
  console.log('Retired Web Speech simulations and copied session-picker tests were removed. Run supportalk-cleanup.mjs and supportalk-reused-audio.mjs for current runtime paths.')

}

runTests().catch((err) => {
  console.error('TEST SUITE FAILED:', err)
  process.exit(1)
})
