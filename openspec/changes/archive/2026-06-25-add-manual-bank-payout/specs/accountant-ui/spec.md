# accountant-ui

## ADDED Requirements

### Requirement: 払い戻しの手動振込済み操作（`/payouts`）

`/payouts` は会計のみに対し、各払い戻し行に「手動振込済みにする」操作を提供 SHALL。これは Stripe Connect のオンボーディングを完了できない受取人へ会計が銀行から手で振り込んだケースを記録するための操作である。操作は `pending` / `onboarding_waiting` / `failed` の行にのみ表示し、`paid` / `processing` の行には表示しては SHALL NOT。

操作は参照メモ（振込参照番号など）を入力させ、確定前に確認ダイアログ（誤確定・二重支払い防止）を表示する MUST。確定時は `payouts.markManuallyPaid({ jomonRef, note })`（`adminProc` / CSRF 検証）を呼ぶ MUST。成功後は一覧を再取得し、実行中は同操作の二重発火を防ぐ MUST。確定済みの行は `paid`・手動振込（`payout_method=manual_bank`）として一覧に反映され、参照メモ・実行者・手動 paid 日時を確認できる MUST。

#### Scenario: 未払い行を手動振込済みにする

- **WHEN** 会計が `pending` / `onboarding_waiting` / `failed` の行で「手動振込済みにする」を選び、参照メモを入力して確認ダイアログで確定する
- **THEN** `payouts.markManuallyPaid({ jomonRef, note })` が呼ばれ、成功すると一覧が再取得され、その行が `paid`（手動振込）として表示される

#### Scenario: paid / processing には操作を出さない

- **WHEN** 会計が `paid` または `processing` の行を見る
- **THEN** 「手動振込済みにする」操作は表示されない

#### Scenario: 確認なしには確定しない

- **WHEN** 会計が「手動振込済みにする」を開いて確認ダイアログをキャンセルする
- **THEN** `payouts.markManuallyPaid` は呼ばれず、状態は変化しない

#### Scenario: 実行中の二重操作防止

- **WHEN** ある行の手動振込確定が実行中
- **THEN** 同じ操作は二重に発火せず、完了後に一覧が再取得される
