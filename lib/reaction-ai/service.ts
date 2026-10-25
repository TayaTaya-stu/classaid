import 'server-only'
import { supabaseAdmin } from '@/lib/supabase-admin'
import type { ReactionAiMode, ReactionSessionConfig, ProjectionEventDTO, ProcessReactionResult } from './types'
import { MOCK_REPLIES, FALLBACK_REPLIES } from './replies'

type Job = { id: string; session_id: string; room_id: string; human_post_id: number; mode: ReactionAiMode; lease_token: string }
export async function getReactionSessionConfig(sessionId: string): Promise<ReactionSessionConfig> {
 const { data, error } = await supabaseAdmin.from('sessions').select('reaction_ai_mode,reaction_ai_status,is_mock_ai,lecture_theme,reaction_pipeline_enabled').eq('id',sessionId).single()
 if(error || !data) throw new Error('Session configuration unavailable')
 if(!['off','empathy','lecture_bridge','neutral'].includes(data.reaction_ai_mode) || !['active','stopped'].includes(data.reaction_ai_status) || typeof data.is_mock_ai !== 'boolean') throw new Error('Invalid session configuration')
 return { mode:data.reaction_ai_mode, status:data.reaction_ai_status,isMockAi:data.is_mock_ai,lectureTheme:data.lecture_theme }
}
// The post INSERT trigger durably enqueues jobs, including when the process stops before after().
export async function enqueueReplyJob(params: { sessionId:string; roomId:string; humanPostId:number; mode:ReactionAiMode }): Promise<string|null> {
 const {data,error}=await supabaseAdmin.from('ai_reply_jobs').select('id').eq('human_post_id',params.humanPostId).eq('session_id',params.sessionId).eq('room_id',params.roomId).maybeSingle()
 if(error) throw new Error('Job lookup failed')
 return data?.id ?? null
}
export async function claimPendingJobs(params: {batchSize?:number; lockDurationMs?:number; jobId?:string}):Promise<Job[]> {
 const {data,error}=await supabaseAdmin.rpc('claim_reaction_jobs',{p_limit:params.batchSize??10,p_job_id:params.jobId??null})
 if(error) throw new Error('Job claim failed')
 return data??[]
}
export async function retryFailedJobs(params:{sessionId?:string;batchSize?:number}):Promise<number> {
 let q=supabaseAdmin.from('ai_reply_jobs').update({status:'pending',attempts:0,locked_until:null,lease_token:null,last_error:null,updated_at:new Date().toISOString()}).eq('status','failed')
 if(params.sessionId) q=q.eq('session_id',params.sessionId)
 const {data,error}=await q.select('id')
 if(error) throw new Error('Retry reset failed')
 return data?.length??0
}
export async function recoverMissingJobs() {
 const {error}=await supabaseAdmin.rpc('recover_reaction_jobs')
 if(error) throw new Error('Missing job recovery failed')
}
export async function executeReactionJob(params:{jobId?:string|null;sessionId:string;roomId:string;humanPostId:number;humanMessage:string;clientSentAt?:string|null;claimedJob?:Job}):Promise<ProcessReactionResult> {
 if(!params.jobId) throw new Error('A durable job is required')
 const job=params.claimedJob ?? (await claimPendingJobs({batchSize:1,jobId:params.jobId}))[0]
 if(!job) return {projectionEventId:0,aiPostId:null,mode:'off',sourceType:'none',isPaired:false,jobStatus:'pending'}
 const started=Date.now()
 try {
  const config=await getReactionSessionConfig(job.session_id)
  const {data:post,error}=await supabaseAdmin.from('posts').select('message').eq('id',job.human_post_id).eq('session_id',job.session_id).eq('room_id',job.room_id).eq('author_type','human').eq('is_deleted',false).single()
  if(error||!post) throw new Error('Job parent unavailable')
  const paired=job.mode!=='off' && config.status!=='stopped'
  if(config.mode!==job.mode) throw new Error('Job mode differs from session mode')
  const mode=job.mode as Exclude<ReactionAiMode,'off'>
  const source=paired ? (config.isMockAi?'mock':'fallback'):'none'
  const text=!paired?null:config.isMockAi?MOCK_REPLIES[mode](post.message):FALLBACK_REPLIES[mode][0].text
  const {data:result,error:finishError}=await supabaseAdmin.rpc('finish_reaction_job',{
   p_job_id:job.id,p_lease:job.lease_token,p_text:text,p_source:source,
   p_fallback_id:source==='fallback'?FALLBACK_REPLIES[mode][0].id:null,
   p_duration:Date.now()-started,p_context:{phase:1,real_generation_implemented:false,lecture_theme:config.lectureTheme},
   p_client_sent_at:params.clientSentAt && Number.isFinite(Date.parse(params.clientSentAt)) ? params.clientSentAt:null
  })
  if(finishError || !result?.event_id) throw new Error('Atomic job finalization failed')
  return {projectionEventId:result.event_id,aiPostId:result.ai_post_id,mode:job.mode,sourceType:source,isPaired:!!result.ai_post_id,jobStatus:'completed'}
 } catch(error) {
  const {error:saveError}=await supabaseAdmin.from('ai_reply_jobs').update({status:'failed',last_error:error instanceof Error?error.message:'job_failed',locked_until:null,lease_token:null,updated_at:new Date().toISOString()}).eq('id',job.id).eq('lease_token',job.lease_token).eq('status','processing')
  if(saveError) console.error('Could not record reaction job failure')
  throw error
 }
}

