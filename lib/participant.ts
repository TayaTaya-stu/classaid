import crypto from 'crypto'

/**
 * 学籍番号の正規化処理
 * - 全角英数を半角英数へ変換 (NFKC正規化)
 * - 前後および中間の空白（半角・全角）を除去
 * - ハイフン（-, ー, ‐, －等）やアンダースコアを除去
 * - 英字をすべて大文字に統一
 * 
 * ※引数の生学籍番号はログへ出力しないでください。
 */
export function normalizeStudentId(rawId: string): string {
  if (!rawId || typeof rawId !== 'string') return ''
  
  return rawId
    .normalize('NFKC')
    .replace(/[\s\-_ー‐－]/g, '')
    .toUpperCase()
    .trim()
}

/**
 * 学籍番号から不可逆かつ安定した identity_hash を生成
 * HMAC-SHA256 を使用し、環境変数 PARTICIPANT_HMAC_SECRET で署名。
 * 同一の学籍番号は常に同一のハッシュになりますが、秘密鍵なしには復元・特定できません。
 */
export function generateIdentityHash(normalizedId: string): string {
  const secret = process.env.PARTICIPANT_HMAC_SECRET

  if (!secret || secret.trim().length === 0) {
    throw new Error('PARTICIPANT_HMAC_SECRET is not configured in environment variables.')
  }

  if (!normalizedId || typeof normalizedId !== 'string' || normalizedId.trim().length === 0) {
    throw new Error('Student ID is empty.')
  }

  return crypto
    .createHmac('sha256', secret)
    .update(normalizedId)
    .digest('hex')
}

export type ParticipantSessionPayload = {
  participantId: string
  authUserId: string
  sessionId: string
  roomId: string
  roomSlug: string
  displayName: string
  issuedAt: number
  expiresAt: number
}

// セッショントークンの有効期限: 12時間
export const SESSION_TOKEN_MAX_AGE_SECONDS = 12 * 60 * 60

const UUID_REGEX = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/

/**
 * 改ざん防止用：サーバー側で検証可能なセッショントークンを生成
 * fail closed: PARTICIPANT_HMAC_SECRET が未定義の場合はエラーを投げ、仮鍵は使用しない
 */
export function createSessionToken(
  params: Omit<ParticipantSessionPayload, 'issuedAt' | 'expiresAt'>
): string {
  const secret = process.env.PARTICIPANT_HMAC_SECRET
  if (!secret || secret.trim().length === 0) {
    throw new Error('Cannot create session token: PARTICIPANT_HMAC_SECRET is missing.')
  }

  const now = Date.now()
  const payload: ParticipantSessionPayload = {
    ...params,
    issuedAt: now,
    expiresAt: now + SESSION_TOKEN_MAX_AGE_SECONDS * 1000,
  }

  const serialized = JSON.stringify(payload)
  const base64Data = Buffer.from(serialized, 'utf-8').toString('base64url')
  const signature = crypto
    .createHmac('sha256', secret)
    .update(base64Data)
    .digest('base64url')

  return `${base64Data}.${signature}`
}

/**
 * セッショントークンの検証と復号
 * fail closed: 秘密鍵未設定、期限切れ、改ざん、形式不正時は必ず null を返す
 */
export function verifySessionToken(token: string): ParticipantSessionPayload | null {
  try {
    if (!token || typeof token !== 'string') return null

    const secret = process.env.PARTICIPANT_HMAC_SECRET
    if (!secret || secret.trim().length === 0) {
      return null
    }

    const parts = token.split('.')
    if (parts.length !== 2) return null

    const [base64Data, signature] = parts
    if (!base64Data || !signature) return null

    const expectedSignature = crypto
      .createHmac('sha256', secret)
      .update(base64Data)
      .digest('base64url')

    const sigBuf = Buffer.from(signature)
    const expectedSigBuf = Buffer.from(expectedSignature)

    // バッファ長が一致しない場合は即座に無効化（timingSafeEqualのエラー回避）
    if (sigBuf.length !== expectedSigBuf.length) {
      return null
    }

    if (!crypto.timingSafeEqual(sigBuf, expectedSigBuf)) {
      return null
    }

    const json = Buffer.from(base64Data, 'base64url').toString('utf-8')
    const payload = JSON.parse(json)

    // 各フィールドの型と空文字チェック
    if (!payload || typeof payload !== 'object') return null

    const {
      participantId,
      authUserId,
      sessionId,
      roomId,
      roomSlug,
      displayName,
      issuedAt,
      expiresAt,
    } = payload

    if (
      typeof participantId !== 'string' || participantId.trim().length === 0 ||
      typeof authUserId !== 'string' || !UUID_REGEX.test(authUserId.trim()) ||
      typeof sessionId !== 'string' || sessionId.trim().length === 0 ||
      typeof roomId !== 'string' || roomId.trim().length === 0 ||
      typeof roomSlug !== 'string' || roomSlug.trim().length === 0 ||
      typeof displayName !== 'string' || displayName.trim().length === 0
    ) {
      return null
    }

    if (!Number.isFinite(issuedAt) || !Number.isFinite(expiresAt)) {
      return null
    }

    // expiresAt が issuedAt 以下の場合は不正
    if (expiresAt <= issuedAt) {
      return null
    }

    // 有効期間が12時間を超えている場合も無効
    const MAX_DURATION_MS = SESSION_TOKEN_MAX_AGE_SECONDS * 1000
    if (expiresAt - issuedAt > MAX_DURATION_MS) {
      return null
    }

    // 有効期限のチェック
    const now = Date.now()
    if (now > expiresAt || issuedAt > now + 60 * 1000) {
      // 期限切れ、または端末時計が著しく未来の場合は無効
      return null
    }

    return payload as ParticipantSessionPayload
  } catch {
    return null
  }
}
