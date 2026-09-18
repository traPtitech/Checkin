## Context

集金（[[add-membership-collection]] ＋ [[add-issuance-ledger]]）は、本人の Stripe Customer に対し draft-first で Invoice を作り（`createDraftInvoice`）、台帳スロットを予約してから finalize（`finalizeAndSendInvoice`）し、`hosted_invoice_url` を返す。現状 `createDraftInvoice` は `payment_settings` を指定しておらず、支払い手段は Stripe アカウント既定（実質カード）に委ねている。

口座振込（銀行振込）を足したい。Stripe では Customer の **`customer_balance`** 支払い手段（funding=`jp_bank_transfer`）で実現する：Invoice 確定時に Stripe が**専用のバーチャル口座（振込先）**を発行し hosted invoice ページに表示、利用者が振り込むと着金が Customer の cash balance に入り、その Invoice に**自動充当**され `invoice.paid` が発火する。

制約・前提:
- **money-safety 不変条件は不変**（[[issuance-ledger]]）: draft → スロット予約 → finalize の順序、draft-only-throw、台帳の `UNIQUE(user_id, activity_year, half)` による dedup。支払い手段はこれらに直交。
- **Stripe boundary はアダプタ層に隔離**（design D3）: 支払い手段の設定は `stripe/invoices.ts` 内で完結し、billing/ledger ドメインや oRPC 入力には漏らさない。
- **着金が非同期**: 口座振込は即時決済ではない。Invoice は着金まで `open`。[[issuance-ledger]] の「未払いは同一 URL 再利用」がこの待ち時間をそのまま吸収する。
- **入金確定は既存経路**: 口座振込でも着金後に `invoice.paid` が出るため、[[payment-webhook]] の署名検証・冪等・会計通知・台帳 paid 確定はそのまま再利用でき、手段を区別しない。

## Goals / Non-Goals

**Goals:**
- 集金で発行する全 Invoice（標準・特別）がカードと口座振込の両方で払えるようにする。
- 既存の発行順序・重複防止・本人連結・入金確定経路を一切変えずに、支払い手段だけを追加する。
- アダプタ層の最小変更（1 関数の create 引数追加）で実現し、ユニットテストで設定を固定する。

**Non-Goals:**
- コンビニ払い（`konbini`）・Checkout Session 経路の追加。
- 払い戻し（Connect connected account / payout）側への変更（無関係）。
- cash balance の手動 reconciliation・過不足の返金フロー（Stripe 既定の automatic reconciliation に委ねる）。
- 口座振込の独自 UI（hosted invoice ページが Stripe 側で振込先を提示）。
- 期判定・price 選択・coverage ロジックの変更。

## Decisions

### D1: `customer_balance` + `jp_bank_transfer` を Invoice の `payment_settings` で指定
`createDraftInvoice` の `invoices.create` に以下を追加する：

```
payment_settings: {
  payment_method_types: ['card', 'customer_balance'],
  payment_method_options: {
    customer_balance: {
      bank_transfer: { type: 'jp_bank_transfer' },
      funding_type: 'bank_transfer',
    },
  },
},
```

- **理由**: Invoice 単位で支払い手段を確定でき、finalize 時に Stripe が口座振込の専用振込先（funding instructions）を生成して hosted ページに出す。`['card', 'customer_balance']` の併記で利用者がページ上で選べる（ユーザー決定）。
- **Customer 追加設定は不要**: Invoice に `customer_balance` を載せれば finalize 時に Invoice 用の funding instructions が出る。cash balance の reconciliation は Stripe 既定（automatic）で着金を未充当 Invoice に充てる。
- **代替案**: (a) Checkout Session に `customer_balance` → 既存は send_invoice/hosted invoice 経路なので Invoice 側に寄せる方が一貫。(b) Customer の `invoice_settings.default_payment_method` で手段固定 → 利用者が選べず、カード併用が崩れる。

### D2: アダプタ層だけで完結（ドメイン・API・台帳は不変）
支払い手段はビジネスルールではなく Invoice の生成属性なので、`stripe/invoices.ts` に閉じる。`CreateDraftInput`・`issueInvoice`/`issueSpecialInvoice`・oRPC 入力・台帳には手を入れない。
- **理由**: 「カード＋口座振込を全 Invoice に」はユーザー決定であり手段の分岐がない。1 か所で固定すれば標準・特別の両発行に自動適用され、money-safety 不変条件（draft-first 等）に触れずに済む。
- **代替案**: oRPC 入力に `method` を足して請求書ごとに切替（AskUserQuestion の選択肢3）→ 今回は両方固定なので不要。将来オプトインが必要になれば `CreateDraftInput` に手段を足す小 change で対応。

### D3: 入金確定・通知・台帳 paid は既存 `invoice.paid` 経路を再利用（変更なし）
口座振込の着金でも Stripe は `invoice.paid` を出す。[[payment-webhook]] は手段非依存（「入金時」）なので、署名検証・event 冪等・会計通知・台帳 paid 確定はそのまま動く。
- **検証**: 口座振込で paid になった Invoice も `customer`・`metadata`（traQ 連結等）を従来同様に持つことを E2E で確認（Webhook ハンドラのキー項目が欠けないこと）。コード変更は無いが、テスト項目として明示する。

### D4: 非同期着金は「未払い＝open」を [[issuance-ledger]] が吸収
口座振込は着金まで `open`。台帳スロットは発行時に予約済みで、同一条件の再要求は「未払いの同一発行 → 既存 URL 返却」に落ちる。重複振込先の濫造や二重スロットは台帳の一意制約が防ぐ。
- **理由**: 追加の pending 状態管理を作らず、既存の open-invoice 再利用モデルにそのまま乗る。

## Risks / Trade-offs

- **Stripe アカウントで Bank transfers（Customer Balance）未有効だと finalize/funding が失敗** → ダッシュボードで有効化が前提（test mode は利用可）。proposal の「前提」に明記。コード側の前提エラーは Stripe からのエラーで顕在化。
- **着金が遅い／部分入金・過入金で cash balance に残る** → Stripe 既定の automatic reconciliation が未充当 Invoice に充てる。過不足の手動処理は本スコープ外（会計が Stripe ダッシュボードで確認）。
- **`jp_bank_transfer` の最低額・利用条件** → 部費（¥2,000/¥4,000）は通常問題ない見込み。test mode で実値確認（E2E）。
- **hosted invoice ページの実描画は実 Stripe でしか確認できない**（HANDOVER §8 の UI 実描画方針に同じ）→ ユニットは create 引数を検証し、振込先表示は test mode E2E で確認。

## Migration Plan

- 変更は `createDraftInvoice` の create 引数追加のみ（後方互換、DB・env 変更なし）。
- ロールバック: `payment_settings` を除けば従来（カードのみ）に戻る。
- 検証ゲート: `pnpm lint` / `typecheck` / `build` / `test`。実 test mode で発行→hosted ページ口座振込表示→テスト着金→`invoice.paid`→台帳 paid 確定の E2E（HANDOVER §10 の dev 構成＋[[payout-e2e-stripe]] 系の足場）。

## Open Questions

- なし（手段はカード＋口座振込で固定、reconciliation は Stripe 既定。将来オプトイン化・過不足返金フローは別 change 候補）。
