-- ==============================================================================
-- ClassAid / shared-wall: 差し替え可能なAI介入プロトコル
-- 目的:
--   * 既存のダメっこAIを保持したまま、標準AI・規範拡張型AI等を切替可能にする
--   * 1サイクル6 / 8 / 10投稿に対応する
--   * 授業開始時のカテゴリー順序をprotocol_snapshotに固定する
-- 既存投稿・既存生成ログは削除しない。
-- ==============================================================================

BEGIN;

-- 従来の4種類限定CHECKを、将来カテゴリーを追加できる安全な識別子CHECKへ置換する。
ALTER TABLE public.ai_interventions
    DROP CONSTRAINT IF EXISTS ai_interventions_planned_message_type_check;

ALTER TABLE public.ai_interventions
    ADD CONSTRAINT ai_interventions_planned_message_type_check
    CHECK (
        planned_message_type IS NULL OR
        planned_message_type ~ '^[a-z][a-z0-9_]{0,63}$'
    );

-- damekko_modeは過去データとの互換性のため残す。新しい分類はmessage_categoryへ保存する。
ALTER TABLE public.ai_generation_attempts
    ADD COLUMN IF NOT EXISTS protocol_id TEXT NULL,
    ADD COLUMN IF NOT EXISTS message_category TEXT NULL,
    ADD COLUMN IF NOT EXISTS actor_id TEXT NULL;

ALTER TABLE public.ai_interventions
    ADD COLUMN IF NOT EXISTS planned_actor_id TEXT NULL,
    ADD COLUMN IF NOT EXISTS planned_actor_display_name TEXT NULL;

ALTER TABLE public.ai_generation_attempts
    DROP CONSTRAINT IF EXISTS ai_generation_attempts_protocol_id_check;
ALTER TABLE public.ai_generation_attempts
    ADD CONSTRAINT ai_generation_attempts_protocol_id_check
    CHECK (protocol_id IS NULL OR length(protocol_id) BETWEEN 1 AND 100);

ALTER TABLE public.ai_generation_attempts
    DROP CONSTRAINT IF EXISTS ai_generation_attempts_message_category_check;
ALTER TABLE public.ai_generation_attempts
    ADD CONSTRAINT ai_generation_attempts_message_category_check
    CHECK (
        message_category IS NULL OR
        message_category ~ '^[a-z][a-z0-9_]{0,63}$'
    );

