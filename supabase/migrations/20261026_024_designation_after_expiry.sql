-- 024: Allow designation-only changes without reopening expired classes.
BEGIN;
CREATE OR REPLACE FUNCTION public.guard_reaction_condition() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
    -- Permit a designation-only change; all other fields must remain identical.
    IF NEW.is_current_target IS DISTINCT FROM OLD.is_current_target
       AND (to_jsonb(NEW) - 'is_current_target') = (to_jsonb(OLD) - 'is_current_target') THEN
        RETURN NEW;
    END IF;
    IF OLD.reaction_pipeline_enabled OR OLD.class_started_at IS NOT NULL THEN
        -- 実験条件（mode, is_mock_ai, class_started_at）は変更禁止
        IF NEW.reaction_ai_mode IS DISTINCT FROM OLD.reaction_ai_mode
           OR NEW.is_mock_ai IS DISTINCT FROM OLD.is_mock_ai
           OR NEW.class_started_at IS DISTINCT FROM OLD.class_started_at
           OR NOT NEW.reaction_pipeline_enabled THEN
            RAISE EXCEPTION 'condition_locked';
        END IF;

        -- 120分自動終了済み、または期限後の再開は禁止
        IF (OLD.auto_expired_at IS NOT NULL OR (OLD.class_started_at IS NOT NULL AND clock_timestamp() >= OLD.class_started_at + interval '120 minutes')) THEN
            IF NEW.reaction_ai_status = 'active' OR NEW.projection_status = 'active' THEN
                RAISE EXCEPTION 'session_expired';
            END IF;
        END IF;

        -- 既に手動終了した授業の再開も禁止
        IF (OLD.status IN ('completed', 'closed') AND NEW.status NOT IN ('completed', 'closed')) THEN
            RAISE EXCEPTION 'session_closed';
        END IF;
        IF (OLD.status IN ('completed', 'closed') AND (NEW.reaction_ai_status = 'active' OR NEW.projection_status = 'active')) THEN
            RAISE EXCEPTION 'session_closed';
        END IF;
    END IF;
    RETURN NEW;
END; $$;


COMMIT;
