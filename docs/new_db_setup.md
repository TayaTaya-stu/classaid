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


## Phase 1 corrective update 2026-10-25

Do not execute SQL in the old ClassAid or Shared Wall projects.
After scripts 000, 001 through 011, 012, and 013, run
`20261025_014_reaction_ai_reliability.sql` on the NEW database only.
014 has not yet been run on a real Supabase project. Back up any trial data first.
It creates a trigger; it is a one-time migration, not a repeatedly executed setup script.

The pipeline is OFF by default even for newly created sessions. For a newly created
DEVELOPMENT session only, explicitly set `reaction_pipeline_enabled=true`,
`reaction_ai_mode` to the chosen mode, and `is_mock_ai=true` before submitting posts.
This is temporary SQL setup until the Phase 2 mode UI exists. Never enable a historical
session: recovery would intentionally enqueue its missing human posts.

Phase 1 mock and fallback text are visibly marked test fixtures, not valid research stimuli.
The real external AI, semantic fallback selection, audio, PDF extraction, start demo,
and student-side nested reply UI have not been implemented by this update.

The post INSERT and durable job enqueue now share a DB transaction. If that DB transaction
fails, submission returns failure, rather than falsely reporting a saved post. AI generation
and finalization happen separately after submission; their failure never rolls back the human post.

`after()` kicks the first worker. It is NOT a periodic scheduler. To recover interrupted jobs,
log in as admin, then call POST `/api/admin/reaction-jobs` from the same-origin browser.
The call recovers missing jobs for explicitly enabled sessions, claims up to 10 atomically,
and processes them. Repeat for more jobs. Failed jobs can be reset with PUT to the same endpoint
with JSON `{ "sessionId": "the-development-session-uuid" }`, then POST again.
No Vercel cron has been configured. A periodic authenticated worker and monitoring are required
before production; a cron alone would not establish the normal 3-second response target.

Projection uses ONLY `reaction-events-v1` / `afterCursor`. An old overlay binary is not compatible
with this new backend; keep old binaries pointed at the old site. During local tests use `npm run overlay`.
The new portable binary must be rebuilt and tested before distribution.

Deleted parent or reply suppresses the whole pair; cursor advances over intentional deletions.
A missing referenced record or DB error fails the batch without advancing the client cursor.
A later deletion cannot retract a pair already delivered; moderation controls require later work.

Render logs use the unguessable screen URL as a session-scoped capability. Do not publish that URL
outside the lecturer workflow. Per-event/client/phase uniqueness limits duplicate writes; a best-effort
per-session request bound is also implemented. This is not an admin credential or proof of attention.
`dom_added` means DOM insertion; `viewport_entered` is the next animation-frame callback with the element
at the viewport edge. Neither proves that a projector displayed pixels or that anyone read them.
`render_latency_ms` measures IPC dispatch to renderer callback on the same PC. DB `created_at` records
server receipt. Never subtract clocks from different devices as an exact end-to-end latency.

No human-only fallback exists for an AI-enabled session except explicit emergency stop.
Unexpected DB errors leave a failed/recoverable job. No software can provide an AI response during
an unavailable DB/network/projector; the objective is recovery without losing the original post.

## 2026-10-25 名前ログイン確定仕様・授業文脈永続化（017 適用済み）

新Supabaseプロジェクトにおいて、017の適用が完了しています。
`PARTICIPANT_HMAC_SECRET` および `GEMINI_API_KEY` は `.env.local` に設定済みです。

---

## 2026-10-25 SupporTalk確定仕様・個別停止/120分自動終了/研究用ビュー（018 ★実DB未適用）

### 概要
- **対象**: 新規reactionプロジェクトのみ。既存マイグレーション（000〜017）は一切変更しない。
- **ファイル**: `supabase/migrations/20261025_018_supportalk_controls_and_views.sql`
- **内容**:
  1. `public.sessions` へのカラム追加:
     - `projection_status text DEFAULT 'active'`（投影状態: 'active', 'paused', 'stopped'）
     - `demo_projected_at timestamptz DEFAULT NULL`（研究用デモ投稿の実投影時刻）
     - `auto_expired_at timestamptz DEFAULT NULL`（120分経過による自動停止時刻）
  2. `public.control_reaction_session`:
     - アクション拡張: `start`, `stop`, `pause_ai`, `resume_ai`, `pause_projection`, `resume_projection`, `record_demo_projection`, `configure`。
     - 二重開始防止（`already_started`）、授業中の条件変更ロック、120分期限超過後の操作ブロック（`session_expired`）。
  3. `public.guard_reaction_condition`:
     - 授業開始後の実験条件（`reaction_ai_mode`）およびモック設定の変更を厳格にロック（4条件を保護）。
     - 個別の「AIのみ停止」「投影のみ停止」とその再開は許可。
     - 120分経過後は再開不可（`session_expired`）。
  4. `public.finish_reaction_job`:
     - 120分期限チェックを追加。期限経過後はAI返信（`posts` へのaiレコード挿入）を行わず、`event_type = 'human_only'` として安全に確定（消失・重複・終了後の不正投影を完全防止）。
  5. 研究用ビュー3種の新設:
     - `v_research_session_overview`: 授業回・日時・条件・参加者数・投稿数・AI返信数・デモ投影時刻・自動終了時刻。
     - `v_research_posts_and_replies`: 投稿とAI返信、時刻、生成元、モデル名、プロンプト版、参照根拠の対応一覧。
     - `v_research_session_logs`: 授業開始・停止・再開・音声切断・復旧・自動終了・デモ投影等の時系列記録。
     - `REVOKE ALL` により学生・匿名から非公開、`service_role` および管理画面からのみ参照可能。

### 実DBへの適用手順（指示があるまで実行しないこと）
1. Supabase DashboardのSQL Editorを開きます。
2. `supabase/migrations/20261025_018_supportalk_controls_and_views.sql` の全内容を貼り付けて実行（Run）します。
3. エラーなく成功することを確認します。



## 2026-10-26 追加修正（実DB未適用）

新規20261026_020_delivery_integrity.sqlが必要です。既存000〜019は変更しません。適用前の授業開始は拒否します。詳細・残る実機確認・保持方針はdocs/delivery-integrity-review-20261026.mdを参照してください。旧中止パッチの020とは異なります。
