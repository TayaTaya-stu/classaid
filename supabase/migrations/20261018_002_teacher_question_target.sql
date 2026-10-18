-- ==============================================================================
-- ClassAid 研究用データベース改修 マイグレーション (フェーズ3-2)
-- ファイル名: supabase/migrations/20261018_002_teacher_question_target.sql
-- 目的: 学生投稿の宛先種別（みんなへ / 先生への質問）を区別する audience_type カラムの追加
-- 
-- 【注意事項 / 警告】
-- 1. このスクリプトは Supabase SQL Editor または Supabase CLI で手動実行するためのものです。
-- 2. DROP TABLE, DROP COLUMN, TRUNCATE, DELETE などのデータ破壊的命令は含まれていません。
-- 3. 既存テーブル (posts) の既存データはすべて維持され、既存投稿はすべて 'room' (みんなへ) として扱われます。
-- 4. 001_research_foundation.sql 適用済みの環境に対して実行してください。
-- ==============================================================================

BEGIN;

-- posts テーブルに audience_type カラムを追加
-- 値は 'room' (ルーム全体 / みんなへ) または 'teacher' (先生への質問) のみ許可
ALTER TABLE posts 
ADD COLUMN IF NOT EXISTS audience_type TEXT NOT NULL DEFAULT 'room' 
CHECK (audience_type IN ('room', 'teacher'));

COMMENT ON COLUMN posts.audience_type IS '投稿の宛先種別: room (みんなへ), teacher (先生への質問)';

-- 将来の教授・管理者画面における「先生への質問」横断検索および各ルームでの高速なフィルタリング用インデックス
CREATE INDEX IF NOT EXISTS idx_posts_audience_type ON posts (audience_type);
CREATE INDEX IF NOT EXISTS idx_posts_room_audience ON posts (room_id, audience_type);

COMMIT;

-- ==============================================================================
-- 【実行後検証クエリ】
-- マイグレーション実行後、カラム追加と既存レコードの状態を確認するための読み取り専用クエリです。
-- ==============================================================================
/*
SELECT 
    column_name, 
    data_type, 
    is_nullable, 
    column_default 
FROM information_schema.columns 
WHERE table_name = 'posts' AND column_name = 'audience_type';

-- 既存投稿がすべて 'room' として扱われていることを確認
SELECT 
    audience_type, 
    count(*) 
FROM posts 
GROUP BY audience_type;
*/
