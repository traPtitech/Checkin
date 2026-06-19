## 1. Stripe アダプタ拡張

- [x] 1.1 `listInvoices({status?, limit, startingAfter?})` を Stripe `invoices.list`（`expand: ['data.customer']`）で実装
- [x] 1.2 `listCheckoutSessions({status?, limit, startingAfter?})` を Stripe `checkout.sessions.list` で実装
- [x] 1.3 list 系は遅延 Stripe クライアントを使い、キー未設定時は使用時のみ明確にエラー（既存方針踏襲）

## 2. payments ドメイン（Stripe 非依存 DTO・URL）

- [x] 2.1 `PaymentRow` / `PaymentPage` DTO 型を定義
- [x] 2.2 Stripe Invoice → `PaymentRow` 正規化（id/金額/通貨/日時/customer/支払い状況/支払いid/Price/Dashboard URL）
- [x] 2.3 Stripe Checkout Session → `PaymentRow` 正規化（amount_total/payment_status/payment_intent 等）
- [x] 2.4 `buildDashboardUrl(mode, kind, id)`（test/live 切替）。mode は `STRIPE_SECRET_KEY` prefix から判定
- [x] 2.5 `limit` クランプ（1..100, 既定 20）と `nextCursor`（`hasMore ? items.at(-1).id : null`）算出

## 3. oRPC 手続き（会計のみ）

- [x] 3.1 `payments.listInvoices`（`requireAdmin`、zod 入力 `{status?, limit?, startingAfter?}`、`PaymentPage` 返却）
- [x] 3.2 `payments.listCheckoutSessions`（同上）
- [x] 3.3 status の zod enum（Invoices: draft/open/paid/uncollectible/void、Sessions: open/complete/expired）

## 4. 検証

- [x] 4.1 ユニットテスト: Invoice/Session の DTO 正規化、`buildDashboardUrl`（test/live）、limit クランプ、nextCursor 算出
- [x] 4.2 `pnpm lint` / `pnpm typecheck` / `pnpm build` / `pnpm test` をグリーンにする
- [ ] 4.3 （test mode キー投入後）実データで一覧・status フィルタ・カーソルページングを確認 — **BLOCKED**: Stripe test mode キー未投入のため実データ確認不可（ユニットテストで正規化・URL・クランプ・nextCursor を担保）
- [x] 4.4 Codex 指摘修正（認可順序 / Checkout 商品参照）: 認可を oRPC ミドルウェア（`userProc` / `adminProc`）で入力検証前に実行し、未認証＋不正入力でも UNAUTHORIZED/FORBIDDEN を返す（curl で検証）。Checkout Session に `expand: ['data.line_items.data.price']` を追加し、正規化で先頭 line item の `price.id` / 説明（description→price.nickname）を `product` にマップ、line items 不在時は明示的な `{ priceId: null, description: null }` を返す
