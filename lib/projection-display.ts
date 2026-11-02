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

