-- ------------------------------------------------------------------------------
-- 20261025_017_name_based_entry_and_context.sql
-- 確定仕様: 復帰コード不要の名前ログイン（自己申告引き継ぎ）と講義文脈のDB永続化
-- 015・016は適用済みのため書き換えず、このファイルを追加する。
-- 実DBにはまだ適用しない。
-- ------------------------------------------------------------------------------

BEGIN;

-- 1. 授業文脈のDB永続化テーブル（プロセス再起動・別プロセス間での共有用）
CREATE TABLE IF NOT EXISTS public.lecture_contexts (
    session_id UUID PRIMARY KEY REFERENCES public.sessions(id) ON DELETE CASCADE,
    lecture_theme TEXT NOT NULL DEFAULT '情報技術・コンピュータサイエンス',
    active_summary TEXT NOT NULL DEFAULT '',
    recent_topics TEXT[] NOT NULL DEFAULT '{}',
    historical_keywords TEXT[] NOT NULL DEFAULT '{}',
    pdf_topics JSONB NOT NULL DEFAULT '[]'::jsonb,
    recent_speech JSONB NOT NULL DEFAULT '[]'::jsonb,
    timeline JSONB NOT NULL DEFAULT '[]'::jsonb,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

COMMENT ON TABLE public.lecture_contexts IS '講義音声の進行メモ・学術語句・PDF抽出テキスト・時刻付き説明記録を永続化するテーブル。';

ALTER TABLE public.lecture_contexts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.lecture_contexts FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.lecture_contexts TO service_role;

-- 音声文脈のアトミック更新関数（PDF文脈を上書きしない）
CREATE OR REPLACE FUNCTION public.update_lecture_speech_context(
    p_session_id UUID,
    p_speech JSONB,
    p_active_summary TEXT,
    p_recent_topics TEXT[],
    p_historical_keywords TEXT[],
    p_timeline JSONB
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
    INSERT INTO public.lecture_contexts (
        session_id, recent_speech, active_summary, recent_topics,
        historical_keywords, timeline, updated_at
    ) VALUES (
        p_session_id, p_speech, p_active_summary, p_recent_topics,
        p_historical_keywords, p_timeline, clock_timestamp()
    ) ON CONFLICT(session_id) DO UPDATE SET
        recent_speech = EXCLUDED.recent_speech,
        active_summary = EXCLUDED.active_summary,
        recent_topics = EXCLUDED.recent_topics,
        historical_keywords = EXCLUDED.historical_keywords,
        timeline = EXCLUDED.timeline,
        updated_at = clock_timestamp();
END;
$$;

-- PDF文脈のアトミック更新関数（音声文脈を上書きしない）
CREATE OR REPLACE FUNCTION public.update_lecture_pdf_context(
    p_session_id UUID,
    p_pdf_topics JSONB
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
    INSERT INTO public.lecture_contexts (
        session_id, pdf_topics, updated_at
    ) VALUES (
        p_session_id, p_pdf_topics, clock_timestamp()
    ) ON CONFLICT(session_id) DO UPDATE SET
        pdf_topics = EXCLUDED.pdf_topics,
        updated_at = clock_timestamp();
END;
$$;

REVOKE ALL ON FUNCTION public.update_lecture_speech_context(UUID, JSONB, TEXT, TEXT[], TEXT[], JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.update_lecture_speech_context(UUID, JSONB, TEXT, TEXT[], TEXT[], JSONB) TO service_role;

REVOKE ALL ON FUNCTION public.update_lecture_pdf_context(UUID, JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.update_lecture_pdf_context(UUID, JSONB) TO service_role;

-- 2. 名前ベースの確定版入室関数 (enter_reaction_session)
-- 復帰コード不要。自己申告による既存名前の引き継ぎ対応。
CREATE OR REPLACE FUNCTION public.enter_reaction_session(
    p_auth_user_id uuid,
    p_entry_slug text,
    p_display_name text,
    p_name_key text,
    p_identity_hash text,
    p_consented boolean,
    p_claim_existing boolean DEFAULT false
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE
    s public.sessions%ROWTYPE;
    pid uuid;
    r public.rooms%ROWTYPE;
    n public.participant_display_name_registry%ROWTYPE;
    new_participant boolean := false;
    is_claimed boolean := false;
    primary_ok boolean;
    reason text;
    arrival text;
    at_time timestamptz := clock_timestamp();
BEGIN
    IF p_consented IS NULL OR length(p_display_name) NOT BETWEEN 2 AND 24 OR p_name_key IS NULL OR p_name_key = '' THEN
        RAISE EXCEPTION 'invalid_input';
    END IF;

    SELECT * INTO s FROM public.sessions WHERE entry_slug = p_entry_slug FOR SHARE;
    IF NOT FOUND THEN RAISE EXCEPTION 'session_not_found'; END IF;
    IF s.room_mode <> 'shared' OR s.is_locked OR s.status NOT IN ('scheduled', 'in_progress') THEN
        RAISE EXCEPTION 'session_closed';
    END IF;

    -- 同じAuthユーザーの直列化
    PERFORM pg_advisory_xact_lock(hashtext('participant_auth:' || p_auth_user_id::text));

    -- 1. 既存のAuthリンクが存在するか確認（同じブラウザ・端末の継続）
    SELECT participant_id INTO pid FROM public.participant_auth_links WHERE auth_user_id = p_auth_user_id;

    IF pid IS NULL THEN
        -- 2. Authリンクがない場合、名前レジストリを確認
        SELECT * INTO n FROM public.participant_display_name_registry WHERE display_name_key = p_name_key;
        
        IF FOUND THEN
            -- 名前が既に登録されている
            IF NOT p_claim_existing THEN
                -- 確認前は自動統合せず、自己申告確認を要求する
                RAISE EXCEPTION 'name_exists_confirm_claim';
            ELSE
                -- 「はい、自分の名前です」と自己申告されたため、既存参加者IDを引き継ぐ
                pid := n.participant_id;
                is_claimed := true;
            END IF;
        ELSE
            -- 未登録の名前なので新規参加者を作成
            INSERT INTO public.participants(identity_hash, assigned_group, is_consented, consented_at, first_session_id)
            VALUES(p_identity_hash, 'A', p_consented, CASE WHEN p_consented THEN at_time ELSE NULL END, s.id)
            RETURNING id INTO pid;

            INSERT INTO public.participant_display_name_registry(participant_id, display_name, display_name_key)
            VALUES(pid, p_display_name, p_name_key);

            new_participant := true;
        END IF;
    ELSE
        -- 既存Authユーザーの場合、登録名と一致しているか確認
        PERFORM 1 FROM public.participants WHERE id = pid FOR UPDATE;
        SELECT * INTO n FROM public.participant_display_name_registry WHERE participant_id = pid;
        IF FOUND AND n.display_name_key <> p_name_key THEN
            RAISE EXCEPTION 'use_registered_name';
        END IF;
    END IF;

    SELECT * INTO STRICT n FROM public.participant_display_name_registry WHERE participant_id = pid;
    IF (SELECT count(*) FROM public.rooms WHERE session_id = s.id) <> 1 THEN
        RAISE EXCEPTION 'invalid_room';
    END IF;
    SELECT * INTO STRICT r FROM public.rooms WHERE session_id = s.id;

    -- Authリンクの作成・更新
    INSERT INTO public.participant_auth_links(auth_user_id, participant_id, last_used_at)
    VALUES(p_auth_user_id, pid, at_time)
    ON CONFLICT(auth_user_id) DO UPDATE SET last_used_at = EXCLUDED.last_used_at, participant_id = EXCLUDED.participant_id;

    primary_ok := p_consented AND s.class_started_at IS NULL AND NOT coalesce((s.protocol_snapshot->>'exclude_from_analysis')::boolean, false);
    reason := CASE
        WHEN NOT p_consented THEN '研究利用への同意なし'
        WHEN s.class_started_at IS NOT NULL THEN '開始後入室（参考）'
        WHEN NOT primary_ok THEN '試運転'
        ELSE NULL
    END;
    arrival := CASE WHEN s.class_started_at IS NULL THEN 'normal' ELSE 'delayed' END;

    INSERT INTO public.session_attendances(
        session_id, participant_id, room_id, display_name, joined_at, last_seen_at,
        attendance_status, is_primary_analysis, exclusion_reason, research_consented
    ) VALUES (
        s.id, pid, r.id, n.display_name, at_time, at_time, arrival, primary_ok, reason, p_consented
    ) ON CONFLICT(session_id, participant_id) DO UPDATE SET
        last_seen_at = EXCLUDED.last_seen_at,
        research_consented = EXCLUDED.research_consented,
        is_primary_analysis = public.session_attendances.is_primary_analysis AND EXCLUDED.research_consented,
        exclusion_reason = CASE
            WHEN NOT EXCLUDED.research_consented THEN '研究利用への同意なし'
            ELSE public.session_attendances.exclusion_reason
        END;

    UPDATE public.participants
    SET is_consented = p_consented,
        consented_at = CASE WHEN p_consented THEN coalesce(consented_at, at_time) ELSE NULL END
    WHERE id = pid;

    UPDATE public.participant_display_name_registry SET last_seen_at = at_time WHERE participant_id = pid;

    -- 自己申告引き継ぎまたは通常入室をイベントログで区別して記録
    INSERT INTO public.event_logs(session_id, room_id, participant_id, event_type, metadata)
    VALUES(
        s.id, r.id, pid,
        CASE WHEN is_claimed THEN 'participant_claimed_by_name' ELSE 'participant_entered' END,
        jsonb_build_object(
            'research_consented', p_consented,
            'registration_new', new_participant,
            'is_claimed', is_claimed
        )
    );

    RETURN jsonb_build_object(
        'participantId', pid,
        'roomId', r.id,
        'roomSlug', r.room_slug,
        'sessionId', s.id,
        'displayName', n.display_name,
        'isNew', new_participant,
        'isClaimed', is_claimed
    );
END;
$$;

REVOKE ALL ON FUNCTION public.enter_reaction_session(uuid, text, text, text, text, boolean, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.enter_reaction_session(uuid, text, text, text, text, boolean, boolean) TO service_role;

-- 3. 本番生成経路への接続とis_mock_ai強制の解除 (control_reaction_session)
-- 016でis_mock_ai=trueが固定されていたのを解除し、本番AI生成を有効化可能にする。
DROP FUNCTION IF EXISTS public.control_reaction_session(uuid, text, text);
CREATE OR REPLACE FUNCTION public.control_reaction_session(
    p_session_id uuid,
    p_action text,
    p_mode text DEFAULT NULL,
    p_is_mock_ai boolean DEFAULT false
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE s public.sessions%ROWTYPE;
BEGIN
    SELECT * INTO STRICT s FROM public.sessions WHERE id=p_session_id FOR UPDATE;
    IF s.room_mode<>'shared' OR s.is_locked OR s.status NOT IN ('scheduled','in_progress') THEN
        RAISE EXCEPTION 'session_closed';
    END IF;

    IF p_action='configure' THEN
        IF s.class_started_at IS NOT NULL OR s.intervention_started_at IS NOT NULL OR s.reaction_pipeline_enabled THEN
            RAISE EXCEPTION 'already_started';
        END IF;
        IF p_mode IS NULL OR p_mode NOT IN ('off','empathy','lecture_bridge','neutral') THEN
            RAISE EXCEPTION 'invalid_mode';
        END IF;
        UPDATE public.sessions
        SET reaction_ai_mode=p_mode,
            is_mock_ai=coalesce(p_is_mock_ai, false),
            reaction_ai_status='active'
        WHERE id=s.id;
    ELSIF p_action='start' THEN
        IF s.class_started_at IS NOT NULL OR s.reaction_pipeline_enabled THEN
            RAISE EXCEPTION 'already_started';
        END IF;
        UPDATE public.sessions
        SET class_started_at=clock_timestamp(),
            status='in_progress',
            reaction_pipeline_enabled=true,
            is_mock_ai=coalesce(p_is_mock_ai, s.is_mock_ai, false)
        WHERE id=s.id;
    ELSIF p_action='stop' THEN
        IF s.class_started_at IS NULL THEN RAISE EXCEPTION 'not_started'; END IF;
        UPDATE public.sessions SET reaction_ai_status='stopped', reaction_pipeline_enabled=true WHERE id=s.id;
    ELSE
        RAISE EXCEPTION 'invalid_action';
    END IF;

    INSERT INTO public.event_logs(session_id, event_type, metadata)
    VALUES(
        s.id,
        'reaction_'||p_action,
        jsonb_build_object(
            'mode', coalesce(p_mode, s.reaction_ai_mode),
            'is_mock_ai', coalesce(p_is_mock_ai, s.is_mock_ai, false),
            'production_ready', true
        )
    );

    SELECT * INTO STRICT s FROM public.sessions WHERE id=s.id;
    RETURN jsonb_build_object(
        'success', true,
        'mode', s.reaction_ai_mode,
        'status', s.reaction_ai_status,
        'isMockAi', s.is_mock_ai,
        'pipelineEnabled', s.reaction_pipeline_enabled,
        'classStartedAt', s.class_started_at
    );
END;
$$;

REVOKE ALL ON FUNCTION public.control_reaction_session(uuid, text, text, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.control_reaction_session(uuid, text, text, boolean) TO service_role;

-- 4. 実際のモデル名・プロンプト版・参照根拠を正しく記録する (finish_reaction_job)
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

    IF NOT s.reaction_pipeline_enabled OR s.reaction_ai_mode<>j.mode THEN
        RAISE EXCEPTION 'configuration_changed';
    END IF;

    et := CASE WHEN j.mode='off' OR s.reaction_ai_status='stopped' THEN 'human_only' ELSE 'paired' END;
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
        WHEN source='generated' THEN coalesce(p_context->>'prompt_version', 'v3-prod')
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

    INSERT INTO public.projection_events(session_id, room_id, human_post_id, ai_post_id, event_type)
    VALUES(j.session_id, j.room_id, h.id, aid, et)
    ON CONFLICT(human_post_id) DO NOTHING;

    SELECT id INTO STRICT eid FROM public.projection_events
    WHERE human_post_id=h.id AND session_id=j.session_id AND room_id=j.room_id
      AND ai_post_id IS NOT DISTINCT FROM aid AND event_type=et;

    UPDATE public.ai_reply_jobs
    SET status='completed', locked_until=NULL, lease_token=NULL, updated_at=clock_timestamp()
    WHERE id=j.id;

    RETURN jsonb_build_object('event_id', eid, 'ai_post_id', aid);
END;
$$;

REVOKE ALL ON FUNCTION public.finish_reaction_job(uuid, uuid, text, text, text, integer, jsonb, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.finish_reaction_job(uuid, uuid, text, text, text, integer, jsonb, timestamptz) TO service_role;

COMMIT;
