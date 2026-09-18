## 1. データモデル

- [x] 1.1 `users` に `stripe_connected_account_id varchar(255)` nullable を追加
- [x] 1.2 `users` に `payout_onboarding_status` enum(`none`,`requested`,`done`) NOT NULL default `none` を追加
- [x] 1.3 `pnpm db:generate` で `0002_*` 生成・コミット（既存 0000/0001 baseline 保持、列追加 ALTER、rename 誤検出に注意）

## 2. Stripe Connect アダプタ（packages/api/src/stripe/connect.ts）

- [x] 2.1 `getOrCreateConnectedAccount`（Express account 作成 / 再利用 / `stripe_connected_account_id` 保存、`metadata.mail_hash`）
- [x] 2.2 `createAccountOnboardingLink`（Account Link `type:'account_onboarding'`、refresh/return URL）
- [x] 2.3 lazy Stripe client を使用。stripe/index.ts から export。Stripe 型はアダプタ内に閉じ込める

## 3. onboarding 状態ロジック（Stripe 非依存, packages/api/src/payouts/onboarding.ts）

- [x] 3.1 `isPayoutsReady(account)`（`payouts_enabled` ＋ `requirements.currently_due` 空、狭い構造入力）
- [x] 3.2 `nextOnboardingStatus(current, ready)`（`done` 終端・冪等）
- [x] 3.3 `BillingConfig`（または PayoutConfig）に `connectWebhookSecret` を追加し解決経路を用意

## 4. oRPC（会計のみ）

- [x] 4.1 `payouts.createOnboardingLink`（`adminProc`＋`assertCsrf`、`{userId}`）: account get-or-create → Account Link → status を（done でなければ）requested に。`{url}` 返却
- [x] 4.2 `payouts.onboardingStatus`（`adminProc`、`{userId}`）: `{status, hasConnectedAccount}`

## 5. account.updated Webhook（Nitro）

- [x] 5.1 `apps/web/server/routes/webhook/account-updated.post.ts`: raw body＋Connect 署名検証
- [x] 5.2 冪等（`hasProcessedStripeEvent`→処理→`recordStripeEventOnce`）。対象 connected account で `users` 特定
- [x] 5.3 `isPayoutsReady` 真かつ非 done なら `done` に遷移。偽/該当無しは状態変更なし（200）。無効署名は 4xx

## 6. 設定・検証

- [x] 6.1 `.env.example` に `STRIPE_CONNECT_WEBHOOK_SECRET` 追記、`nuxt.config` runtimeConfig に対応キー追加
- [x] 6.2 ユニットテスト: `isPayoutsReady`（可/不可）、`nextOnboardingStatus`（none/requested/done・冪等）、get-or-create（モック）
- [x] 6.3 `pnpm lint` / `pnpm typecheck` / `pnpm build` / `pnpm test` をグリーンにする
- [ ] 6.4 （Connect 有効 test mode 後）onboarding リンク→完了→`account.updated`→`done` の E2E
  - BLOCKED: Connect/Stripe のテストキー（Connect 有効な test mode）が無いため実行不可。判定・遷移・get-or-create はユニットで担保済み。キー入手後に sandbox E2E を実施する。
- [x] 6.5 Codex review fixes: get-or-create を race-safe 化（DB 再読込→条件付き compare-and-set `claimConnectedAccountId`→敗者は孤児 account を best-effort 削除して勝者 id を再利用）、`users.stripe_connected_account_id` に UNIQUE 制約（migration `0003_happy_cobalt_man.sql`）、条件付き書込の duplicate-key を防御的に再読込で吸収
