## Why

第一弾スコープ②「入出金の一覧（会計用）」。会計が入金状況を確認できるよう、Stripe を source として請求書由来・決済ページ由来の入出金を一覧する。対応表は自前 DB が正だが、入出金の事実は Stripe が source なので、一覧は Stripe から取得する（DB に複製しない）。[[add-membership-collection]] の Stripe アダプタ・[[add-auth-foundation]] の会計認可（`requireAdmin`）の上に乗る。

## What Changes

- **入出金一覧 API（会計のみ）**: 2 系統を提供。
  - `payments.listInvoices`: 請求書由来（Stripe Invoices）。
  - `payments.listCheckoutSessions`: 決済ページ由来（Stripe Checkout Sessions）。
- **フィルタ＋ページネーション**: `status` 等で絞り込み、Stripe のカーソル方式（`limit` ＋ `starting_after`）でページング。`hasMore` と次カーソルを返す。
- **行の項目**: `id` / 金額（通貨つき）/ 日時 / customer 参照（id、可能なら名前）/ 支払い状況 / 支払いの id（Dashboard URL を生成可）/ 商品（Price）参照。
- **Stripe アダプタ拡張**: list 系（invoices / checkout sessions）の薄いラッパを追加。Dashboard URL はモード（test/live）＋オブジェクト id から生成。
- **認可**: すべて会計（管理者）のみ（`requireAdmin`）。読み取りのみ（DB 変更なし、CSRF 不要）。

明確に**スコープ外**（後続）: UI ページ `/payments` の作成（本 change は API。UI は後続 or 併せて別途）、払い戻し・Jomon 連携、CSV エクスポート。

## Capabilities

### New Capabilities
- `payment-listing`: 会計向けの入出金一覧。請求書由来・決済ページ由来の 2 系統、`status` フィルタ、カーソルページネーション、行項目の正規化（Stripe → ドメイン DTO）、Dashboard URL 生成、`requireAdmin` 認可。

### Modified Capabilities
<!-- なし（既存 capability の要件変更なし。Stripe アダプタへの list 追加は実装拡張） -->

## Impact

- **API（`packages/api`）**: Stripe アダプタに `listInvoices` / `listCheckoutSessions` を追加。oRPC `payments.listInvoices` / `payments.listCheckoutSessions`（`requireAdmin`、zod 入力）。Stripe オブジェクト → ドメイン DTO への正規化と Dashboard URL 生成（モードは `STRIPE_SECRET_KEY` の prefix から判定、または env）。
- **Web/Nitro（`apps/web`）**: 追加配線は不要（oRPC 経由）。UI ページは本 change 範囲外。
- **DB**: 変更なし（入出金の source は Stripe）。
- **テスト/検証**: DTO 正規化・Dashboard URL 生成・カーソル/フィルタのパラメータ組み立てはユニットテスト（Stripe はモック）。実データ一覧は test mode キー投入後に確認。
