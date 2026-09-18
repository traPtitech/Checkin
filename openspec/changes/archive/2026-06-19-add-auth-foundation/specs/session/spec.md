## ADDED Requirements

### Requirement: サーバ側セッションと __Host- cookie

システムは、サーバ側にセッション実体を保存し、不透明（推測困難）なセッション ID を `__Host-` 接頭辞付きの cookie で受け渡し SHALL。cookie 属性は `HttpOnly`・`Secure`・`SameSite`（既定 `Lax`）・`Path=/` とし、`Domain` 属性は付与しない MUST（`__Host-` の制約に従う）。セッションは有効期限を持ち、期限切れ・破棄後の ID では認証されては SHALL NOT。

#### Scenario: セッション cookie の属性

- **WHEN** セッションが確立され cookie が発行される
- **THEN** cookie は `__Host-` 接頭辞付きで `HttpOnly`・`Secure`・`SameSite`・`Path=/` を持ち、`Domain` を持たない

#### Scenario: 期限切れセッションは無効

- **WHEN** 有効期限を過ぎたセッション ID でアクセスする
- **THEN** 認証されず、未ログインとして扱われる

### Requirement: セッションは利用者・会計のいずれかのアクターを表す

セッション実体は、確立元に応じて「利用者（`mail_hash` で識別）」または「会計（traq_id で識別）」のいずれのアクターであるかを保持 SHALL。両者を取り違えて権限を付与しては SHALL NOT。

#### Scenario: 利用者セッション

- **WHEN** isct メール確認によりセッションが確立される
- **THEN** セッションは利用者アクターとして `mail_hash` に紐づく

#### Scenario: 会計セッション

- **WHEN** traQ OAuth ＋ 許可リストによりセッションが確立される
- **THEN** セッションは会計アクターとして traq_id に紐づく

### Requirement: CSRF cookie の発行（double-submit）

システムは、`__Host-checkin_csrf` cookie を発行する手段（`GET /csrf`）を提供 SHALL。CSRF cookie は double-submit 方式で用い、JavaScript から読めるよう `HttpOnly` を付けない（ただし `Secure`・`Path=/`・`SameSite`）。値は推測困難であり、クライアントは状態変更要求時にこの値をヘッダ等で送り返す MUST。

#### Scenario: CSRF cookie を取得できる

- **WHEN** クライアントが `GET /csrf` を呼ぶ
- **THEN** `__Host-checkin_csrf` cookie が発行され、対応するトークン値が返る

### Requirement: 状態変更要求の CSRF 検証

システムは、状態を変更する要求（POST/PATCH/DELETE 等）に対し、リクエストヘッダ等で提示された CSRF トークンと `__Host-checkin_csrf` cookie の値が一致することを検証 SHALL。一致しない、または欠落している場合は処理を拒否する MUST。安全（冪等・副作用なし）な GET には適用しない。

#### Scenario: 一致すれば許可

- **WHEN** ヘッダの CSRF トークンが cookie の値と一致する状態変更要求が来る
- **THEN** 要求は CSRF 検証を通過する

#### Scenario: 不一致・欠落は拒否

- **WHEN** CSRF トークンが欠落、または cookie の値と一致しない状態変更要求が来る
- **THEN** 要求は拒否される

### Requirement: 認可ヘルパ requireUser / requireAdmin

システムは、API のリクエスト Context にセッションを復元し、`requireUser` と `requireAdmin` の認可ヘルパを提供 SHALL。`requireUser` は有効な利用者セッションが無ければ拒否し、操作対象を当該利用者「自分のもの」に限定する手段を与える MUST。`requireAdmin` は会計セッションが無ければ拒否する MUST。

#### Scenario: 未ログインで requireUser

- **WHEN** セッションの無いリクエストが `requireUser` を要する操作を呼ぶ
- **THEN** 認証エラーで拒否される

#### Scenario: 利用者が requireAdmin

- **WHEN** 利用者セッション（会計ではない）で `requireAdmin` を要する操作を呼ぶ
- **THEN** 認可エラーで拒否される

#### Scenario: 会計が requireAdmin

- **WHEN** 会計セッションで `requireAdmin` を要する操作を呼ぶ
- **THEN** 操作が許可される

### Requirement: ログアウト

システムは、現在のセッションを破棄する手段を提供 SHALL。破棄後はサーバ側セッション実体が無効化され、同じ cookie 値では認証されては SHALL NOT。

#### Scenario: ログアウトでセッション無効化

- **WHEN** ログイン中の利用者または会計がログアウトする
- **THEN** サーバ側セッションが無効化され、以後同じ cookie では認証されない
