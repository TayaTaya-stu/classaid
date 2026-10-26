import 'server-only'
import { supabaseAdmin } from '@/lib/supabase-admin'

export function studentEntryUrl(request: Request): string {
  const configured = process.env.STUDENT_BASE_URL
  const url = new URL(configured || request.url)
  if (!['http:','https:'].includes(url.protocol) || url.username || url.password || ['localhost','127.0.0.1','[::1]'].includes(url.hostname)) throw new Error('STUDENT_BASE_URLにスマートフォンから接続できるURLを設定してください。')
  return new URL('/join', url.origin).toString()
}
export async function designatedSession() {
  const { data, error } = await supabaseAdmin.from('sessions')
    .select('id,entry_slug,session_number,scheduled_at,status,is_locked,class_started_at,auto_expired_at')
    .eq('room_mode','shared').eq('is_current_target',true).limit(2)
  if (error) throw new Error('授業情報を取得できません。')
  if (!data || data.length !== 1) return null
  const s = data[0]
  if (s.is_locked || ['completed','closed','locked'].includes(s.status) || s.auto_expired_at ||
    (s.class_started_at && Date.now() >= Date.parse(s.class_started_at) + 120 * 60 * 1000)) return null
  return s
}
