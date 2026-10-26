-- ------------------------------------------------------------------------------
-- 20261026_019_designated_session_and_controls.sql
-- SupporTalk確定仕様:
-- 1. 実験者が管理者画面で「今回使用する授業回」に指定するフラグ (is_current_target)
-- 2. 今回使用する授業回のアトミック指定RPC (set_designated_session)
-- ------------------------------------------------------------------------------

BEGIN;

-- 1. sessionsテーブルへのカラム追加
ALTER TABLE public.sessions
    ADD COLUMN IF NOT EXISTS is_current_target BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN public.sessions.is_current_target IS '実験者が管理者画面で指定した「今回使用する授業回」フラグ（教授アプリの初期表示対象）';

-- 2. アトミック指定関数 (set_designated_session)
CREATE OR REPLACE FUNCTION public.set_designated_session(p_session_id UUID)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE
    v_found BOOLEAN;
BEGIN
    SELECT EXISTS (SELECT 1 FROM public.sessions WHERE id = p_session_id) INTO v_found;
    IF NOT v_found THEN
        RETURN jsonb_build_object('success', false, 'error', 'session_not_found');
    END IF;

    -- 対象セッションをtrueにし、他のセッションをfalseにする
    UPDATE public.sessions
    SET is_current_target = (id = p_session_id);

    RETURN jsonb_build_object('success', true, 'designatedSessionId', p_session_id);
END;
$$;

REVOKE ALL ON FUNCTION public.set_designated_session(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.set_designated_session(UUID) TO service_role;

COMMIT;