COMMENT ON COLUMN public.ai_generation_attempts.protocol_id IS
'候補生成時に固定されていたAIプロトコル識別子';
COMMENT ON COLUMN public.ai_generation_attempts.message_category IS
'候補生成時の発言カテゴリー。旧damekko_modeより一般化した正本';
COMMENT ON COLUMN public.ai_generation_attempts.actor_id IS
'候補生成を担当したAI参加者のプロトコル内識別子';
COMMENT ON COLUMN public.ai_interventions.planned_actor_id IS
'当該投稿枠を担当するAI参加者のプロトコル内識別子';
COMMENT ON COLUMN public.ai_interventions.planned_actor_display_name IS
'投稿時に固定して使用するAI参加者の表示名';

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
    v_slot_count INTEGER;
    v_slot_minute INTEGER;
    v_previous_minute INTEGER := -1;
    v_started_at TIMESTAMPTZ := clock_timestamp();
    v_cycle_start TIMESTAMPTZ;
    v_message_type TEXT;
    v_cycle_sequence JSONB;
    v_actor_sequence JSONB;
    v_actor JSONB;
    v_protocol_id TEXT;
    v_actor_id TEXT;
    v_actor_display_name TEXT;
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
        SELECT 1
        FROM public.ai_interventions ai
        JOIN public.session_cycles sc ON sc.id = ai.cycle_id
        WHERE sc.session_id = p_session_id
    ) THEN
        RAISE EXCEPTION 'protocol already started';
    END IF;
    IF jsonb_typeof(v_session.slot_minutes) <> 'array' THEN
        RAISE EXCEPTION 'slot_minutes must be an array';
    END IF;
    v_slot_count := jsonb_array_length(v_session.slot_minutes);
    IF v_slot_count < 1 OR v_slot_count > 10 THEN
        RAISE EXCEPTION 'slot_minutes must contain between 1 and 10 values';
    END IF;
    FOR v_slot_index IN 1..v_slot_count LOOP
        BEGIN
            v_slot_minute := (v_session.slot_minutes ->> (v_slot_index - 1))::INTEGER;
        EXCEPTION WHEN invalid_text_representation THEN
            RAISE EXCEPTION 'slot_minutes must contain integers';
        END;
        IF v_slot_minute <= v_previous_minute OR v_slot_minute < 0 OR v_slot_minute >= v_session.cycle_duration_minutes THEN
            RAISE EXCEPTION 'slot_minutes must be increasing and inside the cycle';
        END IF;
        v_previous_minute := v_slot_minute;
    END LOOP;
    IF NOT EXISTS (SELECT 1 FROM public.rooms WHERE session_id = p_session_id) THEN
        RAISE EXCEPTION 'session rooms not found';
    END IF;

    v_protocol_id := COALESCE(NULLIF(v_session.protocol_snapshot ->> 'protocol_id', ''), 'legacy');

    -- 設定済みプロトコルでは全サイクル・全枠のカテゴリーが必要。
    IF v_protocol_id <> 'legacy' THEN
        IF jsonb_typeof(v_session.protocol_snapshot -> 'actors') <> 'array'
           OR jsonb_array_length(v_session.protocol_snapshot -> 'actors') < 1 THEN
            RAISE EXCEPTION 'protocol actors are missing';
        END IF;
        IF jsonb_typeof(v_session.protocol_snapshot -> 'cycle_sequences') <> 'array'
           OR jsonb_array_length(v_session.protocol_snapshot -> 'cycle_sequences') <> v_session.cycle_count THEN
            RAISE EXCEPTION 'protocol cycle_sequences do not match cycle_count';
        END IF;
        FOR v_cycle_number IN 1..v_session.cycle_count LOOP
            v_cycle_sequence := v_session.protocol_snapshot -> 'cycle_sequences' -> (v_cycle_number - 1);
            IF jsonb_typeof(v_cycle_sequence) <> 'array' OR jsonb_array_length(v_cycle_sequence) <> v_slot_count THEN
                RAISE EXCEPTION 'protocol sequence does not match slot count';
            END IF;
            v_actor_sequence := v_session.protocol_snapshot -> 'actor_sequences' -> (v_cycle_number - 1);
            IF jsonb_typeof(v_actor_sequence) <> 'array' OR jsonb_array_length(v_actor_sequence) <> v_slot_count THEN
                RAISE EXCEPTION 'protocol actor sequence does not match slot count';
            END IF;
        END LOOP;
    END IF;

    UPDATE public.sessions
    SET intervention_started_at = v_started_at,
        class_started_at = COALESCE(class_started_at, v_started_at),
        status = 'in_progress'
    WHERE id = p_session_id;

    FOR v_cycle_number IN 1..v_session.cycle_count LOOP
        v_cycle_start := v_started_at + make_interval(mins => (v_cycle_number - 1) * v_session.cycle_duration_minutes);
        INSERT INTO public.session_cycles (session_id, cycle_number, status, started_at, paused_at, total_paused_seconds, ended_at)
        VALUES (p_session_id, v_cycle_number, CASE WHEN v_cycle_number = 1 THEN 'running' ELSE 'ready' END,
                CASE WHEN v_cycle_number = 1 THEN v_started_at ELSE NULL END, NULL, 0, NULL)
        ON CONFLICT (session_id, cycle_number) DO UPDATE SET
            status = EXCLUDED.status,
            started_at = EXCLUDED.started_at,
            paused_at = NULL,
            total_paused_seconds = 0,
            ended_at = NULL
        RETURNING id INTO v_cycle_id;

        v_cycle_sequence := v_session.protocol_snapshot -> 'cycle_sequences' -> (v_cycle_number - 1);
        v_actor_sequence := v_session.protocol_snapshot -> 'actor_sequences' -> (v_cycle_number - 1);
        FOR v_room IN
            SELECT id, ai_condition FROM public.rooms
            WHERE session_id = p_session_id AND ai_condition <> 'none'
            ORDER BY group_label
        LOOP
            FOR v_slot_index IN 1..v_slot_count LOOP
                v_slot_minute := (v_session.slot_minutes ->> (v_slot_index - 1))::INTEGER;
                IF v_protocol_id <> 'legacy' THEN
                    v_message_type := v_cycle_sequence ->> (v_slot_index - 1);
                    v_actor_id := v_actor_sequence ->> (v_slot_index - 1);
                    v_actor := NULL;
                    SELECT value INTO v_actor
                    FROM jsonb_array_elements(v_session.protocol_snapshot -> 'actors') AS actors(value)
                    WHERE value ->> 'id' = v_actor_id
                    LIMIT 1;
                    IF v_actor IS NULL THEN RAISE EXCEPTION 'protocol actor not found'; END IF;
                    v_actor_display_name := v_actor ->> 'displayName';
                    IF v_actor_display_name IS NULL OR length(trim(v_actor_display_name)) < 1 OR length(v_actor_display_name) > 50 THEN
                        RAISE EXCEPTION 'invalid protocol actor display name';
                    END IF;
                ELSE
                    v_message_type := CASE
                        WHEN v_room.ai_condition = 'standard' THEN 'standard'
                        WHEN v_slot_index IN (1, 2, 4) THEN 'reaction'
                        WHEN v_slot_index = 3 THEN 'positive'
                        ELSE 'uncertainty'
                    END;
                    v_actor_id := 'student_ai';
                    v_actor_display_name := '学生AI';
                END IF;
                IF v_message_type IS NULL OR v_message_type !~ '^[a-z][a-z0-9_]{0,63}$' THEN
                    RAISE EXCEPTION 'invalid message category';
                END IF;

                INSERT INTO public.ai_interventions (
                    cycle_id, room_id, slot_index, scheduled_at, status, planned_message_type,
                    planned_actor_id, planned_actor_display_name
                ) VALUES (
                    v_cycle_id, v_room.id, v_slot_index,
                    v_cycle_start + make_interval(mins => v_slot_minute),
                    'pending', v_message_type, v_actor_id, v_actor_display_name
                );
            END LOOP;
        END LOOP;
    END LOOP;

    INSERT INTO public.event_logs (session_id, event_type, metadata)
    VALUES (p_session_id, 'session_protocol_started', jsonb_build_object(
        'cycle_count', v_session.cycle_count,
        'cycle_duration_minutes', v_session.cycle_duration_minutes,
        'slot_minutes', v_session.slot_minutes,
        'protocol_snapshot', v_session.protocol_snapshot
    ));

    RETURN v_started_at;
