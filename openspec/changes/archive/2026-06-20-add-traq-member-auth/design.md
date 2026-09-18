## Context

Jomon の払い戻しは受取人を traQ ID で渡す（実 API 調査で確定: v1 `trap_id`、v2 は User UUID→`name`）。Checkin の `users` は `mail_hash` のみで traQ ID を持たず、payout を本人解決できない。ユーザー決定により、traQ ログインを会員セッションにも使い、現役が traQ 認証済みで支払った時に `users.traq_id` を連結する。本 change はそのための認証基盤改修（[[add-auth-foundation]] / [[add-membership-collection]] への MODIFIED）。後続で Jomon アダプタ修正（fix-jomon-payout）と UI（add-member-ui）を行う。

## Goals / Non-Goals

**Goals:**
- セッションを traqId（traQ 認証）＋ user(userId/mailHash) のデュアル・アイデンティティ＋`isAdmin` に拡張。
- traQ ログイン＝会員セッション、会計は許可リスト・サブセット。
- `users.traq_id`(unique) 追加と、認証済み traQ ID の連結（traQ ログイン解決／支払い時保存）。
- `requireMember`/`requireUser`/`requireAdmin` と対応する手続きビルダ。

**Non-Goals:**
- Jomon アダプタの実 API 修正・payout の payee 解決（後続 fix-jomon-payout）。
- UI（後続 add-member-ui）。許可リストの traQ グループ移行。

## Decisions

### D1. セッションのデータモデル

- `sessions` テーブルは現状 `actor_type('user'|'admin')` ＋ `user_id` ＋ `traq_id`。これを**デュアル**に拡張: 1 セッションが `user_id`（nullable）と `traq_id`（nullable）と `is_admin`（bool, default false）を持てるよう変更。`actor_type` enum は廃し、保持アイデンティティで表現する（`user_id` 有=利用者、`traq_id` 有=会員、`is_admin` 真=会計）。
- マイグレーション: `sessions` に `is_admin boolean not null default false` を追加し、`actor_type` を撤廃（drizzle で列削除）。既存セッションは無効化されてよい（再ログインで再確立、運用影響小）。

### D2. SessionActor 型（`packages/api/src/auth/session.ts`）

```
interface SessionIdentity {
  traqId: string | null     // traQ 認証済みなら
  isAdmin: boolean          // 許可リスト判定
  userId: string | null     // 連結/確認済みの利用者
  mailHash: string | null
}
```
`resolveSession` はこの形を返す（null=未ログイン）。`createSession`/`updateSession` で各フィールドを設定。`requireMember`=traqId 必須、`requireUser`=userId 必須、`requireAdmin`=isAdmin 必須（`packages/api/src/auth/context.ts`、oRPC `memberProc`/`userProc`/`adminProc`）。

### D3. ログイン経路の更新

- **traQ コールバック（`apps/web/server/routes/login/callback.get.ts`）**: code 交換→traq_id 取得→`isAdmin = allowlist.includes(traq_id)`→`getUserByTraqId(traq_id)` で連結済み本人を解決（あれば userId/mailHash も）→**会員セッション確立**（許可リスト外でも確立）。
- **isct 確認（`apps/web/server/routes/verify-email/confirm.get.ts`）**: トークン消費→`getOrCreateUserByMailHash`→ **既存セッションに traqId があれば**、その user 行へ `linkTraqId`（競合安全、unique）し、同一セッションに user を載せる（既存セッション更新 or 新規に traqId 引継ぎ）。traqId 無しなら従来どおり利用者セッション。

### D4. identity の連結ヘルパ（`packages/api/src/auth/identity.ts`）

- `getUserByTraqId(db, traqId)`：`users.traq_id` で本人行を引く。
- `linkTraqId(db, userId, traqId): Promise<'linked'|'exists'|'conflict'>`：競合安全な compale-and-set（`UPDATE users SET traq_id=? WHERE id=? AND traq_id IS NULL`）。unique 制約違反（他人が同 traq_id）は `conflict`。既に同値なら `exists`。
- `BillingUserRow`/`getUserById` に `traqId` を含める。

### D5. 支払い時連結（`packages/api/src/router.ts` membership.issueInvoice）

- 既存の本人確認（提出メール mail_hash==session.mailHash）の後、`session.traqId` があれば `linkTraqId(db, user.userId, session.traqId)`（結果は best-effort。`conflict` はログ）。Customer 作成/更新の metadata に traQ ID を含める（既存 metadata.mail_hash に併記）。

### D6. データモデル（`packages/db`）

- `users.traq_id varchar(255)` nullable **unique** を追加。
- `sessions`: `is_admin boolean` 追加、`actor_type` 撤廃（D1）。
- `pnpm db:generate`（`0005` 以降。既存 baseline 保持）。

## Risks / Trade-offs

- **既存 SessionActor を使う箇所の破壊的変更** → Mitigation: `auth.me`・`requireUser/Admin`・Nitro context・全 oRPC 手続きを新型へ移行。型で漏れを検出（typecheck）。
- **sessions スキーマ変更で既存セッション無効化** → Mitigation: 開発初期で実害なし。再ログインで回復。
- **traq_id の信頼**: 認証済みセッション由来のみ連結 → フォーム入力は使わない（§4.1 準拠）。
- **連結の競合**（同一人物の二重行／他人の traq_id）→ Mitigation: unique 制約＋compare-and-set、`conflict` は要対応ログ。
- **会計が自分の請求を出すか**: 会計セッションでも user 未連結なら requireUser 不可。会計は管理操作（adminProc）を使う。問題なし。

## Migration Plan

1. `packages/db` スキーマ（users.traq_id, sessions.is_admin, actor_type 撤廃）→ generate → migrate。
2. session/context 型をデュアルへ拡張、`requireMember`/`memberProc` 追加、全手続き・Nitro context を移行。
3. ログイン経路（traQ callback=会員セッション＋連結解決、verify-email confirm=traqId 連結）更新。
4. issueInvoice で連結保存＋Customer metadata。`auth.me` 返却更新。
5. ユニット（linkTraqId/getUserByTraqId/require*）＋ローカルで isct ログイン・auth.me・issueInvoice（Stripe 無しはエラー表示）確認。
6. ロールバック: 本 change のマイグレーション revert ＋ 型を旧 SessionActor へ戻す。

## Open Questions

- `sessions.actor_type` 撤廃ではなく残置でもよいが、デュアル化に伴い意味が薄れるため撤廃（D1）。要承認なら残置も可。
- traQ コールバックで user 連結解決した際、`auth.me` がどこまで返すか（member/admin/has-user）。実装で `{ member: bool, admin: bool, hasUser: bool }` 程度に。
