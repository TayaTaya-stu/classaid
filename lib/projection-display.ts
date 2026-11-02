import 'server-only'
import { supabaseAdmin } from '@/lib/supabase-admin'

export type ProjectionDisplay = 'simultaneous' | 'staggered'
export const DISPLAY_EVENT = 'projection_display_selected'
export async function readProjectionDisplay(sessionId: string): Promise<ProjectionDisplay> {
  const {data,error} = await supabaseAdmin.from('event_logs').select('metadata')
    .eq('session_id',sessionId).eq('event_type',DISPLAY_EVENT).order('id',{ascending:false}).limit(1).maybeSingle()
  if(error) throw new Error('Projection display unavailable')
  return data?.metadata?.display === 'staggered' ? 'staggered' : 'simultaneous'
}

// A separate, opt-in preview cursor leaves the immutable completed-event queue intact.
export async function getHumanPreviews(sessionId:string,roomId:string,after:number|null) {
  let q=supabaseAdmin.from('posts').select('id,author_display_name,message,created_at')
    .eq('session_id',sessionId).eq('room_id',roomId).eq('author_type','human').eq('is_deleted',false)
  if(after===null){
    const {data,error}=await q.order('id',{ascending:false}).limit(1)
    if(error)throw new Error('Human preview unavailable')
    return {previews:[],humanCursor:data?.[0]?.id??0}
  }
  q=q.gt('id',after)
  const {data,error}=await q.order('id',{ascending:true}).limit(50)
  if(error)throw new Error('Human preview unavailable')
  return {previews:(data??[]).map(p=>({id:p.id,authorDisplayName:p.author_display_name,message:p.message,createdAt:p.created_at})),humanCursor:data?.at(-1)?.id??after}
}
