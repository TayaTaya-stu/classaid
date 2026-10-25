-- ==============================================================================
-- ClassAid / reaction-ai: 返信AI基盤・ジョブ管理・直列化投影キュー・研究ログ
-- マイグレーション番号: 20261025_013_reaction_ai_foundation.sql
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
-- 2. posts テーブルにおける親投稿への重複AI返信防止制約 (DBレベルの二重返信排除)
-- ------------------------------------------------------------------------------
CREATE UNIQUE INDEX IF NOT EXISTS posts_parent_ai_reply_unique
    ON public.posts (parent_id)
    WHERE parent_id IS NOT NULL AND author_type = 'ai' AND is_deleted = FALSE;

-- ------------------------------------------------------------------------------
-- 3. ai_reply_jobs (非同期返信ジョブ管理テーブル: 永続化とリトライ保証)
-- ------------------------------------------------------------------------------
-- 投稿APIが外部AI生成を待たずに即時レスポンスを返すための永続ジョブキュー。
-- プロセス再起動やネットワーク障害でも未完了ジョブが消失せず再試行できる。
CREATE TABLE IF NOT EXISTS public.ai_reply_jobs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id UUID NOT NULL REFERENCES public.sessions(id) ON DELETE RESTRICT,
    room_id UUID NOT NULL REFERENCES public.rooms(id) ON DELETE RESTRICT,
    human_post_id BIGINT NOT NULL REFERENCES public.posts(id) ON DELETE RESTRICT,
    mode TEXT NOT NULL CHECK (mode IN ('off', 'empathy', 'lecture_bridge', 'neutral')),
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'completed', 'failed')),
    attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    max_attempts INTEGER NOT NULL DEFAULT 3,
    last_error TEXT NULL,
    locked_until TIMESTAMPTZ NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT ai_reply_jobs_human_post_unique UNIQUE (human_post_id)
);

COMMENT ON TABLE public.ai_reply_jobs IS '返信生成の永続ジョブキュー。投稿APIの待ち時間分離と耐障害性を担保';

-- ------------------------------------------------------------------------------
-- 4. projection_events (投影イベントキュー: 直列化単調増加カーソル)
-- ------------------------------------------------------------------------------
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

COMMENT ON TABLE public.projection_events IS '投影イベントキュー。完成した組から順に配信カーソルを付与';

-- ------------------------------------------------------------------------------
-- 5. アドバイザリーロックによる投影イベント採番・コミット直列化関数
-- ------------------------------------------------------------------------------
-- 並行トランザクションにおける IDENTITY 採番順とコミット順の逆転（Out-of-order Commit）
-- によるカーソル飛び・イベント欠落を根本から防止するため、同一セッション内のイベント作成を直列化する。
CREATE OR REPLACE FUNCTION public.create_projection_event_atomic(
    p_session_id UUID,
    p_room_id UUID,
    p_human_post_id BIGINT,
    p_ai_post_id BIGINT,
    p_event_type TEXT
)
RETURNS BIGINT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_event_id BIGINT;
BEGIN
    -- セッション単位でトランザクション排他ロックを取得（コミット時に自動解放）
    PERFORM pg_advisory_xact_lock(hashtext('projection_lock:' || p_session_id::text));

    -- 既に当該投稿のイベントが存在していればそのIDを返却（冪等性）
    SELECT id INTO v_event_id
    FROM public.projection_events
    WHERE human_post_id = p_human_post_id;

    IF v_event_id IS NOT NULL THEN
        RETURN v_event_id;
    END IF;

    -- 直列化された環境下で安全に単調増加IDを採番・INSERT
    INSERT INTO public.projection_events (
        session_id, room_id, human_post_id, ai_post_id, event_type
    ) VALUES (
        p_session_id, p_room_id, p_human_post_id, p_ai_post_id, p_event_type
    ) RETURNING id INTO v_event_id;

    RETURN v_event_id;
END;
$$;

-- ------------------------------------------------------------------------------
-- 6. ai_reply_logs (研究分析用返信メタデータログ: 追記専用)
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

COMMENT ON TABLE public.ai_reply_logs IS 'AI返信の生成・判定メタデータを完全記録する研究ログテーブル (追記専用)';

-- ------------------------------------------------------------------------------
-- 7. projection_render_logs (投影画面での実描画開始ログ: 追記専用)
-- ------------------------------------------------------------------------------
-- mainプロセスのIPC送出時刻と区別し、rendererで実際にDOM描画が開始された時刻を永続記録する。
CREATE TABLE IF NOT EXISTS public.projection_render_logs (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    session_id UUID NOT NULL REFERENCES public.sessions(id) ON DELETE RESTRICT,
    event_id BIGINT NOT NULL REFERENCES public.projection_events(id) ON DELETE RESTRICT,
    client_instance_id TEXT NOT NULL DEFAULT 'default_overlay',
    dispatched_at TIMESTAMPTZ NULL,
    rendered_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    render_latency_ms INTEGER NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.projection_render_logs IS 'Electron等の画面上で実際にDOM描画が開始された時刻と所要時間の記録 (追記専用)';

-- ------------------------------------------------------------------------------
-- 8. インデックスの作成
-- ------------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_projection_events_session_id_id 
    ON public.projection_events(session_id, id);

CREATE INDEX IF NOT EXISTS idx_projection_events_room_id_id 
    ON public.projection_events(room_id, id);

CREATE INDEX IF NOT EXISTS idx_ai_reply_jobs_status_locked 
    ON public.ai_reply_jobs(status, locked_until);

CREATE INDEX IF NOT EXISTS idx_ai_reply_logs_session_id 
    ON public.ai_reply_logs(session_id);

CREATE INDEX IF NOT EXISTS idx_projection_render_logs_event_id 
    ON public.projection_render_logs(event_id);

-- ------------------------------------------------------------------------------
-- 9. セキュリティと不変性トリガー
-- ------------------------------------------------------------------------------
ALTER TABLE public.ai_reply_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.projection_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_reply_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.projection_render_logs ENABLE ROW LEVEL SECURITY;

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

        DROP TRIGGER IF EXISTS trg_protect_projection_render_logs ON public.projection_render_logs;
        CREATE TRIGGER trg_protect_projection_render_logs
        BEFORE UPDATE OR DELETE ON public.projection_render_logs
        FOR EACH ROW
        EXECUTE FUNCTION prevent_immutable_record_modification();
    END IF;
END $$;

COMMIT;
