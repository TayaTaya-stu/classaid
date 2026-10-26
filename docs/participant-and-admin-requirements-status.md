> 2026年10月26日 追記：入口・旧経路の整理差分は `docs/cleanup-review-20261026.md` を参照。そこに記載した変更はローカル検証済み、Windowsへの反映と実機確認は未実施。下記の古い音声・教授Web画面の説明より優先する。

# SupporTalk（授業サポートAI）実装状況および検証レポート

更新日: 2026-10-25（最新確定仕様 反映版）

---

## 1. 現在の環境状態

- **作業先**: `c:\Users\koko\Desktop\classaid-reaction-ai`
- **作業ブランチ**: `reaction-ai-prototype`
- **新Supabaseプロジェクト**: **017まで適用済み**（旧プロジェクト・旧DBは一切変更なし）。
- **環境変数**: `PARTICIPANT_HMAC_SECRET`、`GEMINI_API_KEY` ともに `.env.local` に設定済み。
- **018マイグレーション**: `supabase/migrations/20261025_018_supportalk_controls_and_views.sql` を新規作成済み（※**実DBへは未適用**。指示に基づき実行待ち）。
- **Git状態**: 既存変更を保持。commit・push・公開は未実施。

---

## 2. 実装完了項目（確定仕様との整合）

### 【名称・学生画面】
- **システム名称統一**: システム名を「**SupporTalk**」に刷新。現行UI・Electron投影アプリ・AIプロンプトから「コメントスクリーン」という名称を完全撤去。
- **学生画面アイコン・見出し**: 学生画面の「Cマーク」アイコンを撤去し、SupporTalkバッジを配置。見出しを「**授業チャットに参加**」に統一。
- **カメラ利用案内（最重要）**: QRコード横（教員画面・投影Web画面・ElectronフローティングQR画面）および入室画面に、以下の案内を目立つ枠で配置：
  > 「スマートフォンに最初から入っている『カメラ』アプリでQRコードを読み取ってください。次回も同じスマートフォンを使ってください。LINEなどのQR読み取り機能は使わないでください。」
- **名前ログインと継続利用**:
  - 名前の継続利用を促す大きな注意喚起枠（「この名前は、次回以降の授業でも使います。必ず覚えておいてください。初めての方は好きな名前を、2回目以降の方は前回と同じ名前を入力してください。」、例「あおぞら、たろう、さくら」）を配置。
  - 前回参加情報がある場合の先行確認（「前回は『名前』で参加しました。この名前で参加しますか？」［はい］［いいえ］）および別名選択時の安全な新規Auth取得。
  - 同名登録時の自己申告確認モーダル（「以前この名前で参加しましたか？」）を維持。
- **丁寧な研究同意説明（選択前提示）**:
  - 研究利用の同意選択前に、研究目的、名前・投稿・時刻・いいね等の利用、複数回の参加記録の統計的対応付け（個人情報非収集）、同意なしでも利用できること（成績影響なし）を明確に説明。

### 【事前準備と教授の操作】
- **事前準備情報の自動読み込み**: 実験者が事前登録した授業回、日時、AI条件（AIなし／共感／授業接続／中立）、講義PDF情報を教授アプリ（`/teacher`）が初期ロード。
- **通常画面の集約**: 「QR表示」と大きな「**授業開始**」ボタンを中心に配置。
- **詳細設定リンク**: 実験者・教員が必要時に確認・アクセス可能なリンクを画面下部に配置。
- **授業中の条件変更禁止**: 授業開始後はAIモードやモック設定の変更をDBトリガー（`guard_reaction_condition`）およびAPIで厳格にロック（4条件を維持）。

### 【授業開始の一本化】
- **一括起動（ボタン1つ）**:
  - AIあり回：設定済みのAI条件 ＋ 音声取得 ＋ 投影アプリを一括起動。
  - AIなし回：音声取得 ＋ 投影アプリを一括起動（AI返信は出さない）。
- **ステップ・バイ・ステップ案内**: 開始後にセッション、マイク許可、投影アプリの各段階をチェックし、マイク未許可時などはその部分だけ個別に再試行可能（全体成功と誤認させない）。
- **ブラウザとElectronの連携**: 投影アプリ側にプロトコルハンドラー（`supportalk://open?screenUrl=...`）および最新セッション自動検出API（`/api/screen/latest`）を実装。教授が毎回URLをコピー＆ペーストする必要を撤廃。

