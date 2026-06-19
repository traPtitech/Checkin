# payment-webhook

## Purpose

Stripe の `invoice.paid` Webhook を受信し、署名検証・event id による冪等処理を行ったうえで会計へ通知する。入金検知の入口であり、一覧表示自体は後続の入出金一覧（Stripe から取得）に委ねる。

## Requirements

### Requirement: Stripe 署名の検証

システムは、`invoice.paid` Webhook を受信する際、`Stripe-Signature` ヘッダと環境変数の Webhook 署名シークレットで署名を検証 SHALL。検証は raw（未加工）リクエストボディに対して行う MUST。署名が無効・欠落の場合は処理せず拒否（4xx）する SHALL。

#### Scenario: 有効な署名は受理

- **WHEN** 正しい署名付きの `invoice.paid` イベントが届く
- **THEN** 署名検証を通過し、イベント処理に進む

#### Scenario: 無効な署名は拒否

- **WHEN** 署名が欠落または不正なリクエストが届く
- **THEN** イベントは処理されず、拒否（4xx）される

### Requirement: event id による冪等処理

システムは、処理済みの Stripe event id を記録し、同一 event id の再送を二重処理しては SHALL NOT。Stripe は同一イベントを複数回送ることがあるため、event id 単位で副作用（通知）を抑止 MUST。通知が成功した後に event id を記録することで、通知失敗時は記録されず Stripe の再送で再試行される（at-least-once）。

#### Scenario: 同一イベントの再送は二重処理しない

- **WHEN** 通知済みの event id を持つ `invoice.paid` が再送される
- **THEN** 既処理として扱われ、通知は再発火しない

#### Scenario: 通知失敗時は記録されず再試行できる

- **WHEN** 受信した未処理イベントで通知が失敗する
- **THEN** event id は記録されず、Stripe の再送で通知が再試行される

### Requirement: 入金時に会計へ通知

システムは、`invoice.paid` を正常受信・検証したとき、会計へ通知 SHALL。通知は `Notifier` 抽象を介して行い、実装は差し替え可能とする（当面はログ実装でよい）。一覧表示自体は本 capability の責務ではなく、後続の入出金一覧で Stripe から取得する。

#### Scenario: 入金で通知が発火

- **WHEN** 検証済みの `invoice.paid`（未処理の event id）を受信する
- **THEN** `Notifier` を通じて会計向けの通知が発火する
