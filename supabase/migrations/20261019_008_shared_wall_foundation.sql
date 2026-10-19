-- 共有コメントスクリーン版の基礎。既存の3ルーム授業には影響しない追加変更のみ。
BEGIN;

ALTER TABLE public.sessions
  ADD COLUMN IF NOT EXISTS room_mode TEXT NOT NULL DEFAULT 'split'
  CHECK (room_mode IN ('split', 'shared'));

ALTER TABLE public.sessions
  ADD COLUMN IF NOT EXISTS screen_slug TEXT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS sessions_screen_slug_unique
  ON public.sessions (screen_slug)
  WHERE screen_slug IS NOT NULL;

ALTER TABLE public.sessions
  ADD CONSTRAINT sessions_shared_screen_slug_required
  CHECK (room_mode <> 'shared' OR screen_slug IS NOT NULL) NOT VALID;

ALTER TABLE public.sessions
  VALIDATE CONSTRAINT sessions_shared_screen_slug_required;

COMMENT ON COLUMN public.sessions.room_mode IS 'split: A/B/C分割、shared: 授業全体で1ルーム';
COMMENT ON COLUMN public.sessions.screen_slug IS '共有投影画面URLに使用する推測困難な公開トークン';

COMMIT;

-- 適用後の読み取り専用確認例:
-- SELECT id, session_number, room_mode, screen_slug FROM public.sessions ORDER BY scheduled_at DESC;