### 【停止・120分終了】
- **個別停止・再開操作**:
  - 「**AIのみ停止**」（音声取得停止を含む。AIなし回は「**音声のみ停止**」と表示）および「**投影のみ停止**」の独立した小さなボタンを配置。
  - 個別停止から再開可能（実験条件は不変）。
- **120分自動終了保護**:
  - 授業開始から120分でAI・音声・投影をすべて自動停止。
  - 停止・再開やアプリ再起動・スリープ復旧でも終了予定時刻（`class_started_at + 120分`）を延長しない。
  - サーバー側RPC（`control_reaction_session`, `finish_reaction_job`）および画面取得API（`/api/screen/[slug]/posts`）で期限超過後の操作・新規AI生成を厳格に拒否（`session_expired`）。
  - 処理中だったジョブは安全に `human_only` として確定し、AI reply postを生成せず、投影イベントの消失・重複・終了後不正投影を防止。

### 【音声障害耐性】
- **静かな自動復旧**: 正常時の過剰表示を排し、音声途切れ時は警告を連発せずバックグラウンドで自動再接続を試行。
- **フォールバック階層**: 音声メモ → PDF関連テキスト → 授業テーマIT → モード別予備返信マスターの順で継続稼働。
- **長時間障害表示**: 60秒以上復旧しない場合のみ控えめな警告と再試行ボタンを表示。
- **障害ロギング**: 音声切断（`audio_disconnected`）、復旧（`audio_reconnected`）、予備返信使用をすべてDBログに記録。

### 【Supabase上の研究データ一覧・閲覧ビュー】
- **3つの閲覧用ビューを018で新設**:
  1. `v_research_session_overview`: 授業回、日時、AI条件、テーマ、参加者数、投稿数、AI返信数、デモ実投影時刻、自動終了時刻の一覧。
  2. `v_research_posts_and_replies`: 学生表示名、投稿内容、投稿時刻、いいね数、対応するAI返信、返信時刻、生成元、モデル名、プロンプト版、参照根拠の対応一覧。
  3. `v_research_session_logs`: 授業開始・停止・再開・音声切断・復旧・自動終了・デモ投影などの時系列イベント記録（日本語ラベル付き）。
- **アクセス制御**: 学生・匿名アクセスを完全剥奪（`REVOKE ALL`）、`service_role` および管理画面「研究用ビュー」タブから閲覧可能。

### 【日時入力】
- **JST初期値**: 日本標準時の現在日時（`YYYY-MM-DDTHH:mm`）を初期表示。
- **厳格な検証**: 年4桁（2020〜2099）、月2桁（01〜12）、日2桁（01〜31）、時2桁（00〜23）、分2桁（00〜59）をUIとAPIで正規表現および数値範囲チェック。

---

## 3. 自動テストおよび検証結果

以下の自動テストをローカル環境で実行し、すべて合格を確認しました。

### 【018レビュー修正項目（確定反映済み）】
1. **統一起動の応答確認連携**:
   - `handleUnifiedStart` は単なるURL遷移ではなく、Electronに `autostart=1` を渡して起動し、`/api/screen/[screenSlug]/overlay-status` をポーリングしてアプリからのアクティブ応答（ディスプレイ名付き）を確認した後に成功表示。
   - Electron側でもWindows起動引数 (`findProtocolArg`)、クォート除去、`displayId`、`autostart` の連動を実装。
2. **音声認識の閉包解消と厳格管理**:
   - `startSpeechEngine` 内の最新運転意図（`shouldRecordRef`）、期限（`sessionExpiresAtRef`）、授業ID（`currentSessionIdRef`）、マウント状態（`isMountedRef`）をmutable refで管理。
   - 停止・手動終了・画面離脱・120分満了後の意図しない自動再接続を完全遮断。初回切断からの600ms自動復旧も検証。
   - `recognition.start()` の戻り値だけで許可扱いにせず、`onstart` 実イベント発火まで `pending` を維持し、`onerror` 時に `denied` へ遷移。
   - 音声送信API（`/api/teacher/lecture-context`）のHTTP 409（期限切れ・終了）応答を受信した際は音声取得・送信を即時完全停止。
