-- 管理画面から共有授業回・ルーム・QR用URLを原子的に作成する。
-- 既存データの変更・削除は行わない。
BEGIN;

CREATE OR REPLACE FUNCTION public.create_shared_session(
    p_session_number INTEGER,
    p_scheduled_at TIMESTAMPTZ,
    p_is_development BOOLEAN DEFAULT FALSE
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_session_id UUID := gen_random_uuid();
    v_entry_token TEXT := replace(gen_random_uuid()::text, '-', '');
    v_screen_token TEXT := replace(gen_random_uuid()::text, '-', '');
    v_room_token TEXT := replace(gen_random_uuid()::text, '-', '');
BEGIN
    IF p_session_number IS NULL OR p_session_number < 0 OR p_session_number > 999 THEN
        RAISE EXCEPTION 'invalid session number';
    END IF;
    IF p_scheduled_at IS NULL THEN
        RAISE EXCEPTION 'scheduled time is required';
    END IF;
    IF p_is_development IS NULL THEN
        RAISE EXCEPTION 'development flag is required';
    END IF;

    INSERT INTO public.sessions (
        id, session_number, wave_number, research_stage, scheduled_at,
        entry_slug, screen_slug, room_mode, status, is_locked,
        protocol_snapshot, cycle_count, cycle_duration_minutes, slot_minutes
    ) VALUES (
        v_session_id,
        p_session_number,
        0,
        'baseline',
        p_scheduled_at,
        'shared-' || v_entry_token,
        'screen-' || v_screen_token,
        'shared',
        'scheduled',
        FALSE,
        jsonb_build_object(
            'exclude_from_analysis', p_is_development,
            'purpose', CASE WHEN p_is_development THEN 'shared_wall_pilot' ELSE 'shared_wall_class' END
        ),
        3,
        20,
        '[3, 6, 9, 12, 15, 18]'::jsonb
    );

    INSERT INTO public.rooms (session_id, group_label, room_slug, ai_condition)
    VALUES (v_session_id, 'A', 'shared-room-' || v_room_token, 'damekko');

    INSERT INTO public.event_logs (session_id, event_type, metadata)
    VALUES (
        v_session_id,
        'shared_session_created',
        jsonb_build_object(
            'session_number', p_session_number,
            'scheduled_at', p_scheduled_at,
            'is_development', p_is_development
        )
    );

    RETURN v_session_id;
END;
$$;

REVOKE ALL ON FUNCTION public.create_shared_session(INTEGER, TIMESTAMPTZ, BOOLEAN)
FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_shared_session(INTEGER, TIMESTAMPTZ, BOOLEAN)
TO service_role;

COMMIT;
