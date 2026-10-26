-- SupporTalk migration 021: Fix set_designated_session for safeupdate compatibility
-- Apply after 020. Review before running remotely.
BEGIN;

CREATE OR REPLACE FUNCTION public.set_designated_session(p_session_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE
  s public.sessions%ROWTYPE;
BEGIN
  -- 1. トランザクション単位のアドバイザリーロックで並行指定競合を直列化
  PERFORM pg_advisory_xact_lock(hashtext('designated_reaction_session'));

  -- 2. 対象セッションを行ロックして検証（共有ウォール、未ロック、有効期限内、未完了）
  SELECT * INTO s FROM public.sessions WHERE id = p_session_id FOR UPDATE;
  IF NOT FOUND OR s.room_mode <> 'shared' OR s.is_locked OR s.status IN ('completed', 'closed', 'locked')
     OR s.auto_expired_at IS NOT NULL
     OR (s.class_started_at IS NOT NULL AND clock_timestamp() >= s.class_started_at + interval '120 minutes') THEN
    RETURN jsonb_build_object('success', false, 'error', 'session_closed');
  END IF;

  -- 3. 別の指定セッションが現在授業中であれば切替を拒否
  IF EXISTS (
    SELECT 1 FROM public.sessions
    WHERE is_current_target
      AND id <> s.id
      AND status = 'in_progress'
      AND NOT is_locked
      AND auto_expired_at IS NULL
      AND clock_timestamp() < class_started_at + interval '120 minutes'
  ) THEN
    RETURN jsonb_build_object('success', false, 'error', 'class_in_progress');
  END IF;

  -- 4. 現在指定中の行と新しく指定する行のみに限定してアトミックに更新（safeupdate適合）
  UPDATE public.sessions
  SET is_current_target = (id = s.id)
  WHERE is_current_target OR id = s.id;

  RETURN jsonb_build_object('success', true, 'designatedSessionId', s.id);
END;
$$;

REVOKE ALL ON FUNCTION public.set_designated_session(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.set_designated_session(uuid) TO service_role;

COMMIT;