3. **120分終了のロールバック防止と実処理確定**:
   - 期限切れ時の操作拒否時にトランザクションをロールバックさせない構造に変更。`auto_expired_at`、`status = 'completed'`、および終了イベントログが確実にDBへコミット・永続化されることを検証。
   - `check_or_expire_120m` を実際の処理経路（`/api/screen/[screenSlug]/posts`、`controlReaction`）で呼び出し、期限到達を確実にDB確定。
   - `executeReactionJob` はGemini呼び出し前に期限と終了状態を事前検証し、期限切れ時はAI生成をバイパスして `human_only` で完了。
   - 音声受信API（`/api/teacher/lecture-context`）も終了・期限切れ後の更新を409で拒否。
   - Electron側にも保存した終了予定時刻（`sessionExpiresAt`）によるローカル停止タイマーを設け、通信断・スリープ復帰時も期限後の投影を完全防止。
   - 既に手動終了した授業の再開を拒否（`session_closed`）。
4. **投影の停止・再開における表示とカーソル整合性**:
   - 一時停止時は `overlayWindow.webContents.send('overlay:clear')` により画面上の字幕を即時消去。
   - 一時停止中は `lastCursor` を保持し、再開時に停止中に投稿されたコメントを漏れなく・重複なく順次配信。
5. **デモ実投影時刻のrenderer通知記録**:
   - 管理画面のボタン押下時刻を「実投影時刻」として保存する処理を撤廃（画面押下時間ではなく画面表示時間で記録）。
   - デモイベントに `isDemo: true` を付与し、renderer の `requestAnimationFrame` による `viewport_entered` コールバックから `/api/screen/[screenSlug]/render` 経由で `record_demo_projected` RPCを呼び出し、実際の実描画時刻を記録。
6. **研究ビューのカラム・取得修正**:
   - `v_research_session_logs` に `created_at` と `logged_at` の両方を公開し、API（`/api/admin/research-views?type=logs`）の並び順を `created_at` に修正。HTTP経由での正常取得を確認。
7. **対象授業の検出と認証保護**:
   - `/api/screen/latest` に教員パスワード/投影キー/トークン認証を義務付け、未認証アクセスを401拒否。
   - 単純な最大日時ではなく「現在進行中の授業」または「現在日時に最も近い本日の授業」を優先選択し、未来の授業の誤選択を防止。
   - リクエストの `host` ヘッダーから動的にオリジンを生成し、`localhost:3000`、`localhost:3001`、および公開URLのいずれでも正常稼働。

---

## 3. 自動テストおよび検証結果

以下の自動テストをローカル環境で実行し、すべて合格を確認しました。

1. **`tests/supportalk-review-018-reproduction-and-integration.mjs` (018レビュー7項目の再現・統合テスト)**:
   - Point 3: 120分終了時の非ロールバック（`auto_expired_at` とログのコミット）、`check_or_expire_120m` の単体確定、手動終了後再開拒否 (`session_closed`) → **PASS**
   - Point 5: 管理画面ボタン押下時刻の非記録、renderer実描画通知からの実投影時刻記録 → **PASS**
   - Point 4: 投影一時停止時の字幕消去、停止中投稿の保持・再開時配信、重複なしカーソル同期 → **PASS**
   - Point 6: 研究用ビュー（`v_research_session_logs`）の `created_at` および `logged_at` カラム整合性 → **PASS**
   - Point 1: Electron起動引数解析（`findProtocolArg`）の通常・引用符・フラグ対応 → **PASS**
   - Point 2: 音声認識ステートマシン、閉包分離、停止後・アンマウント後・期限後の再接続防止、切断時自動復旧 → **PASS**
   - Point 7: 対象授業選択（未来回誤選択防止、進行中/本日優先選択） → **PASS**
   - **ALL 7 REVIEW POINT TESTS PASSED**

2. **`tests/supportalk-full-flow.mjs` (PGliteによる全19マイグレーション統合テスト)**:
   - Test 1〜7（統一起動、学生入室・投稿・実AIメタデータ付きジョブ、デモ実描画記録、個別停止再開、120分自動終了、AIなしモード、研究ビュー3種） → **PASS**

