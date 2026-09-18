## Why

第一弾スコープ①「入部費 / 部費の集金（請求書ベース）」の土台を作る。認証・本人識別（[[add-auth-foundation]] でアーカイブ済み）が整ったので、ログイン済み利用者が自分の請求書を発行し、Stripe の支払いページで支払えるようにする。原則「サークルが Stripe に依存せず切り替えられる」を守るため、ドメイン（誰がいくら払う）は Stripe 非依存に保ち、Stripe 呼び出しは薄いアダプタに閉じ込める。

本 change は **バックエンド中心**。`/membership` の新規/再入部/現役 UI 振り分けは後続 change とする。

## What Changes

- **Stripe アダプタ層の導入**: Stripe SDK 呼び出しを `packages/api/src/stripe/` のアダプタに閉じ込め、ドメイン層は Price/金額/期の判定のみを担う（Stripe オフ→口座振込 や将来の v2 移行をアダプタ差し替えで吸収）。
- **Customer の get-or-create**: `mail_hash` → DB の `stripe_customer_id` → 無ければ Stripe をメールで検索 → それでも無ければ作成し `customer_id` を DB に保存。
  - **BREAKING（identity 拡張）**: `users` に `stripe_customer_id`（nullable）を追加。identity の「メール平文を永続化しない」要件は維持しつつ、非 PII の Stripe 参照は保持してよいと明確化する。
- **請求書の発行（finalize/send）**: ドメインで費目・期・標準/特別から `price_id` を決定し、Customer に対し Invoice ＋ InvoiceItem(Price) を作成 → finalize → send。支払いページへ誘導。
  - 価格マトリクス: 新規入部費＝前期(4–9月)¥4,000 / 後期(10–3月)¥2,000（活動年度 4/1–3/31 から日付で自動決定）。継続(部費)＝標準¥4,000 / 特別¥2,000。
  - 認可: 標準（新規の前期/後期・継続標準）は**利用者が自分の分のみ**発行。特別¥2,000 は**管理者（会計）のみ**が対象を指定して発行。利用者発行時は提出メールの `mail_hash` がセッションと一致することを検証。
- **入金検知 Webhook（`invoice.paid`）**: Stripe 署名検証 ＋ event id による冪等処理 ＋ 会計への通知（`Notifier` 抽象、当面ログ実装）。一覧表示自体は後続の「入出金一覧」change（Stripe から直接取得）に委ねる。

明確に**スコープ外**（後続 change）: `/membership` UI 振り分け・フォーム、入出金一覧（`/list/*`）、払い戻し・Jomon 連携、resend/催促、任意額請求書。

## Capabilities

### New Capabilities
- `stripe-customer`: `mail_hash` と Stripe Customer の対応付け。get-or-create（DB→メール検索→作成）、`stripe_customer_id` の永続化、Stripe アダプタ境界。
- `membership-billing`: 集金ドメイン。費目（新規/継続）・期（前期/後期）・標準/特別から `price_id` を決定する規則、活動年度に基づく期判定、発行の認可（利用者は自分の標準、管理者は特別）、Invoice 作成→finalize→send。
- `payment-webhook`: `invoice.paid` Webhook の受信。Stripe 署名検証、event id による冪等処理、会計への通知（`Notifier` 抽象）。

### Modified Capabilities
- `identity`: `users` に `stripe_customer_id`（nullable）を追加。「メール平文を永続化しない」要件を、非 PII の Stripe 参照（customer id）は保持してよい形に明確化（メール平文は引き続き保存しない）。

## Impact

- **DB（`packages/db`）**: `users` に `stripe_customer_id` 追加、Webhook 冪等用 `stripe_events`（`event_id` unique）追加。マイグレーション生成・コミット。
- **API（`packages/api`）**: Stripe アダプタ（`stripe/`）、集金ドメイン（費目・期・価格・認可）、oRPC `membership.issueInvoice`（利用者）/`membership.issueSpecialInvoice`（管理者）、`Notifier` 抽象。
- **Web/Nitro（`apps/web`）**: `POST /webhook/invoice-paid`（raw body ＋ Stripe 署名検証の Nitro ルート）。
- **依存・設定**: `stripe` SDK を追加。env に `STRIPE_SECRET_KEY`(test)/`STRIPE_WEBHOOK_SECRET`/`PRICE_SHINKI_ZENKI`/`PRICE_SHINKI_KOUKI`/`PRICE_KEIZOKU_STANDARD`/`PRICE_KEIZOKU_SPECIAL`/`INVOICE_DAYS_UNTIL_DUE` を追加（`.env.example` 更新）。
- **テスト/検証**: 期判定・価格選択・認可はユニットテスト。Stripe 連携は test mode キーが必要なため、E2E はキー投入後に実施（adapter はモックでユニット可能な範囲で検証）。
