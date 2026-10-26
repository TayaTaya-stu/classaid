-- ------------------------------------------------------------------------------
-- 20261025_015_participant_recovery_codes.sql
-- 参加者の「復帰コード」を安全に保存するための追加テーブル。
-- 既存マイグレーションは変更せず、この新規ファイルのみで管理する。
-- ------------------------------------------------------------------------------

ALTER TABLE public.session_attendances
    ADD COLUMN IF NOT EXISTS display_name_key TEXT GENERATED ALWAYS AS (
        lower(btrim(regexp_replace(display_name, '\s+', ' ', 'g')))
    ) STORED;

CREATE UNIQUE INDEX IF NOT EXISTS ux_session_attendances_session_display_name_key
    ON public.session_attendances (session_id, display_name_key);

CREATE TABLE IF NOT EXISTS public.participant_display_name_registry (
    participant_id UUID PRIMARY KEY REFERENCES public.participants(id) ON DELETE CASCADE,
    display_name TEXT NOT NULL,
    display_name_key TEXT NOT NULL UNIQUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.participant_display_name_registry IS '研究全体での表示名重複を防ぐためのレジストリ。表示名そのものではなく正規化キーを一意化する。';
COMMENT ON COLUMN public.participant_display_name_registry.display_name IS '最後に使われた表示名（画面表示用）';
COMMENT ON COLUMN public.participant_display_name_registry.display_name_key IS '正規化済み表示名の一意キー。研究全体で重複禁止。';

CREATE INDEX IF NOT EXISTS idx_participant_display_name_registry_name_key
    ON public.participant_display_name_registry(display_name_key);

ALTER TABLE public.participant_display_name_registry ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS participant_display_name_registry_service_role_policy ON public.participant_display_name_registry;
CREATE POLICY participant_display_name_registry_service_role_policy
    ON public.participant_display_name_registry
    FOR ALL
    TO service_role
    USING (true)
    WITH CHECK (true);

REVOKE ALL ON TABLE public.participant_display_name_registry FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.participant_display_name_registry TO service_role;

CREATE TABLE IF NOT EXISTS public.participant_recovery_codes (
    participant_id UUID PRIMARY KEY REFERENCES public.participants(id) ON DELETE CASCADE,
    recovery_code_hash TEXT NOT NULL UNIQUE,
    created_by_auth_user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_used_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    failed_attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (failed_attempt_count >= 0),
    locked_until TIMESTAMPTZ NULL
);

COMMENT ON TABLE public.participant_recovery_codes IS '参加者が別端末から戻るための復帰コード（ハッシュ保存）。コードそのものは保持しない。';
COMMENT ON COLUMN public.participant_recovery_codes.recovery_code_hash IS 'ハッシュ化済みの復帰コード。平文は保存しない。';
COMMENT ON COLUMN public.participant_recovery_codes.created_by_auth_user_id IS '復帰コードを初回発行した匿名認証ユーザー';
COMMENT ON COLUMN public.participant_recovery_codes.failed_attempt_count IS '不正コード試行回数。連続失敗時のロック判定に使用する。';
COMMENT ON COLUMN public.participant_recovery_codes.locked_until IS '失敗回数が閾値を超えた場合の一時的なロック期限。';

CREATE INDEX IF NOT EXISTS idx_participant_recovery_codes_recovery_hash
    ON public.participant_recovery_codes(recovery_code_hash);

ALTER TABLE public.participant_recovery_codes ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS participant_recovery_codes_service_role_policy ON public.participant_recovery_codes;
CREATE POLICY participant_recovery_codes_service_role_policy
    ON public.participant_recovery_codes
    FOR ALL
    TO service_role
    USING (true)
    WITH CHECK (true);

REVOKE ALL ON TABLE public.participant_recovery_codes FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.participant_recovery_codes TO service_role;
