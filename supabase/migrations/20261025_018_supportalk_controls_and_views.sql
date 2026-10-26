-- ------------------------------------------------------------------------------
-- 20261025_018_supportalk_controls_and_views.sql
-- SupporTalk確定仕様:
-- 1. 120分自動停止・個別停止（AIのみ停止・再開、投影のみ停止・再開）とデモ投影時刻記録
-- 2. 120分終了後のAI生成拒否と境界ジョブ整合性
-- 3. 研究者・教授向けセッション別閲覧用ビュー（学生非公開）
-- ------------------------------------------------------------------------------

BEGIN;

-- 1. セッション管理カラムの拡張
ALTER TABLE public.sessions
    ADD COLUMN IF NOT EXISTS projection_status TEXT NOT NULL DEFAULT 'active',
    ADD COLUMN IF NOT EXISTS demo_projected_at TIMESTAMPTZ DEFAULT NULL,
    ADD COLUMN IF NOT EXISTS auto_expired_at TIMESTAMPTZ DEFAULT NULL;

COMMENT ON COLUMN public.sessions.projection_status IS '投影アプリの表示状態 (active: 投影中, paused: 投影のみ一時停止, stopped: 停止)';
COMMENT ON COLUMN public.sessions.demo_projected_at IS '研究用デモの実投影が開始された時刻（授業開始時刻とは独立に記録）';
COMMENT ON COLUMN public.sessions.auto_expired_at IS '授業開始から120分経過により自動停止された時刻';

-- 2. 単独実行可能な120分期限自動判定・確定RPC (check_or_expire_120m)
CREATE OR REPLACE FUNCTION public.check_or_expire_120m(p_session_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE
    s public.sessions%ROWTYPE;
    v_expires_at timestamptz;
    v_is_expired boolean := false;
BEGIN
    SELECT * INTO s FROM public.sessions WHERE id = p_session_id FOR UPDATE;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'error', 'not_found');
    END IF;

    IF s.class_started_at IS NOT NULL THEN
        v_expires_at := s.class_started_at + interval '120 minutes';
        IF clock_timestamp() >= v_expires_at THEN
            v_is_expired := true;
            IF s.auto_expired_at IS NULL OR s.status <> 'completed' THEN
                UPDATE public.sessions
                SET auto_expired_at = coalesce(auto_expired_at, v_expires_at),
                    status = 'completed',
                    reaction_ai_status = 'stopped',
                    projection_status = 'stopped'
                WHERE id = s.id;

                INSERT INTO public.event_logs(session_id, event_type, metadata)
                VALUES(s.id, 'reaction_auto_expired_120m', jsonb_build_object(
                    'class_started_at', s.class_started_at,
                    'expired_at', v_expires_at
                ));
                SELECT * INTO STRICT s FROM public.sessions WHERE id=s.id;
            END IF;
        END IF;
    END IF;

    RETURN jsonb_build_object(
        'success', true,
        'sessionId', s.id,
        'status', s.status,
        'isExpired', v_is_expired,
        'autoExpiredAt', s.auto_expired_at,
        'reactionAiStatus', s.reaction_ai_status,
        'projectionStatus', s.projection_status,
        'classStartedAt', s.class_started_at,
        'expiresAt', CASE WHEN s.class_started_at IS NOT NULL THEN s.class_started_at + interval '120 minutes' ELSE NULL END
    );
END;
$$;

