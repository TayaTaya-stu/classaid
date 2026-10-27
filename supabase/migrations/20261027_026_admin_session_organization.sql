-- 026: Administrator-only organization. No existing sessions are archived or deleted by this migration.
BEGIN;
ALTER TABLE public.sessions ADD COLUMN is_archived boolean NOT NULL DEFAULT false,
ADD COLUMN admin_deleted_at timestamptz;

CREATE OR REPLACE FUNCTION public.guard_reaction_condition() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
    IF (NEW.is_archived IS DISTINCT FROM OLD.is_archived OR NEW.admin_deleted_at IS DISTINCT FROM OLD.admin_deleted_at)
       AND (to_jsonb(NEW) - 'is_archived' - 'admin_deleted_at') = (to_jsonb(OLD) - 'is_archived' - 'admin_deleted_at') THEN
        RETURN NEW;
    END IF;
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

-- A hidden class must never become the designated/running class through another code path.
CREATE FUNCTION public.guard_archived_session() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
  IF (NEW.is_archived OR NEW.admin_deleted_at IS NOT NULL) AND (NEW.is_current_target OR NEW.status = 'in_progress') THEN
    RAISE EXCEPTION 'archived_session_unavailable';
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER guard_archived_session BEFORE INSERT OR UPDATE ON public.sessions
FOR EACH ROW EXECUTE FUNCTION public.guard_archived_session();

-- Preserve immutable creation audit logs. Delete-unused means removal from all user lists, not SQL DELETE.
-- Lock session and room parents while checking all FK children; only the creation event is structural.
CREATE FUNCTION public.organize_admin_session(p_session_id uuid, p_action text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE
  s public.sessions%ROWTYPE;
  link record;
  room_ids uuid[];
  found_record boolean;
BEGIN
  IF p_action IS NULL OR p_action NOT IN ('archive','restore','delete_unused') THEN
    RETURN jsonb_build_object('success',false,'error','invalid_action');
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('designated_reaction_session'));
  SELECT * INTO s FROM public.sessions WHERE id=p_session_id FOR UPDATE;
  IF NOT FOUND OR s.id='00000000-0000-0000-0000-000000000001' OR s.room_mode<>'shared' OR s.admin_deleted_at IS NOT NULL THEN
    RETURN jsonb_build_object('success',false,'error','session_not_found');
  END IF;
  IF s.is_current_target OR s.status='in_progress' THEN
    RETURN jsonb_build_object('success',false,'error','session_in_use');
  END IF;
  IF p_action='restore' THEN
    UPDATE public.sessions SET is_archived=false WHERE id=s.id;
    RETURN jsonb_build_object('success',true,'action',p_action);
  END IF;
  IF p_action='archive' THEN
    UPDATE public.sessions SET is_archived=true WHERE id=s.id;
    RETURN jsonb_build_object('success',true,'action',p_action);
  END IF;
  IF s.class_started_at IS NOT NULL OR s.demo_projected_at IS NOT NULL
     OR s.reaction_pipeline_enabled OR s.status<>'scheduled' OR s.is_locked
     OR s.pdf_file_url IS NOT NULL THEN
    RETURN jsonb_build_object('success',false,'error','session_has_records');
  END IF;
  PERFORM id FROM public.rooms WHERE session_id=s.id ORDER BY id FOR UPDATE;
  SELECT coalesce(array_agg(id),ARRAY[]::uuid[]) INTO room_ids FROM public.rooms WHERE session_id=s.id;
  FOR link IN
    SELECT c.confrelid,c.conrelid::regclass AS child_table,a.attname AS child_column,
           array_length(c.conkey,1) AS key_count,pa.attname AS parent_column
    FROM pg_constraint c
    JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=c.conkey[1]
    JOIN pg_attribute pa ON pa.attrelid=c.confrelid AND pa.attnum=c.confkey[1]
    WHERE c.contype='f' AND c.confrelid IN ('public.sessions'::regclass,'public.rooms'::regclass)
      AND NOT (c.conrelid='public.rooms'::regclass AND c.confrelid='public.sessions'::regclass)
  LOOP
    -- Fail closed for a future FK shape we do not understand; never cascade unknown records.
    IF link.key_count<>1 OR link.parent_column<>'id' THEN
      RETURN jsonb_build_object('success',false,'error','session_has_records');
    END IF;
    IF link.child_table='public.event_logs'::regclass THEN
      SELECT EXISTS(SELECT 1 FROM public.event_logs WHERE (session_id=s.id OR room_id=ANY(room_ids))
        AND NOT (event_type='shared_session_created' AND room_id IS NULL AND participant_id IS NULL)) INTO found_record;
    ELSIF link.confrelid='public.sessions'::regclass THEN
      EXECUTE format('SELECT EXISTS(SELECT 1 FROM %s WHERE %I=$1)',link.child_table,link.child_column)
        INTO found_record USING s.id;
    ELSE
      EXECUTE format('SELECT EXISTS(SELECT 1 FROM %s WHERE %I=ANY($1))',link.child_table,link.child_column)
        INTO found_record USING room_ids;
    END IF;
    IF found_record THEN
      RETURN jsonb_build_object('success',false,'error','session_has_records');
    END IF;
  END LOOP;
  UPDATE public.sessions SET admin_deleted_at=clock_timestamp() WHERE id=s.id;
  RETURN jsonb_build_object('success',true,'action',p_action);
END; $$;
REVOKE ALL ON FUNCTION public.organize_admin_session(uuid,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.organize_admin_session(uuid,text) TO service_role;
COMMIT;