3. **その他のユニット・統合テスト**:
   - `tests/participation-controls-sql.mjs` → **PASS**
   - `tests/reaction-sql.mjs` → **PASS**
   - `tests/participant-identity.mjs` → **PASS**
   - `tests/real-ai-and-context.mjs` → **PASS**
   - `tests/real-ai-stub-and-reaction-job.mjs` → **PASS**

4. **静的検証**:
   - `npx tsc --noEmit`: 型エラー 0件（**PASS**）

---

## 4. 検証済み項目と未確認事項の区別

### 【自動検証済み（ソフトウェア・ロジックとして動作確認完了）】
- [x] 018レビュー7項目の修正および再現・統合テスト全パス
- [x] 統一起動におけるElectron稼働確認ポーリングと段階別UI表示
- [x] 音声認識の閉包排除、mutable refによる状態管理、HTTP 409による停止
- [x] 120分自動終了時のロールバック防止（`auto_expired_at` 永続化）、`check_or_expire_120m` 確定、手動終了後の再開拒否
- [x] 投影一時停止時の字幕即時クリア、停止中投稿のカーソル保持と再開時順次配信
- [x] デモ実投影時刻のrenderer描画通知記録（ボタン押下時刻非記録）
- [x] 研究用ビューの `created_at` カラム整合性およびアクセス制御
- [x] `/api/screen/latest` の教員認証保護、本日・進行中授業の優先選択、動的オリジン対応

### 【未確認事項（物理ハードウェア・実環境での手動確認が必要な項目）】
- [ ] **物理ディスプレイでのPowerPoint最前面オーバーレイ投影**:
  - 複数モニター環境（プロジェクターや外部ディスプレイ）を接続した実Windows PC上で、実際のPowerPointスライドショーの最前面に透明ウィンドウが透過表示され、クリック透過と字幕アニメーションが滑らかに描画される物理的な視覚確認。
- [ ] **実USB/内蔵マイクによる長時間の講義音声入力**:
  - 実機PCのマイク入力から日本語音声を取得し、ブラウザ（Chrome等）のWeb Speech APIが教室環境下（スピーカー音声や周囲の雑音）で長時間安定動作することの物理的な確認。
- [ ] **実Gemini APIとの有償ライブ接続**:
  - `GEMINI_API_KEY` を用いて、実際の学生投稿および音声キーワードに対するGoogle Gemini APIのリアルタイム通信レイテンシ（2.2秒以内）と課金トークン消費の実測。
- [ ] **実Supabaseへのマイグレーション018適用**:
  - 実DBへの追加SQL実行は行わない指示のため未適用（ローカルPGliteで全19マイグレーションの正常適用を確認済み）。

3. **`tests/reaction-sql.mjs`**:
   - 全19マイグレーションの順次適用、アトミックジョブ確定、失敗時ロールバック、サービスロール権限 → **PASS**

4. **`tests/real-ai-stub-and-reaction-job.mjs`**:
   - 実Gemini生成スタブ、APIエラー時の安全な予備返信フォールバック、2.2秒タイムアウト制御、投稿意図分類、テストマーカー完全撤廃 → **PASS**

5. **`tests/real-ai-and-context.mjs`**:
   - 実PDF解析（unpdf）、日本語本文・ページ番号抽出、講義文脈保持、モード別予備返信 → **PASS**

6. **静的検証**:
6. **静的検証・テスト実績**:
   - `npx tsc --noEmit`: 型エラー 0件（**PASS**, exit code 0）
   - `npm run lint`: エラー 0件、警告 0件（**PASS**, exit code 0）
   - `tests/supportalk-review-018-reproduction-and-integration.mjs`: 全7検証項目合格（**PASS**, exit code 0）
   - `tests/supportalk-full-flow.mjs`: 全7統合フロー合格（**PASS**, exit code 0）
   - `tests/real-ai-and-context.mjs`: 単体テスト合格（**PASS**, exit code 0）
   - `tests/participation-controls-sql.mjs`: SQL・制約テスト合格（**PASS**, exit code 0）

---

## 4. 018レビュー指摘事項の反映完了（5項目）

1. **音声開始の状態表示完全分離**:
   - `handleUnifiedStart` 内の投影開始処理が `setStartSteps((prev) => ...)` 関数型アップデータを用い、音声認識（マイク）状態を初期値 `pending` で上書きする不具合を解消。
   - 音声取得状態と投影接続状態を独立して更新し、マイク未確認・拒否時には「音声取得を確認しました」を絶対に表示しないよう表示制御を厳格化。
