# 新規Supabaseプロジェクト初期化・セットアップ手順書 (Reaction AI版)

本手順書は、旧版（`classaid`, `classaid-shared-wall`）のデータベースや本番環境に影響を与えずに、返信AI版（`classaid-reaction-ai`）を独立稼働させるためのデータベース環境構築手順です。

---

## 1. Supabaseプロジェクトの新規作成
1. [Supabase Dashboard](https://supabase.com/dashboard) へログインし、**「New project」** をクリックします。
2. プロジェクト名（例: `classaid-reaction-ai`）を入力し、安全なデータベースパスワードを設定します。
3. リージョンは日本国内推奨（例: `Northeast (Tokyo) / ap-northeast-1`）を選択します。

---

## 2. 認証設定 (Auth Settings)
学生が学籍番号で匿名入室できるようにするため、匿名認証を有効化します。

1. ダッシュボードの左メニュー **「Authentication」** → **「Providers」** を開きます。
2. **「Anonymous sign-ins」** を展開し、**「Enable Anonymous Sign-ins」** をオンにして保存します。

---

## 3. ストレージバケットの作成 (Storage)
講義スライドPDFを保存するためのバケットを作成します。

1. 左メニュー **「Storage」** を開きます。
2. **「New bucket」** をクリックします。
   * **Name**: `lecture-materials`
   * **Public bucket**: オフ（非公開・service_role経由アクセス）
3. 作成を完了します。

---

## 4. マイグレーションSQLの順次実行 (SQL Editor)
左メニュー **「SQL Editor」** を開き、以下の順番でSQLを実行します。
（本リポジトリの `supabase/migrations/` 配下のファイルを順番に開いて実行してください）

1. `000_fresh_shared_wall_base.sql`（基本テーブル作成: posts, post_likes, settings）
2. `20261018_001_research_foundation.sql`（研究基盤: sessions, rooms, participants, attendances 等）
3. `20261018_002_teacher_question_target.sql`（教員質問ターゲット拡張）
4. `20261018_003_secure_legacy_admin.sql`（レガシー管理権限セキュリティ）
5. `20261018_004_session_control.sql`（セッション進行・一時停止関数）
6. `20261018_005_reuse_ready_cycles.sql`（サイクル再利用制御）
7. `20261018_006_atomic_ai_approval.sql`（AI承認アトミック関数）
8. `20261019_007_ai_test_session.sql`（AIテスト用関数）
9. `20261019_008_shared_wall_foundation.sql`（共有コメントスクリーン拡張: room_mode, screen_slug）
10. `20261019_009_shared_wall_test_session.sql`（共有ウォールテスト関数）
11. `20261019_010_flexible_ai_protocols.sql`（差し替え可能プロトコル基盤）
12. `20261020_011_create_shared_session.sql`（共有セッション原子的作成RPC: `create_shared_session`）
13. `012_session_log_views.sql`（研究分析用ビュー）
14. **`20261025_013_reaction_ai_foundation.sql`**（★返信AI基盤）
    * `sessions` への返信AI制御カラム追加 (`reaction_ai_mode`, `reaction_ai_status`, `is_mock_ai`, `lecture_theme`)
    * 親投稿への重複AI返信防止一意インデックス (`posts_parent_ai_reply_unique`)
    * 非同期返信ジョブ永続キュー (`ai_reply_jobs`)
    * 直列化単調増加投影キュー (`projection_events`)
    * 排他アドバイザリーロック付き原子的採番関数 (`create_projection_event_atomic`)
    * 研究分析用返信ログ (`ai_reply_logs`)
    * 実描画開始ログ (`projection_render_logs`)

> [!NOTE]
> 一括結合したスクリプトとして流すことも可能です。各ファイルは `BEGIN;` 〜 `COMMIT;` のトランザクション単位で安全に分割されています。

---

## 5. 環境変数の設定 (ローカル開発環境)
新規プロジェクトのダッシュボード **「Project Settings」** → **「API」** からキーを取得し、`classaid-reaction-ai/.env.local` を作成します。

```env
# 新Supabaseプロジェクトの設定値
NEXT_PUBLIC_SUPABASE_URL=https://[YOUR-NEW-PROJECT-REF].supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=[YOUR-NEW-ANON-KEY]
SUPABASE_SERVICE_ROLE_KEY=[YOUR-NEW-SERVICE-ROLE-KEY]

# 参加者識別用HMAC秘密鍵（ランダムな32バイト以上の文字列）
PARTICIPANT_HMAC_SECRET=[ランダムな文字列]

# 管理者・教員パスワードとセッション署名鍵
ADMIN_SESSION_SECRET=[ランダムな文字列]
ADMIN_ACCESS_PASSWORD=[実験者用パスワード]
TEACHER_ACCESS_PASSWORD=[先生用パスワード]

# Google Gemini APIキー（Phase 3以降で利用）
GEMINI_API_KEY=[YOUR-GEMINI-API-KEY]
```

※ 旧プロジェクトの `.env.local` は決して上書きコピーせず、必ず新しいプロジェクト専用の値を使用してください。
