## 1. 依存とデータモデル

- [x] 1.1 `packages/api` に `stripe` SDK を追加（`pnpm install`）
- [x] 1.2 `packages/db` schema: `users` に `stripe_customer_id varchar(255)` nullable を追加
- [x] 1.3 `packages/db` schema: `stripe_events`（`id` PK, `event_id` unique, `type`, `received_at`）を追加
- [x] 1.4 `pnpm db:generate` でマイグレーション生成・コミット（列追加が rename 誤検出されないよう注意。生成 SQL は手編集しない）

## 2. Stripe アダプタ層（packages/api/src/stripe）

- [x] 2.1 `client.ts`: `STRIPE_SECRET_KEY` で Stripe クライアント初期化
- [x] 2.2 `customers.ts`: get-or-create（DB→メール検索→作成）、`metadata` に `mail_hash`/`traq_id`、`customer_id` 返却
- [x] 2.3 `invoices.ts`: Customer＋`price_id` から Invoice＋InvoiceItem 作成→finalize→send（`hosted_invoice_url` 返却）
- [x] 2.4 `webhook.ts`: raw body＋署名で `constructEvent`（`invoice.paid` 判定）

## 3. 集金ドメイン（Stripe 非依存, packages/api/src/billing）

- [x] 3.1 `term.ts`: `computeTerm(date)`（4–9=前期 / 10–3=後期、活動年度 4/1–3/31）
- [x] 3.2 `pricing.ts`: `selectPriceId({feeType, term, variant})` を env の 4 つの price から決定
- [x] 3.3 `authorize.ts`: 標準=本人(`mail_hash` 一致)のみ／特別=管理者のみ の判定
- [x] 3.4 `BillingConfig` 型＋解決（price_id 群・`STRIPE_*`・`INVOICE_DAYS_UNTIL_DUE`）。Context へ載せる経路を用意

## 4. 発行 API（oRPC）

- [x] 4.1 `membership.issueInvoice`（`requireUser`＋`assertCsrf`）: メール一致検証→費目/期で price→Customer get-or-create→Invoice 発行
- [x] 4.2 `membership.issueSpecialInvoice`（`requireAdmin`＋`assertCsrf`）: 対象 user→特別 price→Customer 解決→Invoice 発行
- [x] 4.3 返り値に `invoiceId`/`hostedInvoiceUrl`。Context（`packages/api/src/orpc.ts`）に Stripe アダプタ／`BillingConfig`／`Notifier` を追加

## 5. 入金 Webhook（Nitro）

- [x] 5.1 `Notifier` 抽象＋`LogNotifier`（会計向け通知、当面ログ）
- [x] 5.2 `apps/web/server/routes/webhook/invoice-paid.post.ts`: raw body 署名検証→`stripe_events` で冪等→`Notifier.notify`
- [x] 5.3 不正署名は 4xx、`invoice.paid` 以外は無視、同一 event id は二重処理しない

## 6. 設定・配線・検証

- [x] 6.1 `.env.example` に `STRIPE_SECRET_KEY`/`STRIPE_WEBHOOK_SECRET`/`PRICE_*`(4種)/`INVOICE_DAYS_UNTIL_DUE` を追記、`nuxt.config` runtimeConfig に対応キー追加
- [x] 6.2 ユニットテスト: `computeTerm`（前期/後期境界）、`selectPriceId`（4 パターン）、`authorize`（本人一致/不一致/利用者の特別不可/管理者特別可）
- [x] 6.3 `pnpm lint` / `pnpm typecheck` / `pnpm build` / `pnpm test` をグリーンにする
- [x] 6.5 Codex レビュー指摘の修正（特別発行のメール一致検証 / Webhook を check-notify-record 順に / 発行冪等キー / draft クリーンアップ / 空 price_id ガード / Customer 検索前のメール正規化）
- [ ] 6.4 （test mode キー投入後）Stripe sandbox で E2E: 標準発行→支払い→`invoice.paid` 通知、管理者の特別発行、他人発行の拒否、CSRF 欠落の拒否
      （BLOCKED: この環境に Stripe test キーが無いためライブ E2E は未実施。キー投入後に実施する。）
