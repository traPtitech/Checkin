## ADDED Requirements

### Requirement: traQ ID による本人解決と連結

`mail_hash` を本人の主キーとしつつ、システムは**認証済みの traQ ID** を `users.traq_id`（nullable, unique）として本人行に連結 SHALL。`traq_id` は解決の副キーであり、Jomon の払い戻し（traQ ID で受取人を渡す）を本人行へ解決するために用いる。連結に使う traQ ID は**traQ OAuth で認証済みのセッション由来**のものに限る MUST（フォーム入力の traQ ID は §4.1 通り信頼せず連結に使っては SHALL NOT）。`traq_id` は一意であり、二人に同じ traQ ID を連結しては SHALL NOT。

#### Scenario: 連結済み traq_id で本人解決

- **WHEN** `users.traq_id` に連結済みの traq_id で解決を要求する
- **THEN** 対応する本人行が返る

#### Scenario: 未連結は解決できない

- **WHEN** どの本人行にも連結されていない traq_id で解決を要求する
- **THEN** 本人は解決されない（払い戻しでは要対応扱い）

#### Scenario: フォーム入力の traQ ID は連結に使わない

- **WHEN** 請求フォーム等で traQ ID が入力される（未認証）
- **THEN** その traQ ID は `users.traq_id` の連結・参照に使われない

#### Scenario: traq_id は一意

- **WHEN** 既に他の本人行へ連結済みの traq_id を別の本人行へ連結しようとする
- **THEN** 連結は拒否される（unique 制約）
