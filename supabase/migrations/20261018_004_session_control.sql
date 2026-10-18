-- ==============================================================================
-- ClassAid 研究用データベース改修 マイグレーション (フェーズ4-2)
-- 目的: 授業資料PDFと20分×3サイクル・6介入枠の管理基盤
-- ==============================================================================

BEGIN;

ALTER TABLE public.ai_interventions
ADD COLUMN IF NOT EXISTS planned_message_type TEXT NULL
CHECK (planned_message_type IN ('reaction', 'positive', 'uncertainty', 'standard'));

COMMENT ON COLUMN public.ai_interventions.planned_message_type IS
'予定するAI発言種別。ダメっこ条件はreaction/positive/uncertainty、標準条件はstandard';

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('lecture-materials', 'lecture-materials', FALSE, 26214400, ARRAY['application/pdf'])
ON CONFLICT (id) DO UPDATE SET
    public = FALSE,
    file_size_limit = 26214400,
    allowed_mime_types = ARRAY['application/pdf'];

CREATE OR REPLACE FUNCTION public.start_session_protocol(p_session_id UUID)
RETURNS TIMESTAMPTZ
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_session public.sessions%ROWTYPE;
    v_cycle_id UUID;
    v_cycle_number INTEGER;
    v_room RECORD;
    v_slot_index INTEGER;
    v_slot_minute INTEGER;
    v_started_at TIMESTAMPTZ := clock_timestamp();
    v_cycle_start TIMESTAMPTZ;
    v_message_type TEXT;
BEGIN
    IF p_session_id IS NULL THEN
        RAISE EXCEPTION 'session id is required';
    END IF;

    PERFORM pg_advisory_xact_lock(hashtext('start_session_protocol:' || p_session_id::text));

    SELECT * INTO v_session
    FROM public.sessions
    WHERE id = p_session_id
    FOR UPDATE;

    IF NOT FOUND THEN RAISE EXCEPTION 'session not found'; END IF;
    IF v_session.is_locked OR v_session.status IN ('completed', 'locked') THEN
        RAISE EXCEPTION 'session is locked';
    END IF;
    IF v_session.intervention_started_at IS NOT NULL OR EXISTS (
        SELECT 1 FROM public.session_cycles WHERE session_id = p_session_id
    ) THEN
        RAISE EXCEPTION 'protocol already started';
    END IF;
    IF jsonb_array_length(v_session.slot_minutes) <> 6 THEN
        RAISE EXCEPTION 'slot_minutes must contain exactly 6 values';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.rooms WHERE session_id = p_session_id) THEN
        RAISE EXCEPTION 'session rooms not found';
    END IF;

    UPDATE public.sessions
    SET intervention_started_at = v_started_at,
        class_started_at = COALESCE(class_started_at, v_started_at),
        status = 'in_progress'
    WHERE id = p_session_id;

    FOR v_cycle_number IN 1..v_session.cycle_count LOOP
        v_cycle_start := v_started_at + make_interval(mins => (v_cycle_number - 1) * v_session.cycle_duration_minutes);
        INSERT INTO public.session_cycles (session_id, cycle_number, status, started_at)
        VALUES (p_session_id, v_cycle_number, CASE WHEN v_cycle_number = 1 THEN 'running' ELSE 'ready' END,
                CASE WHEN v_cycle_number = 1 THEN v_started_at ELSE NULL END)
        RETURNING id INTO v_cycle_id;

        FOR v_room IN
            SELECT id, ai_condition FROM public.rooms
            WHERE session_id = p_session_id AND ai_condition <> 'none'
            ORDER BY group_label
        LOOP
            FOR v_slot_index IN 1..6 LOOP
                v_slot_minute := (v_session.slot_minutes ->> (v_slot_index - 1))::INTEGER;
                v_message_type := CASE
                    WHEN v_room.ai_condition = 'standard' THEN 'standard'
                    WHEN v_slot_index IN (1, 2, 4) THEN 'reaction'
                    WHEN v_slot_index = 3 THEN 'positive'
                    ELSE 'uncertainty'
                END;

                INSERT INTO public.ai_interventions (
                    cycle_id, room_id, slot_index, scheduled_at, status, planned_message_type
                ) VALUES (
                    v_cycle_id, v_room.id, v_slot_index,
                    v_cycle_start + make_interval(mins => v_slot_minute),
                    'pending', v_message_type
                );
            END LOOP;
        END LOOP;
    END LOOP;

    INSERT INTO public.event_logs (session_id, event_type, metadata)
    VALUES (p_session_id, 'session_protocol_started', jsonb_build_object(
        'cycle_count', v_session.cycle_count,
        'cycle_duration_minutes', v_session.cycle_duration_minutes,
        'slot_minutes', v_session.slot_minutes
    ));

    RETURN v_started_at;
END;
$$;

REVOKE ALL ON FUNCTION public.start_session_protocol(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.start_session_protocol(UUID) TO service_role;

COMMIT;
