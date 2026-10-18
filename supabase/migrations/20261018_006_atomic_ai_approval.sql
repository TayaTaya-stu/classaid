-- ==============================================================================
-- ClassAid 研究用データベース改修 マイグレーション (フェーズ5)
-- 目的: AI候補の承認と投稿を単一トランザクションで確定する
-- ==============================================================================

BEGIN;

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
BEGIN
    IF p_final_message IS NULL OR char_length(trim(p_final_message)) < 1 OR char_length(trim(p_final_message)) > 100 THEN
        RAISE EXCEPTION 'invalid final message';
    END IF;

    SELECT ai.id, ai.room_id, ai.status, sc.session_id
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

    INSERT INTO public.posts (
        session_id, room_id, author_type, participant_id, parent_id,
        reply_target_type, author_display_name, name, message, is_ai,
        is_deleted, audience_type, likes
    ) VALUES (
        v_intervention.session_id, v_intervention.room_id, 'ai', NULL, NULL,
        'none', '学生AI', '学生AI', trim(p_final_message), TRUE,
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
