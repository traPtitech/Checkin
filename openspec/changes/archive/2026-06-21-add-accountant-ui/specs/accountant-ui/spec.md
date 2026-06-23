## ADDED Requirements

### Requirement: 会計のみアクセスとアクセス不可表示

会計（管理）向けページ（`/payments`・`/payouts`）は、`auth.me` の `admin` が真のセッションのみに機能を提供 SHALL。`admin` でないセッション（未ログイン・会員のみ・利用者のみ）では会計機能を描画せず、**アクセス不可（要会計ログイン）**である旨と会計ログイン導線を表示する MUST。会計導線（ヘッダー／トップの会計ページへのリンク）は `admin` のときのみ表示する MUST。サーバ側 `adminProc` が認可の source of truth であり、UI のガードは導線・体験のためであることを前提とする。

#### Scenario: 未ログインで会計ページを開く

- **WHEN** 未ログインで `/payments` または `/payouts` を開く
- **THEN** 会計データは表示されず、要会計ログインの案内と会計ログイン導線が表示される

#### Scenario: 会計でないログインで会計ページを開く

- **WHEN** 会員のみ／利用者のみ（`admin` が偽）のセッションで `/payments` または `/payouts` を開く
- **THEN** 会計データは表示されず、アクセス不可（要会計）である旨が表示される

#### Scenario: 会計導線は会計のみに出す

- **WHEN** `admin` が真でログインしている
- **THEN** ヘッダーまたはトップに `/payments`・`/payouts` への導線が表示される（`admin` でなければ表示されない）

### Requirement: 入出金一覧（`/payments`）

`/payments` は会計のみに対し、design §5.2 の 2 系統を**タブ**で提示 SHALL。請求書由来は `payments.listInvoices`、決済セッション由来は `payments.listCheckoutSessions` を呼び、各行を表（id・金額・通貨・日時・customer・支払い状況・支払い id・商品）で表示する MUST。各行は対応する **Stripe Dashboard リンク**（`dashboardUrl`）を持つ MUST。

#### Scenario: 請求書タブの一覧

- **WHEN** 会計が `/payments` の請求書タブを開く
- **THEN** `payments.listInvoices` が呼ばれ、返った行が表（id・金額・日時・customer・支払い状況・Dashboard リンク等）で表示される

#### Scenario: 決済セッションタブの一覧

- **WHEN** 会計が決済セッションタブに切り替える
- **THEN** `payments.listCheckoutSessions` が呼ばれ、その行が表示される

#### Scenario: Dashboard リンク

- **WHEN** 一覧の行の Dashboard リンクを選ぶ
- **THEN** その行の `dashboardUrl`（test/live を反映）が新しいタブで開く

### Requirement: 一覧のフィルタとカーソルページネーション

`/payments` の各タブは status フィルタとカーソルページネーションを提供 SHALL。請求書は `draft`/`open`/`paid`/`uncollectible`/`void`、決済セッションは `open`/`complete`/`expired` で絞り込める MUST。`hasMore` が真のときのみ次ページ導線を出し、`nextCursor` を `startingAfter` として次ページを取得する MUST。フィルタ変更時はカーソルをリセットする MUST。

#### Scenario: status で絞り込む

- **WHEN** 会計が請求書タブで status を `paid` に変更する
- **THEN** `status: 'paid'` で再取得され、カーソルはリセットされて先頭ページから表示される

#### Scenario: 次ページを読む

- **WHEN** `hasMore` が真の一覧で次ページ導線を選ぶ
- **THEN** `startingAfter: nextCursor` で次ページが取得・表示される

#### Scenario: 末尾で次ページ導線を出さない

- **WHEN** `hasMore` が偽
- **THEN** 次ページ導線は表示されない

### Requirement: 払い戻し管理の一覧と取込（`/payouts`）

`/payouts` は会計のみに対し、払い戻し一覧と Jomon 取込・前進を提供 SHALL。`payouts.list`（status フィルタ: `pending`/`onboarding_waiting`/`processing`/`paid`/`failed`）の各行（jomonRef・userId・金額・通貨・status・transfer id・Jomon 書き戻し済みか）を表示する MUST。Jomon 取込ボタンは `payouts.processApproved` を呼び、返った件数サマリを表示し、一覧を再取得する MUST。

#### Scenario: 払い戻し一覧の表示

- **WHEN** 会計が `/payouts` を開く
- **THEN** `payouts.list` が呼ばれ、各払い戻し行（jomonRef・金額・status 等）が表示される

#### Scenario: status で絞り込む

- **WHEN** 会計が status を `onboarding_waiting` に変更する
- **THEN** `status: 'onboarding_waiting'` で再取得され、その状態の払い戻しのみ表示される

#### Scenario: Jomon 取込・前進

- **WHEN** 会計が Jomon 取込ボタンを押す
- **THEN** `payouts.processApproved` が呼ばれ、件数サマリが表示され、一覧が再取得される

### Requirement: 払い戻しの実行と onboarding 管理

`/payouts` は各行に対し、実行（前進／再試行）と onboarding 操作を提供 SHALL。`paid` でない行には `payouts.execute({ jomonRef })`（前進、`failed` の再試行を含む）を呼ぶ操作を出す MUST。userId が解決済みの行には `payouts.createOnboardingLink({ userId })` で hosted onboarding URL を発行して会計に表示（会計が本人へ転送）し、`payouts.onboardingStatus({ userId })` で onboarding 状態と connected account の有無を確認できる MUST。状態変更操作後は一覧を再取得し、実行中は二重操作を防ぐ MUST。

#### Scenario: 行の実行・再試行

- **WHEN** 会計が `paid` でない行の実行操作を押す
- **THEN** `payouts.execute({ jomonRef })` が呼ばれ、結果（ステップ結果）が反映され一覧が再取得される

#### Scenario: onboarding リンクの発行

- **WHEN** 会計が userId のある行で onboarding リンク発行を押す
- **THEN** `payouts.createOnboardingLink({ userId })` が呼ばれ、返った URL が会計へ表示される（本人へ転送できる）

#### Scenario: onboarding 状態の確認

- **WHEN** 会計が userId のある行で onboarding 状態確認を押す
- **THEN** `payouts.onboardingStatus({ userId })` が呼ばれ、status と connected account の有無が表示される

#### Scenario: 実行中の二重操作防止

- **WHEN** ある行の操作が実行中
- **THEN** 同じ操作は二重に発火せず、完了後に一覧が再取得される
