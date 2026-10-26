# PGRST202 Room Access Error & Root Cause Summary

## 1. PGRST202 エラー全文 (Supabase PostgREST)
```json
{
  "code": "PGRST202",
  "details": "Searched for the function public.verify_reaction_room_access with parameters p_auth_user_id, p_participant_id, p_room_id, p_room_slug, p_session_id or with a single unnamed json/jsonb parameter, but no matches were found in the schema cache.",
  "hint": null,
  "message": "Could not find the function public.verify_reaction_room_access(p_auth_user_id, p_participant_id, p_room_id, p_room_slug, p_session_id) in the schema cache"
}
```

## 2. 発生背景
- `verify_reaction_room_access` RPC 関数は、マイグレーションファイル `supabase/migrations/20261026_020_delivery_integrity.sql`（268〜279行目）に定義されていました。
- リモート Supabase データベース側にはこのマイグレーションが未適用（未実行）であったため、PostgREST のスキーマキャッシュに関数が存在せず `PGRST202` が発生しました。

## 3. 影響とループ発生メカニズム
1. 学生が `/enter/[entrySlug]` で名前入力・研究同意後に「入室」ボタンをクリック。
2. `/api/enter` は 200 OK を返し、セッションCookie（`classaid_session`）を発行。
3. クライアントが `/room/[roomSlug]` へ遷移。
4. `/room/[roomSlug]` 画面で `GET /api/rooms/[roomSlug]/posts` を実行。
5. サーバー側の `lib/room-access.ts` で `verify_reaction_room_access` RPC を呼び出すが、`PGRST202` エラーにより例外/失敗となり `null` を返却。
6. `/api/rooms/[roomSlug]/posts` が 403 Forbidden（`{ error: 'ルームへのアクセス権がありません。再度入室してください。' }`）を返却。
7. クライアントの `app/room/[roomSlug]/page.tsx`（59〜63行目）で 403 を検知し、`router.replace('/join')` を実行。
8. `/join` が最新の入室画面 `/enter/[entrySlug]` へ 303 リダイレクトし、入室画面へ戻るループが発生。

## 4. 最小修正内容
- `lib/room-access.ts` において、未適用 RPC `verify_reaction_room_access` の呼び出しを廃止。
- 既存のリモートDBに存在するテーブル（`rooms`, `sessions`, `session_attendances`, `participant_auth_links`）に対する直接照合クエリを復元し、正常に 200 OK が返る構成に修正。
