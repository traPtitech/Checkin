# connect-onboarding

## Purpose

払い戻し（transfer/payout）の前提となる Stripe Connect connected account の just-in-time onboarding。受取人ごとに connected account を get-or-create し、ホスト型 onboarding リンクを発行し、`account.updated` Webhook のフラグ判定で払い出し可否を見極めて状態（`none`/`requested`/`done`）を冪等に進める。実送金・Jomon 連携は別 capability。

## Requirements

### Requirement: connected account の get-or-create

システムは、受取人（`users` 行）に対し Stripe Connect の connected account を解決 SHALL：`users.stripe_connected_account_id` があれば再利用し、無ければ作成して保存する MUST。作成する account は Express とし、`metadata` に `mail_hash` を入れてよいが、対応付けの参照キーは `stripe_connected_account_id` とする。保存は競合時にも重複・上書きを起こさない（条件付き compare-and-set で、敗者は自分が作った余分な account を後始末する）MUST。`stripe_connected_account_id` は `users` で unique である MUST。

#### Scenario: 既存の connected account を再利用

- **WHEN** `users.stripe_connected_account_id` が設定済みの受取人に onboarding を要求する
- **THEN** 新規作成せず、保存済みの connected account を使う

#### Scenario: 無ければ作成して保存

- **WHEN** connected account 未連携の受取人に onboarding を要求する
- **THEN** connected account を作成し、`users.stripe_connected_account_id` に保存する

#### Scenario: 競合しても重複を残さない

- **WHEN** 同一受取人に対して onboarding 発行が同時並行で起きる
- **THEN** 永続化される connected account は 1 つだけで、敗者側が作成した余分な account は後始末される

### Requirement: ホスト型 onboarding リンクの発行

システムは、connected account に対し Stripe **ホスト型** onboarding リンク（Account Link）を発行 SHALL。発行時、当該受取人の `payout_onboarding_status` を `requested` に遷移する MUST（既に `done` の場合は `done` を維持）。refresh / return URL は自サイト（`APP_ORIGIN` 配下）とする。

#### Scenario: リンク発行で requested になる

- **WHEN** 会計が受取人の onboarding リンク発行を要求する
- **THEN** ホスト型 onboarding リンク（URL）が返り、受取人の状態が `requested` になる

### Requirement: onboarding の状態機械（none / requested / done）

システムは、`payout_onboarding_status` を `none`（初期）→ `requested`（リンク発行）→ `done`（払い出し可能を検知）で管理 SHALL。`done` は終端であり、後退しては SHALL NOT。状態遷移は冪等で、同じ入力で繰り返し評価しても結果が変わらない MUST。

#### Scenario: 初期状態は none

- **WHEN** まだ onboarding を開始していない受取人を参照する
- **THEN** 状態は `none`

#### Scenario: done は維持される

- **WHEN** 既に `done` の受取人に対して再度評価・リンク発行が起きる
- **THEN** 状態は `done` のまま後退しない

### Requirement: account.updated による払い出し可否のフラグ判定

システムは、`account.updated` Webhook を受信したとき、署名検証（Connect 用署名シークレット）→ event id による冪等 → イベントの connected account を特定 → `payouts_enabled` と未提出要件（`requirements.currently_due` が空）から「払い出し可能か」を判定 SHALL。Stripe は単発の「完了」イベントを送らず `account.updated` を何度も送るため、「来たら done」ではなく**フラグで判定** MUST。払い出し可能なら `requested` を `done` に遷移する。署名が無効・欠落なら拒否（4xx）する SHALL。該当 account の受取人が存在しなければ無視（200）する。

#### Scenario: 払い出し可能で done に遷移

- **WHEN** `payouts_enabled` が真かつ未提出要件が無い `account.updated` を受信する
- **THEN** 対象受取人の状態が `done` に遷移する

#### Scenario: 未完了のイベントでは done にしない

- **WHEN** `payouts_enabled` が偽、または未提出要件が残る `account.updated` を受信する
- **THEN** 状態は `done` に遷移しない（`requested` を維持）

#### Scenario: 同一イベントの再送は二重処理しない

- **WHEN** 同じ event id の `account.updated` が再送される
- **THEN** 既処理として扱い、副作用を二重に起こさない

#### Scenario: 無効署名は拒否

- **WHEN** 署名が欠落または不正な Webhook が届く
- **THEN** 処理せず拒否（4xx）される

### Requirement: 発行・状態確認は会計のみ

onboarding リンク発行と状態確認は会計（管理者）のみがアクセス可能 SHALL。認可チェックは入力検証より先に実行される MUST。状態変更を伴う発行は CSRF 検証を行う MUST。

#### Scenario: 会計はリンク発行・状態確認できる

- **WHEN** 会計セッションで onboarding リンク発行または状態確認を要求する
- **THEN** 操作が許可される

#### Scenario: 非会計は拒否

- **WHEN** 利用者または未ログインで onboarding リンク発行を要求する
- **THEN** 認可エラーで拒否される
