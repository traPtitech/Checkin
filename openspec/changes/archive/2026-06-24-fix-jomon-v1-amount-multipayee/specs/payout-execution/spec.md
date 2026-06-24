## ADDED Requirements

### Requirement: v1 の払い戻し金額と複数受取人の扱い

v1 は払い戻し金額を**申請単位**（`current_detail.amount`）でしか持たず、受取人（`repayment_logs[]`）単位の金額を持たない。システムは v1 ドライバで金額を `current_detail.amount` から取得する SHALL（repayment_log に `amount` を要求しては SHALL NOT）。

送金へ進めるかは申請の**総受取人数**（`repayment_logs` の要素数）で判定する MUST：
- 受取人が **1 人だけ**の申請は、その人の払い戻し額が申請額に等しいので、未払いなら `current_detail.amount` で送金フローへ進める MUST。
- 受取人が **2 人以上**の申請は、`current_detail.amount` が申請総額であり個人へ按分する根拠が無いため、**たとえ未払いが 1 人でも**自動送金しては SHALL NOT（残り 1 人へ総額を送ると過払いになる）。`payouts` 行を作らず、`processApproved` の集計で needs-review に数え、対象 application id を返却して会計の UI に**警告として明示**する MUST。
- 全受取人が支払い済み（未払い 0 人）の申請は送金対象にしない。

この判定は手動の単一実行（`payouts.execute`）でも同様に適用し、複数受取人の申請を送金へ進めては SHALL NOT。

#### Scenario: 受取人が 1 人の申請は申請額で送金へ進む

- **WHEN** 承認済み申請の受取人が 1 人で未払いである
- **THEN** その受取人を payee とし、`current_detail.amount` を払い戻し額として送金フロー（本人特定・onboarding・原子的クレーム・送金）へ進む

#### Scenario: 受取人が複数の申請は自動送金せず UI 警告（一部支払い済みでも）

- **WHEN** 承認済み申請の受取人が 2 人以上である（未払いが 1 人だけに減っていても含む）
- **THEN** 自動送金せず（`payouts` 行も作らず）、needs-review として集計し、対象 application id を会計 UI に警告として表示する

#### Scenario: v1 の金額は申請単位から取得する

- **WHEN** v1 ドライバが承認済み申請の詳細を取得する
- **THEN** 払い戻し額は `current_detail.amount` から取得され、repayment_log 側の金額には依存しない
