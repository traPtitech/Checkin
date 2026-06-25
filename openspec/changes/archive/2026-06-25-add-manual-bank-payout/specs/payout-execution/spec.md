# payout-execution

## ADDED Requirements

### Requirement: 手動振込での paid 確定（Stripe 送金を行わない）

システムは、Stripe Connect のオンボーディングを完了できない受取人に会計が銀行から手で振り込んだ場合に、当該 payout を Stripe transfer を発行せずに `paid` へ確定する手動確定パスを提供 SHALL。対象は `pending` / `onboarding_waiting` / `failed` の payout のみとし、`paid` / `processing` は対象外として拒否 MUST（確定済みや実行中の上書きをしない）。

確定は原子的に行う SHALL：単一の条件付き UPDATE で `status` を `paid` にし、同時に `payout_method` を `manual_bank` に、`manual_paid_at`・`manual_paid_note`・`manual_paid_by`（実行した会計のユーザー）を記録する。条件は `status IN ('pending','onboarding_waiting','failed')` を満たすときのみ成功とし、満たさない（既に `paid` / `processing`）場合は更新を行わず短絡 MUST。これにより Stripe 送金フロー（`processing` クレーム）との競合や二重確定で二重に支払われては SHALL NOT。手動確定では `stripe_transfer_id` を設定しては SHALL NOT。

手動確定の対象は受取人（`user_id`）が解決済みである必要は無い MUST NOT 制約とはしないが、本人特定の不変条件（確定済み `user_id` を別人に再リンクしない）は維持する SHALL。

#### Scenario: 未払いの payout を手動振込済みにできる

- **WHEN** 会計が `pending` / `onboarding_waiting` / `failed` のいずれかの payout を、参照メモ付きで「手動振込済み」にする
- **THEN** Stripe transfer を発行せず payout が `paid` になり、`payout_method=manual_bank`・`manual_paid_at`・`manual_paid_note`・`manual_paid_by` が記録される（`stripe_transfer_id` は空のまま）

#### Scenario: paid / processing は手動確定できない

- **WHEN** 会計が `paid` または `processing` の payout を手動振込済みにしようとする
- **THEN** 確定は拒否され、状態は変化せず、二重支払いは起きない

#### Scenario: Stripe 送金との競合で二重に支払わない

- **WHEN** 同一 `jomon_ref` に対し、手動確定と Stripe 送金フローのクレームが同時並行で走る
- **THEN** 原子的更新により一方だけが `paid` を確定し、他方は短絡して支払い（送金）を行わない

## MODIFIED Requirements

### Requirement: 結果を Jomon に書き戻す（再試行可能・再送金しない）

システムは、確定結果（Stripe 送金で `paid` / 手動振込で `paid` / 失敗）を `JomonClient` を通じて Jomon に書き戻す SHALL。書き戻し成否を記録（`jomon_written_back_at`）し、`paid` 済みだが書き戻し未了の payout は、再実行時に**書き戻しのみ再試行**して送金や手動確定を再実行しては SHALL NOT。手動振込で `paid` になった payout は `stripe_transfer_id` を持たないため、書き戻しは `stripe_transfer_id` の存在を前提とせず、手動振込である旨（および `manual_paid_note`）で代替して settled を書き戻す SHALL。v1 は `PUT .../states/repaid/{trapId}` を用いる。**v2 は書き戻し API が無いため未対応として失敗（警告ログ）**し、`jomon_written_back_at` は未設定のまま将来の Jomon 追加に備える（`paid` は確定済みとして保持）。

#### Scenario: v1 は送金済みを書き戻す

- **WHEN** v1 で payout が（Stripe 送金で）`paid` になる
- **THEN** `PUT .../states/repaid/{trapId}` で「送金済み（repaid_at）」が書き戻され、書き戻し済みが記録される

#### Scenario: v1 は手動振込済みを書き戻す

- **WHEN** v1 で payout が手動振込で `paid` になる（`stripe_transfer_id` 無し）
- **THEN** `stripe_transfer_id` を要求せず、`PUT .../states/repaid/{trapId}` で settled（repaid_at）が書き戻され、書き戻し済みが記録される

#### Scenario: 書き戻し失敗は再試行され、再送金はしない

- **WHEN** 確定（送金または手動振込）は成功したが Jomon 書き戻しが失敗（v2 未対応含む）し、後で再実行する
- **THEN** 送金も手動確定も再実行されず、書き戻しのみ再試行される（v2 は対応追加まで失敗し続けるが二重支払いは起きない）
