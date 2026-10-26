import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { verifyRoomAccess } from '@/lib/room-access'

interface RouteContext {
  params: Promise<{
    roomSlug: string
  }>
}

/**
 * GET: ルーム内の投稿一覧を取得
 * - 最新100件を取得し、クライアント向けに時系列昇順へ並べ替え
 * - いいね情報取得時のDBエラーを適切にハンドリング
 */
export async function GET(request: Request, context: RouteContext) {
  try {
    const { roomSlug } = await context.params
    const roomAccess = await verifyRoomAccess(roomSlug)

    if (!roomAccess) {
      return NextResponse.json(
        { error: 'ルームへのアクセス権がありません。再度入室してください。' },
        { status: 403 }
      )
    }

    const { room, session, participant } = roomAccess

    const afterParam = new URL(request.url).searchParams.get('afterId')
    const afterId = afterParam && /^\d+$/.test(afterParam) ? Number(afterParam) : null

    // Fetch at most 100 base messages, then restore any missing human parents.
    const postColumns = 'id, author_display_name, author_type, is_ai, message, audience_type, created_at, likes, parent_id'
    let postsQuery = supabaseAdmin
      .from('posts')
      .select(postColumns)
      .eq('room_id', room.id)
      .eq('is_deleted', false)

    postsQuery = afterId !== null
      ? postsQuery.gt('id', afterId).order('id', { ascending: true }).limit(100)
      : postsQuery.order('created_at', { ascending: false }).order('id', { ascending: false }).limit(100)

    const { data: rawPosts, error: postsError } = await postsQuery

    if (postsError) {
      return NextResponse.json(
        { error: '投稿一覧の取得に失敗しました。' },
        { status: 500 }
      )
    }

    // クライアントへ返す前に時系列昇順（古い順）へ反転
    let postList = afterId !== null ? (rawPosts || []) : (rawPosts || []).slice().reverse()
    const presentIds = new Set(postList.map(post=>post.id))
    const missingParents = [...new Set(postList.filter(post=>post.author_type==='ai'&&post.parent_id&&!presentIds.has(post.parent_id)).map(post=>post.parent_id!))]
    if(missingParents.length){
      const {data:parents,error:parentError}=await supabaseAdmin.from('posts').select(postColumns)
        .eq('room_id',room.id).eq('session_id',session.id).eq('author_type','human').eq('is_deleted',false).in('id',missingParents)
      if(parentError)return NextResponse.json({error:'返信元の投稿を確認できません。'},{status:503})
      postList=[...(parents||[]),...postList].sort((a,b)=>a.id-b.id)
    }

    const rawVisible=new URL(request.url).searchParams.get('visibleIds')||''
    if(rawVisible.length>4400)return NextResponse.json({error:'表示対象が多すぎます。'},{status:400})
    const visible=rawVisible?rawVisible.split(',').filter(x=>/^\d+$/.test(x)).map(Number).filter(Number.isSafeInteger).slice(-200):[]
    const snapshots=new Map<number,number>(postList.map(p=>[p.id,Number(p.likes)||0]))
    if(afterId!==null&&visible.length){
      const {data:oldRows,error:oldError}=await supabaseAdmin.from('posts').select('id,likes').eq('room_id',room.id).eq('is_deleted',false).in('id',visible)
      if(oldError)return NextResponse.json({error:'いいね数を確認できません。'},{status:503})
      for(const row of oldRows||[])snapshots.set(row.id,Number(row.likes)||0)
    }
    const likeCounts:Record<number,number>=Object.fromEntries(snapshots)
    const likedPostIds=new Set<number>()
    if(snapshots.size){
      const {data:mine,error:likeError}=await supabaseAdmin.from('post_likes').select('post_id').eq('participant_id',participant.id).in('post_id',[...snapshots.keys()])
      if(likeError)return NextResponse.json({error:'いいねを確認できません。'},{status:503})
      for(const row of mine||[])likedPostIds.add(row.post_id)
    }
    const likeUpdates=[...snapshots].map(([id,count])=>({id,likesCount:count,isLiked:likedPostIds.has(id)}))

    // 3. クライアントへ返す安全なDTOの組み立て
    const posts = postList.map((post) => {
      const isAi = post.author_type === 'ai' || post.is_ai === true

      return {
        id: post.id,
        authorDisplayName: isAi ? '学生AI' : post.author_display_name,
        authorType: isAi ? ('ai' as const) : ('human' as const),
        message: post.message,
        parentId: post.parent_id ?? null,
        createdAt: post.created_at,
        likesCount: likeCounts[post.id] || 0,
        isLiked: likedPostIds.has(post.id),
        audienceType: post.audience_type === 'teacher' ? ('teacher' as const) : ('room' as const),
      }
    })

    return NextResponse.json({
      posts, likeUpdates,
      resultMode: afterId !== null ? 'delta' : 'full',
      isSessionLocked: session.isLocked || ['completed', 'locked'].includes(session.status),
      currentUser: {
        displayName: participant.displayName,
      },
      roomLabel: room.groupLabel,
    })
  } catch {
    return NextResponse.json(
      { error: 'サーバー内部エラーが発生しました。' },
      { status: 500 }
    )
  }
}

/**
 * POST: 人間学生による新規投稿の作成
 */