REVOKE ALL ON FUNCTION public.check_or_expire_120m(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.check_or_expire_120m(uuid) TO service_role;

-- 2.1 デモ実投影時刻の記録RPC（rendererの描画通知から呼ばれる）
CREATE OR REPLACE FUNCTION public.record_demo_projected(
    p_session_id uuid,
    p_rendered_at timestamptz DEFAULT clock_timestamp()
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE
    v_actual_time timestamptz;
BEGIN
    v_actual_time := coalesce(p_rendered_at, clock_timestamp());
    UPDATE public.sessions
    SET demo_projected_at = coalesce(demo_projected_at, v_actual_time)
    WHERE id = p_session_id;

    INSERT INTO public.event_logs(session_id, event_type, metadata)
    VALUES(p_session_id, 'demo_projected_at', jsonb_build_object(
        'rendered_at', v_actual_time,
        'source', 'overlay_renderer'
    ));

    RETURN jsonb_build_object('success', true, 'demoProjectedAt', v_actual_time);
END;
$$;

REVOKE ALL ON FUNCTION public.record_demo_projected(uuid, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_demo_projected(uuid, timestamptz) TO service_role;

-- 2.2 授業進行・個別停止・120分終了制御RPC (control_reaction_session)
DROP FUNCTION IF EXISTS public.control_reaction_session(uuid, text, text, boolean);
CREATE OR REPLACE FUNCTION public.control_reaction_session(
    p_session_id uuid,
    p_action text,
    p_mode text DEFAULT NULL,
    p_is_mock_ai boolean DEFAULT false
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE
    s public.sessions%ROWTYPE;
    v_expires_at timestamptz;
    v_is_expired boolean := false;
BEGIN
    SELECT * INTO STRICT s FROM public.sessions WHERE id=p_session_id FOR UPDATE;
    IF s.room_mode<>'shared' OR s.is_locked THEN
        RAISE EXCEPTION 'session_closed';
    END IF;

    -- 120分期限の計算と判定（開始時刻から120分）
    IF s.class_started_at IS NOT NULL THEN
        v_expires_at := s.class_started_at + interval '120 minutes';
        IF clock_timestamp() >= v_expires_at THEN
            v_is_expired := true;
            IF s.auto_expired_at IS NULL OR s.status <> 'completed' THEN
                UPDATE public.sessions
                SET auto_expired_at = coalesce(auto_expired_at, v_expires_at),
                    status = 'completed',
                    reaction_ai_status = 'stopped',
                    projection_status = 'stopped'
                WHERE id = s.id;
                INSERT INTO public.event_logs(session_id, event_type, metadata)
                VALUES(s.id, 'reaction_auto_expired_120m', jsonb_build_object(
                    'class_started_at', s.class_started_at,
                    'expired_at', v_expires_at
                ));
                SELECT * INTO STRICT s FROM public.sessions WHERE id=s.id;
            END IF;
        END IF;
    END IF;

    -- 終了確定チェック（手動終了または120分自動終了）
    IF (s.status IN ('completed', 'closed') OR s.auto_expired_at IS NOT NULL OR v_is_expired) THEN
        IF p_action = 'check_or_expire_120m' THEN
            -- 状態確認のみ
            NULL;
        ELSIF p_action = 'stop' THEN
            -- すでに停止済み
            NULL;
        ELSIF v_is_expired OR s.auto_expired_at IS NOT NULL THEN
            -- 期限到達後の操作拒否: 例外を投げずに確定結果を返すことでロールバックを防止
            RETURN jsonb_build_object(
                'success', false,
                'error', 'session_expired',
                'isExpired', true,
                'autoExpiredAt', s.auto_expired_at,
                'status', s.status,
                'reactionAiStatus', s.reaction_ai_status,
                'projectionStatus', s.projection_status
            );
        ELSE
            -- 手動終了済みの授業の再開拒否
            RETURN jsonb_build_object(
                'success', false,
                'error', 'session_closed',
                'isExpired', false,
                'autoExpiredAt', s.auto_expired_at,
                'status', s.status,
                'reactionAiStatus', s.reaction_ai_status,
                'projectionStatus', s.projection_status
            );
        END IF;
    END IF;

    -- アクション別処理
    IF p_action = 'configure' THEN
        IF s.class_started_at IS NOT NULL OR s.intervention_started_at IS NOT NULL OR s.reaction_pipeline_enabled THEN
            RAISE EXCEPTION 'already_started';
        END IF;
        IF p_mode IS NULL OR p_mode NOT IN ('off','empathy','lecture_bridge','neutral') THEN
            RAISE EXCEPTION 'invalid_mode';
        END IF;
        UPDATE public.sessions
        SET reaction_ai_mode = p_mode,
            is_mock_ai = coalesce(p_is_mock_ai, false),
            reaction_ai_status = 'active',
            projection_status = 'active'
        WHERE id = s.id;

    ELSIF p_action = 'start' THEN
        -- 開始の二重操作防止
        IF s.class_started_at IS NOT NULL OR s.reaction_pipeline_enabled THEN
            RAISE EXCEPTION 'already_started';
        END IF;
        UPDATE public.sessions
        SET class_started_at = clock_timestamp(),
            status = 'in_progress',
            reaction_pipeline_enabled = true,
            is_mock_ai = coalesce(p_is_mock_ai, s.is_mock_ai, false),
            reaction_ai_status = 'active',
            projection_status = 'active'
        WHERE id = s.id;
        v_expires_at := clock_timestamp() + interval '120 minutes';

    ELSIF p_action = 'pause_ai' THEN
        IF s.class_started_at IS NULL THEN RAISE EXCEPTION 'not_started'; END IF;
        UPDATE public.sessions SET reaction_ai_status = 'stopped' WHERE id = s.id;

    ELSIF p_action = 'resume_ai' THEN
        IF s.class_started_at IS NULL THEN RAISE EXCEPTION 'not_started'; END IF;
        UPDATE public.sessions SET reaction_ai_status = 'active' WHERE id = s.id;

    ELSIF p_action = 'pause_projection' THEN
        IF s.class_started_at IS NULL THEN RAISE EXCEPTION 'not_started'; END IF;
        UPDATE public.sessions SET projection_status = 'paused' WHERE id = s.id;

    ELSIF p_action = 'resume_projection' THEN
        IF s.class_started_at IS NULL THEN RAISE EXCEPTION 'not_started'; END IF;
        UPDATE public.sessions SET projection_status = 'active' WHERE id = s.id;

    ELSIF p_action = 'record_demo_projection' THEN
        -- 管理画面ボタン押下時刻を「実投影時刻」として保存しない
        -- 実投影時刻は renderer の描画通知 (record_demo_projected RPC) からのみ記録される
        NULL;

    ELSIF p_action = 'check_or_expire_120m' THEN
        NULL;

    ELSIF p_action = 'stop' THEN
        IF s.class_started_at IS NULL THEN RAISE EXCEPTION 'not_started'; END IF;
        UPDATE public.sessions
        SET reaction_ai_status = 'stopped',
            projection_status = 'stopped',
            status = 'completed'
        WHERE id = s.id;

    ELSE
        RAISE EXCEPTION 'invalid_action';
    END IF;

    -- ログ記録
    INSERT INTO public.event_logs(session_id, event_type, metadata)
    VALUES(
        s.id,
        'supportalk_' || p_action,
        jsonb_build_object(
            'mode', s.reaction_ai_mode,
            'reaction_ai_status', s.reaction_ai_status,
            'projection_status', s.projection_status,
            'is_expired', v_is_expired
        )
    );

    SELECT * INTO STRICT s FROM public.sessions WHERE id = s.id;
    RETURN jsonb_build_object(
        'success', true,
        'mode', s.reaction_ai_mode,
        'status', s.status,
        'reactionAiStatus', s.reaction_ai_status,
        'projectionStatus', s.projection_status,
        'isMockAi', s.is_mock_ai,
        'pipelineEnabled', s.reaction_pipeline_enabled,
        'classStartedAt', s.class_started_at,
        'expiresAt', CASE WHEN s.class_started_at IS NOT NULL THEN s.class_started_at + interval '120 minutes' ELSE NULL END,
        'isExpired', (s.class_started_at IS NOT NULL AND clock_timestamp() >= s.class_started_at + interval '120 minutes'),
        'demoProjectedAt', s.demo_projected_at,
        'autoExpiredAt', s.auto_expired_at
    );
END;
$$;

REVOKE ALL ON FUNCTION public.control_reaction_session(uuid, text, text, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.control_reaction_session(uuid, text, text, boolean) TO service_role;

-- 2.5 guard_reaction_condition の更新（個別停止・再開に対応しつつ、実験条件modeの変更・手動終了後の再開・期限切れ後の再開は禁止）
CREATE OR REPLACE FUNCTION public.guard_reaction_condition() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
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

REVOKE ALL ON FUNCTION public.guard_reaction_condition() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.guard_reaction_condition() TO service_role;

-- 3. 120分期限対応版 finish_reaction_job
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

REVOKE ALL ON FUNCTION public.finish_reaction_job(uuid, uuid, text, text, text, integer, jsonb, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.finish_reaction_job(uuid, uuid, text, text, text, integer, jsonb, timestamptz) TO service_role;

-- 4. 研究者・教授向けセッション別閲覧用ビュー（学生非公開）
-- ビュー1: 授業回一覧と全体進行・AI運転状態
CREATE OR REPLACE VIEW public.v_research_session_overview AS
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
    (SELECT count(*)::int FROM public.session_attendances sa WHERE sa.session_id = s.id) AS participant_count,
    (SELECT count(*)::int FROM public.posts p WHERE p.session_id = s.id AND p.author_type = 'human' AND NOT p.is_deleted) AS human_post_count,
    (SELECT count(*)::int FROM public.posts p WHERE p.session_id = s.id AND p.author_type = 'ai' AND NOT p.is_deleted) AS ai_reply_count
FROM public.sessions s
WHERE s.room_mode = 'shared'
ORDER BY s.session_number DESC, s.created_at DESC;

-- ビュー2: 投稿とAI返信・時刻・生成元の対応一覧
CREATE OR REPLACE VIEW public.v_research_posts_and_replies AS
SELECT
    s.session_number,
    s.id AS session_id,
    hp.id AS human_post_id,
    hp.author_display_name AS student_display_name,
    hp.message AS student_message,
    hp.created_at AS post_created_at,
    hp.likes AS post_likes,
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
WHERE hp.author_type = 'human' AND NOT hp.is_deleted
ORDER BY hp.created_at ASC;

-- ビュー3: 授業操作・自動終了・イベントログ一覧
CREATE OR REPLACE VIEW public.v_research_session_logs AS
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
ORDER BY el.created_at DESC;

-- 閲覧用ビューの権限管理（学生anon/authenticatedには非公開、service_roleのみ）
REVOKE ALL ON public.v_research_session_overview FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.v_research_session_overview TO service_role;

REVOKE ALL ON public.v_research_posts_and_replies FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.v_research_posts_and_replies TO service_role;

REVOKE ALL ON public.v_research_session_logs FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.v_research_session_logs TO service_role;

COMMIT;
