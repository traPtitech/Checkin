## ADDED Requirements

### Requirement: Jomon アダプタ（pull・v1/v2・stub）

システムは、承認済み振込依頼の取得と結果の書き戻しを `JomonClient` アダプタ越しに行う SHALL。実装は環境設定で `stub` / `v1` / `v2` を選択でき、ドメインは具体実装に依存しては SHALL NOT。Checkin→Jomon の認証は Bearer サービストークン（env、片方向）とする MUST。即時性は不要のため pull 方式とする。

#### Scenario: ドライバを切り替えられる

- **WHEN** `JOMON_API_VERSION` を `stub` / `v1` / `v2` のいずれかに設定する
- **THEN** 対応する `JomonClient` 実装が使われ、ドメインコードは変更不要

#### Scenario: 取得と書き戻しの両操作を持つ

- **WHEN** 払い戻しフローが Jomon と連携する
- **THEN** 「承認済み振込依頼の取得」と「結果（送金済み/失敗）の書き戻し」が `JomonClient` 経由で行える

### Requirement: 取込は jomon_ref で冪等

システムは、取り込んだ振込依頼を `payouts` に記録し、`jomon_ref` を unique キーとして冪等に upsert SHALL。同一依頼を複数回取り込んでも重複行や二重送金を起こしては SHALL NOT。

#### Scenario: 同一依頼の再取込は重複しない

- **WHEN** 同じ `jomon_ref` の依頼を 2 回取り込む
- **THEN** `payouts` 行は 1 つのままで、状態は引き継がれる

### Requirement: 本人特定（対応表 mail_hash）

システムは、各振込依頼の受取人を対応表（`mail_hash`）で特定 SHALL。特定できない依頼は送金へ進めず、役員対応が必要な状態として記録・可視化する MUST（誤送金を避ける）。

#### Scenario: 特定できたら処理を進める

- **WHEN** 振込依頼の受取人が `mail_hash` で `users` 行に解決できる
- **THEN** その依頼は onboarding 判定／送金へ進む

#### Scenario: 特定できなければ送金しない

- **WHEN** 受取人を `mail_hash` で特定できない
- **THEN** 送金は行わず、要対応として記録される

### Requirement: onboarding 未完なら onboarding へ誘導

システムは、受取人の `payout_onboarding_status` が `done` でない場合、connected account を get-or-create し onboarding リンクを発行したうえで、当該 payout を `onboarding_waiting` とする SHALL。`done` になるまで送金しては SHALL NOT。

#### Scenario: 未完は待機にする

- **WHEN** 受取人の onboarding が未完（`done` でない）で払い戻しが必要
- **THEN** onboarding リンクが発行され、payout は `onboarding_waiting` になる（送金はしない）

#### Scenario: 完了後に再開できる

- **WHEN** 受取人の onboarding が `done` になった後で再実行する
- **THEN** `onboarding_waiting` の payout が送金へ進む

### Requirement: Stripe での送金実行（冪等）

システムは、`done` の受取人の connected account に対し Stripe で送金（transfer）を実行 SHALL。`jomon_ref` を Stripe 冪等キーに用い、再試行で二重送金を起こしては SHALL NOT。成功時は payout を `paid` にし `stripe_transfer_id` を保存、失敗時は `failed` にする MUST。

#### Scenario: 送金成功

- **WHEN** `done` の受取人へ送金を実行し成功する
- **THEN** payout は `paid` になり `stripe_transfer_id` が保存される

#### Scenario: 送金失敗

- **WHEN** 送金実行が失敗する
- **THEN** payout は `failed` になり、二重送金は起きない

#### Scenario: 再実行は二重送金しない

- **WHEN** 既に `paid` の payout に対して再実行が起きる
- **THEN** 冪等キーにより新たな送金は発生しない

### Requirement: 結果を Jomon に書き戻す

システムは、送金結果（送金済み / 失敗）を `JomonClient` を通じて Jomon に書き戻す SHALL。書き戻しは結果確定後に行う MUST。

#### Scenario: 送金済みを書き戻す

- **WHEN** payout が `paid` になる
- **THEN** Jomon に「送金済み」が書き戻される

#### Scenario: 失敗を書き戻す

- **WHEN** payout が `failed` になる
- **THEN** Jomon に「失敗」が書き戻される

### Requirement: 払い戻し操作は会計のみ

取込・実行・一覧/状態確認は会計（管理者）のみがアクセス可能 SHALL。認可チェックは入力検証より先に実行され、状態変更を伴う操作は CSRF 検証を行う MUST。

#### Scenario: 会計は実行できる

- **WHEN** 会計セッションで取込・実行・一覧を要求する
- **THEN** 操作が許可される

#### Scenario: 非会計は拒否

- **WHEN** 利用者または未ログインで払い戻し操作を要求する
- **THEN** 認可エラーで拒否される
