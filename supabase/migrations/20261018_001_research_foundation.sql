-- ==============================================================================
-- ClassAid 研究用データベース改修 マイグレーション (フェーズ1)
-- ファイル名: supabase/migrations/20261018_001_research_foundation.sql
-- 目的: 実験第3〜5回（ベースライン・介入1・介入2）に対応する研究用スキーマの構築
-- 
-- 【注意事項 / 警告】
-- 1. このスクリプトは Supabase SQL Editor または Supabase CLI で手動実行するためのものです。
-- 2. DROP TABLE, DROP COLUMN, TRUNCATE, DELETE などのデータ破壊的命令は含まれていません。
-- 3. 既存テーブル (posts, post_likes, settings) のデータはすべて維持されます。
-- 4. 冪等性（再実行性）について:
--    このスクリプトは初回の移行実行を前提として設計されています。トランザクション内で
--    実行されますが、一度コミットされた後に同一スクリプトを再実行すると、
--    「テーブルが既に存在する」「カラムが重複している」等のエラーが発生します。
--    重複実行は行わないでください。
-- ==============================================================================

BEGIN;

-- ==============================================================================
-- 1. 新規マスター・制御テーブルの作成
-- ==============================================================================

-- ------------------------------------------------------------------------------
-- 1-1. sessions (授業回・実験回のメタ情報とプロトコル制御)
-- ------------------------------------------------------------------------------
CREATE TABLE sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_number INTEGER NOT NULL CHECK (session_number >= 0),
    wave_number INTEGER NOT NULL CHECK (wave_number >= 0),
    research_stage TEXT NOT NULL CHECK (research_stage IN ('baseline', 'intervention_1', 'intervention_2')),
    scheduled_at TIMESTAMPTZ NOT NULL,
    class_started_at TIMESTAMPTZ NULL,
    class_ended_at TIMESTAMPTZ NULL,
    intervention_started_at TIMESTAMPTZ NULL,
    intervention_ended_at TIMESTAMPTZ NULL,
    cycle_count INTEGER NOT NULL DEFAULT 3 CHECK (cycle_count > 0),
    cycle_duration_minutes INTEGER NOT NULL DEFAULT 20 CHECK (cycle_duration_minutes > 0),
    slot_minutes JSONB NOT NULL DEFAULT '[3, 6, 9, 12, 15, 18]'::jsonb,
    protocol_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
    pdf_file_url TEXT NULL,
    current_page INTEGER NOT NULL DEFAULT 1 CHECK (current_page >= 1),
    entry_slug TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'in_progress', 'completed', 'locked')),
    is_locked BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE sessions IS '各授業回（第3,4,5回）の実験設定・進行時刻・プロトコルを保持するテーブル';
COMMENT ON COLUMN sessions.entry_slug IS '学生が入室画面(/enter/[entry_slug])で利用する推測困難な参加用スラッグ';
COMMENT ON COLUMN sessions.slot_minutes IS '各サイクル内でAI生成を開始する基準分（例: [3,6,9,12,15,18]）';
COMMENT ON COLUMN sessions.protocol_snapshot IS '実験実施当日のプロトコル設定全スナップショット';
COMMENT ON COLUMN sessions.is_locked IS '授業終了後に研究データを読み取り専用にするためのロックフラグ';

