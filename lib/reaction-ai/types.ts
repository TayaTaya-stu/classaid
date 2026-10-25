export type ReactionAiMode = 'off' | 'empathy' | 'lecture_bridge' | 'neutral'
export type ReactionAiStatus = 'active' | 'stopped'
export type ReplySourceType = 'mock' | 'generated' | 'fallback' | 'none'
export type ReplyJobStatus = 'pending' | 'processing' | 'completed' | 'failed'

export interface ReactionSessionConfig {
  mode: ReactionAiMode
  status: ReactionAiStatus
  isMockAi: boolean
  lectureTheme: string | null
  protocolSnapshot?: Record<string, unknown> | null
}

export interface PostRecord {
  id: number
  session_id: string
  room_id: string
  participant_id: string | null
  author_type: 'human' | 'ai'
  author_display_name: string
  message: string
  created_at: string
  parent_id?: number | null
}

export interface ProjectionEventDTO {
  cursor: number
  eventType: 'human_only' | 'paired'
  humanPost: {
    id: number
    authorDisplayName: string
    authorType: 'human'
    message: string
    createdAt: string
  }
  aiReply: {
    id: number
    authorDisplayName: string
    authorType: 'ai'
    message: string
    createdAt: string
    isMock?: boolean
    sourceType?: ReplySourceType
  } | null
  createdAt: string
}

export interface ProcessReactionResult {
  projectionEventId: number
  aiPostId: number | null
  mode: ReactionAiMode
  sourceType: ReplySourceType
  isPaired: boolean
  jobStatus: ReplyJobStatus
}
