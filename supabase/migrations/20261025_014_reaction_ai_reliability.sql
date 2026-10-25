-- New reaction DB only. Run after migration 013. Never run on an old project's DB.
BEGIN;
ALTER TABLE public.sessions ADD COLUMN IF NOT EXISTS reaction_pipeline_enabled boolean NOT NULL DEFAULT false;
ALTER TABLE public.ai_reply_jobs ADD COLUMN IF NOT EXISTS lease_token uuid;
ALTER TABLE public.ai_reply_jobs ADD COLUMN IF NOT EXISTS client_sent_at timestamptz;

-- A trigger makes human-post persistence and job creation one transaction.
CREATE OR REPLACE FUNCTION public.enqueue_reaction_post() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 IF NEW.author_type='human' AND NOT NEW.is_deleted THEN
  INSERT INTO public.ai_reply_jobs(session_id,room_id,human_post_id,mode)
  SELECT NEW.session_id,NEW.room_id,NEW.id,s.reaction_ai_mode FROM public.sessions s
  JOIN public.rooms r ON r.id=NEW.room_id AND r.session_id=s.id
  WHERE s.id=NEW.session_id AND s.reaction_pipeline_enabled
  ON CONFLICT(human_post_id) DO NOTHING;
 END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER enqueue_reaction_post AFTER INSERT ON public.posts
 FOR EACH ROW EXECUTE FUNCTION public.enqueue_reaction_post();

CREATE OR REPLACE FUNCTION public.claim_reaction_jobs(p_limit integer DEFAULT 10,p_job_id uuid DEFAULT NULL)
RETURNS SETOF public.ai_reply_jobs LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 UPDATE public.ai_reply_jobs SET status='failed',last_error='lease_expired_attempts_exhausted',lease_token=NULL,locked_until=NULL
 WHERE status='processing' AND locked_until<clock_timestamp() AND attempts>=max_attempts;
 RETURN QUERY WITH candidates AS (
 SELECT j.id FROM public.ai_reply_jobs j
 WHERE (p_job_id IS NULL OR j.id=p_job_id) AND j.attempts<j.max_attempts
 AND (j.status='pending' OR (j.status='processing' AND j.locked_until<clock_timestamp()))
 ORDER BY j.created_at,j.id FOR UPDATE SKIP LOCKED LIMIT greatest(1,least(p_limit,20))
 ) UPDATE public.ai_reply_jobs j SET status='processing',attempts=j.attempts+1,
 lease_token=gen_random_uuid(),locked_until=clock_timestamp()+interval '60 seconds',updated_at=clock_timestamp()
 FROM candidates c WHERE j.id=c.id RETURNING j.*;
END; $$;

