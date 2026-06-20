## 1. @nuxt/ui 導入

- [x] 1.1 `apps/web` に `@nuxt/ui`（Nuxt 4 対応版）を追加（`pnpm install`）
- [x] 1.2 `nuxt.config` の `modules` に `'@nuxt/ui'` を追加。`app/assets/css/main.css`（`@import "tailwindcss"; @import "@nuxt/ui";`）＋ `css` 登録、`app/app.config.ts`（テーマ）
- [x] 1.3 `app/app.vue` を `<UApp>` ＋ `<NuxtLayout><NuxtPage/></NuxtLayout>` に

## 2. 共通基盤（composable・レイアウト）

- [x] 2.1 `useAuthMe()`（`useAsyncData('auth-me', () => $orpc.auth.me())`、`refresh` 公開）
- [x] 2.2 `useCsrf()`（`__Host-checkin_csrf` cookie 読取、無ければ `GET /csrf`）＋ ログアウト処理（`x-csrf-token` 付き `POST /logout` → refresh）
- [x] 2.3 `app/layouts/default.vue`: ヘッダー（ロゴ・ログイン状態・ログアウト/会計ログイン導線）

## 3. ページ

- [x] 3.1 `app/pages/index.vue`（既存 health 版を置換）: 状態別出し分け
- [x] 3.2 `app/pages/verify-email.vue`: メール入力 → `auth.requestEmailVerification`（redirect 保持）→ 成功/失敗表示、送信中 disabled
- [x] 3.3 `app/pages/membership.vue`: 未ログインは 新規/再入部/現役 → `/verify-email?redirect=/membership?type=...`；ログイン済みはフォーム（email/name/区分）→ `membership.issueInvoice` → `hostedInvoiceUrl` 誘導。区分→feeType 変換、エラー/二重送信対策

## 4. 検証

- [x] 4.1 `pnpm lint` / `pnpm typecheck` / `pnpm build` をグリーンにする
- [x] 4.2 ローカル起動で確認: 未ログイン `/membership` の分岐、`/verify-email` 送信（LogMailer のリンク）、確認リンク→ログイン→`/membership` フォーム描画、ヘッダーのログイン状態・ログアウト
- [ ] 4.3 （Stripe test キー投入後）`/membership` フォームから実発行→支払いページの E2E
  - BLOCKED: Stripe test キー未投入のため未実施。鍵なしでは `membership.issueInvoice` が `INTERNAL_SERVER_ERROR` を返すことを確認済みで、UI は汎用エラー（「発行に失敗しました」）を表示する。`NUXT_STRIPE_SECRET_KEY` ＋ 価格 ID 投入後に実発行→`hostedInvoiceUrl` 誘導を確認すること。
