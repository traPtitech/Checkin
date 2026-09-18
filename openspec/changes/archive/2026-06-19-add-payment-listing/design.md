## Context

[[add-membership-collection]] で Stripe アダプタ（client/customers/invoices/webhook）と会計認可（`requireAdmin`）が整った。本 change は会計向けの入出金一覧（design.md §5.2）を、Stripe を source として読み取り専用で提供する。

## Goals / Non-Goals

**Goals:**
- 請求書由来（Invoices）・決済ページ由来（Checkout Sessions）の 2 系統の一覧 API。
- `status` フィルタ ＋ カーソルページネーション。
- Stripe 型に依存しない行 DTO ＋ Dashboard URL 生成。
- 会計のみ（`requireAdmin`）の読み取り。

**Non-Goals:**
- `/payments` UI ページ（後続）。CSV エクスポート、検索の高度化。
- 払い戻し・Jomon、入出金の DB 複製。

## Decisions

### D1. アダプタ拡張（`packages/api/src/stripe/`）

- `listing.ts`（または `invoices.ts`/新規）に薄いラッパを追加：
  - `listInvoices({ status?, limit, startingAfter? })` → Stripe `invoices.list`（`expand: ['data.customer']` で名前取得）。
  - `listCheckoutSessions({ status?, limit, startingAfter? })` → Stripe `checkout.sessions.list`。
- ドメイン DTO へ正規化（Stripe 型を外に出さない）。

### D2. 行 DTO（Stripe 非依存）

```
interface PaymentRow {
  id: string
  amount: number            // 最小単位
  currency: string
  createdAt: string         // ISO
  customer: { id: string | null, name?: string | null }
  paymentStatus: string     // invoice.status / session.payment_status
  paymentId: string | null  // payment_intent 等
  product: { priceId?: string | null, description?: string | null }
  dashboardUrl: string
}
interface PaymentPage { items: PaymentRow[], hasMore: boolean, nextCursor: string | null }
```

`nextCursor` は最後の行の `id`（Stripe の `starting_after` に渡す）。

### D3. フィルタ・ページネーション

- `limit` は 1..100 にクランプ（既定 20）。
- `status`: Invoices は `draft|open|paid|uncollectible|void`、Checkout Sessions は `open|complete|expired`。値は zod enum で受け、Stripe にそのまま渡す。
- `hasMore` は Stripe レスポンスの `has_more` を採用。`nextCursor = hasMore ? items.at(-1).id : null`。

### D4. Dashboard URL

- モード判定: `STRIPE_SECRET_KEY` が `sk_test_`/`rk_test_` で始まれば test。`buildDashboardUrl(mode, kind, id)`：
  - invoice → `https://dashboard.stripe.com/{test/}invoices/{id}`
  - checkout session → `https://dashboard.stripe.com/{test/}checkout/sessions/{id}`（または payment intent へ）
- `mode` は `BillingConfig` から導出（既存の `stripeSecretKey` を利用）。純粋関数として `billing/` ではなくアダプタ近傍 or `payments` ドメインに置く（Stripe 型非依存）。

### D5. oRPC

- `payments.listInvoices` / `payments.listCheckoutSessions`（`requireAdmin`、読み取りなので `assertCsrf` は不要）。
- input zod: `{ status?: enum, limit?: number, startingAfter?: string }`。output: `PaymentPage`。

## Risks / Trade-offs

- **Stripe レート制限／件数** → Mitigation: ページサイズ上限、カーソル方式。必要なら将来キャッシュ。
- **customer 展開のコスト** → Mitigation: `expand` は名前程度に限定。重ければ id のみに縮小可能。
- **モード判定をキー prefix に依存** → Mitigation: 明示 env（`STRIPE_MODE`）での上書きも許容してよい（実装で任意）。
- **test mode キー未投入で実データ確認不可** → Mitigation: 正規化・URL 生成・パラメータ組み立てをユニットテスト（Stripe モック）。

## Migration Plan

1. アダプタに list 系を追加 → `payments` ドメイン（DTO 正規化・URL 生成）→ oRPC 手続き。
2. ユニットテスト（DTO 正規化、Dashboard URL の test/live、limit クランプ、nextCursor 算出）。
3. test mode キー投入後、実データで一覧・フィルタ・ページングを確認。

## Open Questions

- Checkout Sessions の「金額」は `amount_total`、支払い状況は `payment_status` を採用（実装で確定）。現状 Checkout 経由の決済が無ければ空一覧で問題ない。
- `/payments` UI を本 change に含めるか別 change か（本 change は API のみ。UI は次で）。