2. **音声の停止・再開と授業回変更時の完全分離**:
   - `executeAction` が成否（boolean）を返し、`handleToggleAi` は `resume_ai` 成功時のみ `startSpeechEngine()` を起動。
   - 授業回変更時（`sessionId` 変更）に以前の音声認識インスタンスを明示停止・タイマークリア。古い認識結果の遅延到着や自動再接続が新しい授業回へ混入する経路を `targetSessionId === currentSessionIdRef.current` ガードにより完全遮断。
3. **投影の稼働確認とローカル120分期限保持**:
   - Electron `startOverlay` において、ウィンドウ描画（`loadFile`）の完了と初回 API ポーリング成功を確認してから `reportOverlayStatus(..., 'active')` を報告。
   - 初回取得時に `sessionExpiresAt` を確定保持し、万一の通信断発生時でもローカルタイマーにより120分で確実に投影を自動終了。
4. **デモ投稿の条件整合と描画ログ保存の確実化**:
   - `overlay:test` において、現在の `reactionAiMode` が `'off'` の場合は `eventType: 'human_only'`（`aiReply: null`）として投影送信し、AI返信を不当に表示しないよう条件を厳格化。
   - レンダラー側での描画完了コールバック（`overlay:rendered`）において、APIレスポンスの `res.ok` を確認し、HTTPエラー時には保存成功ログを出力しないよう修正。
5. **検証（型チェック・lint・実装直接テスト）**:
   - ESLint ルールを無効化することなく、全4エラー・6警告を解消（エラー 0件、警告 0件）。
   - テスト内の独自 `SpeechStateMachine` を撤廃し、`lib/reaction-ai/context.ts`（`extractCandidateKeywords`, `resolveReferenceEvidence`）およびマイグレーション017のDB RPC（`update_lecture_speech_context`, `update_lecture_pdf_context`）の実装そのものを直接検証するテストスイートへ移行。

---

## 4. 検証済み項目と未確認事項の区別

### 【自動検証済み（動作確認完了）】
- [x] システム名「SupporTalk」への刷新と「コメントスクリーン」文言・「Cマーク」の完全撤去
- [x] 学生入室画面のカメラ利用案内、名前記憶案内、事前同意説明、名前切り替え/自己申告引き継ぎ
- [x] 教員画面の一括「授業開始」ボタン、起動状況ステップチェック、個別マイク再試行導線
- [x] 「AIのみ停止」「投影のみ停止」の個別操作と再開、授業中の条件変更ロック
- [x] 120分自動終了、終了予定の非延長、スリープ復旧時フェンシング、サーバー側AI生成拒否、処理中ジョブの安全処理
- [x] 音声切断・復旧のDBロギング、多重フォールバック階層（音声→PDF→テーマ→予備返信）
- [x] Supabase研究用ビュー3種の作成と権限分離、管理画面からの閲覧
- [x] 日本時間（JST）の日時初期表示と4桁年・2桁月・2桁日の厳格検証
- [x] Electron投影アプリのSupporTalk化、最新授業自動検出API連携、プロトコルハンドラー

### 【未確認事項（実機・実接続による手動確認が必要な項目）】
- [ ] **実Gemini APIとのライブ通信**:
  - `GEMINI_API_KEY` は設定済みですが、実際の講義音声・学生投稿を用いたGemini APIとのリアルタイム通信（レイテンシ・生成品質の実測）は未実施。
- [ ] **実Windows環境でのPowerPoint最前面オーバーレイ投影**:
  - Electron投影アプリを実Windowsマシンで起動し、PowerPointスライドショーの最前面に透明ウィンドウとして重ねて、学生投稿とAI返信が流れる物理的な表示確認は未実施。
- [ ] **実Supabaseへのマイグレーション018適用**:
  - 実DBへの追加SQL実行は行わない指示のため未適用（ローカルPGliteで19全マイグレーションを検証済み）。


## 2026-10-26 追加修正（実DB未適用）

新規20261026_020_delivery_integrity.sqlが必要です。既存000〜019は変更しません。適用前の授業開始は拒否します。詳細・残る実機確認・保持方針はdocs/delivery-integrity-review-20261026.mdを参照してください。旧中止パッチの020とは異なります。
