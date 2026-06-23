## 1. アダプタ：請求書に口座振込を追加

- [x] 1.1 `packages/api/src/stripe/invoices.ts` の `createDraftInvoice` で `invoices.create` に `payment_settings` を追加する：`payment_method_types: ['card', 'customer_balance']`、`payment_method_options.customer_balance = { bank_transfer: { type: 'jp_bank_transfer' }, funding_type: 'bank_transfer' }`。
- [x] 1.2 既存コメント（draft-first / 非冪等の理由）を壊さず、口座振込が支払い**手段**の追加であり発行順序・台帳ロジックに影響しないことを 1〜2 行で補記する。
- [x] 1.3 ドメイン（billing/ledger）・oRPC 入力・`CreateDraftInput` を変更していないことを確認（手段はアダプタ層で完結）。

## 2. テスト

- [x] 2.1 `stripe/invoices.ts` のユニットテストに、`createDraftInvoice` が `payment_settings`（`['card','customer_balance']` ＋ `jp_bank_transfer` / `funding_type: 'bank_transfer'`）付きで `invoices.create` を呼ぶことを検証するケースを追加（Stripe モックの呼び出し引数アサート）。新規 `packages/api/src/stripe/invoices.test.ts`（3 ケース）。
- [x] 2.2 既存の発行・台帳・Webhook テストが緑のままであること（手段追加で回帰しない）を確認。123 tests green。

## 3. 検証ゲート

- [x] 3.1 `pnpm lint` / `pnpm typecheck` / `pnpm build` / `pnpm test` を緑にする。Codex レビュー（money-safety 4 観点）も blocking 無し。

## 4. 実 Stripe E2E（test mode／キー投入後）— BLOCKED（Stripe アカウントで JPY ＋ 日本の銀行振込の有効化が前提）

- [ ] 4.1 dev 構成（HANDOVER §10）で `/membership` から請求書を発行し、hosted invoice ページにカードと口座振込（専用振込先）が両方表示されることを確認。
- [ ] 4.2 test mode のテスト着金（Stripe の cash-balance 加算 API/ヘルパ）で口座振込入金をシミュレートし、`invoice.paid` が発火 → 会計通知 → 発行台帳が paid 確定することを確認（Webhook ハンドラのキー項目＝`customer`/`metadata` が欠けないこと）。
- [ ] 4.3 口座振込が着金前は Invoice が `open` のまま保たれ、同一条件の再発行が既存 URL を返す（[[issuance-ledger]] の未払い再利用）ことを確認。