-- ------------------------------------------------------------------------------
-- 1-2. rooms (各授業回の3ルーム: A, B, C)
-- ------------------------------------------------------------------------------
CREATE TABLE rooms (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id UUID NOT NULL REFERENCES sessions(id) ON DELETE RESTRICT,
    group_label TEXT NOT NULL CHECK (group_label IN ('A', 'B', 'C')),
    room_slug TEXT NOT NULL UNIQUE,
    ai_condition TEXT NOT NULL CHECK (ai_condition IN ('none', 'standard', 'damekko')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT rooms_session_group_unique UNIQUE (session_id, group_label)
);

COMMENT ON TABLE rooms IS '各授業回の3グループに対応するルーム。学生にはai_conditionを秘匿する';

-- ------------------------------------------------------------------------------
-- 1-3. participants (参加者マスター: 学籍番号ハッシュによる永続識別)
-- ------------------------------------------------------------------------------
CREATE TABLE participants (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    identity_hash TEXT NOT NULL UNIQUE,
    assigned_group TEXT NOT NULL CHECK (assigned_group IN ('A', 'B', 'C')),
    is_consented BOOLEAN NOT NULL DEFAULT FALSE,
    consented_at TIMESTAMPTZ NULL,
    first_session_id UUID NOT NULL REFERENCES sessions(id) ON DELETE RESTRICT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE participants IS '参加者の永続レコード。学籍番号そのものは保存せず、HMAC-SHA256ハッシュ(identity_hash)のみ保持';
COMMENT ON COLUMN participants.assigned_group IS '初回参加時に均等割り当てされ、3回を通して固定される所属グループ(A/B/C)';

-- ------------------------------------------------------------------------------
-- 1-4. participant_auth_links (Supabase匿名認証 auth.uid() と participants の結合)
-- ------------------------------------------------------------------------------
CREATE TABLE participant_auth_links (
    auth_user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE RESTRICT,
    participant_id UUID NOT NULL REFERENCES participants(id) ON DELETE RESTRICT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_used_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE participant_auth_links IS 'RLSによる本人確認用。Supabase Authの匿名ユーザーIDとparticipants.idを紐付ける';

-- ------------------------------------------------------------------------------
-- 1-5. session_attendances (各授業回ごとの出欠・遅延判定・仮名・接続管理)
-- ------------------------------------------------------------------------------
CREATE TABLE session_attendances (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id UUID NOT NULL REFERENCES sessions(id) ON DELETE RESTRICT,
    participant_id UUID NOT NULL REFERENCES participants(id) ON DELETE RESTRICT,
    room_id UUID NOT NULL REFERENCES rooms(id) ON DELETE RESTRICT,
    display_name TEXT NOT NULL,
    joined_at TIMESTAMPTZ NULL,
    attendance_status TEXT NOT NULL DEFAULT 'not_joined' CHECK (
        attendance_status IN ('not_joined', 'normal', 'delayed', 'heavily_delayed', 'absent', 'technical_issue')
    ),
    is_primary_analysis BOOLEAN NOT NULL DEFAULT TRUE,
    exclusion_reason TEXT NULL,
    last_seen_at TIMESTAMPTZ NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT session_attendances_session_participant_unique UNIQUE (session_id, participant_id),
    CONSTRAINT session_attendances_room_display_name_unique UNIQUE (room_id, display_name)
);

COMMENT ON TABLE session_attendances IS '各回の出欠・参加区分（通常/遅延/大幅遅延/欠席/障害）と主分析対象フラグを管理';
COMMENT ON COLUMN session_attendances.display_name IS 'システムが自動生成する各回限定の短い仮名（例: ペンギン3号）';

-- ------------------------------------------------------------------------------
-- 1-6. session_cycles (20分×3サイクルの介入進行・一時停止管理)
-- ------------------------------------------------------------------------------
CREATE TABLE session_cycles (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id UUID NOT NULL REFERENCES sessions(id) ON DELETE RESTRICT,
    cycle_number INTEGER NOT NULL CHECK (cycle_number > 0),
    status TEXT NOT NULL DEFAULT 'ready' CHECK (
        status IN ('ready', 'running', 'paused', 'completed', 'skipped')
    ),
    started_at TIMESTAMPTZ NULL,
    paused_at TIMESTAMPTZ NULL,
    total_paused_seconds INTEGER NOT NULL DEFAULT 0 CHECK (total_paused_seconds >= 0),
    ended_at TIMESTAMPTZ NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT session_cycles_session_cycle_number_unique UNIQUE (session_id, cycle_number)
);

COMMENT ON TABLE session_cycles IS '各介入サイクル（20分）の実行・一時停止・累計停止秒数を管理';

-- ------------------------------------------------------------------------------
-- 1-7. slide_pages (スライドPDFのページ別抽出テキスト)
-- ------------------------------------------------------------------------------
CREATE TABLE slide_pages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id UUID NOT NULL REFERENCES sessions(id) ON DELETE RESTRICT,
    page_number INTEGER NOT NULL CHECK (page_number >= 1),
    extracted_text TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT slide_pages_session_page_unique UNIQUE (session_id, page_number)
);

COMMENT ON TABLE slide_pages IS 'AI生成時に参照する各スライドページの抽出テキスト';

-- ==============================================================================
-- 2. 既存データ保護用 レガシー受皿セッション・ルームの登録
-- ==============================================================================
-- 開発・検証中の既存投稿398件を紐付けるための固定UUIDを持つレガシーレコードを挿入
INSERT INTO sessions (
    id,
    session_number,
    wave_number,
    research_stage,
    scheduled_at,
    entry_slug,
    status,
    is_locked,
    created_at
) VALUES (
    '00000000-0000-0000-0000-000000000001'::uuid,
    0,
    0,
    'baseline',
    now(),
    'legacy-dev-entry',
    'completed',
    TRUE,
    now()
);

INSERT INTO rooms (
    id,
    session_id,
    group_label,
    room_slug,
    ai_condition,
    created_at
) VALUES (
    '00000000-0000-0000-0000-000000000002'::uuid,
    '00000000-0000-0000-0000-000000000001'::uuid,
    'A',
    'legacy-dev-room',
    'none',
    now()
);

-- ==============================================================================
-- 3. 既存 posts テーブルの拡張（非破壊的マイグレーション）
-- ==============================================================================
-- 3-1. カラムの追加（既存の id: bigint, reaction系カラムはすべて維持）
ALTER TABLE posts ADD COLUMN IF NOT EXISTS session_id UUID NULL;
ALTER TABLE posts ADD COLUMN IF NOT EXISTS room_id UUID NULL;
ALTER TABLE posts ADD COLUMN IF NOT EXISTS author_type TEXT NULL;
ALTER TABLE posts ADD COLUMN IF NOT EXISTS participant_id UUID NULL;
ALTER TABLE posts ADD COLUMN IF NOT EXISTS parent_id BIGINT NULL;
ALTER TABLE posts ADD COLUMN IF NOT EXISTS reply_target_type TEXT NULL;
ALTER TABLE posts ADD COLUMN IF NOT EXISTS author_display_name TEXT NULL;
ALTER TABLE posts ADD COLUMN IF NOT EXISTS is_deleted BOOLEAN NOT NULL DEFAULT FALSE;

-- 3-2. 既存データ398件のバックフィル
-- is_ai = true は必ず author_type = 'ai' とし、既存AI投稿を保持
UPDATE posts
SET
    session_id = '00000000-0000-0000-0000-000000000001'::uuid,
    room_id = '00000000-0000-0000-0000-000000000002'::uuid,
    author_type = CASE 
        WHEN is_ai = TRUE THEN 'ai' 
        ELSE 'human' 
    END,
    author_display_name = COALESCE(name, CASE WHEN is_ai = TRUE THEN '学生AI' ELSE '匿名' END),
    reply_target_type = 'none',
    is_deleted = FALSE
WHERE session_id IS NULL;

-- 3-3. バックフィル後のNOT NULL制約およびCHECK制約・外部キー制約の付与
ALTER TABLE posts ALTER COLUMN session_id SET NOT NULL;
ALTER TABLE posts ADD CONSTRAINT fk_posts_session FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE RESTRICT;

ALTER TABLE posts ALTER COLUMN room_id SET NOT NULL;
ALTER TABLE posts ADD CONSTRAINT fk_posts_room FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE RESTRICT;

ALTER TABLE posts ALTER COLUMN author_type SET NOT NULL;
ALTER TABLE posts ADD CONSTRAINT check_posts_author_type CHECK (author_type IN ('human', 'ai'));

ALTER TABLE posts ALTER COLUMN reply_target_type SET NOT NULL;
ALTER TABLE posts ADD CONSTRAINT check_posts_reply_target_type CHECK (reply_target_type IN ('none', 'to_human', 'to_ai'));

ALTER TABLE posts ALTER COLUMN author_display_name SET NOT NULL;

-- parent_id は既存 posts.id (bigint) への自己参照外部キー
ALTER TABLE posts ADD CONSTRAINT fk_posts_parent FOREIGN KEY (parent_id) REFERENCES posts(id) ON DELETE RESTRICT;

-- participant_id は participants.id への外部キー（AI投稿およびレガシー投稿時はNULL許容）
ALTER TABLE posts ADD CONSTRAINT fk_posts_participant FOREIGN KEY (participant_id) REFERENCES participants(id) ON DELETE RESTRICT;

COMMENT ON COLUMN posts.author_type IS '投稿主別 (human / ai)';
COMMENT ON COLUMN posts.reply_target_type IS '返信先分類 (none / to_human / to_ai)';
COMMENT ON COLUMN posts.is_deleted IS '論理削除フラグ（物理削除は禁止）';

-- ==============================================================================
-- 4. 既存 post_likes テーブルの拡張
-- ==============================================================================
-- participant_id を追加（既存の id: bigint, post_id: bigint, user_id: uuid は維持）
ALTER TABLE post_likes ADD COLUMN IF NOT EXISTS participant_id UUID NULL REFERENCES participants(id) ON DELETE RESTRICT;

-- 新規研究データにおける重複いいね防止用の部分一意インデックス（participant_id が設定されている行のみ）
CREATE UNIQUE INDEX IF NOT EXISTS post_likes_post_participant_unique_idx 
ON post_likes (post_id, participant_id) 
WHERE participant_id IS NOT NULL;

COMMENT ON COLUMN post_likes.participant_id IS '研究実験における参加者ID。既存データ5件はNULLのまま維持';

-- ==============================================================================
-- 5. AI生成・介入ログテーブルの作成
-- ==============================================================================

-- ------------------------------------------------------------------------------
-- 5-1. ai_interventions (予定投稿枠ごとの進行・承認・投稿管理テーブル: 進行中UPDATE可)
-- ------------------------------------------------------------------------------
CREATE TABLE ai_interventions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    cycle_id UUID NOT NULL REFERENCES session_cycles(id) ON DELETE RESTRICT,
    room_id UUID NOT NULL REFERENCES rooms(id) ON DELETE RESTRICT,
    slot_index INTEGER NOT NULL CHECK (slot_index >= 1),
    scheduled_at TIMESTAMPTZ NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (
        status IN ('pending', 'generating', 'ready_for_review', 'posted', 'skipped')
    ),
    selected_attempt_id UUID NULL, -- 5-2 作成後に外部キー制約を追加
    is_modified BOOLEAN NOT NULL DEFAULT FALSE,
    modification_reason TEXT NULL,
    is_fallback BOOLEAN NOT NULL DEFAULT FALSE,
    final_posted_message TEXT NULL,
    post_id BIGINT NULL REFERENCES posts(id) ON DELETE RESTRICT,
    reviewed_at TIMESTAMPTZ NULL,
    posted_at TIMESTAMPTZ NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT ai_interventions_cycle_room_slot_unique UNIQUE (cycle_id, room_id, slot_index)
);

COMMENT ON TABLE ai_interventions IS 'AIの各投稿枠（1授業あたり18スロット）。承認や投稿完了時に更新される';

-- ------------------------------------------------------------------------------
-- 5-2. ai_generation_attempts (AI候補生成・再生成の試行履歴テーブル: 追記専用)
-- ------------------------------------------------------------------------------
CREATE TABLE ai_generation_attempts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    intervention_id UUID NOT NULL REFERENCES ai_interventions(id) ON DELETE RESTRICT,
    attempt_index INTEGER NOT NULL DEFAULT 1 CHECK (attempt_index >= 1),
    ai_condition TEXT NOT NULL CHECK (ai_condition IN ('standard', 'damekko')),
    damekko_mode TEXT NULL CHECK (damekko_mode IN ('reaction', 'positive', 'uncertainty')),
    candidate_messages JSONB NOT NULL DEFAULT '[]'::jsonb,
    slide_page_used INTEGER NULL,
    referenced_transcript_text TEXT NULL,
    referenced_chat_ids JSONB NULL DEFAULT '[]'::jsonb,
    prompt_version TEXT NOT NULL,
    git_commit_hash TEXT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT ai_generation_attempts_intervention_attempt_unique UNIQUE (intervention_id, attempt_index)
);

