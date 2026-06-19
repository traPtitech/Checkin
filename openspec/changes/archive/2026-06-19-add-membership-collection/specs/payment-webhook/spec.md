## ADDED Requirements

### Requirement: Stripe 署名の検証

システムは、`invoice.paid` Webhook を受信する際、`Stripe-Signature` ヘッダと環境変数の Webhook 署名シークレットで署名を検証 SHALL。検証は raw（未加工）リクエストボディに対して行う MUST。署名が無効・欠落の場合は処理せず拒否（4xx）する SHALL。

#### Scenario: 有効な署名は受理

- **WHEN** 正しい署名付きの `invoice.paid` イベントが届く
- **THEN** 署名検証を通過し、イベント処理に進む

#### Scenario: 無効な署名は拒否

- **WHEN** 署名が欠落または不正なリクエストが届く
- **THEN** イベントは処理されず、拒否（4xx）される

### Requirement: event id による冪等処理

システムは、処理済みの Stripe event id を記録し、同一 event id の再送を二重処理しては SHALL NOT。Stripe は同一イベントを複数回送ることがあるため、event id 単位で一度だけ副作用（通知等）を発火 MUST。

#### Scenario: 同一イベントの再送は一度だけ処理

- **WHEN** 同じ event id の `invoice.paid` が 2 回届く
- **THEN** 副作用（会計への通知）は 1 回だけ発火し、2 回目はスキップされる

### Requirement: 入金時に会計へ通知

システムは、`invoice.paid` を正常受信・検証したとき、会計へ通知 SHALL。通知は `Notifier` 抽象を介して行い、実装は差し替え可能とする（当面はログ実装でよい）。一覧表示自体は本 capability の責務ではなく、後続の入出金一覧で Stripe から取得する。

#### Scenario: 入金で通知が発火

- **WHEN** 検証済みの `invoice.paid`（未処理の event id）を受信する
- **THEN** `Notifier` を通じて会計向けの通知が 1 回発火する