CREATE OR REPLACE FUNCTION public.finish_reaction_job(p_job_id uuid,p_lease uuid,p_text text,p_source text,
 p_fallback_id text,p_duration integer,p_context jsonb,p_client_sent_at timestamptz DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE j public.ai_reply_jobs%ROWTYPE; h public.posts%ROWTYPE; s public.sessions%ROWTYPE;
 aid bigint; eid bigint; et text; source text;
BEGIN
 SELECT * INTO STRICT j FROM public.ai_reply_jobs WHERE id=p_job_id FOR UPDATE;
 IF j.status='completed' THEN
  SELECT id,ai_post_id INTO eid,aid FROM public.projection_events WHERE human_post_id=j.human_post_id;
  IF eid IS NULL THEN RAISE EXCEPTION 'completed_job_missing_event'; END IF;
  RETURN jsonb_build_object('event_id',eid,'ai_post_id',aid);
 END IF;
 IF j.status<>'processing' OR j.lease_token IS DISTINCT FROM p_lease OR j.locked_until<clock_timestamp() THEN
  RAISE EXCEPTION 'invalid_or_expired_lease';
 END IF;
 SELECT * INTO STRICT h FROM public.posts WHERE id=j.human_post_id;
 SELECT * INTO STRICT s FROM public.sessions WHERE id=j.session_id FOR SHARE;
 IF h.session_id<>j.session_id OR h.room_id<>j.room_id OR h.author_type<>'human' OR h.is_deleted
 OR NOT EXISTS(SELECT 1 FROM public.rooms WHERE id=j.room_id AND session_id=j.session_id)
 THEN RAISE EXCEPTION 'invalid_job_parent'; END IF;
 IF NOT s.reaction_pipeline_enabled OR s.reaction_ai_mode<>j.mode THEN RAISE EXCEPTION 'configuration_changed'; END IF;
 et:=CASE WHEN j.mode='off' OR s.reaction_ai_status='stopped' THEN 'human_only' ELSE 'paired' END;
 source:=CASE WHEN et='human_only' THEN 'none' ELSE p_source END;
 IF et='paired' THEN
  IF p_source NOT IN ('mock','fallback','generated') OR p_text IS NULL OR length(trim(p_text)) NOT BETWEEN 1 AND 500 THEN
   RAISE EXCEPTION 'invalid_reply'; END IF;
  IF p_source='mock' AND NOT s.is_mock_ai THEN RAISE EXCEPTION 'mock_not_enabled'; END IF;
  SELECT id INTO aid FROM public.posts WHERE parent_id=h.id AND author_type='ai' AND NOT is_deleted;
  IF aid IS NULL THEN
   INSERT INTO public.posts(session_id,room_id,participant_id,author_type,author_display_name,name,message,
    is_ai,parent_id,reply_target_type,audience_type,likes,dislikes,is_deleted)
   VALUES(j.session_id,j.room_id,NULL,'ai','学生AI','学生AI',p_text,true,h.id,'to_human','room',0,0,false)
   RETURNING id INTO aid;
  ELSIF NOT EXISTS(SELECT 1 FROM public.posts WHERE id=aid AND session_id=j.session_id AND room_id=j.room_id) THEN
   RAISE EXCEPTION 'invalid_existing_reply';
  END IF;
 END IF;
 -- All event publishers take the same lock before allocating an event ID.
 PERFORM pg_advisory_xact_lock(hashtext('projection_lock:'||j.session_id::text));
 INSERT INTO public.ai_reply_logs(session_id,room_id,human_post_id,ai_post_id,mode,source_type,
 model_name,prompt_version,fallback_id,context_reference,generation_duration_ms,client_sent_at,post_created_at,reply_created_at)
 VALUES(j.session_id,j.room_id,h.id,aid,j.mode,source,CASE WHEN source='mock' THEN 'mock-phase1' ELSE 'fallback-rule' END,
 'phase1-v2',p_fallback_id,coalesce(p_context,'{}'),p_duration,p_client_sent_at,h.created_at,
 CASE WHEN aid IS NULL THEN NULL ELSE (SELECT created_at FROM public.posts WHERE id=aid) END)
 ON CONFLICT(human_post_id) DO NOTHING;
 INSERT INTO public.projection_events(session_id,room_id,human_post_id,ai_post_id,event_type)
 VALUES(j.session_id,j.room_id,h.id,aid,et) ON CONFLICT(human_post_id) DO NOTHING;
 SELECT id INTO STRICT eid FROM public.projection_events WHERE human_post_id=h.id
 AND session_id=j.session_id AND room_id=j.room_id AND ai_post_id IS NOT DISTINCT FROM aid AND event_type=et;
 UPDATE public.ai_reply_jobs SET status='completed',locked_until=NULL,lease_token=NULL,updated_at=clock_timestamp()
 WHERE id=j.id;
 RETURN jsonb_build_object('event_id',eid,'ai_post_id',aid);
END; $$;

-- Historical repair is explicit and restricted to enabled reaction sessions.
CREATE OR REPLACE FUNCTION public.recover_reaction_jobs() RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE n integer;
BEGIN
 INSERT INTO public.ai_reply_jobs(session_id,room_id,human_post_id,mode)
 SELECT p.session_id,p.room_id,p.id,s.reaction_ai_mode FROM public.posts p JOIN public.sessions s ON s.id=p.session_id
 WHERE s.reaction_pipeline_enabled AND p.author_type='human' AND NOT p.is_deleted
 AND NOT EXISTS(SELECT 1 FROM public.projection_events e WHERE e.human_post_id=p.id)
 ON CONFLICT(human_post_id) DO NOTHING;
 GET DIAGNOSTICS n=ROW_COUNT; RETURN n;
END; $$;

CREATE OR REPLACE FUNCTION public.reaction_log_immutable() RETURNS trigger
LANGUAGE plpgsql SET search_path=public,pg_temp AS $$ BEGIN RAISE EXCEPTION 'immutable_research_log'; END; $$;
DROP TRIGGER IF EXISTS trg_protect_ai_reply_logs ON public.ai_reply_logs;
CREATE TRIGGER trg_protect_ai_reply_logs BEFORE UPDATE OR DELETE ON public.ai_reply_logs FOR EACH ROW EXECUTE FUNCTION public.reaction_log_immutable();
DROP TRIGGER IF EXISTS trg_protect_projection_render_logs ON public.projection_render_logs;
CREATE TRIGGER trg_protect_projection_render_logs BEFORE UPDATE OR DELETE ON public.projection_render_logs FOR EACH ROW EXECUTE FUNCTION public.reaction_log_immutable();
ALTER TABLE public.projection_render_logs ADD COLUMN IF NOT EXISTS phase text NOT NULL DEFAULT 'dom_added' CHECK(phase IN ('dom_added','viewport_entered'));
CREATE UNIQUE INDEX IF NOT EXISTS render_event_instance_phase ON public.projection_render_logs(event_id,client_instance_id,phase);
-- The earlier public function is superseded; never expose a privileged insertion RPC.
REVOKE ALL ON FUNCTION public.create_projection_event_atomic(uuid,uuid,bigint,bigint,text) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.enqueue_reaction_post() FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.reaction_log_immutable() FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.claim_reaction_jobs(integer,uuid) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.finish_reaction_job(uuid,uuid,text,text,text,integer,jsonb,timestamptz) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.recover_reaction_jobs() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.claim_reaction_jobs(integer,uuid),public.recover_reaction_jobs() TO service_role;
GRANT EXECUTE ON FUNCTION public.finish_reaction_job(uuid,uuid,text,text,text,integer,jsonb,timestamptz) TO service_role;
REVOKE ALL ON public.ai_reply_jobs,public.ai_reply_logs,public.projection_events,public.projection_render_logs FROM anon,authenticated;
GRANT ALL ON public.ai_reply_jobs,public.ai_reply_logs,public.projection_events,public.projection_render_logs TO service_role;
GRANT USAGE,SELECT ON SEQUENCE public.projection_events_id_seq,public.projection_render_logs_id_seq TO service_role;
COMMIT;
