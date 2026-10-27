import type { ReactionAiMode } from './types'

type Mode = Exclude<ReactionAiMode, 'off'>

export type PostIntent = 'question' | 'confused' | 'impression' | 'general' | 'retraction'

/**
 * 学生の投稿メッセージから投稿の種別（質問、困惑、感想、一般）を判定する。
 */
export function detectPostIntent(message: string): PostIntent {
  const text = message.trim().toLowerCase()

  // 質問・疑問の判定
  if (/[?？]/.test(text) || /なぜ|どうして|どうやって|どうなって|なんで|んだろ|のかな|どういうこと|何ですか|何だろう|教えて|ですか|でしょうか/.test(text)) {
    return 'question'
  }

  if (/なんちゃって|冗談|取り消|撤回|やっぱなし/.test(text)) return 'retraction'

  // 困惑・難しさの判定
  if (/わからない|わからん|分からん|分からない|わかんない|難しい|むずい|混乱|ついていけない|追いつけない|意味不明|厳しい|迷子/.test(text)) {
    return 'confused'
  }

  // 感想・気づき・納得の判定
  if (/いいね|なるほど|面白い|おもしろい|すごい|理解できた|納得|たしかに|確かに|そうなんだ|便利|へー/.test(text)) {
    return 'impression'
  }

  return 'general'
}

/**
 * モードおよび投稿種別に応じた自然な本番用予備返信マスター
 */
export const NATURAL_FALLBACK_MASTER: Record<
  Mode,
  Record<PostIntent, Array<{ id: string; text: string }>>
> = {
  empathy: {
    retraction: [
      { id: 'emp-r-1', text: 'ついそう言いたくなるときあるよね' },
      { id: 'emp-r-2', text: 'ちょっと言ってみたくなった感じかな' },
    ],
    question: [
      { id: 'emp-q-1', text: 'そこ気になるね、自分も一緒に考えたい' },
      { id: 'emp-q-2', text: 'それ気になるね、自分もそこ引っかかるかも' },
    ],
    confused: [
      { id: 'emp-c-1', text: 'わかる、むずいところで頭が止まっちゃうよね' },
      { id: 'emp-c-2', text: 'わかんなくなると、そこから先も追いづらいよね' },
    ],
    impression: [
      { id: 'emp-i-1', text: 'そう感じたんだね、話してくれてうれしい' },
      { id: 'emp-i-2', text: 'なるほどって思えると、ちょっとうれしいよね' },
    ],
    general: [
      { id: 'emp-g-1', text: 'うんうん、そう思うのもわかるかも' },
      { id: 'emp-g-2', text: 'そのひとこと、なんかわかる気がする' },
      { id: 'emp-g-3', text: 'うん、そういう感じになるよね' },
      { id: 'emp-g-4', text: 'うん、なんとなく気になる感じあるよね' },
      { id: 'emp-g-5', text: '言葉にしきれない感じもあるよね' },
      { id: 'emp-g-6', text: 'うんうん、ちょっと気になっちゃうね' },
      { id: 'emp-g-7', text: 'なんとなく言ってみたくなるの、わかる' },
      { id: 'emp-g-8', text: 'そういう反応になるのもわかるかも' },
      { id: 'emp-g-9', text: 'うん、ひとこと言いたくなっちゃうね' },
      { id: 'emp-g-10', text: 'うんうん、その感じちょっとわかる' },
    ],
  },
  lecture_bridge: {
    retraction: [
      { id: 'brg-r-1', text: '身近な操作にも、取り消しの仕組みがあると助かるよね' },
      { id: 'brg-r-2', text: '考え直せる設計って、普段使う道具にも大事そうだね' },
    ],
    question: [
      { id: 'brg-q-1', text: 'その疑問、普段使ってるアプリにもヒントがありそう' },
      { id: 'brg-q-2', text: '身近な仕組みと見比べたら、少し見えてくるかもね' },
    ],
    confused: [
      { id: 'brg-c-1', text: '自分なら身近な画面操作に置き換えて考えたくなるかも' },
      { id: 'brg-c-2', text: '難しいところ、いつものスマホだとどうなるんだろう' },
    ],
    impression: [
      { id: 'brg-i-1', text: '使ってるアプリを思い浮かべると、見え方も変わりそう' },
      { id: 'brg-i-2', text: 'いつものスマホにも、つながる話が隠れてるかもね' },
    ],
    general: [
      { id: 'brg-g-1', text: 'ITの授業、知らん仕組みに出会えるのちょっと楽しみやな' },
      { id: 'brg-g-2', text: '情報技術って、使うだけやなく仕組みを知るのもおもろそう' },
      { id: 'brg-g-3', text: 'ITを学ぶと、身近な仕組みを見る目もちょっと変わりそうやな' },
      { id: 'brg-g-4', text: 'ITの話、なんで動くんやろって考えながら聞くのも楽しそう' },
      { id: 'brg-g-5', text: '情報技術の裏側、授業で少しずつ知っていきたいな' },
      { id: 'brg-g-6', text: 'ITの仕組み、使ってるとき気づかん工夫もありそうやね' },
      { id: 'brg-g-7', text: '情報技術を学ぶと、いつもの便利にも理由が見えてきそう' },
      { id: 'brg-g-8', text: 'ITの授業、知ってるつもりの仕組みほど奥が深そうやな' },
      { id: 'brg-g-9', text: 'ITを学ぶ時間、身近な疑問を持ちながら聞きたいな' },
      { id: 'brg-g-10', text: '情報技術って、当たり前をちょっと疑ってみるのも楽しそう' },
    ],
  },
  neutral: {
    retraction: [
      { id: 'neu-r-1', text: '直前の発言を言い直す内容です。' },
      { id: 'neu-r-2', text: '冗談として補足した投稿です。' },
    ],
    question: [
      { id: 'neu-q-1', text: '疑問を示す投稿です。' },
      { id: 'neu-q-2', text: '不明な点についての質問です。' },
    ],
    confused: [
      { id: 'neu-c-1', text: '内容のわかりにくさについての投稿です。' },
      { id: 'neu-c-2', text: '理解が難しいという発言です。' },
    ],
    impression: [
      { id: 'neu-i-1', text: '感想を述べた投稿です。' },
      { id: 'neu-i-2', text: '気づきを示すコメントです。' },
    ],
    general: [
      { id: 'neu-g-1', text: '短い発言です。' },
      { id: 'neu-g-2', text: 'ひとことの投稿です。' },
      { id: 'neu-g-3', text: '短いコメントです。' },
      { id: 'neu-g-4', text: 'チャットへの短文投稿です。' },
      { id: 'neu-g-5', text: 'ひとことの反応です。' },
      { id: 'neu-g-6', text: '短文によるコメントです。' },
      { id: 'neu-g-7', text: '短い反応を示す投稿です。' },
      { id: 'neu-g-8', text: 'ひとことの発言が記載されています。' },
      { id: 'neu-g-9', text: '短い言葉による投稿です。' },
      { id: 'neu-g-10', text: 'チャット内のひとことです。' },
    ],
  },
}

