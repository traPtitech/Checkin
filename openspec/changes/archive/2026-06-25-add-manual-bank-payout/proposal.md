## Why

Stripe Connect のオンボーディングを完了できない受取人には、会計が実際に銀行から手で振り込む運用が既に発生している。しかし現状の払い戻しは Stripe Connect 一本道で、手動振込を「支払い済み（settled）」として記録する手段が無い。結果、その payout は `pending` / `onboarding_waiting` / `failed` のまま永久に残り、Jomon 側の振込依頼も未処理のまま残る。会計が手で振り込んだ事実をシステムに反映できるようにする。

## What Changes

- **手動振込での確定パス（payout-execution）**: Stripe transfer を発行せずに、会計の操作で payout を `paid` に確定する専用パスを追加する。対象は `pending` / `onboarding_waiting` / `failed` のみで、`paid` / `processing` は対象外。送金実行と同じく原子的クレームで確定し、Stripe 送金との競合・二重確定を防ぐ。
- **監査用フィールド（DB）**: `payouts` に `payout_method`（`stripe_connect` / `manual_bank`）、手動 paid 日時、参照メモ、実行者（会計ユーザー）を追加する。既存行は `stripe_connect` 既定で後方互換。
- **Jomon 書き戻し（payout-execution）**: 手動 paid でも既存の Stripe `paid` と同様に Jomon へ settled を書き戻す。`stripe_transfer_id` が無いため、手動振込である旨／参照メモで代替する。書き戻しは再試行可能で、確定済みの `paid` を再送金・上書きしない。
- **会計 UI（accountant-ui）**: `/payouts` の各行に「手動振込済みにする」操作（参照メモ入力＋確認ダイアログ）を追加する。`paid` / `processing` の行には出さない。新 oRPC route `payouts.markManuallyPaid({ jomonRef, note })`（`adminProc` / CSRF）を追加する。

## Capabilities

### New Capabilities
<!-- なし。既存 capability の要件追加で表現する。 -->

### Modified Capabilities
- `payout-execution`: 手動振込での `paid` 確定パス（対象状態の限定・原子的クレーム・Stripe 送金を行わない）と、それを含む Jomon 書き戻し・`payout_method`／実行者の記録という要件を追加する。
- `accountant-ui`: `/payouts` 各行に「手動振込済みにする」操作（参照メモ入力・確認ダイアログ・`paid`/`processing` では非表示）を追加する。

## Impact

- **DB**: `packages/db/src/schema.ts` の `payouts` テーブルにカラム追加（`payout_method`・`manual_paid_at`・`manual_paid_note`・`manual_paid_by`）＋ drizzle マイグレーション。
- **API / ドメイン**: `packages/api/src/payouts/`（手動確定ロジック・atomic claim 拡張）、`packages/api/src/payouts/store.ts`（確定クエリ）、`packages/api/src/router.ts`（新 route `payouts.markManuallyPaid`）。Jomon 書き戻し（`packages/api/src/jomon/*`）は手動 paid を settled として扱えるようにする。
- **フロント**: `apps/web/app/pages/payouts.vue`（行操作・モーダル・確認）。
- **互換性**: 既存 payout・既存フローは不変（`payout_method` 既定 `stripe_connect`）。BREAKING なし。
