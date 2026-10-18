-- ==============================================================================
-- ClassAid 開発確認用セッション（研究分析から除外）
-- AIなし・標準AI・ダメっこAIの候補生成と投稿を安全に確認するためのデータ
-- ==============================================================================

BEGIN;

INSERT INTO public.sessions (
    id, session_number, wave_number, research_stage, scheduled_at,
    entry_slug, status, is_locked, protocol_snapshot,
    cycle_count, cycle_duration_minutes, slot_minutes
) VALUES (
    '00000000-0000-0000-0000-000000000010'::uuid,
    0, 0, 'baseline', now(),
    'ai-pipeline-test', 'scheduled', FALSE,
    '{"exclude_from_analysis":true,"purpose":"ai_pipeline_test"}'::jsonb,
    3, 20, '[3,6,9,12,15,18]'::jsonb
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.rooms (id, session_id, group_label, room_slug, ai_condition)
VALUES
    ('00000000-0000-0000-0000-000000000011'::uuid, '00000000-0000-0000-0000-000000000010'::uuid, 'A', 'ai-pipeline-test-a', 'none'),
    ('00000000-0000-0000-0000-000000000012'::uuid, '00000000-0000-0000-0000-000000000010'::uuid, 'B', 'ai-pipeline-test-b', 'standard'),
    ('00000000-0000-0000-0000-000000000013'::uuid, '00000000-0000-0000-0000-000000000010'::uuid, 'C', 'ai-pipeline-test-c', 'damekko')
ON CONFLICT (id) DO NOTHING;

COMMIT;
