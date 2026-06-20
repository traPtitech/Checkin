## ADDED Requirements

### Requirement: 共通レイアウトとログイン状態表示

システムは、全利用者向けページに共通ヘッダー（サービスロゴ）を表示 SHALL。`auth.me` で現在のアクターを取得し、ログイン中はその旨（アイコン/識別表示）とログアウト導線を、未ログイン時はログイン/確認への導線を出す MUST。

#### Scenario: 未ログインのヘッダー

- **WHEN** 未ログインでページを開く
- **THEN** ロゴと「部費を払う／会計の方はこちら」等の導線が表示され、ログアウトは表示されない

#### Scenario: ログイン中のヘッダー

- **WHEN** 利用者または会計としてログイン中にページを開く
- **THEN** ログイン状態（アイコン/識別）とログアウト導線が表示される

### Requirement: トップページの状態別出し分け

`/` は、ログイン状態・権限に応じて機能への導線を出し分け SHALL。未ログインは部費支払いと会計ログインへの導線、ログイン済みは現在のアクター表示と主要導線を表示する MUST。

#### Scenario: 未ログインのトップ

- **WHEN** 未ログインで `/` を開く
- **THEN** 「部費を払う（/membership）」と「会計の方はこちら（traQ ログイン）」への導線が出る

#### Scenario: ログイン済みのトップ

- **WHEN** ログイン済みで `/` を開く
- **THEN** 現在のアクターが表示され、ログアウトできる

### Requirement: isct メール確認フロー（redirect 保持）

`/verify-email` は、isct メールアドレスの入力を受け、`auth.requestEmailVerification` を呼んで確認メールを送信し、送信完了を利用者に明示 SHALL。`redirect` クエリを保持し、確認後にその安全な遷移先へ戻せるようにする MUST。許可ドメイン外・エラー時はその旨を表示する。

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

`/membership` は、ログイン状態に応じて振り分け SHALL。未ログイン（isct 未確認）では `新規入部 / 再入部 / 現役` の選択を提示し、いずれも `/verify-email?redirect=/membership` へ誘導する MUST。ログイン済み（isct 確認済み）では請求書フォーム（メール・氏名・区分）から `membership.issueInvoice` を呼び、発行された支払いページ（`hostedInvoiceUrl`）へ誘導する MUST。区分は `新規入部`・`再入部` を `new`、`現役` を `continuation` に対応づける。特別 ¥2,000 は会計のみで、利用者 UI には出さない SHALL。

#### Scenario: 未ログインは確認へ誘導

- **WHEN** 未ログインで `/membership` を開き区分を選ぶ
- **THEN** `/verify-email?redirect=/membership` へ誘導される

#### Scenario: ログイン済みは請求書を発行できる

- **WHEN** ログイン済み利用者がメール・氏名・区分を入力して発行する
- **THEN** `membership.issueInvoice` が呼ばれ、成功時は支払いページ（`hostedInvoiceUrl`）への導線が表示される

#### Scenario: 区分が価格種別に対応する

- **WHEN** 区分として `現役` を選ぶ
- **THEN** `feeType: 'continuation'` で発行される（`新規入部`・`再入部` は `feeType: 'new'`）

#### Scenario: 発行失敗の表示

- **WHEN** 発行要求がエラーになる（例: 設定不足や認可エラー）
- **THEN** 利用者にエラーが表示され、二重送信を促さない
