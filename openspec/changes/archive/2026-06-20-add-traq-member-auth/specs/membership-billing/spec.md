## ADDED Requirements

### Requirement: 支払い時の traQ ID 連結

請求書発行時、セッションが **traQ 認証（traqId）と利用者（userId）の双方**を持つ場合、システムは当該本人行の `users.traq_id` を保存（未設定時）し、Stripe Customer の `metadata` にも traQ ID を入れる SHALL。参照キーは引き続き `mail_hash` / `stripe_customer_id` であり、traQ ID は連結・ログ用に留める。`users.traq_id` が既に設定済みなら上書きしては SHALL NOT。traQ 未認証（traqId 無し）の発行では連結しない。

#### Scenario: traQ 認証済みの支払いで連結される

- **WHEN** traQ 認証済みかつ user 解決済みのセッションで標準請求書を発行する
- **THEN** その本人行の `users.traq_id` が（未設定なら）保存され、Customer metadata にも traQ ID が入る

#### Scenario: 既に連結済みなら維持

- **WHEN** 既に `users.traq_id` を持つ本人が再度発行する
- **THEN** 既存の `traq_id` は上書きされない

#### Scenario: traQ 未認証では連結しない

- **WHEN** isct のみ（traQ 未認証）のセッションで発行する
- **THEN** `users.traq_id` は設定されない（発行自体は従来どおり可能）
