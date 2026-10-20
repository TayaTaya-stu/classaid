import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import {
  normalizeStudentId,
  generateIdentityHash,
  createSessionToken,
  SESSION_TOKEN_MAX_AGE_SECONDS,
} from '@/lib/participant'
import { generateUniqueDisplayName } from '@/lib/display-names'

// entrySlug のフォーマット検証（英数字・ハイフン・アンダースコア、1〜100文字）
const ENTRY_SLUG_REGEX = /^[a-zA-Z0-9_-]{1,100}$/
// 学籍番号の正規化後フォーマット検証（英数字ちょうど8文字）
// 入力時の全角/半角・大文字/小文字は normalizeStudentId で吸収する。
const NORMALIZED_ID_REGEX = /^[A-Z0-9]{8}$/

export async function POST(request: Request) {
  try {
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

    const { studentId, entrySlug, consented, authToken } = body as Record<string, unknown>

    // 1. 実験参加への同意確認
    if (consented !== true) {
      return NextResponse.json(
        { error: '研究参加への同意が必要です。' },
        { status: 400 }
      )
    }

    // 2. entrySlug の厳格なバリデーション
    if (typeof entrySlug !== 'string' || !ENTRY_SLUG_REGEX.test(entrySlug.trim())) {
      return NextResponse.json(
        { error: '授業参加用URLが正しくありません。案内されたURLからアクセスしてください。' },
        { status: 400 }
      )
    }
    const cleanEntrySlug = entrySlug.trim()

    // 3. 学籍番号のバリデーション（生の値はエラーに出さない）
    if (typeof studentId !== 'string' || studentId.trim().length === 0 || studentId.length > 50) {
      return NextResponse.json(
        { error: '学籍番号を正しく入力してください。' },
        { status: 400 }
      )
    }

    const normalizedId = normalizeStudentId(studentId)
    if (!NORMALIZED_ID_REGEX.test(normalizedId)) {
      return NextResponse.json(
        { error: '学籍番号は英数字8文字で入力してください。' },
        { status: 400 }
      )
    }

    // 4. 匿名認証トークンの必須検証（データ作成より先に最優先で検証）
    if (typeof authToken !== 'string' || authToken.trim().length === 0) {
      return NextResponse.json(
        { error: '認証情報が確認できません。ページを再読み込みしてください。' },
        { status: 401 }
      )
    }

    let authUserId: string
    try {
      const { data: authUserData, error: authUserError } = await supabaseAdmin.auth.getUser(authToken.trim())
      if (authUserError || !authUserData?.user?.id) {
        return NextResponse.json(
          { error: '有効な認証セッションではありません。ページを再読み込みしてください。' },
          { status: 401 }
        )
      }
      authUserId = authUserData.user.id
    } catch {
      return NextResponse.json(
        { error: '認証の検証中にエラーが発生しました。' },
        { status: 401 }
      )
    }

    // 5. 不可逆ハッシュ (identity_hash) の生成
    let identityHash: string
    try {
      identityHash = generateIdentityHash(normalizedId)
    } catch {
      return NextResponse.json(
        { error: 'サーバー設定エラー（HMAC秘密鍵が未構成です）。管理者に連絡してください。' },
        { status: 500 }
      )
    }

    // 6. 既存の認証リンクと参加者IDの整合性検証（乗っ取り防止・データ作成前チェック）
    const { data: existingLink, error: linkQueryError } = await supabaseAdmin
      .from('participant_auth_links')
      .select('participant_id')
      .eq('auth_user_id', authUserId)
      .maybeSingle()

    if (linkQueryError) {
      return NextResponse.json(
        { error: '認証リンクの確認に失敗しました。' },
        { status: 500 }
      )
    }

    let knownParticipantId: string | null = null
    let knownAssignedGroup: string | null = null

    if (existingLink) {
      // 既存リンクがある場合、紐付いている参加者の identity_hash を照合
      const { data: linkedParticipant, error: participantCheckError } = await supabaseAdmin
        .from('participants')
        .select('id, identity_hash, assigned_group')
        .eq('id', existingLink.participant_id)
        .maybeSingle()

      if (participantCheckError) {
        return NextResponse.json(
          { error: '参加者データの確認に失敗しました。' },
          { status: 500 }
        )
      }

      if (!linkedParticipant || linkedParticipant.identity_hash !== identityHash) {
        // 同一ブラウザ/匿名ユーザーで別の学籍番号が入力された場合はデータ作成を行わず安全に遮断
        return NextResponse.json(
          { error: '認証セッションに矛盾が検出されました。ブラウザを再起動するかシークレットウィンドウでお試しください。' },
          { status: 409 }
        )
      }

      // 同一参加者であることが確認できたため再利用
      knownParticipantId = linkedParticipant.id
      knownAssignedGroup = linkedParticipant.assigned_group
    }

    // 7. セッション（授業回）の特定とステータス検証
    const { data: session, error: sessionError } = await supabaseAdmin
      .from('sessions')
      .select('id, session_number, status, is_locked, intervention_started_at, room_mode')
      .eq('entry_slug', cleanEntrySlug)
      .maybeSingle()

    if (sessionError) {
      if (sessionError.code === '42P01' || sessionError.message?.includes('does not exist')) {
        return NextResponse.json(
          { error: 'データベースマイグレーションが未実行です。管理者に連絡してください。' },
          { status: 503 }
        )
      }
      return NextResponse.json(
        { error: '授業回情報の取得に失敗しました。' },
        { status: 500 }
      )
    }

    if (!session) {
      return NextResponse.json(
        { error: '該当する授業セッションが見つかりません。URLを確認してください。' },
        { status: 404 }
      )
    }

    if (session.is_locked || !['scheduled', 'in_progress'].includes(session.status)) {
      return NextResponse.json(
        { error: 'この授業セッションは現在入室を受け付けていません。' },
        { status: 403 }
      )
    }

    // 8. 参加者マスターの確定（既存または原子的RPC呼び出し）
    let participantId: string
    let assignedGroup: string

    if (knownParticipantId && knownAssignedGroup) {
      participantId = knownParticipantId
      assignedGroup = knownAssignedGroup
    } else {
      const { data: participantData, error: rpcError } = await supabaseAdmin.rpc(
        'assign_or_get_participant',
        {
          p_identity_hash: identityHash,
          p_first_session_id: session.id,
        }
      )

      if (rpcError || !participantData || participantData.length === 0) {
        return NextResponse.json(
          { error: '参加者登録処理に失敗しました。管理者に連絡してください。' },
          { status: 500 }
        )
      }

      participantId = participantData[0].participant_id
      assignedGroup = participantData[0].assigned_group
    }

    const now = new Date()
    const nowIso = now.toISOString()

    // 9. participant_auth_links の確定（新規INSERTまたはlast_used_at更新）
    if (!existingLink) {
      const { error: insertLinkError } = await supabaseAdmin
        .from('participant_auth_links')
        .insert({
          auth_user_id: authUserId,
          participant_id: participantId,
          last_used_at: nowIso,
        })

      if (insertLinkError) {
        return NextResponse.json(
          { error: '認証リンクの保存に失敗しました。' },
          { status: 500 }
        )
      }
    } else {
      const { error: updateLinkError } = await supabaseAdmin
        .from('participant_auth_links')
        .update({ last_used_at: nowIso })
        .eq('auth_user_id', authUserId)

      if (updateLinkError) {
        return NextResponse.json(
          { error: '認証リンクの更新に失敗しました。' },
          { status: 500 }
        )
      }
    }

    // 10. ルームを取得。共有モードでは所属グループに関係なく全員を唯一のルームへ入れる。
    let roomQuery = supabaseAdmin
      .from('rooms')
      .select('id, room_slug')
      .eq('session_id', session.id)

    if (session.room_mode !== 'shared') {
      roomQuery = roomQuery.eq('group_label', assignedGroup)
    }

    const { data: roomRows, error: roomError } = await roomQuery.limit(2)
    const room = roomRows?.[0]

    if (roomError || !room || (session.room_mode === 'shared' && roomRows.length !== 1)) {
      return NextResponse.json(
        { error: session.room_mode === 'shared'
          ? '共有ルームの設定が正しくありません。管理者に連絡してください。'
          : '割り当てられたルームの取得に失敗しました。' },
        { status: 500 }
      )
    }

    // 11. 出欠・表示名管理 (session_attendances) の処理（同時入室の冪等性保証）
    const { data: existingAttendance, error: attendanceFindError } = await supabaseAdmin
      .from('session_attendances')
      .select('id, display_name, joined_at')
      .eq('session_id', session.id)
      .eq('participant_id', participantId)
      .maybeSingle()

    if (attendanceFindError) {
      return NextResponse.json(
        { error: '出席情報の取得に失敗しました。' },
        { status: 500 }
      )
    }

    let displayName: string

    if (existingAttendance) {
      // 既に存在する場合: joined_at は保持し、last_seen_at のみ更新
      displayName = existingAttendance.display_name

      const { error: updateAttendanceError } = await supabaseAdmin
        .from('session_attendances')
        .update({ last_seen_at: nowIso })
        .eq('id', existingAttendance.id)

      if (updateAttendanceError) {
        return NextResponse.json(
          { error: '出席情報の更新に失敗しました。' },
          { status: 500 }
        )
      }
    } else {
      // 初回入室時: 介入開始時刻との差分で出欠判定
      let attendanceStatus = 'normal'
      let isPrimaryAnalysis = true
      let exclusionReason: string | null = null

      if (session.intervention_started_at) {
        const interventionStart = new Date(session.intervention_started_at).getTime()
        const diffSeconds = (now.getTime() - interventionStart) / 1000

        if (diffSeconds > 600) {
          attendanceStatus = 'heavily_delayed'
          isPrimaryAnalysis = false
          exclusionReason = '大幅遅延入室(10分超)'
        } else if (diffSeconds > 180) {
          attendanceStatus = 'delayed'
          isPrimaryAnalysis = false
          exclusionReason = '遅延入室(3〜10分)'
        }
      }

      // ルーム内の既存表示名を取得
      const { data: roomAttendances, error: roomNamesError } = await supabaseAdmin
        .from('session_attendances')
        .select('display_name')
        .eq('room_id', room.id)

      if (roomNamesError) {
        return NextResponse.json(
          { error: 'ルーム内表示名の確認に失敗しました。' },
          { status: 500 }
        )
      }

      const existingNames = roomAttendances?.map((a) => a.display_name) || []
      let inserted = false
      let finalName = ''

      // 仮名重複時は別の名前で最大5回再試行
      for (let attempt = 0; attempt < 5; attempt++) {
        const candidateName = generateUniqueDisplayName(existingNames)

        const { error: insertAttendanceError } = await supabaseAdmin
          .from('session_attendances')
          .insert({
            session_id: session.id,
            participant_id: participantId,
            room_id: room.id,
            display_name: candidateName,
            joined_at: nowIso,
            attendance_status: attendanceStatus,
            is_primary_analysis: isPrimaryAnalysis,
            exclusion_reason: exclusionReason,
            last_seen_at: nowIso,
          })

        if (!insertAttendanceError) {
          inserted = true
          finalName = candidateName
          break
        }

        // ユニーク制約違反の場合の分岐処理
        if (insertAttendanceError.code === '23505') {
          // 同一学生の二重入室競合（session_id, participant_id）か再検索して確認
          const { data: raceAttendance } = await supabaseAdmin
            .from('session_attendances')
            .select('id, display_name')
            .eq('session_id', session.id)
            .eq('participant_id', participantId)
            .maybeSingle()

          if (raceAttendance) {
            // 他方のリクエストが先に作成完了していた場合、その出席レコードを採用して成功扱いにする
            inserted = true
            finalName = raceAttendance.display_name
            break
          }

          // (room_id, display_name) の競合なら、該当の名前を除外リストへ追加して再試行
          existingNames.push(candidateName)
          continue
        }

        // その他のDBエラー
        return NextResponse.json(
          { error: '出席情報の登録に失敗しました。' },
          { status: 500 }
        )
      }

      if (!inserted) {
        return NextResponse.json(
          { error: '表示名の自動割り当てが混み合っています。もう一度お試しください。' },
          { status: 503 }
        )
      }

      displayName = finalName
    }

    // 12. 安全な入室状態（HttpOnly Cookie）の設定 (fail-closed)
    let sessionToken: string
    try {
      sessionToken = createSessionToken({
        participantId,
        authUserId,
        sessionId: session.id,
        roomId: room.id,
        roomSlug: room.room_slug,
        displayName,
      })
    } catch {
      return NextResponse.json(
        { error: 'セッショントークンの発行に失敗しました。管理者に連絡してください。' },
        { status: 500 }
      )
    }

    // 13. レスポンス
    const response = NextResponse.json({
      success: true,
      roomSlug: room.room_slug,
      displayName,
    })

    response.cookies.set({
      name: 'classaid_session',
      value: sessionToken,
      httpOnly: true,
      sameSite: 'lax',
      secure: new URL(request.url).protocol === 'https:',
      path: '/',
      maxAge: SESSION_TOKEN_MAX_AGE_SECONDS,
    })

    return response
  } catch {
    return NextResponse.json(
      { error: 'サーバー内部エラーが発生しました。' },
      { status: 500 }
    )
  }
}
