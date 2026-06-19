# identity

## Purpose

サービス内の本人を、メール平文に依存しない不透明キー `mail_hash` で識別する。集金側（Stripe Customer）と払い戻し側（connected account）を 1 つの本人行に束ねる「対応表」の基盤であり、対応表は自前 DB を source of truth とする。

## Requirements

### Requirement: 本人キーは mail_hash

システムは、サービス内の本人を `mail_hash` で識別 SHALL。`mail_hash` は isct メールアドレスから導出される不透明な識別子であり、集金側（Customer）と払い戻し側（connected account）を 1 つの本人行に束ねる対応表の主キーとして用いる。`mail_hash` は `users` テーブルで unique であり、同一人物（同一 isct メール）は常に同一の `mail_hash` を持つ MUST。

#### Scenario: 同一メールは同一の本人行に解決される

- **WHEN** 同一の isct メールから 2 回 `mail_hash` を導出する
- **THEN** 同一の `mail_hash` が得られ、同一の `users` 行に解決される

#### Scenario: 異なるメールは異なる本人行になる

- **WHEN** 異なる 2 つの isct メールから `mail_hash` を導出する
- **THEN** 異なる `mail_hash` が得られ、別々の `users` 行になる

### Requirement: mail_hash の正規化と導出

`mail_hash` は、メールアドレスを正規化（前後空白の除去、ローカル部とドメインの小文字化）したうえで、環境変数で与えられる秘密鍵を用いた **HMAC-SHA256** によって導出 SHALL。導出は決定的であり、同じ入力からは常に同じ出力を返す MUST。秘密鍵が未設定の場合、システムは起動・処理を継続せずエラーとする SHALL（弱い既定値へフォールバックしてはならない）。

#### Scenario: 大文字小文字・空白が異なっても同一になる

- **WHEN** `"  Foo.Bar@m.isct.ac.jp "` と `"foo.bar@m.isct.ac.jp"` をそれぞれ正規化して導出する
- **THEN** 両者の `mail_hash` は一致する

#### Scenario: 秘密鍵が未設定なら処理を拒否する

- **WHEN** `mail_hash` 用の秘密鍵が環境変数に設定されていない状態で導出が要求される
- **THEN** システムはエラーを返し、弱い既定値での導出は行わない

### Requirement: メール平文を永続化しない

システムは、isct メールの平文を DB に保存しては SHALL NOT。本人識別に必要なのは `mail_hash` のみであり、メール平文は確認メールの送信や Stripe Customer 作成など処理中の一時的な利用に限る。メール平文の保持が必要な場面（請求先など）は Stripe 側に委ねる。一方で、本人行（`users`）が **非 PII の Stripe 参照**（例: `stripe_customer_id`）を保持することは許容される MUST（これらはメール平文ではない）。

#### Scenario: 確認後に平文が残らない

- **WHEN** isct メール確認が完了し本人行が作成される
- **THEN** `users` 行にはメール平文を保持する列が存在せず、識別は `mail_hash` で行われる

#### Scenario: Stripe 参照は保持してよい

- **WHEN** 集金フローで Customer が作成され `stripe_customer_id` が保存される
- **THEN** `users` 行は `stripe_customer_id`（非 PII の参照）を保持できるが、メール平文の列は持たない

### Requirement: 本人行の get-or-create

システムは、確認済みの `mail_hash` に対して本人行を取得し、無ければ作成する操作を提供 SHALL。作成は冪等であり、競合時にも `mail_hash` の unique 制約により重複行を作らない MUST。

#### Scenario: 初回は作成される

- **WHEN** 既存行の無い `mail_hash` で get-or-create を呼ぶ
- **THEN** 新しい `users` 行が作成され、その行が返る

#### Scenario: 2 回目は既存行が返る

- **WHEN** 既に行のある `mail_hash` で get-or-create を呼ぶ
- **THEN** 新しい行は作られず、既存の行が返る
