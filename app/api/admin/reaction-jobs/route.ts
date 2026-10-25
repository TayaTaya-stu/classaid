import { NextResponse } from 'next/server'
import { isAdminAuthenticated } from '@/lib/admin-auth'
import { claimPendingJobs, retryFailedJobs, executeReactionJob, recoverMissingJobs } from '@/lib/reaction-ai/service'
import { supabaseAdmin } from '@/lib/supabase-admin'

/**
 * POST: 未処理ジョブの回収と実行 (claim + execute)
 *
 * 呼び出し元:
 * - ローカル開発: curl / スクリプトで手動または定期実行
 * - Production: requires a separately configured authenticated worker; no cron is installed here.
 *
 * after() による初回キックが失敗した場合や、プロセス再起動でジョブが
 * 取り残された場合に、このAPIが回収・実行を担保する。
 */
export async function POST() {
  if (!(await isAdminAuthenticated())) {
    return NextResponse.json({ error: '管理者認証が必要です。' }, { status: 401 })
  }

  try {
    await recoverMissingJobs()
    const claimedJobs = await claimPendingJobs({ batchSize: 10, lockDurationMs: 60_000 })

    if (claimedJobs.length === 0) {
      return NextResponse.json({ claimed: 0, message: '未処理ジョブはありません。' })
    }

    const results = []
    for (const job of claimedJobs) {
      // 人間投稿のメッセージを取得（ジョブテーブルには保存していないため）
      const { data: humanPost } = await supabaseAdmin
        .from('posts')
        .select('message')
        .eq('id', job.human_post_id)
        .maybeSingle()

      try {
      const result = await executeReactionJob({
        claimedJob: job,
        jobId: job.id,
        sessionId: job.session_id,
        roomId: job.room_id,
        humanPostId: job.human_post_id,
        humanMessage: humanPost?.message || '',
      })
      results.push({ jobId: job.id, status: result.jobStatus })
      } catch { results.push({jobId:job.id,status:'failed'}) }
    }

    return NextResponse.json({
      claimed: claimedJobs.length,
      results,
    })
  } catch (error) {
    console.error('Reaction job recovery error:', error)
    return NextResponse.json(
      { error: 'ジョブ回収処理に失敗しました。' },
      { status: 500 }
    )
  }
}

/**
 * PUT: 失敗ジョブのリセット (retry)
 *
 * 一時的なDB障害等からの復旧後に、failed ジョブを pending に戻す。
 * リセット後は次回の POST (claim) またはポーリングで自動実行される。
 */
export async function PUT(request: Request) {
  if (!(await isAdminAuthenticated())) {
    return NextResponse.json({ error: '管理者認証が必要です。' }, { status: 401 })
  }

  try {
    let sessionId: string | undefined
    try {
      const body = await request.json() as Record<string, unknown>
      if (typeof body?.sessionId === 'string') {
        sessionId = body.sessionId
      }
    } catch {
      // Reject malformed requests below.
    }

    if(!sessionId || !/^[a-f0-9-]{36}$/i.test(sessionId)) return NextResponse.json({error:'sessionId is required'},{status:400})
    const resetCount = await retryFailedJobs({ sessionId, batchSize: 20 })
    return NextResponse.json({ reset: resetCount })
  } catch (error) {
    console.error('Reaction job retry error:', error)
    return NextResponse.json(
      { error: 'ジョブリセット処理に失敗しました。' },
      { status: 500 }
    )
  }
}
