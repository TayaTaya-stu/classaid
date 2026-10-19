-- 共有版の画面・入室・AI介入を確認する開発専用授業回。
-- 本番授業回は日程と条件の確定後、別SQLで作成する。
DO $$
DECLARE
  v_session_id UUID := gen_random_uuid();
  v_token TEXT := replace(gen_random_uuid()::text, '-', '');
BEGIN
  INSERT INTO public.sessions (
    id, session_number, wave_number, research_stage, scheduled_at,
    entry_slug, screen_slug, room_mode, status, is_locked,
    protocol_snapshot, cycle_count, cycle_duration_minutes, slot_minutes
  ) VALUES (
    v_session_id, 0, 0, 'baseline', now(),
    'shared-dev-' || v_token,
    'screen-' || replace(gen_random_uuid()::text, '-', ''),
    'shared', 'scheduled', FALSE,
    jsonb_build_object('exclude_from_analysis', true, 'purpose', 'shared_wall_development'),
    3, 20, '[3, 6, 9, 12, 15, 18]'::jsonb
  );

  INSERT INTO public.rooms (session_id, group_label, room_slug, ai_condition)
  VALUES (
    v_session_id,
    'A',
    'shared-room-' || replace(gen_random_uuid()::text, '-', ''),
    'damekko'
  );
END;
$$;

-- 実行後、管理画面で最新の「開発テスト」を選ぶと投影画面へのボタンが現れる。