END;
$$;

REVOKE ALL ON FUNCTION public.start_session_protocol(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.start_session_protocol(UUID) TO service_role;

-- AI表示名も投稿枠のスナップショットから確定する。
CREATE OR REPLACE FUNCTION public.approve_ai_intervention(
    p_intervention_id UUID,
    p_attempt_id UUID,
    p_final_message TEXT,
    p_original_message TEXT
)
RETURNS BIGINT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_intervention RECORD;
    v_post_id BIGINT;
    v_display_name TEXT;
BEGIN
    IF p_final_message IS NULL OR char_length(trim(p_final_message)) < 1 OR char_length(trim(p_final_message)) > 100 THEN
        RAISE EXCEPTION 'invalid final message';
    END IF;

    SELECT ai.id, ai.room_id, ai.status, ai.planned_actor_display_name, sc.session_id
    INTO v_intervention
    FROM public.ai_interventions ai
    JOIN public.session_cycles sc ON sc.id = ai.cycle_id
    JOIN public.sessions s ON s.id = sc.session_id
    WHERE ai.id = p_intervention_id AND NOT s.is_locked AND s.status NOT IN ('completed', 'locked')
    FOR UPDATE OF ai;

    IF NOT FOUND THEN RAISE EXCEPTION 'intervention unavailable'; END IF;
    IF v_intervention.status = 'posted' THEN RAISE EXCEPTION 'intervention already posted'; END IF;
    IF NOT EXISTS (
        SELECT 1 FROM public.ai_generation_attempts
        WHERE id = p_attempt_id AND intervention_id = p_intervention_id
    ) THEN RAISE EXCEPTION 'generation attempt mismatch'; END IF;

    v_display_name := COALESCE(NULLIF(trim(v_intervention.planned_actor_display_name), ''), '学生AI');
    INSERT INTO public.posts (
        session_id, room_id, author_type, participant_id, parent_id,
        reply_target_type, author_display_name, name, message, is_ai,
        is_deleted, audience_type, likes
    ) VALUES (
        v_intervention.session_id, v_intervention.room_id, 'ai', NULL, NULL,
        'none', v_display_name, v_display_name, trim(p_final_message), TRUE,
        FALSE, 'room', 0
    ) RETURNING id INTO v_post_id;

    UPDATE public.ai_interventions
    SET status = 'posted',
        selected_attempt_id = p_attempt_id,
        is_modified = trim(p_final_message) IS DISTINCT FROM trim(COALESCE(p_original_message, '')),
        modification_reason = CASE
            WHEN trim(p_final_message) IS DISTINCT FROM trim(COALESCE(p_original_message, '')) THEN 'manual_edit'
            ELSE NULL
        END,
        final_posted_message = trim(p_final_message),
        post_id = v_post_id,
        reviewed_at = clock_timestamp(),
        posted_at = clock_timestamp()
    WHERE id = p_intervention_id;

    RETURN v_post_id;
END;
$$;

REVOKE ALL ON FUNCTION public.approve_ai_intervention(UUID, UUID, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.approve_ai_intervention(UUID, UUID, TEXT, TEXT) TO service_role;

COMMIT;
