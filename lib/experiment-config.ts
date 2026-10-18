import 'server-only'

export const EXPERIMENT_AI_CONFIG = {
  model: 'gemini-3.1-flash-lite',
  promptVersion: 'damekko-v1-provisional',
  candidateCount: 3,
  maxCharacters: 70,
  recentChatLimit: 30,
  style: {
    shared: '大学生らしい自然な短文。説明口調を避け、句読点は少なめ。内容に合う場合だけ軽い関西弁を使う。',
    standard: '授業内容を簡潔に整理・確認する中立的な学生として発言する。弱さ、混乱、過度な感情は示さない。',
    damekko: {
      reaction: '短いリアクションで、短文でも参加してよい規範を示す。例の丸写しはせず、文脈に具体的に反応する。',
      positive: '誰でも言える肯定的な感想を示す。過剰に褒めず、授業の具体的内容を一つ拾う。',
      uncertainty: '分からなさや未完成な理解を隠さず、学び続ける姿勢を示す。完全な無理解やふざけた態度にはしない。',
    },
  },
} as const

export type PlannedMessageType = 'reaction' | 'positive' | 'uncertainty' | 'standard'

export function instructionFor(condition: 'standard' | 'damekko', messageType: PlannedMessageType) {
  if (condition === 'standard') return EXPERIMENT_AI_CONFIG.style.standard
  if (messageType === 'standard') return EXPERIMENT_AI_CONFIG.style.damekko.reaction
  return EXPERIMENT_AI_CONFIG.style.damekko[messageType]
}
