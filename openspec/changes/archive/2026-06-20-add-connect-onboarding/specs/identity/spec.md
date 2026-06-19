## MODIFIED Requirements

### Requirement: メール平文を永続化しない

システムは、isct メールの平文を DB に保存しては SHALL NOT。本人識別に必要なのは `mail_hash` のみであり、メール平文は確認メールの送信や Stripe Customer 作成など処理中の一時的な利用に限る。メール平文の保持が必要な場面（請求先など）は Stripe 側に委ねる。一方で、本人行（`users`）が **非 PII の Stripe 参照**（例: `stripe_customer_id`、`stripe_connected_account_id`）や、それに付随する**非 PII の状態**（例: `payout_onboarding_status`）を保持することは許容される MUST（これらはメール平文ではない）。

#### Scenario: 確認後に平文が残らない

- **WHEN** isct メール確認が完了し本人行が作成される
- **THEN** `users` 行にはメール平文を保持する列が存在せず、識別は `mail_hash` で行われる

#### Scenario: Stripe 参照は保持してよい

- **WHEN** 集金フローで Customer が作成され `stripe_customer_id` が保存される
- **THEN** `users` 行は `stripe_customer_id`（非 PII の参照）を保持できるが、メール平文の列は持たない

#### Scenario: 払い戻しの Connect 参照・状態も保持してよい

- **WHEN** 払い戻しの onboarding で connected account が作成され `stripe_connected_account_id` と `payout_onboarding_status` が保存される
- **THEN** `users` 行はこれら非 PII の参照・状態を保持できるが、メール平文の列は持たない
