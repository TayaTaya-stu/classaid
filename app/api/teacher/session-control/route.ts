import { NextResponse } from 'next/server'
import { isTeacherAuthenticated } from '@/lib/teacher-auth'
import { controlReaction } from '@/lib/reaction-ai/control'

export async function POST(request: Request) {
  if (!(await isTeacherAuthenticated(request))) return NextResponse.json({ error: '先生用認証が必要です。' }, { status: 401 })
  const body = await request.json().catch(() => null)
  if (!body || typeof body !== 'object') return NextResponse.json({ error: '入力が不正です。' }, { status: 400 })
  if (body.action === 'start') return controlReaction(body.sessionId, 'start')
  if (body.action === 'emergency_stop_reaction' || body.action === 'stop') return controlReaction(body.sessionId, 'stop')
  if (body.action === 'pause_ai') return controlReaction(body.sessionId, 'pause_ai')
  if (body.action === 'resume_ai') return controlReaction(body.sessionId, 'resume_ai')
  if (body.action === 'pause_projection') return controlReaction(body.sessionId, 'pause_projection')
  if (body.action === 'resume_projection') return controlReaction(body.sessionId, 'resume_projection')
  if (body.action === 'record_demo_projection') return controlReaction(body.sessionId, 'record_demo_projection')
  if (body.action === 'set_reaction_mode') return controlReaction(body.sessionId, 'configure', body.mode)
  return NextResponse.json({ error: '未対応の操作です。' }, { status: 400 })
}
