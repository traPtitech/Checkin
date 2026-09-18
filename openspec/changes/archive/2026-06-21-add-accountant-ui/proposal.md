## Why

[[add-member-ui]] で利用者向け UI は揃ったが、**会計（管理）が触れる画面が無い**。集金の入出金確認も、Jomon 承認済み払い戻しの実行・onboarding 管理も、現状 oRPC を直接叩く以外に手段がない。バックエンド（`payments.*` / `payouts.*`、いずれも `adminProc` で会計セッション必須）は実装済みなので、残るは UI のみ。design.md §8 のうち会計向けページ（`/payments`・払い戻し管理）を対象にする。

## What Changes

- **`/payments`（入出金一覧、会計のみ）**: design §5.2 の 2 系統を**タブ**で出す。
  - 請求書由来（`payments.listInvoices`、status: draft/open/paid/uncollectible/void）と決済セッション由来（`payments.listCheckoutSessions`、status: open/complete/expired）。
  - 各タブに status フィルタ＋**カーソルページネーション**（`nextCursor`/`hasMore`、「次へ」「もっと読む」）。
  - 各行: id・金額・通貨・日時・customer・支払い状況・支払い id・商品、そして **Stripe Dashboard リンク**（`dashboardUrl`、test/live aware）。
- **`/payouts`（払い戻し管理、会計のみ）**: design §5.3 の実行・onboarding を会計が操作できるようにする。
  - **Jomon 取込・前進**: `payouts.processApproved` を呼ぶボタン（承認済み振込依頼を取込み各 1 ステップ前進、件数サマリ表示）。
  - **一覧**: `payouts.list`（status フィルタ: pending/onboarding_waiting/processing/paid/failed）。各行に jomonRef・userId・金額・通貨・status・transfer id・Jomon 書き戻し済みか。
  - **各行の操作**: `payouts.execute`（jomonRef 指定で前進／`failed` 再試行）。userId がある行は `payouts.createOnboardingLink`（hosted onboarding URL を発行し会計へ表示＝本人へ転送）と `payouts.onboardingStatus`（status＋connected account の有無）。
- **共通**: [[add-member-ui]] のレイアウト/ヘッダー・`useAuthMe`・`useCsrf`・`@nuxt/ui` を流用。会計セッション（`auth.me` の `admin`）でなければ**アクセス不可表示**（導線も会計のみ出す）。状態変更系（processApproved/execute/createOnboardingLink）は oRPC クライアントプラグインが付与する `x-csrf-token`（`assertCsrf` 対応）でそのまま動く。

明確に**スコープ外**（後続）: `/admins`（会計は env 許可リスト管理で旧 DB 管理者テーブルは deprecated＝管理 UI 不要）、`issueSpecialInvoice`（特別請求書発行は対象 user 検索 UI が無く別 change）、`/payouts/onboarding/{refresh,return}` の戻り先ページ、決済状況のリアルタイム反映。

## Capabilities

### New Capabilities
- `accountant-ui`: 会計（管理）向け Web UI。`/payments`（請求書/決済セッションのタブ・status フィルタ・カーソルページネーション・Dashboard リンク）と `/payouts`（Jomon 取込実行・status フィルタ一覧・行ごとの execute／onboarding リンク発行・onboarding 状態確認）。サーバ状態は既存 oRPC（`payments.listInvoices`/`listCheckoutSessions`、`payouts.list`/`processApproved`/`execute`/`createOnboardingLink`/`onboardingStatus`、`auth.me`）越しに扱う。会計セッション（`auth.me.admin`）必須。

### Modified Capabilities
<!-- バックエンドの要件変更なし。UI は既存 adminProc API を利用するのみ。 -->

## Impact

- **Web（`apps/web`）**: `app/pages/payments.vue`・`app/pages/payouts.vue` を追加。会計導線を `app/layouts/default.vue` ヘッダーと `app/pages/index.vue` に追加（`admin` のときのみ表示）。必要なら共通フォーマッタ composable（金額・日時）を追加。
- **API/DB**: 変更なし（既存 `adminProc` oRPC を利用）。CSRF は既存 oRPC クライアントプラグインが自動付与。認可はサーバ側 `adminProc` が source of truth（UI のガードは導線・体験のため）。
- **依存**: 追加なし（`@nuxt/ui` は導入済み）。
- **検証**: ページのレンダリング・分岐・タブ/フィルタ/ページネーション・各操作ボタンをローカル起動で確認。実データ（Stripe 一覧・Jomon 取込・transfer）は Stripe test キー／Jomon 接続投入後に E2E（未投入では空一覧／設定エラーを UI で表示）。
