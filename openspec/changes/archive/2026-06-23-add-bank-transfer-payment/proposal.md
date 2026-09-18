## Why

部費の集金で、現状の請求書はカード払いしか想定していない（`createDraftInvoice` は `payment_method_types` を指定せず Stripe 既定＝カードに委ねている）。カード手数料を避けたい利用者・会計のために、**口座振込（銀行振込）**でも部費を払えるようにする。Stripe では Customer の `customer_balance`（funding=`jp_bank_transfer`）として実現でき、入金確定は既存の `invoice.paid` Webhook 経路にそのまま乗る（[[payment-webhook]]）。HANDOVER §9-5 が「別 change」として挙げていた項目。

## What Changes

- **請求書がカード＋口座振込の両方で払える**: 集金で発行する Invoice の `payment_settings.payment_method_types` を `['card', 'customer_balance']` にし、`payment_method_options.customer_balance` を `{ bank_transfer: { type: 'jp_bank_transfer' }, funding_type: 'bank_transfer' }` に設定する。利用者は hosted invoice ページでカードか口座振込を選べる。
- **口座振込は非同期入金**: 利用者は hosted invoice ページに表示される**専用の振込先（バーチャル口座）**へ振り込む。着金まで Invoice は `open` のまま。Stripe が着金を Customer の cash balance に反映し Invoice へ自動充当 → 既存の `invoice.paid` が発火し、会計通知・発行台帳の paid 確定（[[issuance-ledger]]）がそのまま走る。
- **発行台帳・本人連結はそのまま**: draft-first 発行順序（[[issuance-ledger]] の money-safety 不変条件）・期判定・price 選択・traQ ID 連結は変更しない。口座振込は支払い**手段**の追加であり、重複防止や本人特定のロジックには触れない。
- 標準発行（`issueInvoice`）と特別発行（`issueSpecialInvoice`）の両方に等しく適用する（請求書作成アダプタ 1 か所で設定するため自動的に両対応）。

明確に**スコープ外**: コンビニ払い（`konbini`）・Checkout Session 経路。払い戻し（Connect connected account）側＝こちらは別系統で無関係。cash balance の手動 reconciliation／過不足返金フロー（Stripe 既定の automatic reconciliation に委ねる）。口座振込専用 UI（hosted invoice ページが Stripe 側で提供）。

## Capabilities

### New Capabilities
<!-- なし（既存 capability への delta のみ） -->

### Modified Capabilities
- `membership-billing`: 「請求書の作成・確定・送付」要件に、発行する Invoice が**カードと口座振込（`jp_bank_transfer`）の両方**で支払える（`customer_balance` 経由）こと、口座振込は非同期着金で Invoice が着金まで `open` を維持しつつ着金後は既存の入金確定経路に合流することを追記。

## Impact

- **API（`packages/api`）**: `stripe/invoices.ts` の `createDraftInvoice` で `payment_settings`（`payment_method_types` ＋ `payment_method_options.customer_balance.bank_transfer = jp_bank_transfer` / `funding_type = bank_transfer`）を設定。ドメイン（billing/ledger）・oRPC 入力は不変（手段はアダプタ層で完結）。
- **Web/Nitro（`apps/web`）**: 変更なし（hosted invoice ページが Stripe 側で振込先を表示）。`invoice.paid` Webhook 経路は既存のまま再利用。
- **設定/前提**: Stripe アカウントで「Bank transfers（Customer Balance）」が有効である必要（ダッシュボード設定。test mode は利用可）。新規 env なし。
- **テスト/検証**: `createDraftInvoice` が口座振込オプション付きで Invoice を作ることをユニットテスト（Stripe モックの呼び出し引数を検証）。実 test mode で発行→hosted ページに口座振込が出る→テスト着金（Stripe の cash-balance 加算ヘルパ）→`invoice.paid`→台帳 paid 確定まで E2E（HANDOVER §10 の dev 構成上）。