COMMENT ON TABLE ai_generation_attempts IS 'AIの候補生成試行ログ。何回再生成してもすべて追記され、更新・削除は禁止';

-- 循環参照の外部キーを追加 (ai_interventions.selected_attempt_id -> ai_generation_attempts.id)
ALTER TABLE ai_interventions 
ADD CONSTRAINT fk_ai_interventions_selected_attempt 
FOREIGN KEY (selected_attempt_id) REFERENCES ai_generation_attempts(id) ON DELETE RESTRICT;

-- ==============================================================================
-- 6. 操作・状態変化ログテーブル & アンケート連携テーブル
-- ==============================================================================

-- ------------------------------------------------------------------------------
-- 6-1. event_logs (操作・状態変化ログテーブル: 追記専用)
-- ------------------------------------------------------------------------------
CREATE TABLE event_logs (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    session_id UUID NOT NULL REFERENCES sessions(id) ON DELETE RESTRICT,
    room_id UUID NULL REFERENCES rooms(id) ON DELETE RESTRICT,
    participant_id UUID NULL REFERENCES participants(id) ON DELETE RESTRICT,
    event_type TEXT NOT NULL,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE event_logs IS '入退室、接続変化、タブ表示切替等の操作ログ。下書き本文は一切保存せず、追記専用';

-- ------------------------------------------------------------------------------
-- 6-2. survey_tokens (アンケート回答照合用トークン)
-- ------------------------------------------------------------------------------
CREATE TABLE survey_tokens (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id UUID NOT NULL REFERENCES sessions(id) ON DELETE RESTRICT,
    participant_id UUID NOT NULL REFERENCES participants(id) ON DELETE RESTRICT,
    token TEXT NOT NULL UNIQUE,
    is_used BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT survey_tokens_session_participant_unique UNIQUE (session_id, participant_id)
);

COMMENT ON TABLE survey_tokens IS 'Googleフォーム回答と参加者IDを匿名で照合するためのワンタイムトークン';

-- ==============================================================================
-- 7. データの不変性保護トリガー (Immutability Triggers)
-- ==============================================================================

-- 追記専用テーブル（UPDATE・DELETE禁止）のトリガー関数
CREATE OR REPLACE FUNCTION prevent_immutable_record_modification()
RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'This table is strictly append-only. UPDATE and DELETE operations are forbidden.';
END;
$$ LANGUAGE plpgsql;

-- posts の物理削除（DELETE）禁止トリガー関数（soft delete のみを許可）
CREATE OR REPLACE FUNCTION prevent_posts_physical_delete()
RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'Physical DELETE on posts is forbidden. Use soft delete (is_deleted = true) instead.';
END;
$$ LANGUAGE plpgsql;

-- トリガーの適用
CREATE TRIGGER trg_protect_event_logs
BEFORE UPDATE OR DELETE ON event_logs
FOR EACH ROW
EXECUTE FUNCTION prevent_immutable_record_modification();

CREATE TRIGGER trg_protect_ai_generation_attempts
BEFORE UPDATE OR DELETE ON ai_generation_attempts
FOR EACH ROW
EXECUTE FUNCTION prevent_immutable_record_modification();

CREATE TRIGGER trg_protect_posts_physical_delete
BEFORE DELETE ON posts
FOR EACH ROW
EXECUTE FUNCTION prevent_posts_physical_delete();

-- ==============================================================================
-- 8. 検索用インデックスの作成
-- ==============================================================================
CREATE INDEX IF NOT EXISTS idx_rooms_session_id ON rooms(session_id);
CREATE INDEX IF NOT EXISTS idx_participants_first_session ON participants(first_session_id);
CREATE INDEX IF NOT EXISTS idx_participant_auth_links_participant_id ON participant_auth_links(participant_id);
CREATE INDEX IF NOT EXISTS idx_session_attendances_session_id ON session_attendances(session_id);
CREATE INDEX IF NOT EXISTS idx_session_attendances_participant_id ON session_attendances(participant_id);
CREATE INDEX IF NOT EXISTS idx_session_attendances_room_id ON session_attendances(room_id);
CREATE INDEX IF NOT EXISTS idx_session_cycles_session_id ON session_cycles(session_id);
CREATE INDEX IF NOT EXISTS idx_slide_pages_session_id ON slide_pages(session_id);

CREATE INDEX IF NOT EXISTS idx_posts_session_id ON posts(session_id);
CREATE INDEX IF NOT EXISTS idx_posts_room_id ON posts(room_id);
CREATE INDEX IF NOT EXISTS idx_posts_participant_id ON posts(participant_id);
CREATE INDEX IF NOT EXISTS idx_posts_parent_id ON posts(parent_id);
CREATE INDEX IF NOT EXISTS idx_posts_created_at ON posts(created_at);

CREATE INDEX IF NOT EXISTS idx_post_likes_post_id ON post_likes(post_id);
CREATE INDEX IF NOT EXISTS idx_post_likes_participant_id ON post_likes(participant_id);

CREATE INDEX IF NOT EXISTS idx_ai_interventions_cycle_id ON ai_interventions(cycle_id);
CREATE INDEX IF NOT EXISTS idx_ai_interventions_room_id ON ai_interventions(room_id);
CREATE INDEX IF NOT EXISTS idx_ai_generation_attempts_intervention_id ON ai_generation_attempts(intervention_id);

CREATE INDEX IF NOT EXISTS idx_event_logs_session_created ON event_logs(session_id, created_at);
CREATE INDEX IF NOT EXISTS idx_event_logs_participant_id ON event_logs(participant_id);

CREATE INDEX IF NOT EXISTS idx_survey_tokens_session_participant ON survey_tokens(session_id, participant_id);

-- ==============================================================================
-- 9. 新規テーブルの Row Level Security (RLS) 有効化
-- ==============================================================================
-- 新規テーブルはすべてRLSを有効化（現フェーズでは学生用ポリシーを作成せず閉鎖）
-- 既存の posts, post_likes, settings のポリシーはこのフェーズでは変更しない
ALTER TABLE sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE rooms ENABLE ROW LEVEL SECURITY;
ALTER TABLE participants ENABLE ROW LEVEL SECURITY;
ALTER TABLE participant_auth_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE session_attendances ENABLE ROW LEVEL SECURITY;
ALTER TABLE session_cycles ENABLE ROW LEVEL SECURITY;
ALTER TABLE slide_pages ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_interventions ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_generation_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE event_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE survey_tokens ENABLE ROW LEVEL SECURITY;

-- ==============================================================================
-- 10. 同時入室用 原子的グループ割り当てRPC関数
-- ==============================================================================
-- 70人規模の一斉アクセス時でもグループ人数差を最小化するため、排他ロックと原子的集計を行う
CREATE OR REPLACE FUNCTION assign_or_get_participant(
    p_identity_hash TEXT,
    p_first_session_id UUID
)
RETURNS TABLE (
    participant_id UUID,
    assigned_group TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_existing_id UUID;
    v_existing_group TEXT;
    v_chosen_group TEXT;
    v_new_id UUID;
BEGIN
    -- 引数の妥当性確認
    IF p_identity_hash IS NULL OR trim(p_identity_hash) = '' THEN
        RAISE EXCEPTION 'p_identity_hash must not be empty';
    END IF;

    IF p_first_session_id IS NULL THEN
        RAISE EXCEPTION 'p_first_session_id must not be null';
    END IF;

    IF NOT EXISTS (SELECT 1 FROM public.sessions WHERE id = p_first_session_id) THEN
        RAISE EXCEPTION 'Target session does not exist';
    END IF;

    -- トランザクションレベルの排他アドバイザリーロック（競合回避）
    PERFORM pg_advisory_xact_lock(hashtext('assign_participant_lock'));

    -- 1. 既存参加者チェック
    SELECT p.id, p.assigned_group INTO v_existing_id, v_existing_group
    FROM public.participants p
    WHERE p.identity_hash = p_identity_hash;

    IF FOUND THEN
        RETURN QUERY SELECT v_existing_id, v_existing_group;
        RETURN;
    END IF;

    -- 2. 新規参加者のグループ均等割り当て
    -- A, B, C の現在人数を集計し、最少人数グループを選択。同数の場合は random() で偏りを防ぐ
    WITH group_counts AS (
        SELECT g.label AS group_label, COUNT(p.id) AS participant_count
        FROM (VALUES ('A'), ('B'), ('C')) AS g(label)
        LEFT JOIN public.participants p ON p.assigned_group = g.label
        GROUP BY g.label
    )
    SELECT gc.group_label INTO v_chosen_group
    FROM group_counts gc
    ORDER BY gc.participant_count ASC, random()
    LIMIT 1;

    -- 3. 新規参加者の登録
    INSERT INTO public.participants (
        identity_hash,
        assigned_group,
        is_consented,
        consented_at,
        first_session_id
    ) VALUES (
        p_identity_hash,
        v_chosen_group,
        TRUE,
        now(),
        p_first_session_id
    )
    RETURNING id INTO v_new_id;

    RETURN QUERY SELECT v_new_id, v_chosen_group;
END;
$$;

-- 権限設定: service_role のみ実行可能とし、一般ユーザーからは遮断
REVOKE ALL ON FUNCTION assign_or_get_participant(TEXT, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION assign_or_get_participant(TEXT, UUID) TO service_role;

COMMIT;

-- ==============================================================================
-- 【実行後検証クエリ】
-- 本マイグレーションを Supabase で実行した後、データ整合性を確認するための
-- 読み取り専用クエリです。実行時は以下のコメントを解除して実行してください。
-- ==============================================================================
/*
-- 1. 投稿総数、人間投稿数、AI投稿数、未削除フラグの確認（398件、人間226件、AI172件）
SELECT 
    count(*) AS total_posts,
    count(*) FILTER (WHERE author_type = 'human') AS human_posts,
    count(*) FILTER (WHERE author_type = 'ai') AS ai_posts,
    count(*) FILTER (WHERE is_deleted = false) AS active_posts,
    count(*) FILTER (WHERE session_id = '00000000-0000-0000-0000-000000000001'::uuid) AS legacy_posts
FROM posts;

-- 2. いいね総数の確認（5件）
SELECT count(*) AS total_likes FROM post_likes;

-- 3. レガシーセッション・ルームの作成確認
SELECT s.session_number, s.research_stage, r.group_label, r.room_slug
FROM sessions s
JOIN rooms r ON s.id = r.session_id
WHERE s.id = '00000000-0000-0000-0000-000000000001'::uuid;

-- 4. 新設テーブル一覧（11テーブルが存在することを確認）
SELECT table_name 
FROM information_schema.tables 
WHERE table_schema = 'public' 
  AND table_name IN (
    'sessions', 'rooms', 'participants', 'participant_auth_links',
    'session_attendances', 'session_cycles', 'slide_pages',
    'ai_interventions', 'ai_generation_attempts', 'event_logs', 'survey_tokens'
  )
ORDER BY table_name;
*/
