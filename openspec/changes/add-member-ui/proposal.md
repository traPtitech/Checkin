## Why

これまでバックエンド（認証・集金・一覧・払い戻し）を仕様駆動で整備してきたが、利用者が触れる画面が無い。第一弾の価値（部費・入部費の集金）をエンドツーエンドで使えるよう、**利用者向けの UI**（トップ／isct メール確認／部費支払い）を用意する。design.md §8 のうち利用者向けページを対象とし、会計（管理）画面は後続 change とする。

## What Changes

- **UI 基盤の導入**: `@nuxt/ui` を導入し、共通レイアウト（ヘッダー：サービスロゴ／ログイン時はアイコン）と基本コンポーネント（フォーム・ボタン・通知）を使えるようにする。
- **`/`（トップ）**: ログイン状態・権限で出し分け。未ログインは「部費を払う」導線＋「会計の方はこちら（traQ ログイン）」、ログイン中はアクター表示＋ログアウト。`auth.me` を参照。
- **`/verify-email`（isct メール確認）**: isct メールを入力 → `auth.requestEmailVerification` で確認メール送信 → 「確認メールを送信しました」。`redirect` クエリを保持し、確認後に元のページへ戻す。
- **`/membership`（部費支払い）**: §5.1 の振り分けを**確定済み認証方針（§2）に合わせて整理**する。
  - 未ログイン（＝isct 未確認）→ `新規入部 / 再入部 / 現役` を選ぶと `/verify-email?redirect=/membership` へ誘導。
  - ログイン済み（isct 確認済み）→ 請求書フォーム（メール再入力・氏名・区分）→ `membership.issueInvoice` → 発行された支払いページ（`hostedInvoiceUrl`）へ誘導。
  - 区分マッピング: `新規入部`・`再入部` → `feeType: 'new'`（前期/後期で自動価格）、`現役` → `feeType: 'continuation'`（標準）。特別 ¥2,000 は会計のみ（UI 非表示）。
  - **reconcile**: design §5.1 旧フローの「現役 → traQ ログイン」は、確定方針（利用者＝isct マジックリンク／会計＝traQ、§2）と矛盾するため、**支払い者は全員 isct 確認**に統一。traQ ログインは会計導線として別に出す。
- 既存スカフォルドの `index.vue`（health 確認用）を上記トップに置き換える。

明確に**スコープ外**（後続）: `/payments`・`/admins`・払い戻し管理などの会計（管理）UI、ステップバー、入部フォーム機能、決済状況のリアルタイム反映。

## Capabilities

### New Capabilities
- `member-ui`: 利用者向け Web UI。共通レイアウト/ヘッダー（ログイン状態表示）、`/` の状態別出し分け、`/verify-email` の確認メール送信フロー（redirect 保持）、`/membership` の区分振り分けと請求書発行 → 支払いページ誘導。サーバ状態は既存 oRPC（`auth.me` / `auth.requestEmailVerification` / `membership.issueInvoice`）と Nitro ルート（`/verify-email/confirm` / `/login` / `/logout` / `/csrf`）越しに扱う。

### Modified Capabilities
<!-- バックエンドの要件変更なし。UI は既存 API を利用するのみ。 -->

## Impact

- **Web（`apps/web`）**: `@nuxt/ui` 追加（`nuxt.config` modules、Tailwind/CSS、`app.config`）。`app/layouts/default.vue`（ヘッダー）、`app/pages/index.vue`（置換）、`app/pages/verify-email.vue`、`app/pages/membership.vue`。`auth.me` を使う composable（例 `useAuthMe`）。
- **API/DB**: 変更なし（既存 oRPC/Nitro を利用）。CSRF は既存の oRPC クライアントプラグインが自動付与。
- **依存**: `@nuxt/ui`（＋ Tailwind 依存）を追加。
- **検証**: ページのレンダリング・分岐・フォーム送信（verify-email は LogMailer で確認可能）をローカル起動で確認。`membership.issueInvoice` の実発行は Stripe test キー投入後に E2E（キー未投入では送信時エラーになる旨を UI で表示）。
