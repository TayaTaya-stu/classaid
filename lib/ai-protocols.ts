import 'server-only'

export const SUPPORTED_SLOT_COUNTS = [6, 8, 10] as const
export type SupportedSlotCount = (typeof SUPPORTED_SLOT_COUNTS)[number]

type CategoryDefinition = {
  label: string
  instruction: string
}

type ActorDefinition = {
  id: string
  displayName: string
  personaInstruction: string
}

export type AiProtocolDefinition = {
  id: string
  version: string
  label: string
  description: string
  promptVersion: string
  sharedStyle: string
  actors: ActorDefinition[]
  categoryOrder: string[]
  categories: Record<string, CategoryDefinition>
}

const SHARED_STUDENT_STYLE =
  '大学生らしい自然な短文。説明口調を避け、句読点は少なめ。内容に合う場合だけ軽い関西弁を使う。'

export const AI_PROTOCOLS = {
  'standard-v1': {
    id: 'standard-v1',
    version: '1.0.0',
    label: '標準AI',
    description: '授業内容を中立的に整理・確認する比較条件',
    promptVersion: 'standard-v1',
    sharedStyle: SHARED_STUDENT_STYLE,
    actors: [{ id: 'student_ai', displayName: '学生AI', personaInstruction: '特定のキャラクターを誇張せず、自然な学生参加者として振る舞う。' }],
    categoryOrder: ['standard'],
    categories: {
      standard: {
        label: '内容整理・確認',
        instruction: '授業内容を簡潔に整理・確認する中立的な学生として発言する。弱さ、混乱、強い感情、ユーモアは示さない。',
      },
    },
  },
  'damekko-v1': {
    id: 'damekko-v1',
    version: '1.0.0',
    label: 'ダメっこAI（保存版）',
    description: '短い反応・肯定的感想・未完成な理解を示す従来案',
    promptVersion: 'damekko-v1-provisional',
    sharedStyle: SHARED_STUDENT_STYLE,
    actors: [{ id: 'student_ai', displayName: '学生AI', personaInstruction: '理解に自信がない場面も隠さないが、授業への参加意欲は保つ学生として振る舞う。' }],
    categoryOrder: ['reaction', 'positive', 'uncertainty'],
    categories: {
      reaction: {
        label: '短い反応',
        instruction: '短いリアクションで、短文でも参加してよい規範を明確に示す。例の丸写しはせず、文脈に具体的に反応する。',
      },
      positive: {
        label: '肯定的な感想',
        instruction: '誰でも言える肯定的な感想を明確に示す。過剰に褒めず、授業の具体的内容を一つ拾う。',
      },
      uncertainty: {
        label: '分からなさ・未完成な理解',
        instruction: '分からなさや未完成な理解を隠さず、なお参加し続ける姿勢を明確に示す。完全な無理解や授業放棄にはしない。',
      },
    },
  },
  'norm-expansion-v0.1': {
    id: 'norm-expansion-v0.1',
    version: '0.1.0',
    label: '規範拡張型AI（暫定）',
    description: '暗黙に避けられやすい5種類の発言様式を明確に実演する暫定案',
    promptVersion: 'norm-expansion-v0.1',
    sharedStyle: SHARED_STUDENT_STYLE,
    actors: [{ id: 'student_ai', displayName: '学生AI', personaInstruction: '複数の参加様式を自然に実演する学生として振る舞い、カテゴリーの特徴を曖昧にしない。' }],
    categoryOrder: ['reaction_support', 'personal_evaluation', 'content_humor', 'question_check', 'tentative_thought'],
    categories: {
      reaction_support: {
        label: '短い反応・支持',
        instruction: '共感・驚き・賛同のいずれかを、説明を付け足さない短文としてはっきり表す。直近の内容に対応させる。',
      },
      personal_evaluation: {
        label: '個人的感想・評価',
        instruction: '授業内容に関連する自分の感情、好み、個人的評価を主観であることが分かる形ではっきり表す。',
      },
      content_humor: {
        label: '内容関連ユーモア',
        instruction: '授業内容または教員の直近の発言に関連する、意味が伝わる軽いユーモアをはっきり表す。無関係な雑談、侮辱、授業妨害にはしない。',
      },
      question_check: {
        label: '質問・確認',
        instruction: '分からない点をぼかさず、何を知りたいのか分かる素朴な質問としてはっきり尋ねる。AIへの返答を名指しで要求しない。',
      },
      tentative_thought: {
        label: '考察・未完成な理解',
        instruction: '授業内容について、自信のなさを隠さない未完成な解釈・仮説・関連付けを具体的に表す。正解を断定しない。',
      },
    },
  },
} as const satisfies Record<string, AiProtocolDefinition>

