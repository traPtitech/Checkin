## 1. データモデル（packages/db）

- [x] 1.1 暫定 `users(id, name, created_at)` を認証用 `users(id, mail_hash unique, created_at, updated_at)` に置き換える（Stripe 系カラムは追加しない）
- [x] 1.2 `sessions` テーブルを追加（`id`, `id_hash` unique, `actor_type`(user|admin), `user_id` FK nullable, `traq_id` nullable, `expires_at`, `created_at`）
- [x] 1.3 `email_verifications` テーブルを追加（`id`, `token_hash` unique, `mail_hash`, `redirect` nullable, `expires_at`, `consumed_at` nullable, `created_at`）
- [x] 1.4 `pnpm db:generate` でマイグレーションを生成し、`packages/db/drizzle/` をコミット（生成 SQL は手編集しない）

## 2. 本人識別（identity）

- [x] 2.1 メール正規化関数（trim ＋ ローカル部・ドメイン lowercase）を実装
- [x] 2.2 `mail_hash = HMAC-SHA256(MAIL_HASH_SECRET, 正規化メール)` を Node `crypto` で実装。`MAIL_HASH_SECRET` 未設定はエラー（弱い既定値へフォールバックしない）
- [x] 2.3 `mail_hash` での本人行 get-or-create（冪等、unique 制約で重複回避）を実装
- [x] 2.4 identity 単体テスト（同一メール→同一 hash、空白/大小無視、秘密鍵未設定エラー、get-or-create 冪等）

## 3. セッション基盤（session）

- [x] 3.1 セッション ID の CSPRNG 生成と DB へのハッシュ保存・照合を実装
- [x] 3.2 セッション確立／復元／破棄（ログアウト）と有効期限失効を実装
- [x] 3.3 `__Host-checkin_session` cookie の発行・読取（HttpOnly/Secure/SameSite=Lax/Path=/、Domain なし）を実装。localhost 開発時の Secure cookie 方針を反映
- [x] 3.4 Nitro `GET /csrf`（cookie 発行のため oRPC ではなく Nitro ルート）で `__Host-checkin_csrf`（HttpOnly なし、Secure/SameSite/Path=/）発行＋トークン返却
- [x] 3.5 状態変更要求の double-submit CSRF 検証（ヘッダ `x-csrf-token` と cookie 一致、GET は除外）を Nitro 層で実装

## 4. oRPC Context と認可ヘルパ

- [x] 4.1 `packages/api/src/orpc.ts` の `Context` に `session` / `requireUser()` / `requireAdmin()` を追加
- [x] 4.2 Nitro 側（`apps/web/server/...`）で cookie からセッションを復元し `Context` を構築するユーティリティを実装
- [x] 4.3 `apps/web/server/routes/rpc/[...].ts` のマウントで CSRF 検証＋セッション復元を配線
- [x] 4.4 `requireUser` / `requireAdmin` の挙動テスト（未ログイン拒否、利用者→requireAdmin 拒否、会計→許可）

## 5. isct メール確認（email-verification）

- [x] 5.1 `Mailer` アダプタ抽象＋`LogMailer`（dev）を実装し、env `MAILER_DRIVER` で選択
- [x] 5.2 oRPC `auth.requestEmailVerification`（`POST /verify-email`）: ドメインホワイトリスト検証 → 単回・期限付きトークン発行（ハッシュ保存）→ 確認リンクをメール送信。`redirect` を保持
- [x] 5.3 Nitro `GET /verify-email/confirm`: トークン消費（単回・期限・再利用拒否）→ 本人行 get-or-create → 利用者セッション確立 → 同一サイトの `redirect` へ遷移
- [x] 5.4 email-verification テスト（ドメイン外拒否、期限切れ拒否、再利用拒否、正常確認でセッション確立）

## 6. 会計 traQ OAuth（admin-authorization）

- [x] 6.1 Nitro `GET /login`: `state`＋PKCE `code_verifier` 生成・保存、`redirect`（同一サイト）保持、traQ authorize へリダイレクト
- [x] 6.2 Nitro `GET /login/callback`: `state` 検証 → code→token 交換 → traq_id 取得 → `CHECKIN_ACCOUNTANT_TRAQ_IDS` 許可リスト照合 → 会計セッション確立 → `redirect` へ
- [x] 6.3 オープンリダイレクト対策（外部 URL の `redirect` は既定先へ）を `/login` と `/verify-email/confirm` 双方に適用
- [x] 6.4 admin-authorization テスト（state 不一致拒否、許可リスト内→会計、許可リスト外→会計にならない、redirect 保持）

## 7. 設定・配線・検証

- [x] 7.1 `.env.example` に新規 env（MAIL_HASH_SECRET, ISCT_ALLOWED_EMAIL_DOMAINS, CHECKIN_ACCOUNTANT_TRAQ_IDS, TRAQ_OAUTH_*, APP_ORIGIN, MAILER_*, TTL 各種）を追記
- [x] 7.2 `auth.me`（現在のアクター取得）を oRPC に追加。ログアウトは cookie 削除のため Nitro `POST /logout`（CSRF 検証付き）として実装
- [x] 7.5 クライアント oRPC プラグインに double-submit CSRF を統合（cookie を `x-csrf-token` で送信、無ければ `GET /csrf` を取得）— Codex レビュー指摘対応
- [x] 7.3 `pnpm lint` / `pnpm typecheck` / `pnpm build` をグリーンにする
- [x] 7.4 ローカルで E2E 動作確認（メール確認でログイン→ requireUser 通過、traQ ログイン→ requireAdmin 通過、CSRF 欠落で拒否）
