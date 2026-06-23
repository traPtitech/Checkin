## Context

バックエンドの会計向け機能（[[add-payment-listing]] / [[add-connect-onboarding]] / [[add-payout-execution]]）は揃ったが、会計が触れる UI が無い。[[add-member-ui]] の基盤（`@nuxt/ui`・`useAuthMe`・`useCsrf`・共通レイアウト）を流用し、design.md §8 の会計向けページ（`/payments`・払い戻し管理）を実装する。

前提（[[add-traq-member-auth]] 反映後）: traQ ログイン＝会員セッション、会計は許可リストのサブセット（`auth.me.admin`）。`auth.me` は `{ authenticated, member, admin, hasUser, traqId }`。認可の source of truth はサーバ側 `adminProc`（oRPC middleware が入力検証より前に認可）であり、UI のガードは導線・体験のため。

既存サーバ機能（UI から型安全に使う、すべて `adminProc`）:
- `payments.listInvoices({ status?, limit?, startingAfter? })` → `{ items: PaymentRow[], hasMore, nextCursor }`。status: `draft`/`open`/`paid`/`uncollectible`/`void`。
- `payments.listCheckoutSessions({ status?, limit?, startingAfter? })` → 同上。status: `open`/`complete`/`expired`。
- `PaymentRow`: `{ id, amount, currency, createdAt(ISO), customer{id,name?}, paymentStatus, paymentId, product{priceId?,description?}, dashboardUrl }`。
- `payouts.list({ status? })` → `{ items: PayoutRow[] }`。`PayoutRow`: `{ id, jomonRef, userId, amount, currency, status, stripeTransferId, jomonWrittenBackAt }`。status: `pending`/`onboarding_waiting`/`processing`/`paid`/`failed`。
- `payouts.processApproved()` → 件数サマリ（取込・前進の結果）。`assertCsrf`。
- `payouts.execute({ jomonRef })` → ステップ結果。`assertCsrf`。
- `payouts.createOnboardingLink({ userId })` → `{ url }`。`assertCsrf`。
- `payouts.onboardingStatus({ userId })` → `{ status, hasConnectedAccount }`。読み取り（CSRF 不要）。
- CSRF: 既存 oRPC クライアントプラグインが mutation に `x-csrf-token` を自動付与（cookie 由来、未取得なら `GET /csrf`）。

## Goals / Non-Goals

**Goals:**
- `/payments`（請求書/決済セッションのタブ・status フィルタ・カーソルページネーション・Dashboard リンク）。
- `/payouts`（払い戻し一覧・status フィルタ・Jomon 取込・行ごとの execute／onboarding リンク発行／onboarding 状態確認）。
- 会計のみアクセス（非会計はアクセス不可表示）、会計導線はヘッダー/トップに `admin` のときだけ。

**Non-Goals:**
- `/admins`（会計は env 許可リスト管理＝旧 DB 管理者テーブル deprecated、管理 UI 不要）。
- 特別請求書発行（`issueSpecialInvoice`、対象 user 検索 UI が無く別 change）。
- `/payouts/onboarding/{refresh,return}` の戻り先ページ。決済状況のリアルタイム反映。

## Decisions

### D1. 会計ガードと導線（`admin` 判定）

- 共通: `useAuthMe()` で `admin = me.admin`。`/payments`・`/payouts` は `admin` が偽なら本体を描画せず、`UAlert`（要会計ログイン）＋会計ログイン導線（`<a href="/login?redirect=...">`、フルページ Nitro ルート）を出す。
- ヘッダー（`layouts/default.vue`）とトップ（`index.vue`）に、`admin` のときだけ `/payments`・`/payouts` への `UButton`/`NuxtLink` を追加。
- サーバが真の認可（`adminProc`）。UI ガードはあくまで体験用で、非会計が直接叩いても `adminProc` が拒否する。

### D2. データ取得（`useAsyncData` + 明示再取得）