export async function getProjectionEvents(params: {
  roomId: string
  sessionId: string
  afterCursor: number | null
  limit?: number
}): Promise<{ events: ProjectionEventDTO[]; nextCursor: number | null }> {
  const { roomId, sessionId, afterCursor, limit = 50 } = params

  let query = supabaseAdmin
    .from('projection_events')
    .select('id, human_post_id, ai_post_id, event_type, created_at')
    .eq('room_id', roomId)
    .eq('session_id', sessionId)

  if (afterCursor !== null) {
    query = query.gt('id', afterCursor).order('id', { ascending: true }).limit(limit)
  } else {
    query = query.order('id', { ascending: false }).limit(limit)
  }

  const { data: rawEvents, error } = await query

  // DB障害とデータなしを明確に区別する
  if (error) {
    throw new Error(`projection_events query failed: ${error.message}`)
  }
  if (!rawEvents || rawEvents.length === 0) {
    return { events: [], nextCursor: afterCursor }
  }

  const orderedEvents = afterCursor !== null ? rawEvents : rawEvents.slice().reverse()
  const postIdsToFetch = new Set<number>()
  for (const ev of orderedEvents) {
    postIdsToFetch.add(ev.human_post_id)
    if (ev.ai_post_id) postIdsToFetch.add(ev.ai_post_id)
  }

  const { data: postRows, error: postsError } = await supabaseAdmin
    .from('posts')
    .select('id, author_display_name, author_type, is_ai, message, created_at, is_deleted')
    .eq('session_id', sessionId).eq('room_id', roomId)
    .in('id', Array.from(postIdsToFetch))

  if (postsError) {
    throw new Error(`Posts fetch for projection events failed: ${postsError.message}`)
  }

  const postMap = new Map<number, (typeof postRows extends (infer U)[] | null ? U : never)>()
  postRows?.forEach((post) => postMap.set(post.id, post))

  const dtos: ProjectionEventDTO[] = []
  for (const ev of orderedEvents) {
    const humanPost = postMap.get(ev.human_post_id)
    if (!humanPost) throw new Error('Missing projection parent')
    if (humanPost.is_deleted) continue
    if (humanPost.author_type !== 'human') throw new Error('Invalid projection parent')

    const aiPost = ev.ai_post_id ? postMap.get(ev.ai_post_id) : null
    if (ev.event_type === 'paired' && (!aiPost || aiPost.author_type !== 'ai')) throw new Error('Missing projection reply')
    if (aiPost?.is_deleted) continue

    dtos.push({
      cursor: ev.id,
      eventType: ev.event_type as 'human_only' | 'paired',
      humanPost: {
        id: humanPost.id,
        authorDisplayName: humanPost.author_display_name,
        authorType: 'human',
        message: humanPost.message,
        createdAt: humanPost.created_at,
      },
      aiReply: aiPost
        ? {
            id: aiPost.id,
            authorDisplayName: '学生AI',
            authorType: 'ai',
            message: aiPost.message,
            createdAt: aiPost.created_at,

          }
        : null,
      createdAt: ev.created_at,
    })
  }

  const nextCursor = orderedEvents.at(-1)?.id ?? afterCursor
  return { events: dtos, nextCursor }
}
