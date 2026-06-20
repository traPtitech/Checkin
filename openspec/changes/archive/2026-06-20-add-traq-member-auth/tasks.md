## 1. データモデル

- [x] 1.1 `users` に `traq_id varchar(255)` nullable **unique** を追加
- [x] 1.2 `sessions` に `is_admin boolean not null default false` を追加し、`actor_type` enum を撤廃（保持アイデンティティで表現）
- [x] 1.3 `pnpm db:generate`（baseline 0000–0005 保持）→ `pnpm db:migrate`

## 2. セッション/認可のデュアル化（packages/api）

- [x] 2.1 `SessionIdentity`（traqId/isAdmin/userId/mailHash）へ型変更。`createSession`/`resolveSession`/`destroySession` を更新（user_id・traq_id・is_admin を保存/復元）
- [x] 2.2 既存セッションに後からアイデンティティを足す `attachUserToSession`（traQ セッションに user を連結）を実装
- [x] 2.3 `context.ts`: `requireMember`/`requireUser`/`requireAdmin` を新型に。`orpc.ts` に `memberProc`/`userProc`/`adminProc`（middleware は入力検証より前）
- [x] 2.4 Nitro `buildRequestContext` と `auth.me`（`{member, admin, hasUser, traqId?}` 等）を新型へ移行。既存の全 oRPC 手続き（payments/payouts/membership）が型エラー無く動くよう調整

## 3. identity の traq_id 連結（packages/api/src/auth/identity.ts）

- [x] 3.1 `users.traq_id` を `BillingUserRow`/`getUserById` に含める
- [x] 3.2 `getUserByTraqId(db, traqId)`
- [x] 3.3 `linkTraqId(db, userId, traqId)`：競合安全な compare-and-set（`WHERE traq_id IS NULL`）。unique 違反は `conflict`、同値は `exists`

## 4. ログイン経路の更新（apps/web）

- [x] 4.1 `login/callback.get.ts`: 会員セッション確立（許可リスト外も成立）、`isAdmin=allowlist`、`getUserByTraqId` で連結済み user を解決して載せる
- [x] 4.2 `verify-email/confirm.get.ts`: 既存セッションに traqId があれば `linkTraqId` ＋ user を同一セッションに連結（無ければ従来の利用者セッション）

## 5. 支払い時連結（membership）

- [x] 5.1 `membership.issueInvoice`: 本人確認後、`session.traqId` があれば `linkTraqId`（best-effort、conflict はログ）。Customer 作成/更新の metadata に traQ ID を併記

## 6. 検証

- [x] 6.1 ユニットテスト: `linkTraqId`（linked/exists/conflict）、`getUserByTraqId`、`requireMember/User/Admin`、セッションのデュアル解決
- [x] 6.2 `pnpm lint` / `pnpm typecheck` / `pnpm build` / `pnpm test` をグリーンに
- [x] 6.3 ローカル: isct ログイン→`auth.me`、issueInvoice（Stripe 無しはエラー表示）、許可リスト判定の単体確認。traQ 実ログインはキー要のため関数単位で担保
  - 連結ロジック・デュアル解決・許可リスト判定（`isAccountant`）・`auth.me` 形状は DB バック/ユニットテストで担保（`identity.test.ts` 9件 + `auth.test.ts`）。
  - BLOCKED（実 E2E）: traQ OAuth 実ログイン・Stripe 実 issueInvoice はクレデンシャル要のため未実施（コールバック/confirm ルートはビルド通過で静的検証済み）。
  - Codex review fixes: confirm.get.ts は link→（linked/exists のみ）attach 順に修正し conflict 時は別人の traQ 連結を主張しない fresh user session を発行。issueInvoice は conflict の session.traqId を Customer metadata に焼かない（linkedTraqId ?? row.traqId）。`linkTraqId` conflict が他ユーザーの連結を破壊しない点は identity.test.ts で担保。
