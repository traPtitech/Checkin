# member-ui

## Purpose

利用者向けの Web UI（`@nuxt/ui`）。共通レイアウト/ヘッダー（ログイン状態表示）、トップ `/` の状態別出し分け、`/verify-email` の isct 確認メール送信（redirect 保持）、`/membership` の design §5.1 デュアル・アイデンティティ振り分けと請求書発行 → 支払いページ誘導。サーバ状態は既存 oRPC（`auth.me` / `auth.requestEmailVerification` / `membership.issueInvoice`）と Nitro ルート（`/verify-email/confirm` / `/login` / `/logout` / `/csrf`）越しに扱う。

## Requirements

### Requirement: 共通レイアウトとログイン状態表示

システムは、全利用者向けページに共通ヘッダー（サービスロゴ）を表示 SHALL。`auth.me`（`{ authenticated, member, admin, hasUser, traqId }`）で現在の状態を取得し、ログイン中はその旨（会員/会計の識別表示）とログアウト導線を、未ログイン時はログイン/確認への導線を出す MUST。

#### Scenario: 未ログインのヘッダー

- **WHEN** 未ログインでページを開く
- **THEN** ロゴと「部費を払う／会計・現役の方はログイン」等の導線が表示され、ログアウトは表示されない

#### Scenario: ログイン中のヘッダー

- **WHEN** 会員または会計としてログイン中にページを開く
- **THEN** ログイン状態（会員/会計、必要なら traqId）とログアウト導線が表示される

### Requirement: トップページの状態別出し分け

`/` は、ログイン状態・権限に応じて機能への導線を出し分け SHALL。未ログインは部費支払いとログインへの導線、ログイン済みは現在の状態表示と主要導線・ログアウトを表示する MUST。

#### Scenario: 未ログインのトップ

- **WHEN** 未ログインで `/` を開く
- **THEN** 「部費を払う（/membership）」と「ログイン（traQ）」への導線が出る

#### Scenario: ログイン済みのトップ

- **WHEN** ログイン済みで `/` を開く
- **THEN** 現在の状態（member/admin/hasUser）が表示され、ログアウトできる

### Requirement: isct メール確認フロー（redirect 保持）

`/verify-email` は、isct メールアドレスの入力を受け、`auth.requestEmailVerification` を呼んで確認メールを送信し、送信完了を利用者に明示 SHALL。`redirect` クエリを同一サイトにサニタイズして保持し、確認後にその安全な遷移先へ戻せるようにする MUST。許可ドメイン外・エラー時はその旨を表示し、送信中は二重送信を防ぐ。

#### Scenario: 確認メール送信

- **WHEN** 利用者が isct メールを入力して送信する
- **THEN** 確認メール送信が要求され、「確認メールを送信しました」と表示される

#### Scenario: redirect を保持する

- **WHEN** `/verify-email?redirect=/membership` から確認を開始する
- **THEN** 確認リンクは `redirect=/membership` を保持し、確認完了後に `/membership` へ戻る

#### Scenario: ドメイン外の入力

- **WHEN** 許可ドメイン外のメールを送信する
- **THEN** エラーが表示され、確認メールは送られない

### Requirement: 部費支払いの振り分けと発行

`/membership` は、`auth.me` のデュアル・アイデンティティ（`member`/`hasUser`/`admin`）に応じて design §5.1 の振り分けを行う SHALL。

- **未ログイン**では `新規入部 / 再入部 / 現役` の選択を提示する。`新規入部`・`再入部` は `/verify-email?redirect=...` へ、`現役` は `/login?redirect=/membership`（traQ ログイン）へ誘導する MUST。
- **traQ 会員だが利用者未連結（`member && !hasUser`）**では、isct メール確認で連結するよう `/verify-email?redirect=/membership` へ誘導する MUST。
- **利用者あり（`hasUser`）**では請求書フォーム（メール・氏名・区分）から `membership.issueInvoice` を呼び、発行された支払いページ（`hostedInvoiceUrl`）へ誘導する MUST。

区分は `新規入部`・`再入部` を `new`、`現役` を `continuation` に対応づける。特別 ¥2,000 は会計のみで、利用者 UI には出さない SHALL。

#### Scenario: 未ログインの新規/再入部は確認へ

- **WHEN** 未ログインで `新規入部` または `再入部` を選ぶ
- **THEN** `/verify-email?redirect=/membership` へ誘導される

#### Scenario: 未ログインの現役は traQ ログインへ

- **WHEN** 未ログインで `現役` を選ぶ
- **THEN** `/login?redirect=/membership`（traQ ログイン）へ誘導される

#### Scenario: 会員だが未連結は確認へ

- **WHEN** traQ ログイン済みだが利用者未連結（`member && !hasUser`）で `/membership` を開く
- **THEN** isct 確認で連結するよう `/verify-email?redirect=/membership` へ誘導される

#### Scenario: 利用者ありは請求書を発行できる

- **WHEN** `hasUser` の利用者がメール・氏名・区分を入力して発行する
- **THEN** `membership.issueInvoice` が呼ばれ、成功時は支払いページ（`hostedInvoiceUrl`）への導線が表示される

#### Scenario: 区分が価格種別に対応する

- **WHEN** 区分として `現役` を選ぶ
- **THEN** `feeType: 'continuation'` で発行される（`新規入部`・`再入部` は `feeType: 'new'`）

#### Scenario: 発行失敗の表示

- **WHEN** 発行要求がエラーになる（例: 設定不足や認可エラー）
- **THEN** 利用者にエラーが表示され、二重送信を促さない
