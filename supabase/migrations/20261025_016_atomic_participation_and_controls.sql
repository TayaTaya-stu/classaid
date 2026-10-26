-- Reaction project only. Apply after 015; no old migrations are rewritten.
BEGIN;
ALTER TABLE public.session_attendances ADD COLUMN IF NOT EXISTS research_consented boolean NOT NULL DEFAULT false;
CREATE TABLE public.participant_entry_attempts (
 auth_user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
 window_started_at timestamptz NOT NULL DEFAULT clock_timestamp(), attempts integer NOT NULL DEFAULT 0
);
ALTER TABLE public.participant_entry_attempts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.participant_entry_attempts FROM PUBLIC,anon,authenticated;
GRANT ALL ON public.participant_entry_attempts TO service_role;

-- Separate committed RPC: failures/rollback of registration cannot erase the rate limit.
-- Limit is per verified requesting Auth user, never per victim name or recovery code.
CREATE FUNCTION public.consume_participant_entry_attempt(p_auth_user_id uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE a public.participant_entry_attempts%ROWTYPE;
BEGIN
 INSERT INTO public.participant_entry_attempts(auth_user_id) VALUES(p_auth_user_id) ON CONFLICT DO NOTHING;
 SELECT * INTO STRICT a FROM public.participant_entry_attempts WHERE auth_user_id=p_auth_user_id FOR UPDATE;
 IF a.window_started_at < clock_timestamp()-interval '15 minutes' THEN
  UPDATE public.participant_entry_attempts SET window_started_at=clock_timestamp(),attempts=1 WHERE auth_user_id=p_auth_user_id;
  RETURN true;
 END IF;
 IF a.attempts>=20 THEN RETURN false; END IF;
 UPDATE public.participant_entry_attempts SET attempts=attempts+1 WHERE auth_user_id=p_auth_user_id;
 RETURN true;
END; $$;

-- Auth identity is verified by the server before invoking this service-only function.
CREATE FUNCTION public.enter_reaction_session(
 p_auth_user_id uuid,p_entry_slug text,p_display_name text,p_name_key text,
 p_identity_hash text,p_new_recovery_hash text,p_recovery_hash text,p_consented boolean
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE s public.sessions%ROWTYPE; pid uuid; r public.rooms%ROWTYPE;
 n public.participant_display_name_registry%ROWTYPE; chosen text; new_participant boolean:=false;
 primary_ok boolean; reason text; arrival text; at_time timestamptz:=clock_timestamp();
BEGIN
 IF p_consented IS NULL OR length(p_display_name) NOT BETWEEN 2 AND 24 OR p_name_key IS NULL OR p_name_key='' THEN
  RAISE EXCEPTION 'invalid_input'; END IF;
 SELECT * INTO s FROM public.sessions WHERE entry_slug=p_entry_slug FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'session_not_found'; END IF;
 IF s.room_mode<>'shared' OR s.is_locked OR s.status NOT IN ('scheduled','in_progress') THEN RAISE EXCEPTION 'session_closed'; END IF;
 PERFORM pg_advisory_xact_lock(hashtext('participant_auth:'||p_auth_user_id::text));
 SELECT participant_id INTO pid FROM public.participant_auth_links WHERE auth_user_id=p_auth_user_id;
 IF pid IS NULL AND p_recovery_hash IS NOT NULL THEN
  SELECT participant_id INTO pid FROM public.participant_recovery_codes WHERE recovery_code_hash=p_recovery_hash;
  IF pid IS NULL THEN RAISE EXCEPTION 'invalid_recovery'; END IF;
 ELSIF pid IS NOT NULL AND p_recovery_hash IS NOT NULL THEN
  IF NOT EXISTS(SELECT 1 FROM public.participant_recovery_codes WHERE participant_id=pid AND recovery_code_hash=p_recovery_hash) THEN
   RAISE EXCEPTION 'already_linked'; END IF;
 END IF;
 IF pid IS NULL THEN
  IF EXISTS(SELECT 1 FROM public.participant_display_name_registry WHERE display_name_key=p_name_key) THEN
   RAISE EXCEPTION 'name_taken'; END IF;
  INSERT INTO public.participants(identity_hash,assigned_group,is_consented,consented_at,first_session_id)
  VALUES(p_identity_hash,'A',p_consented,CASE WHEN p_consented THEN at_time ELSE NULL END,s.id) RETURNING id INTO pid;
  INSERT INTO public.participant_display_name_registry(participant_id,display_name,display_name_key)
  VALUES(pid,p_display_name,p_name_key);
  INSERT INTO public.participant_recovery_codes(participant_id,recovery_code_hash,created_by_auth_user_id)
  VALUES(pid,p_new_recovery_hash,p_auth_user_id);
  new_participant:=true;
 ELSE
  PERFORM 1 FROM public.participants WHERE id=pid FOR UPDATE;
  SELECT * INTO n FROM public.participant_display_name_registry WHERE participant_id=pid;
  IF NOT FOUND THEN RAISE EXCEPTION 'legacy_participant_not_migrated'; END IF;
  -- Keep the originally registered name on every device and every class.
  IF n.display_name_key<>p_name_key THEN RAISE EXCEPTION 'use_registered_name'; END IF;
 END IF;
 SELECT * INTO STRICT n FROM public.participant_display_name_registry WHERE participant_id=pid;
 IF (SELECT count(*) FROM public.rooms WHERE session_id=s.id)<>1 THEN RAISE EXCEPTION 'invalid_room'; END IF;
 SELECT * INTO STRICT r FROM public.rooms WHERE session_id=s.id;
 INSERT INTO public.participant_auth_links(auth_user_id,participant_id,last_used_at) VALUES(p_auth_user_id,pid,at_time)
 ON CONFLICT(auth_user_id) DO UPDATE SET last_used_at=EXCLUDED.last_used_at;
 primary_ok:=p_consented AND s.class_started_at IS NULL AND NOT coalesce((s.protocol_snapshot->>'exclude_from_analysis')::boolean,false);
 reason:=CASE WHEN NOT p_consented THEN '研究利用への同意なし' WHEN s.class_started_at IS NOT NULL THEN '開始後入室（参考）'
 WHEN NOT primary_ok THEN '試運転' ELSE NULL END;
 arrival:=CASE WHEN s.class_started_at IS NULL THEN 'normal' ELSE 'delayed' END;
 INSERT INTO public.session_attendances(session_id,participant_id,room_id,display_name,joined_at,last_seen_at,
 attendance_status,is_primary_analysis,exclusion_reason,research_consented)
 VALUES(s.id,pid,r.id,n.display_name,at_time,at_time,arrival,primary_ok,reason,p_consented)
 ON CONFLICT(session_id,participant_id) DO UPDATE SET last_seen_at=EXCLUDED.last_seen_at,
 research_consented=EXCLUDED.research_consented,
 is_primary_analysis=public.session_attendances.is_primary_analysis AND EXCLUDED.research_consented,
 exclusion_reason=CASE WHEN NOT EXCLUDED.research_consented THEN '研究利用への同意なし' ELSE public.session_attendances.exclusion_reason END;
 -- Global summary is conservative; per-class consent is the source for analysis.
 UPDATE public.participants SET is_consented=p_consented,consented_at=CASE WHEN p_consented THEN coalesce(consented_at,at_time) ELSE NULL END WHERE id=pid;
 UPDATE public.participant_display_name_registry SET last_seen_at=at_time WHERE participant_id=pid;
 IF p_recovery_hash IS NOT NULL THEN UPDATE public.participant_recovery_codes SET last_used_at=at_time WHERE participant_id=pid; END IF;
 INSERT INTO public.event_logs(session_id,room_id,participant_id,event_type,metadata) VALUES(s.id,r.id,pid,'participant_entered',jsonb_build_object('research_consented',p_consented,'registration_new',new_participant));
 RETURN jsonb_build_object('participantId',pid,'roomId',r.id,'roomSlug',r.room_slug,'sessionId',s.id,
 'displayName',n.display_name,'isNew',new_participant,
 'canIssueCode',EXISTS(SELECT 1 FROM public.participant_recovery_codes WHERE participant_id=pid AND recovery_code_hash=p_new_recovery_hash));
END; $$;

CREATE FUNCTION public.control_reaction_session(p_session_id uuid,p_action text,p_mode text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE s public.sessions%ROWTYPE;
BEGIN
 SELECT * INTO STRICT s FROM public.sessions WHERE id=p_session_id FOR UPDATE;
 IF s.room_mode<>'shared' OR s.is_locked OR s.status NOT IN ('scheduled','in_progress') THEN RAISE EXCEPTION 'session_closed'; END IF;
 IF p_action='configure' THEN
  IF s.class_started_at IS NOT NULL OR s.intervention_started_at IS NOT NULL OR s.reaction_pipeline_enabled THEN RAISE EXCEPTION 'already_started'; END IF;
  IF p_mode IS NULL OR p_mode NOT IN ('off','empathy','lecture_bridge','neutral') THEN RAISE EXCEPTION 'invalid_mode'; END IF;
  UPDATE public.sessions SET reaction_ai_mode=p_mode,is_mock_ai=true,reaction_ai_status='active' WHERE id=s.id;
 ELSIF p_action='start' THEN
  IF s.class_started_at IS NOT NULL OR s.reaction_pipeline_enabled THEN RAISE EXCEPTION 'already_started'; END IF;
  UPDATE public.sessions SET class_started_at=clock_timestamp(),status='in_progress',reaction_pipeline_enabled=true,is_mock_ai=true WHERE id=s.id;
 ELSIF p_action='stop' THEN
  IF s.class_started_at IS NULL THEN RAISE EXCEPTION 'not_started'; END IF;
  UPDATE public.sessions SET reaction_ai_status='stopped',reaction_pipeline_enabled=true WHERE id=s.id;
 ELSE RAISE EXCEPTION 'invalid_action'; END IF;
 INSERT INTO public.event_logs(session_id,event_type,metadata)
 VALUES(s.id,'reaction_'||p_action,jsonb_build_object('mode',coalesce(p_mode,s.reaction_ai_mode),'prototype',true));
 SELECT * INTO STRICT s FROM public.sessions WHERE id=s.id;
 RETURN jsonb_build_object('success',true,'mode',s.reaction_ai_mode,'status',s.reaction_ai_status,
 'isMockAi',s.is_mock_ai,'pipelineEnabled',s.reaction_pipeline_enabled,'classStartedAt',s.class_started_at);
END; $$;
-- Prevent direct writers from changing the experimental condition once posting begins.
CREATE FUNCTION public.guard_reaction_condition() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
 IF OLD.reaction_pipeline_enabled OR OLD.class_started_at IS NOT NULL THEN
  IF NEW.reaction_ai_mode IS DISTINCT FROM OLD.reaction_ai_mode OR NEW.is_mock_ai IS DISTINCT FROM OLD.is_mock_ai
   OR NEW.class_started_at IS DISTINCT FROM OLD.class_started_at OR NOT NEW.reaction_pipeline_enabled
   OR (OLD.reaction_ai_status='stopped' AND NEW.reaction_ai_status<>'stopped') THEN RAISE EXCEPTION 'condition_locked'; END IF;
 END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER guard_reaction_condition BEFORE UPDATE ON public.sessions FOR EACH ROW EXECUTE FUNCTION public.guard_reaction_condition();
REVOKE ALL ON FUNCTION public.consume_participant_entry_attempt(uuid), public.enter_reaction_session(uuid,text,text,text,text,text,text,boolean),
 public.control_reaction_session(uuid,text,text),public.guard_reaction_condition() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.consume_participant_entry_attempt(uuid),public.enter_reaction_session(uuid,text,text,text,text,text,text,boolean),public.control_reaction_session(uuid,text,text) TO service_role;
COMMIT;