/**
 * メッセージとモードから自然な予備返信を選択する
 */
export function getNaturalFallbackReply(
  mode: Mode,
  message: string
): { id: string; text: string; intent: PostIntent } {
  const intent = detectPostIntent(message)
  const candidates = fallbackCandidates(mode, message)
  // 決定論的かつ分散するようメッセージの文字コードハッシュで選択
  let hash = 0
  for (let i = 0; i < message.length; i++) {
    hash = (hash << 5) - hash + message.charCodeAt(i)
    hash |= 0
  }
  const index = Math.abs(hash) % candidates.length
  const selected = candidates[index] || candidates[0]
  return { ...selected, text: mode === 'neutral' ? directNeutralFallback(message) : selected.text, intent }
}

/**
 * 互換用定義
 */
export const MOCK_REPLIES: Record<Mode, (message: string) => string> = {
  empathy: (msg) => getNaturalFallbackReply('empathy', msg).text,
  lecture_bridge: (msg) => getNaturalFallbackReply('lecture_bridge', msg).text,
  neutral: (msg) => getNaturalFallbackReply('neutral', msg).text,
}

export const FALLBACK_REPLIES: Record<Mode, Array<{ id: string; text: string }>> = {
  empathy: [
    ...NATURAL_FALLBACK_MASTER.empathy.retraction,
    ...NATURAL_FALLBACK_MASTER.empathy.question,
    ...NATURAL_FALLBACK_MASTER.empathy.confused,
    ...NATURAL_FALLBACK_MASTER.empathy.impression,
    ...NATURAL_FALLBACK_MASTER.empathy.general,
  ],
  lecture_bridge: [
    ...NATURAL_FALLBACK_MASTER.lecture_bridge.retraction,
    ...NATURAL_FALLBACK_MASTER.lecture_bridge.question,
    ...NATURAL_FALLBACK_MASTER.lecture_bridge.confused,
    ...NATURAL_FALLBACK_MASTER.lecture_bridge.impression,
    ...NATURAL_FALLBACK_MASTER.lecture_bridge.general,
  ],
  neutral: [
    ...NATURAL_FALLBACK_MASTER.neutral.retraction,
    ...NATURAL_FALLBACK_MASTER.neutral.question,
    ...NATURAL_FALLBACK_MASTER.neutral.confused,
    ...NATURAL_FALLBACK_MASTER.neutral.impression,
    ...NATURAL_FALLBACK_MASTER.neutral.general,
  ],
}


