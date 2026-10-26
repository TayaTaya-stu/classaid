import { NextResponse } from 'next/server'
import { designatedSession } from '@/lib/student-entry'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { normalizeDisplayName, normalizeDisplayNameKey, generateParticipantIdentityHash,
  createSessionToken, SESSION_TOKEN_MAX_AGE_SECONDS } from '@/lib/participant'

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => null)
    if (!body || typeof body !== 'object') return NextResponse.json({ error: '入力を確認してください。' }, { status: 400 })
    const { entrySlug, displayName, consented, authToken, claimExisting, forgotPreviousName } = body
    if ((forgotPreviousName !== undefined && typeof forgotPreviousName !== 'boolean') || (forgotPreviousName && claimExisting)) {
      return NextResponse.json({ error: '名前不明で登録する場合は、未使用の新しい名前を入力してください。' }, { status: 400 })
    }
    const name = normalizeDisplayName(typeof displayName === 'string' ? displayName : '')
    if (typeof entrySlug !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(entrySlug) || name.length < 2 || name.length > 24 || typeof consented !== 'boolean') {
      return NextResponse.json({ error: '名前（2〜24文字）と研究利用の選択を確認してください。' }, { status: 400 })
    }
    if (typeof authToken !== 'string') return NextResponse.json({ error: 'ページを再読み込みしてください。' }, { status: 401 })
    const { data: auth, error: authError } = await supabaseAdmin.auth.getUser(authToken)
    if (authError || !auth.user) return NextResponse.json({ error: 'ページを再読み込みしてください。' }, { status: 401 })
    const uid = auth.user.id
    const { data: allowed, error: rateError } = await supabaseAdmin.rpc('consume_participant_entry_attempt', { p_auth_user_id: uid })
    if (rateError) return NextResponse.json({ error: '入室準備を確認できません。管理者に連絡してください。' }, { status: 503 })
    if (!allowed) return NextResponse.json({ error: '試行が多いため、15分ほど待ってから再試行してください。' }, { status: 429 })

    const currentSession = await designatedSession()
    if (!currentSession || currentSession.entry_slug !== entrySlug) return NextResponse.json({ error: '前の授業の入室画面です。今回のQRを読み直してください。' }, { status: 409 })

    const { data, error } = await supabaseAdmin.rpc('enter_reaction_session', {
      p_auth_user_id: uid,
      p_entry_slug: entrySlug,
      p_display_name: name,
      p_name_key: normalizeDisplayNameKey(name),
      p_identity_hash: generateParticipantIdentityHash(`anonymous:v3:${uid}`),
      p_consented: consented,
      p_claim_existing: Boolean(claimExisting),
    })

    if (error) {
      const message = error.message || ''
      if (forgotPreviousName && /name_exists_confirm_claim|name_taken/.test(message)) {
        return NextResponse.json({ error: 'この名前はすでに登録されています。未使用の新しい名前を入力してください。' }, { status: 409 })
      }
      if (message.includes('name_exists_confirm_claim')) {
        return NextResponse.json({
          promptClaim: true,
          displayName: name,
          message: '以前この名前で参加しましたか？',
        }, { status: 409 })
      }

      const status = /name_taken|use_registered_name|already_linked/.test(message) || error.code === '23505' ? 409
        : /session_closed/.test(message) ? 403 : /session_not_found/.test(message) ? 404 : 500
      const text = /use_registered_name/.test(message) ? '初回に登録した名前を入力してください。'
        : status === 403 ? 'この授業は現在入室できません。'
        : status === 404 ? '授業が見つかりません。'
        : '入室に失敗しました。管理者に連絡してください。'
      return NextResponse.json({ error: text }, { status })
    }

    // Do not report a completed entry until the recovery declaration is recorded.
    // A failed log write can be retried with the same Auth identity; do not sign out.
    if (forgotPreviousName) {
      const { error: logError } = await supabaseAdmin.from('event_logs').insert({
        session_id: data.sessionId,
        room_id: data.roomId,
        participant_id: data.participantId,
        event_type: 'participant_name_unknown_registration',
        metadata: {
          recovery_method: 'self_reported_forgotten_name',
          created_new_participant_in_this_request: data.isNew === true,
          previous_participant_identified: false,
        },
      })
      if (logError) {
        console.error('[SupporTalk] Entry recovery log failed:', logError.code)
        return NextResponse.json({ error: '参加記録を保存できませんでした。同じ名前のまま、もう一度入室してください。' }, { status: 503 })
      }
    }

    const token = createSessionToken({
      participantId: data.participantId,
      authUserId: uid,
      sessionId: data.sessionId,
      roomId: data.roomId,
      roomSlug: data.roomSlug,
      displayName: data.displayName,
    })

    const response = NextResponse.json({
      success: true,
      participantId: data.participantId,
      displayName: data.displayName,
      roomSlug: data.roomSlug,
      isNew: data.isNew,
      isClaimed: data.isClaimed,
    })
    response.headers.set('Cache-Control', 'no-store')
    response.cookies.set({
      name: 'classaid_session',
      value: token,
      httpOnly: true,
      sameSite: 'lax',
      secure: new URL(request.url).protocol === 'https:',
      path: '/',
      maxAge: SESSION_TOKEN_MAX_AGE_SECONDS,
    })
    return response
  } catch {
    return NextResponse.json({ error: '設定または入室処理を確認できません。管理者に連絡してください。' }, { status: 500 })
  }
}

// Only return the profile linked to the caller's verified anonymous Auth identity.
export async function GET(request: Request) {
  const headers = { 'Cache-Control': 'no-store', Vary: 'Authorization' }
  const token = request.headers.get('authorization')?.match(/^Bearer (.+)$/i)?.[1]
  if (!token) return NextResponse.json({ error: '認証が必要です。' }, { status: 401, headers })
  try {
    const { data, error } = await supabaseAdmin.auth.getUser(token)
    if (error || !data.user) return NextResponse.json({ error: '認証を確認してください。' }, { status: 401, headers })
    const link = await supabaseAdmin.from('participant_auth_links').select('participant_id').eq('auth_user_id', data.user.id).maybeSingle()
    if (link.error) throw link.error
    if (!link.data) return NextResponse.json({ displayName: '', participantId: '' }, { headers })
    const profile = await supabaseAdmin.from('participant_display_name_registry').select('display_name').eq('participant_id', link.data.participant_id).maybeSingle()
    if (profile.error || !profile.data) throw new Error('profile_unavailable')
    return NextResponse.json({ displayName: profile.data.display_name, participantId: link.data.participant_id }, { headers })
  } catch {
    return NextResponse.json({ error: '登録名を確認できません。再試行してください。' }, { status: 503, headers })
  }
}
