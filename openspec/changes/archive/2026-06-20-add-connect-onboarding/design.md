## Context

[[add-membership-collection]] で Stripe アダプタ（lazy client）・`stripe_events` 冪等台帳・会計認可（`adminProc`）が整った。本 change は払い戻しの前提となる Stripe Connect の connected account onboarding を Jomon 非依存で整備する（design.md §4/§5.3/§7）。実送金・Jomon 連携は後続 [[jomon-integration]]。

design.md §5.3 の要点に従う:
- onboarding は just-in-time。ホスト型 onboarding リンクを発行（API onboarding ではなく hosted を推奨）。
- 完了検知は `account.updated` Webhook。単発「完了」イベントは無いので `payouts_enabled` 等のフラグ＋未提出要件で判定し、event id で冪等に状態遷移。

## Goals / Non-Goals

**Goals:**
- connected account の get-or-create（Express）と `stripe_connected_account_id` 永続化。
- ホスト型 onboarding リンク（Account Link）発行と `payout_onboarding_status` 遷移。
- `account.updated` Webhook によるフラグ判定（`payouts_enabled` ＋ `requirements.currently_due`）と冪等な `requested→done`。
- 会計のみの発行・状態確認 API。

**Non-Goals:**
- Jomon 取込・振込依頼・結果書き戻し、実 transfer/payout、Payouts テーブル（後続 add-payout-execution）。
- `/payouts` UI、催促/再送、資金繰り。

## Decisions

### D1. データモデル（`packages/db`）

- `users` に追加：`stripe_connected_account_id varchar(255)` nullable、`payout_onboarding_status` enum(`none`,`requested`,`done`) NOT NULL default `none`。
- Webhook 冪等は既存 `stripe_events`（`event_id` unique）を再利用（新テーブル不要）。
- `pnpm db:generate` で `0002_*` を生成・コミット（列追加の ALTER。rename 誤検出に注意。既存ベースライン 0000/0001 は保持）。

### D2. Stripe Connect アダプタ（`packages/api/src/stripe/connect.ts`）

- `getOrCreateConnectedAccount(client, db, { userId, stripeConnectedAccountId, mailHash })`：`accounts.create({ type: 'express', metadata: { mail_hash } })` → `users.stripe_connected_account_id` 保存。既存があれば再利用。
- `createAccountOnboardingLink(client, { accountId, refreshUrl, returnUrl })`：`accountLinks.create({ account, type: 'account_onboarding', refresh_url, return_url })` → URL。
- `retrieveAccount(client, accountId)`：webhook 検証後の再取得が必要な場合用（基本はイベントの object を使用）。
- Stripe 型はアダプタ内に閉じ込める。

### D3. onboarding 状態（純粋ロジック, `packages/api/src/payouts/onboarding.ts`）

- `isPayoutsReady(account)`：`account.payouts_enabled === true && (account.requirements?.currently_due ?? []).length === 0`（Stripe 型に依存しない狭い構造入力で受ける）。
- `nextOnboardingStatus(current, ready)`：`done` は終端。`ready` なら `done`。それ以外は `current==='none' ? 'none' : 'requested'`（リンク発行側で `requested` にする）。冪等。

### D4. oRPC（会計のみ）

- `payouts.createOnboardingLink`（`adminProc` ＋ `assertCsrf`）: input `{ userId }`。connected account を get-or-create → Account Link 発行 → `payout_onboarding_status` を（`done` でなければ）`requested` に。返り値 `{ url }`。refresh/return URL は `APP_ORIGIN + '/payouts/onboarding/{refresh,return}'`（UI は後続）。
- `payouts.onboardingStatus`（`adminProc`）: input `{ userId }` → `{ status, hasConnectedAccount }`。

### D5. account.updated Webhook（Nitro）

- `apps/web/server/routes/webhook/account-updated.post.ts`。**raw body** → `stripe.webhooks.constructEvent(raw, sig, STRIPE_CONNECT_WEBHOOK_SECRET)`。
- 冪等: 既存パターン（`hasProcessedStripeEvent` → 処理 → `recordStripeEventOnce`）。account.updated は多数飛ぶが event id 単位で一度だけ。
- 対象特定: `event.account`（または `event.data.object.id`）の connected account id で `users` を検索。
- 判定: `isPayoutsReady(object)` 真かつ現状態 `done` でなければ `done` に更新。偽なら変更なし。該当ユーザーが無ければ無視（200）。
- 署名は Connect 用シークレットで検証（主 Webhook と別エンドポイントの可能性に備え専用 env）。CSRF/セッションは適用しない。
- done 遷移時に会計へ通知してもよい（任意、`Notifier`）。

### D6. 設定

- `BillingConfig`（または新規 `PayoutConfig`）に `connectWebhookSecret`（`STRIPE_CONNECT_WEBHOOK_SECRET`）を追加。`.env.example` / runtimeConfig に追記。`APP_ORIGIN` は既存。
- Connect account type は `express`（hosted onboarding 推奨、Stripe 管理ダッシュボード）。

## Risks / Trade-offs

- **`account.updated` は完了単発ではない** → Mitigation: フラグ（`payouts_enabled`＋要件）判定＋event id 冪等。「来たら done」にしない。
- **Connect Webhook 署名シークレットが主と別** → Mitigation: 専用 env を用意（同一なら同値を設定）。
- **onboarding リンクの受取人への到達**（メール平文を持たない）→ 本 change では会計にリンクを返して転送する設計。自動メール送付は email を持つ後続フロー（Jomon の payee 情報等）で対応。
- **Connect 未有効な test アカウント**では E2E 不可 → Mitigation: 判定・遷移・get-or-create をユニットテスト。Connect 有効化後に sandbox E2E。

## Migration Plan

1. `users` 列追加 → `pnpm db:generate`（0002）→ migrate。
2. Connect アダプタ → onboarding 純粋ロジック → oRPC（発行/状態）→ account.updated Webhook → 設定。
3. ユニットテスト（`isPayoutsReady`、`nextOnboardingStatus`、get-or-create のモック）。
4. Connect 有効 test mode で onboarding リンク→完了→`account.updated`→`done` の E2E。
5. ロールバック: マイグレーション revert ＋ 発行 API/Webhook 無効化（後続未着手なら局所）。

## Open Questions

- connected account の type は Express で確定（hosted onboarding）。将来 Standard/Custom が要れば再検討。
- done 遷移時の会計通知を出すか（任意。まずは状態更新のみでも可）。
- refresh/return URL のページ実体は後続 UI change。
