# stripe-customer

## Purpose

`mail_hash` と Stripe Customer を対応付ける。get-or-create（DB→メール検索→作成）で `stripe_customer_id` を自前 DB に永続化し、Stripe 呼び出しはアダプタ境界に閉じ込めて集金ドメインを Stripe 非依存に保つ。

## Requirements

### Requirement: Customer の get-or-create

システムは、`mail_hash` に対応する Stripe Customer を次の順で解決 SHALL：(1) DB の `users.stripe_customer_id` があればそれを使う、(2) 無ければ提出されたメールで Stripe を検索して一致があれば採用、(3) それでも無ければ作成する。新規作成・検索採用のいずれでも、得た `customer_id` を `users` に保存 MUST。Customer 作成にはメール平文が必要であり、利用者発行フローでは提出メールから導出した `mail_hash` がセッションの `mail_hash` と一致することを前提とする。

#### Scenario: DB に customer_id があれば再利用

- **WHEN** `users.stripe_customer_id` が設定済みの利用者が請求書発行を要求する
- **THEN** Stripe 検索・作成を行わず、保存済みの Customer を使う

#### Scenario: DB に無く Stripe に既存があれば採用して保存

- **WHEN** DB に `stripe_customer_id` が無く、提出メールで Stripe を検索して既存 Customer が見つかる
- **THEN** その Customer を採用し、`users.stripe_customer_id` に保存する

#### Scenario: どちらにも無ければ作成して保存

- **WHEN** DB にも Stripe にも該当 Customer が無い
- **THEN** メール（＋名前）で Customer を作成し、`users.stripe_customer_id` に保存する

### Requirement: 参照キーは customer_id（traQ ID を参照に使わない）

システムは、本人と Customer の対応付けの参照キーとして `stripe_customer_id`（DB 保存）を用いる SHALL。再入部時などに入力された traQ ID は信頼できないため、Customer の保存・参照キーには使っては SHALL NOT。ログ可読性のため Customer の `name` / `metadata` に `mail_hash` や traQ ID を入れるのは可とするが、参照には使わない。

#### Scenario: traQ ID は参照に使われない

- **WHEN** 利用者が請求書発行時に traQ ID を入力する
- **THEN** その traQ ID は Customer の参照・保存キーには使われず、対応付けは `mail_hash`／`stripe_customer_id` で行われる

### Requirement: Stripe 呼び出しはアダプタ境界に閉じ込める

システムは、Stripe SDK の呼び出しをアダプタ層に隔離 SHALL。集金ドメイン（費目・期・価格・認可の判定）は Stripe 型に直接依存しては SHALL NOT。これにより「Stripe オフ→口座振込」や将来の API 移行をアダプタ差し替えで吸収できる。

#### Scenario: ドメインは Stripe 非依存

- **WHEN** 価格や期の判定ロジックを参照する
- **THEN** それらは Stripe SDK の型・呼び出しに依存せず、アダプタのインターフェース越しにのみ Stripe を使う