- `/payments`: タブ（`invoices`/`checkout-sessions`）と status をローカル `ref`。`useAsyncData` のキーは固定（例 `payments-invoices`）にし、フィルタ/ページ変更時は引数を ref から読んで `refresh()` で再取得。あるいは関数で都度 `$orpc...` を呼んで `items`/`hasMore`/`nextCursor` を `ref` に格納する素朴な実装でもよい（型は `AppRouter` 由来）。
- カーソルページネーション: `startingAfter` を `ref<string|undefined>`。フィルタ変更で `undefined` にリセット。「次へ」で `nextCursor` をセットして再取得。簡潔さ優先で「ページ送り（前のページに戻らない）」または「もっと読む（追記）」のどちらかにする。実装は **「次へ／前へ」のスタックなしの単純送り**でなく、**append 型「もっと読む」**を採用（戻る操作不要、実装単純）。先頭に戻るにはフィルタ再適用。
- `/payouts`: status を `ref`、`payouts.list` を呼んで `items` を `ref`。操作後は `list` を再取得。

### D3. 表示整形

- 金額: `PaymentRow.amount`/`PayoutRow.amount` は最小単位（JPY は円そのもの）。`currency` 付きで `Intl.NumberFormat('ja-JP', { style:'currency', currency })` で整形（JPY は小数なし）。共通 util（`app/utils` か composable）に切り出してもよい。
- 日時: `createdAt`（ISO）を `Intl.DateTimeFormat('ja-JP')` で整形。
- 表は `UTable`（@nuxt/ui）または素の `<table>`＋Tailwind。`UTable` の `columns` を型に合わせて定義。
- Dashboard リンク: `dashboardUrl` を `target="_blank"` の `UButton`/`a`。

### D4. 払い戻し操作（CSRF mutation）

- Jomon 取込: `UButton` → `processApproved()` → 返ったサマリを `UAlert`/トーストで表示 → `list` 再取得。実行中 disabled。
- 行 execute: `paid` 以外の行に `UButton` → `execute({ jomonRef })` → 結果表示 → `list` 再取得。行ごとに pending 状態を持ち二重操作防止。
- onboarding リンク: userId のある行に `UButton` → `createOnboardingLink({ userId })` → 返った `url` を表示（コピーできるよう `UInput` readonly か `UAlert` 内にリンク）。会計が本人へ転送する想定（メール平文を持たないため自動送信はしない）。
- onboarding 状態: userId のある行に `UButton` → `onboardingStatus({ userId })` → `status`＋`hasConnectedAccount` を行内/モーダルに表示。
- 失敗時はエラー表示（`ORPCError` の code を見て会計向けに簡潔に）。

### D5. 型安全な oRPC 呼び出し

- 既存 `$orpc`（`useNuxtApp().$orpc`、型 `AppRouter`）を使用。サーバ実装は import しない（型のみ）。status の enum 値は文字列リテラルで持ち、`USelect` の選択肢にする。

## Risks / Trade-offs

- **実データ未投入（Stripe キー／Jomon 接続なし）** → `listInvoices` 等は空 or エラー。UI は空一覧表示と、操作失敗時の汎用エラーを出す。分岐・タブ・フィルタ・ガードは鍵なしでも確認可能（一覧は空、`payouts.list` は DB 由来なので取込前は空）。
- **onboarding URL の取り扱い** → メール平文を持たない方針上、自動送信せず会計に URL を提示して手動転送。design §5.3 と整合（会計が転送）。URL は機微なので画面表示のみ（ログに出さない）。
- **append 型ページネーションでフィルタ状態と取得済みリストの整合** → フィルタ変更時に必ずリストとカーソルをリセット。
- **@nuxt/ui の `UTable` API** → 導入済みだが列定義の形を確認。複雑なら素の table にフォールバック（lint/typecheck/build をグリーンに保つ）。

## Migration Plan

1. （任意）整形 util（金額・日時）を追加。
2. `layouts/default.vue`・`index.vue` に会計導線（`admin` のみ）を追加。
3. `app/pages/payments.vue`: タブ＋status フィルタ＋append ページネーション＋Dashboard リンク、会計ガード。
4. `app/pages/payouts.vue`: 一覧＋status フィルタ＋取込／execute／onboarding 操作、会計ガード。
5. `pnpm lint`/`typecheck`/`build` グリーン。ローカル起動で会計ログイン→各ページの描画・タブ/フィルタ・操作ボタン（実データは空でも導線確認）を確認。

## Open Questions

- ページネーションは append 型「もっと読む」を採用（前ページへ戻る要件は無い）。必要になれば後続でページ送りに拡張。
- onboarding URL のコピー UI は readonly `UInput`＋コピーボタン想定（@nuxt/ui の利用可能コンポーネントに合わせる）。
- `/payments` の customer 名・商品説明は Stripe 由来で空のことがある（その場合は id/プレースホルダ表示）。
