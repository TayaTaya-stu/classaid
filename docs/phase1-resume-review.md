# Phase 1 中断状態からの修正

2026年10月25日。入力は reaction-ai-current-review.zip に含まれる未コミット状態。
この変更は 3c80631 からの累積パッチではない。送付ZIPの状態に一度だけ適用する。
元のClassAid・Shared Wall、Supabase、Vercelには接続も変更もしていない。

## 変更

- 人間投稿のDB保存とジョブ作成をトリガーで同一トランザクションにした。
- ワーカーは SKIP LOCKED によるclaimと期限付きlease tokenを使う。
- AI返信・研究ログ・投影イベント・ジョブ完了は一つのRPCで確定する。
- 設定取得失敗でモックを有効化せず、失敗を回収対象として記録する。
- RPC失敗時の直接INSERTと、旧postsカーソルへの自動切替を廃止した。
- 削除済みの親または返信は組ごと非表示。DB取得失敗ではカーソルを進めない。
- 450msずつの表示待ちを撤廃し、AI返信を小さく次行へ表示する。
- 投影通知の保存API、限定的なscreen capability検証、重複抑止を追加した。
- モックと予備返信を独立ファイルへ分離。文章は試験用であり実験用ではない。
- Supabase設定不足をダミー接続先で隠さない。

## 検証

- TypeScript型検査 合格。
- ESLint 合格。
- Next.js本番build 合格。22ページの静的生成、追加render API含むルートを確認。
- Electron mainとrendererの構文検査 合格。
- DOM模擬テスト:50組を待ちタイマーなしで8位置へ追加し、DOM追加と次フレーム通知を確認。
- PGlite（組込みPostgreSQL）:旧基盤から追加014まで15本のSQLを順に実行。
- 投稿トリガーによるジョブ作成、二重claim拒否、不正lease拒否、確定の冪等性を確認。
- 投影INSERTで意図的にエラーを発生させ、返信・ログがまとめて取り消されることと再試行成功を確認。
- 期限切れlease回収後に古いworkerを拒否すること、offのジョブ完了、追記専用ログ更新拒否、関数実行権限を確認。

PGliteではSupabaseのauth.usersとstorage.bucketsを最小のテスト用テーブルで代用している。
実SupabaseのAuth/Storage/PostgREST・ネットワーク・複数DB接続の実並行負荷は未検証。
Windows Electronの実描画、投影機、スマホ、実授業環境、3秒目標、120人負荷は未検証。
DOM通知は実表示や注視の証明ではない。

## この段階で完成していないもの

実AI、音声進行メモ、PDF抽出検索、開始デモ、教授と管理者の4択UI、学生画面の従属返信、
正式予備文、Vercel上の定期回収ワーカーは後続作業。
ローカルでの復旧は管理者APIの明示的実行。定期スケジューラがあるとは扱わない。

## 再現用テスト

`node tests/reaction-overlay.mjs`

SQL検証は製品のpackage.jsonを変更せず、別フォルダにインストールした
@electric-sql/pglite を環境変数 PGLITE_MODULE のモジュールパスで指定して
`node tests/reaction-sql.mjs` を実行した。実DBへ接続するテストではない。

## 適用後

まだSQLを実行しない。まずローカルで差分・型・lint・buildを確認し、コミットを作る。
その後、新しいSupabaseプロジェクトの作成と設定を一つずつ行う。
詳細は docs/new_db_setup.md の最終節を参照。