export type AiProtocolId = keyof typeof AI_PROTOCOLS

export type ProtocolSnapshot = {
  protocol_id: AiProtocolId
  protocol_version: string
  protocol_label: string
  prompt_version: string
  configured_at: string
  slot_count: SupportedSlotCount
  slot_minutes: number[]
  cycle_sequences: string[][]
  shared_style: string
  actors: ActorDefinition[]
  actor_sequences: string[][]
  categories: Record<string, CategoryDefinition>
}

export function isAiProtocolId(value: unknown): value is AiProtocolId {
  return typeof value === 'string' && value in AI_PROTOCOLS
}

export function isSupportedSlotCount(value: unknown): value is SupportedSlotCount {
  return typeof value === 'number' && SUPPORTED_SLOT_COUNTS.includes(value as SupportedSlotCount)
}

export function slotMinutesFor(slotCount: SupportedSlotCount): number[] {
  if (slotCount === 6) return [3, 6, 9, 12, 15, 18]
  if (slotCount === 8) return [2, 4, 7, 9, 12, 14, 17, 19]
  return [1, 3, 5, 7, 9, 11, 13, 15, 17, 19]
}

export function balancedCycleSequences(protocol: AiProtocolDefinition, slotCount: SupportedSlotCount, cycleCount = 3) {
  const categories = protocol.categoryOrder
  return Array.from({ length: cycleCount }, (_, cycleIndex) => {
    const offset = categories.length === 1 ? 0 : (cycleIndex * 2) % categories.length
    return Array.from({ length: slotCount }, (_, slotIndex) => categories[(offset + slotIndex) % categories.length])
  })
}

export function createProtocolSnapshot(protocolId: AiProtocolId, slotCount: SupportedSlotCount, cycleCount = 3): ProtocolSnapshot {
  const protocol = AI_PROTOCOLS[protocolId]
  const slotMinutes = slotMinutesFor(slotCount)
  return {
    protocol_id: protocol.id as AiProtocolId,
    protocol_version: protocol.version,
    protocol_label: protocol.label,
    prompt_version: protocol.promptVersion,
    configured_at: new Date().toISOString(),
    slot_count: slotCount,
    slot_minutes: slotMinutes,
    cycle_sequences: balancedCycleSequences(protocol, slotCount, cycleCount),
    shared_style: protocol.sharedStyle,
    actors: protocol.actors,
    actor_sequences: Array.from({ length: cycleCount }, (_, cycleIndex) =>
      Array.from({ length: slotCount }, (_, slotIndex) => protocol.actors[(cycleIndex + slotIndex) % protocol.actors.length].id)),
    categories: protocol.categories,
  }
}

export function protocolOptions() {
  return Object.values(AI_PROTOCOLS).map(({ id, label, description, version }) => ({ id, label, description, version }))
}

export function instructionFromSnapshot(snapshot: unknown, messageCategory: string) {
  if (!snapshot || typeof snapshot !== 'object') return null
  const value = snapshot as Partial<ProtocolSnapshot>
  const category = value.categories?.[messageCategory]
  if (!category || typeof category.instruction !== 'string') return null
  return {
    protocolId: typeof value.protocol_id === 'string' ? value.protocol_id : 'legacy',
    promptVersion: typeof value.prompt_version === 'string' ? value.prompt_version : 'legacy',
    sharedStyle: typeof value.shared_style === 'string' ? value.shared_style : SHARED_STUDENT_STYLE,
    categoryLabel: category.label,
    instruction: category.instruction,
  }
}

export function actorFromSnapshot(snapshot: unknown, actorId: string | null | undefined) {
  if (!snapshot || typeof snapshot !== 'object') return null
  const value = snapshot as Partial<ProtocolSnapshot>
  const actor = value.actors?.find((item) => item.id === actorId) || value.actors?.[0]
  return actor || null
}
