BEGIN;

-- 旧管理画面が利用していたsettingsへのブラウザ直接アクセスを停止する。
-- 今後の管理操作は、管理者Cookieを検証するサーバーAPIのみを経由する。
DROP POLICY IF EXISTS "Anyone can read settings" ON public.settings;
DROP POLICY IF EXISTS "Anyone can update settings" ON public.settings;

COMMIT;