// DB state serializes selections across workers. Local state is only a degraded fallback.
const localSelections = new Map<string, string>()
export async function getSessionFallbackReply(
  sessionId: string, mode: Mode, message: string
): Promise<{ id: string; text: string; intent: PostIntent; selectionScope: 'database' | 'process' }> {
  const intent = detectPostIntent(message)
  const candidates = fallbackCandidates(mode, message)
  const key = `${sessionId}:${mode}`
  let selected: { id: string; text: string } | undefined
  let selectionScope: 'database' | 'process' = 'process'
  try {
    const { supabaseAdmin } = await import('@/lib/supabase-admin')
    const { data, error } = await supabaseAdmin.rpc('choose_reaction_fallback', {
      p_session_id: sessionId, p_mode: mode, p_candidate_ids: candidates.map(item => item.id),
    }).abortSignal(AbortSignal.timeout(1500))
    if (!error && typeof data === 'string') selected = candidates.find(item => item.id === data)
    if (selected) selectionScope = 'database'
  } catch { /* Preserve paired output during DB/schema/transport failure; scope is logged. */ }
  if (!selected) {
    const previous = localSelections.get(key)
    selected = candidates.find(item => item.id !== previous) || candidates[0]
  }
  localSelections.delete(key)
  localSelections.set(key, selected.id)
  if (localSelections.size > 1000) localSelections.delete(localSelections.keys().next().value!)
  return { ...selected, text: mode === 'neutral' ? directNeutralFallback(message) : selected.text, intent, selectionScope }
}

export const CHAT_GREETING_FALLBACKS: Record<Mode, Array<{id: string; text: string}>> = {
  empathy: [
    { id: 'emp-hi-1', text: 'こんちゃー！来たね〜' },
    { id: 'emp-hi-2', text: 'やっほー！こんにちは〜' },
    { id: 'emp-hi-3', text: 'こんにちはー！会えたね〜' },
    { id: 'emp-hi-4', text: 'こんちゃ！自分もいるよ〜' },
  ],
  lecture_bridge: [
    { id: 'brg-hi-1', text: 'こんちゃ！普段使う道具の仕組みも気になるね' },
    { id: 'brg-hi-2', text: 'やっほー！身近な操作にも意外な工夫がありそう' },
  ],
  neutral: [
    { id: 'neu-hi-1', text: '挨拶の投稿です。' },
    { id: 'neu-hi-2', text: '挨拶を述べた内容です。' },
  ],
}

export function fallbackCandidates(mode: Mode, message: string) {
  return /^(こんちゃ[ー〜～!！]*|こんにちは[ー〜～!！]*|やっほ[ー〜～!！]*|おはよ[うー〜～!！]*)$/.test(message.trim())
    ? CHAT_GREETING_FALLBACKS[mode]
    : NATURAL_FALLBACK_MASTER[mode][detectPostIntent(message)]
}

// During API failure, preserve the poster's words instead of inventing a description.
export function directNeutralFallback(message: string): string {
  const text = message.trim()
  const plain = text.replace(/[ー〜～!！。\s]+$/gu, '')
  if (/^(こんちゃ|こんにちは|やっほ)$/.test(plain)) return 'こんにちは。'
  if (/^おはよ[う]?$/.test(plain)) return 'おはようございます。'
  if (/^(始まった|はじまった)$/.test(plain)) return '授業が始まりました。'
  if (/^(できた|出来た)$/.test(plain)) return 'できました。'
  if (/^(むずい|難しい|むずかしい)$/.test(plain)) return '難しい内容です。'
  if (/^(わからない|分からない|わからん|分からん|わかんない)$/.test(plain)) return 'わかりません。'
  // Unrecognized content is retained verbatim; do not pretend to understand it.
  const retained = text.length > 140 ? text.slice(0, 139) + '…' : text
  return /[。！？!?…]$/.test(retained) ? retained : retained + '。'
}
