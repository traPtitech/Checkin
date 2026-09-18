## Context

バックエンド（[[add-auth-foundation]] / [[add-membership-collection]]）は揃ったが UI が無い。利用者向けの最小フロー（トップ／isct メール確認／部費支払い）を `@nuxt/ui` で実装し、集金をエンドツーエンドで使えるようにする。会計（管理）UI は後続。

前提（[[add-traq-member-auth]] 反映後）: traQ ログイン＝**会員セッション**、会計は許可リスト・サブセット。`auth.me` は `{ authenticated, member, admin, hasUser, traqId }` を返す。よって design §5.1 の「現役→traQ ログイン」を**そのまま採用**し、未連結会員は isct 確認で連結する。

既存サーバ機能（UI から使う）:
- oRPC: `auth.me`（`{actor:null|'user'|'admin', traqId?}`）、`auth.requestEmailVerification({email, redirect?})`、`membership.issueInvoice({email,name,feeType})`→`{invoiceId, hostedInvoiceUrl}`。
- Nitro（フルページ遷移）: `GET /verify-email/confirm`（メールリンク先）、`GET /login`（traQ）、`POST /logout`、`GET /csrf`。
- CSRF: 既存 oRPC クライアントプラグインが mutation に `x-csrf-token` を自動付与（cookie 由来）。

## Goals / Non-Goals

**Goals:**
- `@nuxt/ui` 導入と共通レイアウト（ヘッダー：ロゴ＋ログイン状態）。
- `/`・`/verify-email`・`/membership` の利用者向けページ。
- `auth.me` による状態別出し分け、verify の redirect 保持、issueInvoice→支払いページ誘導。

**Non-Goals:**
- `/payments`・`/admins`・払い戻し管理（後続）。ステップバー、入部フォーム、決済状況の自動反映。

## Decisions

### D1. @nuxt/ui 導入

- `apps/web` に `@nuxt/ui`（Nuxt 4 対応版）を追加。`nuxt.config` の `modules` に `'@nuxt/ui'` を追加（`@nuxt/eslint` と併用）。
- Tailwind v4（@nuxt/ui 同梱）。`app/assets/css/main.css` に `@import "tailwindcss";` ＋ `@import "@nuxt/ui";`、`nuxt.config` の `css` に登録。`app/app.config.ts` でテーマ（primary 色等）を設定。
- `app/app.vue` を `<UApp>` でラップ（トースト/オーバーレイ提供）し、`<NuxtLayout><NuxtPage/></NuxtLayout>`。

### D2. レイアウト/ヘッダー（`app/layouts/default.vue`）

- ヘッダー: サービスロゴ（`Checkin`）、右側にログイン状態。`auth.me` を共有 composable `useAuthMe()`（`useAsyncData('auth-me', () => $orpc.auth.me())`、`refresh` 公開）で取得。
- 未ログイン: 「部費を払う」(/membership)、「会計の方はこちら」(`<a href="/login?redirect=...">`)。
- ログイン中: アクター表示（user/会計 traqId）＋ログアウトボタン。
- 全ページ `layout: 'default'`。

### D3. ログアウト（CSRF 対応）

- `POST /logout` は CSRF が要る。`useCsrf()` ヘルパ: `__Host-checkin_csrf` cookie を読み、無ければ `GET /csrf` を取得 → `x-csrf-token` 付きで `POST /logout` → 成功後 `useAuthMe().refresh()` ＋ `/` へ。

### D4. `/`（`app/pages/index.vue`、既存 health 版を置換）

- `auth.me` で出し分け。未ログイン: サービス説明＋「部費を払う」＋会計ログイン導線。ログイン中: アクター表示＋主要導線。

### D5. `/verify-email`（`app/pages/verify-email.vue`）

- `UInput`（email）＋`UButton`。送信で `auth.requestEmailVerification({ email, redirect })`（`redirect` は `route.query.redirect` を sanitize して付与）。
- 成功: 「確認メールを送信しました。メール内のリンクから続行してください」をトースト/`UAlert`。失敗（ドメイン外等）はエラー表示。二重送信防止（送信中は disabled）。

### D6. `/membership`（`app/pages/membership.vue`）— §5.1 デュアル振り分け

- `auth.me`（`{ authenticated, member, admin, hasUser, traqId }`）を取得。
- **未ログイン**（`!authenticated`）: `新規入部 / 再入部 / 現役` の選択（`UButton`/カード）。
  - `新規入部`・`再入部` → `navigateTo('/verify-email?redirect=' + encodeURIComponent('/membership?type=' + sel))`。
  - `現役` → `navigateTo('/login?redirect=/membership', { external: true })`（traQ ログイン Nitro ルート）。
- **会員だが未連結**（`member && !hasUser`）: 「isct メール確認で連結してください」案内＋`/verify-email?redirect=/membership` 導線。
- **利用者あり**（`hasUser`）: 請求書フォーム（`email`・`name`・`区分`セレクト。`type` クエリがあれば区分初期選択）。送信で区分→feeType（`新規入部`/`再入部`→`new`、`現役`→`continuation`）に変換し `membership.issueInvoice`。
  - 成功: `hostedInvoiceUrl` への「支払いページへ進む」ボタン（`navigateTo(url, { external: true })`）。
  - 失敗: エラー表示（例: メール不一致＝「確認したメールと一致しません」、その他＝汎用）。送信中 disabled。
- 注: セッションは `mailHash` のみ保持しメール平文は持たないため、フォームでメールを再入力させ、サーバが `mail_hash` 一致を検証する（既存仕様）。`hasUser` の利用者が traQ 会員でもあれば、発行時に traq_id が連結される（[[add-traq-member-auth]]）。

### D7. 型安全な oRPC 呼び出し

- 既存 `$orpc`（`useNuxtApp().$orpc`、型は `AppRouter`）を使用。サーバ実装は import しない（型のみ）。

## Risks / Trade-offs

- **@nuxt/ui / Tailwind v4 と既存 ESLint(stylistic) の相性** → Mitigation: 生成物を lint:fix で整え、必要なら .vue の stylistic 設定を確認。ビルド/型チェックをグリーンに保つ。
- **Stripe キー未投入で issueInvoice が失敗** → Mitigation: UI はエラーを表示。verify-email フロー（LogMailer）と分岐は鍵なしでも確認可能。
- **現役の traQ ログイン導線** → [[add-traq-member-auth]] で traQ ログイン＝会員セッションになったため、design §5.1 の「現役→traQ ログイン」をそのまま採用。会計導線も同じ traQ ログイン（許可リストで isAdmin 判定）。SSR の `auth.me` は cookie 転送済み（既存プラグイン）で機能。

## Migration Plan

1. `@nuxt/ui` 追加・設定（modules/css/app.config/app.vue）。
2. `useAuthMe`/`useCsrf` composable → `layouts/default.vue` → `index.vue` 置換 → `verify-email.vue` → `membership.vue`。
3. `pnpm lint`/`typecheck`/`build` グリーン。ローカル起動で 分岐・verify 送信（LogMailer）・membership フォーム描画を確認。

## Open Questions

- ロゴ画像は当面テキスト（後で差し替え）。
- `membership` の区分 3 種のうち「再入部」を `new` 扱いにする点は要確認（入部費を再度払う想定）。本 change では `new` とする。
- 会計ログイン後に利用者向け請求書を出す導線は出さない（会計セッションは issueInvoice 不可）。会計は管理 UI（後続）へ。
