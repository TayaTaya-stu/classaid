-- SupporTalk current project only. Apply after 019. Review before running remotely.
BEGIN;
CREATE OR REPLACE FUNCTION public.set_designated_session(p_session_id uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE s public.sessions%ROWTYPE;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtext('designated_reaction_session'));
 SELECT * INTO s FROM public.sessions WHERE id=p_session_id FOR UPDATE;
 IF NOT FOUND OR s.room_mode<>'shared' OR s.is_locked OR s.status IN ('completed','closed','locked') OR s.auto_expired_at IS NOT NULL OR (s.class_started_at IS NOT NULL AND clock_timestamp()>=s.class_started_at+interval '120 minutes') THEN RETURN jsonb_build_object('success',false,'error','session_closed'); END IF;
 IF EXISTS(SELECT 1 FROM public.sessions WHERE is_current_target AND id<>s.id AND status='in_progress' AND NOT is_locked AND auto_expired_at IS NULL AND clock_timestamp()<class_started_at+interval '120 minutes') THEN RETURN jsonb_build_object('success',false,'error','class_in_progress'); END IF;
 UPDATE public.sessions SET is_current_target=(id=s.id);
 RETURN jsonb_build_object('success',true,'designatedSessionId',s.id);
END; $$;
CREATE FUNCTION public.start_designated_reaction_session(p_session_id uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 PERFORM pg_advisory_xact_lock(hashtext('designated_reaction_session'));
 IF NOT EXISTS(SELECT 1 FROM public.sessions WHERE id=p_session_id AND is_current_target) THEN RAISE EXCEPTION 'session_not_designated'; END IF;
 RETURN public.control_reaction_session(p_session_id,'start',NULL,false);
END; $$;
REVOKE ALL ON FUNCTION public.start_designated_reaction_session(uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.start_designated_reaction_session(uuid) TO service_role;

ALTER TABLE public.posts ADD COLUMN IF NOT EXISTS client_request_id uuid;
CREATE UNIQUE INDEX IF NOT EXISTS posts_request_once ON public.posts(session_id,participant_id,client_request_id) WHERE client_request_id IS NOT NULL;
CREATE OR REPLACE FUNCTION public.submit_reaction_post(p_session_id uuid,p_room_id uuid,p_participant_id uuid,p_auth_user_id uuid,p_request_id uuid,p_message text,p_client_sent_at timestamptz DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE s public.sessions%ROWTYPE; a public.session_attendances%ROWTYPE; p public.posts%ROWTYPE;
BEGIN
 IF p_request_id IS NULL OR p_message IS NULL OR length(btrim(p_message)) NOT BETWEEN 1 AND 500 THEN RAISE EXCEPTION 'invalid_input'; END IF;
 SELECT * INTO STRICT s FROM public.sessions WHERE id=p_session_id FOR SHARE;
 IF NOT s.is_current_target OR s.is_locked OR s.status<>'in_progress' OR NOT s.reaction_pipeline_enabled OR s.class_started_at IS NULL OR s.auto_expired_at IS NOT NULL OR clock_timestamp()>=s.class_started_at+interval '120 minutes' THEN RAISE EXCEPTION 'session_closed'; END IF;
 SELECT * INTO STRICT a FROM public.session_attendances WHERE session_id=s.id AND participant_id=p_participant_id AND room_id=p_room_id;
 IF NOT EXISTS(SELECT 1 FROM public.participant_auth_links WHERE auth_user_id=p_auth_user_id AND participant_id=p_participant_id) THEN RAISE EXCEPTION 'unauthorized'; END IF;
 PERFORM pg_advisory_xact_lock(hashtext(s.id::text||p_participant_id::text));
 SELECT * INTO p FROM public.posts WHERE session_id=s.id AND participant_id=p_participant_id AND client_request_id=p_request_id;
 IF FOUND THEN
   IF p.message<>btrim(p_message) THEN RAISE EXCEPTION 'request_conflict'; END IF;
 ELSE
   IF (SELECT count(*) FROM public.posts WHERE session_id=s.id AND participant_id=p_participant_id AND author_type='human' AND created_at>clock_timestamp()-interval '10 seconds')>=12 THEN RAISE EXCEPTION 'post_rate_limited'; END IF;
   INSERT INTO public.posts(session_id,room_id,participant_id,author_type,author_display_name,name,message,is_ai,likes,dislikes,parent_id,reply_target_type,audience_type,is_deleted,client_request_id)
   VALUES(s.id,p_room_id,p_participant_id,'human',a.display_name,a.display_name,btrim(p_message),false,0,0,NULL,'none','room',false,p_request_id) RETURNING * INTO p;
 END IF;
 IF NOT EXISTS(SELECT 1 FROM public.ai_reply_jobs WHERE human_post_id=p.id) THEN RAISE EXCEPTION 'queue_unavailable'; END IF;
 UPDATE public.ai_reply_jobs SET client_sent_at=coalesce(client_sent_at,p_client_sent_at) WHERE human_post_id=p.id;
 RETURN jsonb_build_object('id',p.id,'created_at',p.created_at);
END; $$;
REVOKE ALL ON FUNCTION public.submit_reaction_post(uuid,uuid,uuid,uuid,uuid,text,timestamptz) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.submit_reaction_post(uuid,uuid,uuid,uuid,uuid,text,timestamptz) TO service_role;

CREATE OR REPLACE FUNCTION public.set_reaction_like(p_session_id uuid,p_room_id uuid,p_participant_id uuid,p_auth_user_id uuid,p_post_id bigint,p_liked boolean)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE s public.sessions%ROWTYPE; n bigint;
BEGIN
 SELECT * INTO STRICT s FROM public.sessions WHERE id=p_session_id FOR SHARE;
 IF NOT s.is_current_target OR s.is_locked OR s.status<>'in_progress' OR s.auto_expired_at IS NOT NULL OR clock_timestamp()>=s.class_started_at+interval '120 minutes' THEN RAISE EXCEPTION 'session_closed'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.session_attendances WHERE session_id=s.id AND participant_id=p_participant_id AND room_id=p_room_id) OR NOT EXISTS(SELECT 1 FROM public.participant_auth_links WHERE auth_user_id=p_auth_user_id AND participant_id=p_participant_id) OR NOT EXISTS(SELECT 1 FROM public.posts WHERE id=p_post_id AND session_id=s.id AND room_id=p_room_id AND NOT is_deleted) THEN RAISE EXCEPTION 'unauthorized'; END IF;
 PERFORM pg_advisory_xact_lock(hashtext(p_post_id::text||':'||p_participant_id::text));
 IF p_liked THEN INSERT INTO public.post_likes(post_id,participant_id,user_id) VALUES(p_post_id,p_participant_id,p_auth_user_id) ON CONFLICT DO NOTHING;
 ELSE DELETE FROM public.post_likes WHERE post_id=p_post_id AND participant_id=p_participant_id; END IF;
 SELECT count(*) INTO n FROM public.post_likes WHERE post_id=p_post_id;
 RETURN jsonb_build_object('success',true,'isLiked',p_liked,'likesCount',n);
END; $$;
REVOKE ALL ON FUNCTION public.set_reaction_like(uuid,uuid,uuid,uuid,bigint,boolean) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.set_reaction_like(uuid,uuid,uuid,uuid,bigint,boolean) TO service_role;

CREATE TABLE public.lecture_audio_deliveries(session_id uuid NOT NULL REFERENCES public.sessions(id),segment_hash text NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(session_id,segment_hash));
ALTER TABLE public.lecture_audio_deliveries ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.lecture_audio_deliveries FROM PUBLIC,anon,authenticated;
GRANT ALL ON public.lecture_audio_deliveries TO service_role;
-- Full speech text stays only in the process rolling window, never in this DB column.
UPDATE public.lecture_contexts SET recent_speech='[]';
REVOKE EXECUTE ON FUNCTION public.update_lecture_speech_context(uuid,jsonb,text,text[],text[],jsonb) FROM service_role;
CREATE OR REPLACE FUNCTION public.append_lecture_context(p_session_id uuid,p_text text,p_keywords text[],p_hashes text[])
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE s public.sessions%ROWTYPE; c public.lecture_contexts%ROWTYPE; known integer; words text[];
BEGIN
 SELECT * INTO STRICT s FROM public.sessions WHERE id=p_session_id FOR SHARE;
 IF NOT s.is_current_target OR s.status<>'in_progress' OR s.is_locked OR s.reaction_ai_status<>'active' OR s.auto_expired_at IS NOT NULL OR clock_timestamp()>=s.class_started_at+interval '120 minutes' THEN RAISE EXCEPTION 'session_closed'; END IF;
 IF length(p_text)>6000 OR coalesce(array_length(p_hashes,1),0) NOT BETWEEN 1 AND 7 THEN RAISE EXCEPTION 'invalid_audio'; END IF;
 PERFORM pg_advisory_xact_lock(hashtext('lecture_context:'||s.id::text));
 SELECT count(*) INTO known FROM public.lecture_audio_deliveries WHERE session_id=s.id AND segment_hash=ANY(p_hashes);
 IF known=cardinality(p_hashes) THEN RETURN false; END IF;
 IF known>0 THEN RAISE EXCEPTION 'audio_overlap_retry'; END IF;
 INSERT INTO public.lecture_contexts(session_id,lecture_theme) VALUES(s.id,coalesce(s.lecture_theme,'情報技術')) ON CONFLICT DO NOTHING;
 SELECT * INTO STRICT c FROM public.lecture_contexts WHERE session_id=s.id FOR UPDATE;
 SELECT coalesce(array_agg(word ORDER BY first_seen),'{}') INTO words FROM (SELECT word,min(ord) first_seen FROM unnest(c.historical_keywords||p_keywords) WITH ORDINALITY t(word,ord) GROUP BY word ORDER BY min(ord) DESC LIMIT 600) x;
 UPDATE public.lecture_contexts SET recent_speech='[]',active_summary=right(p_text,500),recent_topics=p_keywords,historical_keywords=words,
 timeline=(SELECT coalesce(jsonb_agg(value ORDER BY ord),'[]') FROM jsonb_array_elements(c.timeline||jsonb_build_array(jsonb_build_object('timestamp',clock_timestamp(),'summary',left(p_text,150),'keywords',to_jsonb(p_keywords)))) WITH ORDINALITY t(value,ord) WHERE ord>greatest(0,jsonb_array_length(c.timeline)+1-600)),updated_at=clock_timestamp() WHERE session_id=s.id;
 INSERT INTO public.lecture_audio_deliveries(session_id,segment_hash) SELECT s.id,h FROM unnest(p_hashes) h ON CONFLICT DO NOTHING;
 RETURN true;
END; $$;
REVOKE ALL ON FUNCTION public.append_lecture_context(uuid,text,text[],text[]) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.append_lecture_context(uuid,text,text[],text[]) TO service_role;

CREATE OR REPLACE FUNCTION public.register_lecture_pdf(p_session_id uuid,p_pdf_topics jsonb,p_path text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE s public.sessions%ROWTYPE;
BEGIN
 SELECT * INTO STRICT s FROM public.sessions WHERE id=p_session_id FOR UPDATE;
 IF s.class_started_at IS NOT NULL OR s.is_locked THEN RAISE EXCEPTION 'already_started'; END IF;
 UPDATE public.sessions SET pdf_file_url=p_path WHERE id=s.id;
 INSERT INTO public.lecture_contexts(session_id,pdf_topics,lecture_theme) VALUES(s.id,p_pdf_topics,coalesce(s.lecture_theme,'情報技術')) ON CONFLICT(session_id) DO UPDATE SET pdf_topics=EXCLUDED.pdf_topics,updated_at=clock_timestamp();
END; $$;
REVOKE ALL ON FUNCTION public.register_lecture_pdf(uuid,jsonb,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.register_lecture_pdf(uuid,jsonb,text) TO service_role;

CREATE OR REPLACE FUNCTION public.claim_session_reaction_jobs(p_session_id uuid,p_limit integer DEFAULT 4)
RETURNS SETOF public.ai_reply_jobs LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.sessions WHERE id=p_session_id AND is_current_target AND status='in_progress' AND NOT is_locked AND class_started_at IS NOT NULL AND auto_expired_at IS NULL AND clock_timestamp()<class_started_at+interval '120 minutes') THEN
 UPDATE public.ai_reply_jobs SET status='failed',attempts=max_attempts,lease_token=NULL,locked_until=NULL,last_error='session_ended' WHERE session_id=p_session_id AND status IN ('pending','processing');
 RETURN; END IF;
 UPDATE public.ai_reply_jobs SET status='failed',lease_token=NULL,locked_until=NULL,last_error='attempts_exhausted' WHERE session_id=p_session_id AND attempts>=max_attempts AND (status='pending' OR (status='processing' AND locked_until<clock_timestamp()));
 UPDATE public.ai_reply_jobs SET status='pending' WHERE session_id=p_session_id AND status='failed' AND attempts<max_attempts AND updated_at<clock_timestamp()-interval '5 seconds';
 RETURN QUERY WITH candidates AS (SELECT id FROM public.ai_reply_jobs WHERE session_id=p_session_id AND attempts<max_attempts AND (status='pending' OR (status='processing' AND locked_until<clock_timestamp())) ORDER BY created_at,id FOR UPDATE SKIP LOCKED LIMIT greatest(1,least(p_limit,4)))
 UPDATE public.ai_reply_jobs j SET status='processing',attempts=j.attempts+1,lease_token=gen_random_uuid(),locked_until=clock_timestamp()+interval '60 seconds',updated_at=clock_timestamp() FROM candidates c WHERE j.id=c.id RETURNING j.*;
END; $$;
REVOKE ALL ON FUNCTION public.claim_session_reaction_jobs(uuid,integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.claim_session_reaction_jobs(uuid,integer) TO service_role;

CREATE OR REPLACE FUNCTION public.finish_reaction_job(
    p_job_id uuid,
    p_lease uuid,
    p_text text,
    p_source text,
    p_fallback_id text,
    p_duration integer,
    p_context jsonb,
    p_client_sent_at timestamptz DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE
    j public.ai_reply_jobs%ROWTYPE;
    h public.posts%ROWTYPE;
    s public.sessions%ROWTYPE;
    aid bigint;
    eid bigint;
    et text;
    source text;
    v_model_name text;
    v_prompt_version text;
    v_is_expired boolean := false;
BEGIN
    SELECT * INTO STRICT j FROM public.ai_reply_jobs WHERE id=p_job_id FOR UPDATE;
    IF j.status='completed' THEN
        SELECT id, ai_post_id INTO eid, aid FROM public.projection_events WHERE human_post_id=j.human_post_id;
        IF eid IS NULL THEN RAISE EXCEPTION 'completed_job_missing_event'; END IF;
        RETURN jsonb_build_object('event_id', eid, 'ai_post_id', aid);
    END IF;

    IF j.status<>'processing' OR j.lease_token IS DISTINCT FROM p_lease OR j.locked_until<clock_timestamp() THEN
        RAISE EXCEPTION 'invalid_or_expired_lease';
    END IF;

    SELECT * INTO STRICT h FROM public.posts WHERE id=j.human_post_id;
    SELECT * INTO STRICT s FROM public.sessions WHERE id=j.session_id FOR SHARE;

    IF h.session_id<>j.session_id OR h.room_id<>j.room_id OR h.author_type<>'human' OR h.is_deleted
       OR NOT EXISTS(SELECT 1 FROM public.rooms WHERE id=j.room_id AND session_id=j.session_id) THEN
        RAISE EXCEPTION 'invalid_job_parent';
    END IF;

    IF s.status<>'in_progress' OR s.is_locked OR s.auto_expired_at IS NOT NULL OR clock_timestamp()>=s.class_started_at+interval '120 minutes' THEN
        UPDATE public.ai_reply_jobs SET status='failed',attempts=max_attempts,last_error='session_ended',lease_token=NULL,locked_until=NULL WHERE id=j.id;
        RETURN jsonb_build_object('job_status','failed');
    END IF;

    -- 120分期限チェック
    IF s.class_started_at IS NOT NULL AND clock_timestamp() >= s.class_started_at + interval '120 minutes' THEN
        v_is_expired := true;
    END IF;

    -- 終了条件：モードOFF、AI停止中、または期限切れ後の投稿
    et := CASE
        WHEN j.mode='off' OR s.reaction_ai_status='stopped' OR v_is_expired THEN 'human_only'
        ELSE 'paired'
    END;
    source := CASE WHEN et='human_only' THEN 'none' ELSE p_source END;

    IF et='paired' THEN
        IF p_source NOT IN ('mock','fallback','generated') OR p_text IS NULL OR length(trim(p_text)) NOT BETWEEN 1 AND 500 THEN
            RAISE EXCEPTION 'invalid_reply';
        END IF;
        IF p_source='mock' AND NOT s.is_mock_ai THEN
            RAISE EXCEPTION 'mock_not_enabled';
        END IF;

        SELECT id INTO aid FROM public.posts WHERE parent_id=h.id AND author_type='ai' AND NOT is_deleted;
        IF aid IS NULL THEN
            INSERT INTO public.posts(
                session_id, room_id, participant_id, author_type, author_display_name, name,
                message, is_ai, parent_id, reply_target_type, audience_type, likes, dislikes, is_deleted
            ) VALUES(
                j.session_id, j.room_id, NULL, 'ai', '学生AI', '学生AI',
                p_text, true, h.id, 'to_human', 'room', 0, 0, false
            ) RETURNING id INTO aid;
        ELSIF NOT EXISTS(SELECT 1 FROM public.posts WHERE id=aid AND session_id=j.session_id AND room_id=j.room_id) THEN
            RAISE EXCEPTION 'invalid_existing_reply';
        END IF;
    END IF;

    v_model_name := CASE
        WHEN source='generated' THEN coalesce(p_context->>'model_name', 'gemini-2.5-flash')
        WHEN source='mock' THEN 'mock-phase1'
        ELSE coalesce(p_context->>'model_name', 'fallback-rule')
    END;

    v_prompt_version := CASE
        WHEN source='generated' THEN coalesce(p_context->>'prompt_version', 'reaction-v3-real-ai')
        WHEN source='mock' THEN 'phase1-v2'
        ELSE coalesce(p_context->>'prompt_version', 'fallback-v3')
    END;

    PERFORM pg_advisory_xact_lock(hashtext('projection_lock:'||j.session_id::text));

    INSERT INTO public.ai_reply_logs(
        session_id, room_id, human_post_id, ai_post_id, mode, source_type,
        model_name, prompt_version, fallback_id, context_reference,
        generation_duration_ms, client_sent_at, post_created_at, reply_created_at
    ) VALUES (
        j.session_id, j.room_id, h.id, aid, j.mode, source,
        v_model_name, v_prompt_version, p_fallback_id, coalesce(p_context, '{}'::jsonb),
        p_duration, p_client_sent_at, h.created_at,
        CASE WHEN aid IS NULL THEN NULL ELSE (SELECT created_at FROM public.posts WHERE id=aid) END
    ) ON CONFLICT(human_post_id) DO NOTHING;

    -- 投影イベントの作成（投影停止中でもキューの順序維持のためイベント自体は作成するが、projection_statusで配信を制御）
    INSERT INTO public.projection_events(session_id, room_id, human_post_id, ai_post_id, event_type)
    VALUES(j.session_id, j.room_id, h.id, aid, et)
    ON CONFLICT(human_post_id) DO NOTHING;

    SELECT id INTO STRICT eid FROM public.projection_events
    WHERE human_post_id=h.id AND session_id=j.session_id AND room_id=j.room_id
      AND ai_post_id IS NOT DISTINCT FROM aid AND event_type=et;

    UPDATE public.ai_reply_jobs
    SET status='completed', locked_until=NULL, lease_token=NULL, updated_at=clock_timestamp()
    WHERE id=j.id;

    RETURN jsonb_build_object('event_id', eid, 'ai_post_id', aid, 'isExpired', v_is_expired);
END;
$$;

CREATE TABLE public.reaction_generation_budget(session_id uuid PRIMARY KEY REFERENCES public.sessions(id),reply_calls integer NOT NULL DEFAULT 0,audio_calls integer NOT NULL DEFAULT 0);
ALTER TABLE public.reaction_generation_budget ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.reaction_generation_budget FROM PUBLIC,anon,authenticated;
GRANT ALL ON public.reaction_generation_budget TO service_role;
CREATE FUNCTION public.reserve_reaction_generation(p_session_id uuid,p_limit integer,p_kind text DEFAULT 'reply') RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE n integer;
BEGIN
 IF p_kind NOT IN ('reply','audio') OR p_limit NOT BETWEEN 1 AND 100000 THEN RAISE EXCEPTION 'invalid_budget'; END IF;
 INSERT INTO public.reaction_generation_budget(session_id) VALUES(p_session_id) ON CONFLICT DO NOTHING;
 IF p_kind='reply' THEN UPDATE public.reaction_generation_budget SET reply_calls=reply_calls+1 WHERE session_id=p_session_id AND reply_calls<p_limit RETURNING reply_calls INTO n;
 ELSE UPDATE public.reaction_generation_budget SET audio_calls=audio_calls+1 WHERE session_id=p_session_id AND audio_calls<p_limit RETURNING audio_calls INTO n; END IF;
 RETURN n IS NOT NULL;
END; $$;
REVOKE ALL ON FUNCTION public.reserve_reaction_generation(uuid,integer,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.reserve_reaction_generation(uuid,integer,text) TO service_role;

UPDATE public.posts p SET likes=(SELECT count(*) FROM public.post_likes l WHERE l.post_id=p.id);
CREATE FUNCTION public.refresh_reaction_like_counter() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 IF TG_OP='DELETE' OR (TG_OP='UPDATE' AND OLD.post_id<>NEW.post_id) THEN UPDATE public.posts SET likes=greatest(0,coalesce(likes,0)-1) WHERE id=OLD.post_id; END IF;
 IF TG_OP='INSERT' OR (TG_OP='UPDATE' AND OLD.post_id<>NEW.post_id) THEN UPDATE public.posts SET likes=coalesce(likes,0)+1 WHERE id=NEW.post_id; END IF;
 RETURN NULL;
END; $$;
CREATE TRIGGER reaction_like_counter AFTER INSERT OR DELETE OR UPDATE OF post_id ON public.post_likes FOR EACH ROW EXECUTE FUNCTION public.refresh_reaction_like_counter();
REVOKE ALL ON FUNCTION public.refresh_reaction_like_counter() FROM PUBLIC,anon,authenticated;

CREATE FUNCTION public.verify_reaction_room_access(p_session_id uuid,p_room_id uuid,p_participant_id uuid,p_auth_user_id uuid,p_room_slug text)
RETURNS TABLE(session_id uuid,session_number integer,status text,is_locked boolean,room_id uuid,room_slug text,group_label text,participant_id uuid,display_name text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT s.id,s.session_number,s.status,s.is_locked,r.id,r.room_slug,r.group_label,a.participant_id,a.display_name
 FROM public.sessions s JOIN public.rooms r ON r.session_id=s.id
 JOIN public.session_attendances a ON a.session_id=s.id AND a.room_id=r.id
 JOIN public.participant_auth_links l ON l.participant_id=a.participant_id
 WHERE s.id=p_session_id AND r.id=p_room_id AND r.room_slug=p_room_slug AND a.participant_id=p_participant_id AND l.auth_user_id=p_auth_user_id
 AND s.room_mode='shared' AND s.is_current_target AND NOT s.is_locked AND s.status NOT IN ('completed','closed','locked') AND s.auto_expired_at IS NULL AND (s.class_started_at IS NULL OR clock_timestamp()<s.class_started_at+interval '120 minutes')
$$;
REVOKE ALL ON FUNCTION public.verify_reaction_room_access(uuid,uuid,uuid,uuid,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.verify_reaction_room_access(uuid,uuid,uuid,uuid,text) TO service_role;

CREATE OR REPLACE VIEW public.v_analysis_session_overview AS
SELECT
    s.id AS session_id,
    s.session_number,
    s.scheduled_at,
    s.class_started_at,
    CASE WHEN s.class_started_at IS NOT NULL THEN s.class_started_at + interval '120 minutes' ELSE NULL END AS expires_at_120m,
    s.demo_projected_at,
    s.auto_expired_at,
    s.status AS session_status,
    s.reaction_ai_mode,
    s.reaction_ai_status,
    s.projection_status,
    s.is_mock_ai,
    s.lecture_theme,
    (SELECT count(*)::int FROM public.session_attendances sa WHERE sa.session_id = s.id AND sa.research_consented AND sa.is_primary_analysis) AS participant_count,
    (SELECT count(*)::int FROM public.posts p WHERE p.session_id = s.id AND p.author_type = 'human' AND NOT p.is_deleted AND EXISTS(SELECT 1 FROM public.session_attendances a WHERE a.session_id=s.id AND a.participant_id=p.participant_id AND a.research_consented AND a.is_primary_analysis)) AS human_post_count,
    (SELECT count(*)::int FROM public.posts p WHERE p.session_id = s.id AND p.author_type = 'ai' AND NOT p.is_deleted AND EXISTS(SELECT 1 FROM public.posts parent JOIN public.session_attendances a ON a.session_id=parent.session_id AND a.participant_id=parent.participant_id WHERE parent.id=p.parent_id AND a.research_consented AND a.is_primary_analysis)) AS ai_reply_count
FROM public.sessions s
WHERE s.room_mode = 'shared' AND NOT coalesce((s.protocol_snapshot->>'exclude_from_analysis')::boolean,false)
ORDER BY s.session_number DESC, s.created_at DESC;

-- ビュー2: 投稿とAI返信・時刻・生成元の対応一覧
CREATE OR REPLACE VIEW public.v_analysis_posts_and_replies AS
SELECT
    s.session_number,
    s.id AS session_id,
    hp.id AS human_post_id,
    hp.author_display_name AS student_display_name,
    hp.message AS student_message,
    hp.created_at AS post_created_at,
    (SELECT count(*) FROM public.post_likes pl JOIN public.session_attendances a ON a.session_id=hp.session_id AND a.participant_id=pl.participant_id WHERE pl.post_id=hp.id AND a.research_consented AND a.is_primary_analysis) AS post_likes,
    ap.id AS ai_post_id,
    ap.message AS ai_reply_message,
    ap.created_at AS reply_created_at,
    l.source_type,
    l.model_name,
    l.prompt_version,
    l.fallback_id,
    l.generation_duration_ms,
    l.context_reference,
    pe.event_type AS projection_event_type,
    pe.id AS projection_event_id
FROM public.posts hp
JOIN public.sessions s ON hp.session_id = s.id
LEFT JOIN public.ai_reply_logs l ON l.human_post_id = hp.id
LEFT JOIN public.posts ap ON l.ai_post_id = ap.id
LEFT JOIN public.projection_events pe ON pe.human_post_id = hp.id
WHERE hp.author_type = 'human' AND NOT hp.is_deleted AND EXISTS(SELECT 1 FROM public.session_attendances a WHERE a.session_id=hp.session_id AND a.participant_id=hp.participant_id AND a.research_consented AND a.is_primary_analysis) AND NOT coalesce((s.protocol_snapshot->>'exclude_from_analysis')::boolean,false)
ORDER BY hp.created_at ASC;

-- ビュー3: 授業操作・自動終了・イベントログ一覧
CREATE OR REPLACE VIEW public.v_analysis_session_logs AS
SELECT
    s.session_number,
    s.id AS session_id,
    el.id AS log_id,
    el.event_type,
    el.created_at,
    el.created_at AS logged_at,
    el.participant_id,
    el.metadata
FROM public.event_logs el
JOIN public.sessions s ON el.session_id = s.id
WHERE NOT coalesce((s.protocol_snapshot->>'exclude_from_analysis')::boolean,false) AND (el.participant_id IS NULL OR EXISTS(SELECT 1 FROM public.session_attendances a WHERE a.session_id=s.id AND a.participant_id=el.participant_id AND a.research_consented AND a.is_primary_analysis))
ORDER BY el.created_at DESC;

REVOKE ALL ON public.v_analysis_session_overview FROM PUBLIC,anon,authenticated;
GRANT SELECT ON public.v_analysis_session_overview TO service_role;
REVOKE ALL ON public.v_analysis_posts_and_replies FROM PUBLIC,anon,authenticated;
GRANT SELECT ON public.v_analysis_posts_and_replies TO service_role;
REVOKE ALL ON public.v_analysis_session_logs FROM PUBLIC,anon,authenticated;
GRANT SELECT ON public.v_analysis_session_logs TO service_role;
COMMIT;
