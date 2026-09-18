## ADDED Requirements

### Requirement: 会計のみがアクセスできる

入出金一覧は会計（管理者）のみがアクセス可能 SHALL。利用者・未ログインのアクセスは拒否する MUST。

#### Scenario: 会計は一覧を取得できる

- **WHEN** 会計セッションで入出金一覧を要求する
- **THEN** 一覧が返る

#### Scenario: 非会計は拒否される

- **WHEN** 利用者または未ログインで入出金一覧を要求する
- **THEN** 認可エラーで拒否される

### Requirement: 請求書由来と決済ページ由来の 2 系統

システムは、入出金一覧を「請求書由来（Stripe Invoices）」と「決済ページ由来（Stripe Checkout Sessions）」の 2 系統で提供 SHALL。各系統は独立したエンドポイントで取得できる MUST。一覧は Stripe を source とし、自前 DB に複製しない。

#### Scenario: 請求書由来を取得

- **WHEN** 会計が請求書由来の一覧を要求する
- **THEN** Stripe Invoices に基づく行の一覧が返る

#### Scenario: 決済ページ由来を取得

- **WHEN** 会計が決済ページ由来の一覧を要求する
- **THEN** Stripe Checkout Sessions に基づく行の一覧が返る

### Requirement: フィルタとカーソルページネーション

システムは、`status` 等で絞り込み、カーソル方式（`limit` ＋ `starting_after`）でページングできる SHALL。レスポンスには次ページの有無（`hasMore`）と次カーソルを含める MUST。`limit` には上限を設け、過大値はクランプする SHALL。

#### Scenario: status で絞り込む

- **WHEN** `status` を指定して一覧を要求する
- **THEN** その状態に一致する行のみが返る

#### Scenario: 次ページを取得する

- **WHEN** 前ページの次カーソルを `starting_after` に指定して要求する
- **THEN** 続きの行が返り、さらに続きがあれば `hasMore` が真になる

### Requirement: 行項目の正規化

システムは、各行を Stripe 型に依存しないドメイン DTO に正規化して返す SHALL。各行は少なくとも次を含む MUST：`id`、金額（最小単位＋通貨）、日時、customer 参照（id、可能なら名前）、支払い状況、支払いの id、商品（Price）参照、および Stripe Dashboard で開ける URL。

#### Scenario: 行に必要項目が含まれる

- **WHEN** 一覧の各行を受け取る
- **THEN** `id`・金額・通貨・日時・customer 参照・支払い状況・支払い id・商品参照・Dashboard URL が含まれる

### Requirement: Dashboard URL の生成

システムは、支払い／請求のオブジェクト id から Stripe Dashboard の URL を生成 SHALL。test/live のモードに応じて URL（`/test/` の有無）を切り替える MUST。

#### Scenario: test モードの URL

- **WHEN** test モードのオブジェクトから Dashboard URL を生成する
- **THEN** URL は test 用のパス（`/test/`）を含む

#### Scenario: live モードの URL

- **WHEN** live モードのオブジェクトから Dashboard URL を生成する
- **THEN** URL は live 用のパス（`/test/` を含まない）になる
