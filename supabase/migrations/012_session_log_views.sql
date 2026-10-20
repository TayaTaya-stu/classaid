-- Fresh Shared Wall finalization.
-- Removes only the empty legacy placeholder created by migration 001 and
-- makes one read-only log view per newly created class session.
BEGIN;

DELETE FROM public.rooms
WHERE id = '00000000-0000-0000-0000-000000000002'::uuid
  AND session_id = '00000000-0000-0000-0000-000000000001'::uuid
  AND NOT EXISTS (
      SELECT 1 FROM public.posts
      WHERE room_id = '00000000-0000-0000-0000-000000000002'::uuid
  );

DELETE FROM public.sessions
WHERE id = '00000000-0000-0000-0000-000000000001'::uuid
  AND NOT EXISTS (
      SELECT 1 FROM public.rooms
      WHERE session_id = '00000000-0000-0000-0000-000000000001'::uuid
  );

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
    v_view_name TEXT;
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

    v_view_name := format(
        'class_%s_%s_posts',
        lpad(p_session_number::text, 3, '0'),
        substr(replace(v_session_id::text, '-', ''), 1, 8)
    );

    EXECUTE format(
        'CREATE VIEW public.%I WITH (security_invoker = true) AS
         SELECT id, created_at, author_display_name, message, author_type,
                participant_id, room_id, likes, audience_type, is_deleted
         FROM public.posts
         WHERE session_id = %L::uuid',
        v_view_name,
        v_session_id::text
    );

    EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC, anon, authenticated', v_view_name);
    EXECUTE format('GRANT SELECT ON public.%I TO service_role', v_view_name);

    RETURN v_session_id;
END;
$$;

REVOKE ALL ON FUNCTION public.create_shared_session(INTEGER, TIMESTAMPTZ, BOOLEAN)
FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_shared_session(INTEGER, TIMESTAMPTZ, BOOLEAN)
TO service_role;

COMMIT;
