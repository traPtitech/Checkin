## MODIFIED Requirements

### Requirement: セッションは利用者・会計のいずれかのアクターを表す

セッション実体は、**traQ 認証（traqId）** と **利用者（`mail_hash` 由来の userId/mailHash）** の双方のアイデンティティを保持でき、会計権限フラグ（`isAdmin`）を持つ SHALL。1 つのセッションが両アイデンティティを併せ持てる（traQ ログイン済みの現役が isct 確認も済ませた場合）。アイデンティティを取り違えて権限を付与しては SHALL NOT。

#### Scenario: 会員（traQ）セッション

- **WHEN** traQ OAuth でログインする
- **THEN** セッションは traqId を持つ会員として確立される（user 未連結なら userId は持たない）

#### Scenario: 利用者（isct）セッション

- **WHEN** isct メール確認でログインする
- **THEN** セッションは userId/mailHash を持つ利用者として確立される

#### Scenario: 連結済みは両アイデンティティを持つ

- **WHEN** traQ 会員が isct 確認も済ませる、または `users.traq_id` が連結済みの traq_id でログインする
- **THEN** セッションは traqId と userId/mailHash の双方を持つ

#### Scenario: 会計はフラグで表す

- **WHEN** 許可リストに含まれる traq_id でログインする
- **THEN** セッションは `isAdmin` を持つ

### Requirement: 認可ヘルパ requireUser / requireAdmin

システムは、API のリクエスト Context にセッションを復元し、`requireMember` / `requireUser` / `requireAdmin` の認可ヘルパを提供 SHALL。`requireMember` は traQ 認証（traqId）が無ければ拒否する。`requireUser` は請求可能な利用者アイデンティティ（userId）が無ければ拒否し、操作対象を当該利用者「自分のもの」に限定する手段を与える MUST。`requireAdmin` は会計権限（`isAdmin`）が無ければ拒否する MUST。

#### Scenario: 未ログインで requireUser

- **WHEN** セッションの無いリクエストが `requireUser` を要する操作を呼ぶ
- **THEN** 認証エラーで拒否される

#### Scenario: user 未連結の会員が requireUser

- **WHEN** traQ 会員だが user 未連結（userId 無し）のセッションで `requireUser` を要する操作を呼ぶ
- **THEN** 認証エラーで拒否される（isct 確認/連結が必要）

#### Scenario: 会員が requireMember

- **WHEN** traQ 認証済みセッションで `requireMember` を要する操作を呼ぶ
- **THEN** 操作が許可される

#### Scenario: 会員（非会計）が requireAdmin

- **WHEN** `isAdmin` を持たないセッションで `requireAdmin` を要する操作を呼ぶ
- **THEN** 認可エラーで拒否される

#### Scenario: 会計が requireAdmin

- **WHEN** `isAdmin` を持つセッションで `requireAdmin` を要する操作を呼ぶ
- **THEN** 操作が許可される