export async function POST(request: Request, context: RouteContext) {
  try {
    const { roomSlug } = await context.params
    const roomAccess = await verifyRoomAccess(roomSlug)

    if (!roomAccess) {
      return NextResponse.json(
        { error: 'ルームへのアクセス権限が確認できません。' },
        { status: 403 }
      )
    }

    const { room, session, participant, authUserId } = roomAccess

    // セッション終了・ロック状態の確認
    if (session.isLocked || ['completed', 'locked'].includes(session.status)) {
      return NextResponse.json(
        { error: 'この授業セッションは終了しているため、投稿できません。' },
        { status: 403 }
      )
    }

    const { data: postingConfig, error: postingConfigError } = await supabaseAdmin.from('sessions')
      .select('reaction_pipeline_enabled').eq('id', session.id).single()
    if (postingConfigError) return NextResponse.json({ error: '投稿設定を確認できません。' }, { status: 503 })
    if (!postingConfig.reaction_pipeline_enabled) return NextResponse.json({ error: '試運転開始前です。開始までお待ちください。' }, { status: 409 })

    let body: unknown
    try {
      body = await request.json()
    } catch {
      return NextResponse.json(
        { error: '不正なリクエスト形式です。' },
        { status: 400 }
      )
    }

    if (!body || typeof body !== 'object') {
      return NextResponse.json(
        { error: 'リクエストデータが無効です。' },
        { status: 400 }
      )
    }

    const requestBody = body as Record<string, unknown>
    const { message } = requestBody

    // 学生用APIでは返信を受け付けない
    if (Object.prototype.hasOwnProperty.call(requestBody, 'parentId')) {
      return NextResponse.json(
        { error: '返信機能は利用できません。通常の投稿として送信してください。' },
        { status: 400 }
      )
    }

    // 1. 本文の検証
    if (typeof message !== 'string' || message.trim().length === 0) {
      return NextResponse.json(
        { error: '投稿内容を入力してください。' },
        { status: 400 }
      )
    }

    const trimmedMessage = message.trim()
    if (trimmedMessage.length > 500) {
      return NextResponse.json(
        { error: '投稿内容は500文字以内で入力してください。' },
        { status: 400 }
      )
    }

    const requestId = requestBody.requestId
    if (typeof requestId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(requestId)) {
      return NextResponse.json({ error: '画面を更新してから再送信してください。' }, { status: 400 })
    }
    const { data: newPost, error: insertError } = await supabaseAdmin.rpc('submit_reaction_post', {
      p_session_id: session.id, p_room_id: room.id, p_participant_id: participant.id,
      p_auth_user_id: authUserId, p_request_id: requestId, p_message: trimmedMessage,
      p_client_sent_at:typeof requestBody.clientSentAt==='string'&&Number.isFinite(Date.parse(requestBody.clientSentAt))?new Date(requestBody.clientSentAt).toISOString():null,
    })
    if (insertError?.message.includes('post_rate_limited'))return NextResponse.json({error:'送信が集中しています。少し待って再送信してください。'},{status:429})
    if (insertError?.message.includes('session_closed')) return NextResponse.json({error:'この授業は終了しました。今回のQRから入り直してください。'},{status:409})
    if (insertError?.message.includes('request_conflict')) return NextResponse.json({error:'前の送信結果を確認してから、画面を更新してください。'},{status:409})

    if (insertError || !newPost) {
      return NextResponse.json(
        { error: '投稿の保存に失敗しました。' },
        { status: 500 }
      )
    }

    // 1. 返信ジョブの永続キュー登録（待ち時間の分離・障害時のジョブ消失防止）
    // ジョブ照会等のDBアクセスは待つが、外部AI生成などの重い処理は一切待たない
    const clientSentAt = typeof requestBody.clientSentAt === 'string' ? requestBody.clientSentAt : null
    let jobId: string | null = null
    try {
      const { enqueueReplyJob } = await import('@/lib/reaction-ai/service')
      jobId = await enqueueReplyJob({
        sessionId: session.id,
        roomId: room.id,
        humanPostId: newPost.id,
        mode: 'off', // mode is read by the DB trigger, never inferred here
      })

      if (!jobId) return NextResponse.json({ success: true, post: { id:newPost.id, authorDisplayName:participant.displayName, authorType:'human', message:trimmedMessage, createdAt:newPost.created_at, likesCount:0, isLiked:false, audienceType:'room' } })

      // 2. 非同期ワーカーのキック（レスポンス完了後にバックグラウンド実行）
      // Next.js 16 の after() を利用し、レスポンス返却をブロックしない
      const { after } = await import('next/server')
      after(async () => {
        try {
          const { executeReactionJob } = await import('@/lib/reaction-ai/service')
          await executeReactionJob({
            jobId,
            sessionId: session.id,
            roomId: room.id,
            humanPostId: newPost.id,
            humanMessage: trimmedMessage,
            clientSentAt,
          })
        } catch (workerError) {
          console.error('Async reaction worker error:', workerError)
        }
      })
    } catch (enqueueError) {
      console.error('Failed to enqueue reaction job:', enqueueError)
    }

    // 3. 人間投稿の成功レスポンスを即座に返却（外部生成の完了は待たない）
    return NextResponse.json({
      success: true,
      post: {
        id: newPost.id,
        authorDisplayName: participant.displayName,
        authorType: 'human',
        message: trimmedMessage,
        createdAt: newPost.created_at,
        likesCount: 0,
        isLiked: false,
        audienceType: 'room',
      },
    })
  } catch {
    return NextResponse.json(
      { error: 'サーバー内部エラーが発生しました。' },
      { status: 500 }
    )
  }
}
