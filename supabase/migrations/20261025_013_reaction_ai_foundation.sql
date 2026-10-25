-- ==============================================================================
-- ClassAid / reaction-ai: 返信AI基盤・投影イベントキュー・研究ログ
-- マイグレーション番号: 20261025_013_reaction_ai_foundation.sql
-- 目的:
--   * 人間投稿に対する自動返信を独立管理する
--   * 生成完了順と投影順の整合性を担保する単調増加カーソル (projection_events)
--   * AI返信の研究分析用メタデータログ (ai_reply_logs)
--   * 既存のデータ・テーブル・トリガーには非破壊で追加
-- ==============================================================================

BEGIN;

-- ------------------------------------------------------------------------------
-- 1. sessions テーブルへ返信AI用制御カラムの追加
-- ------------------------------------------------------------------------------
ALTER TABLE public.sessions
    ADD COLUMN IF NOT EXISTS reaction_ai_mode TEXT NOT NULL DEFAULT 'off'
    CHECK (reaction_ai_mode IN ('off', 'empathy', 'lecture_bridge', 'neutral')),
    ADD COLUMN IF NOT EXISTS reaction_ai_status TEXT NOT NULL DEFAULT 'active'
    CHECK (reaction_ai_status IN ('active', 'stopped')),
    ADD COLUMN IF NOT EXISTS is_mock_ai BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS lecture_theme TEXT NULL;

COMMENT ON COLUMN public.sessions.reaction_ai_mode IS '返信AIの動作モード (off / empathy / lecture_bridge / neutral)';
COMMENT ON COLUMN public.sessions.reaction_ai_status IS '緊急停止ステータス (active: 通常稼働 / stopped: 緊急停止中)';
COMMENT ON COLUMN public.sessions.is_mock_ai IS '試験用モック返信フラグ (trueの場合、実AIではなくモック生成を明示)';
COMMENT ON COLUMN public.sessions.lecture_theme IS '授業テーマ (学術的接続の事前コンテキスト)';

-- ------------------------------------------------------------------------------
-- 2. projection_events (投影イベントキュー: 単調増加カーソル)
-- ------------------------------------------------------------------------------
-- AI返信の生成完了順が人間投稿IDと前後しても、字幕取得が欠落しないよう
-- 投影準備が整った順に厳格な単調増加IDを付与する。
CREATE TABLE IF NOT EXISTS public.projection_events (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    session_id UUID NOT NULL REFERENCES public.sessions(id) ON DELETE RESTRICT,
    room_id UUID NOT NULL REFERENCES public.rooms(id) ON DELETE RESTRICT,
    human_post_id BIGINT NOT NULL REFERENCES public.posts(id) ON DELETE RESTRICT,
    ai_post_id BIGINT NULL REFERENCES public.posts(id) ON DELETE RESTRICT,
    event_type TEXT NOT NULL CHECK (event_type IN ('human_only', 'paired')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT projection_events_human_post_unique UNIQUE (human_post_id)
);

COMMENT ON TABLE public.projection_events IS '投影用イベントテーブル。各人間投稿につき最大1件。生成完了順に単調増加IDを発行';
COMMENT ON COLUMN public.projection_events.event_type IS 'human_only: AIなし、paired: 人間投稿＋AI返信の組';

-- ------------------------------------------------------------------------------
-- 3. ai_reply_logs (研究分析用返信ログテーブル: 追記専用)
-- ------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.ai_reply_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id UUID NOT NULL REFERENCES public.sessions(id) ON DELETE RESTRICT,
    room_id UUID NOT NULL REFERENCES public.rooms(id) ON DELETE RESTRICT,
    human_post_id BIGINT NOT NULL REFERENCES public.posts(id) ON DELETE RESTRICT,
    ai_post_id BIGINT NULL REFERENCES public.posts(id) ON DELETE RESTRICT,
    mode TEXT NOT NULL CHECK (mode IN ('off', 'empathy', 'lecture_bridge', 'neutral')),
    source_type TEXT NOT NULL CHECK (source_type IN ('mock', 'generated', 'fallback', 'none')),
    model_name TEXT NULL,
    prompt_version TEXT NULL,
    fallback_id TEXT NULL,
    context_reference JSONB NOT NULL DEFAULT '{}'::jsonb,
    generation_duration_ms INTEGER NULL,
    client_sent_at TIMESTAMPTZ NULL,
    post_created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    reply_created_at TIMESTAMPTZ NULL,
    error_reason TEXT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT ai_reply_logs_human_post_unique UNIQUE (human_post_id)
);

COMMENT ON TABLE public.ai_reply_logs IS 'AI返信の生成・判定メタデータを完全記録する研究ログテーブル';
COMMENT ON COLUMN public.ai_reply_logs.source_type IS 'mock: 試験モック / generated: 通常外部AI生成 / fallback: 予備返信 / none: AIなし';

-- ------------------------------------------------------------------------------
-- 4. インデックスの作成
-- ------------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_projection_events_session_id_id 
    ON public.projection_events(session_id, id);

CREATE INDEX IF NOT EXISTS idx_projection_events_room_id_id 
    ON public.projection_events(room_id, id);

CREATE INDEX IF NOT EXISTS idx_ai_reply_logs_session_id 
    ON public.ai_reply_logs(session_id);

CREATE INDEX IF NOT EXISTS idx_ai_reply_logs_human_post_id 
    ON public.ai_reply_logs(human_post_id);

-- ------------------------------------------------------------------------------
-- 5. セキュリティと不変性トリガー
-- ------------------------------------------------------------------------------
ALTER TABLE public.projection_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_reply_logs ENABLE ROW LEVEL SECURITY;

-- 既存の追記専用保護関数が存在する場合は適用
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM pg_proc WHERE proname = 'prevent_immutable_record_modification'
    ) THEN
        DROP TRIGGER IF EXISTS trg_protect_ai_reply_logs ON public.ai_reply_logs;
        CREATE TRIGGER trg_protect_ai_reply_logs
        BEFORE UPDATE OR DELETE ON public.ai_reply_logs
        FOR EACH ROW
        EXECUTE FUNCTION prevent_immutable_record_modification();
    END IF;
END $$;

COMMIT;
