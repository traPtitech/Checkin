## Context

Checkin は Nuxt 4（`apps/web`、Nitro サーバ内包）＋ oRPC（`packages/api`）＋ Drizzle/MariaDB（`packages/db`）の pnpm モノレポ。現状は health probe と暫定 `users` テーブルのみで、認証・本人識別が存在しない。本 change は後続（集金・入出金一覧・払い戻し）の全機能が依存する土台を作る。

design.md（リポジトリ直下）の決定事項に従う:

- 本人キー = isct メールのハッシュ（サービス内 ID、isct 限定）。集金側・払い戻し側を 1 行に束ねる。メール平文は DB に持たず Stripe 側に保持。
- セッションは httpOnly cookie ＋ double-submit CSRF（`__Host-checkin_csrf`）。JWT クライアント保持は不採用（traP 他サービスとセッション方式で一貫）。
- 会計は traQ OAuth ＋ traQ グループ／環境変数で認可。本 change では env の traQ ID 許可リストを採用。
- 対応表は自前 DB が source of truth。

確定済みの設計選択（ユーザーとの合意）:

- isct ドメイン = `@m.isct.ac.jp` 単一ホワイトリスト（env で変更可）。
- `mail_hash` = HMAC-SHA256(正規化メール, 環境変数の秘密鍵)。
- 会計判定 = env の traQ ID 許可リスト（traQ グループ連携は後続 change）。

## Goals / Non-Goals

**Goals:**
- `mail_hash` を Stripe 非依存に定義し、`users` を対応表の土台として確立する。
- isct メールのマジックリンクで利用者セッションを確立できる。
- traQ OAuth ＋ env 許可リストで会計セッションを確立できる。
- `__Host-` cookie セッション ＋ double-submit CSRF と、`requireUser` / `requireAdmin` 認可ヘルパを oRPC Context に提供する。
- メール送信を `Mailer` アダプタで抽象化し、dev/log と本番実装を差し替え可能にする。

**Non-Goals:**
- Stripe Customer / Invoice / 集金フロー（後続 change）。
- 入出金一覧、Jomon 連携・払い戻し・Connect onboarding（後続 change）。
- traQ グループによる会計判定（env 許可リストで代替、将来拡張）。
- 本名など追加プロフィールの保持（必要になった時点で別途検討）。
- レート制限・監査ログの本格運用（基本的な単回トークン・期限のみ本 change で担保）。

## Decisions

### D1. データモデル（`packages/db/src/schema.ts`）

暫定 `users(id, name, created_at)` を置き換え、3 テーブルを追加する。

- **`users`**: `id`（PK, ULID/UUID 文字列）, `mail_hash`（varchar, **unique**）, `created_at`, `updated_at`。Stripe 系カラム（`stripe_customer_id` 等）は本 change では追加せず、集金/払い戻し change で `ADDED`/`MODIFIED` する。
- **`sessions`**: `id`（不透明トークン由来の値ではなく、cookie に載せる ID は別途ランダム生成。DB には ID のハッシュを保存）, `actor_type`（`user` | `admin`）, `user_id`（FK→users, nullable, user の場合のみ）, `traq_id`（varchar, nullable, admin の場合のみ）, `expires_at`, `created_at`。
- **`email_verifications`**: `id`(PK), `token_hash`（varchar, unique, トークン平文は保存しない）, `mail_hash`, `redirect`（nullable, 同一サイトパス）, `expires_at`, `consumed_at`（nullable）, `created_at`。

cookie/トークンの実値は DB に平文保存せず、SHA-256 等のハッシュで保存・照合する（漏洩時の被害低減）。`pnpm db:generate` でマイグレーションを生成しコミット。

### D2. mail_hash の導出

`normalize(email) = trim → ローカル部・ドメインを lowercase`。`mail_hash = HMAC_SHA256(secret = env.MAIL_HASH_SECRET, message = normalize(email))` を hex で表現。`MAIL_HASH_SECRET` 未設定なら起動時／導出時にエラー（弱い既定値へのフォールバック禁止）。Node 標準 `crypto` を使用、追加依存なし。**注意**: 秘密鍵を後から変えると全 `mail_hash` が変わり対応が壊れるため、鍵はローテーション対象外として運用（design.md の対応表方針と整合）。

### D3. セッションと cookie

- セッション ID はサーバで CSPRNG 生成（高エントロピー）。cookie 名 `__Host-checkin_session`、属性 `HttpOnly; Secure; SameSite=Lax; Path=/`（`Domain` 無し）。
- DB には ID のハッシュを保存し、照合時にハッシュ比較。`expires_at` で失効。ログアウトは行削除（または失効印）。
- `SameSite=Lax` を基本とし、加えて double-submit CSRF を併用（OAuth/外部からの遷移と整合しつつ多層防御）。
- CSRF: `GET /csrf` が `__Host-checkin_csrf`（`Secure; SameSite=Lax; Path=/`、**HttpOnly なし**）を発行しトークン値を返す。状態変更要求はヘッダ `x-csrf-token` を cookie 値と突き合わせる。GET には適用しない。

### D4. Nitro ルート vs oRPC の役割分担

ブラウザ遷移・GET ページ・OAuth コールバックは **Nitro ルート**（`apps/web/server/routes/...`）、データ操作は **oRPC プロシージャ**（`packages/api`）。

- Nitro: `GET /login`（traQ 認可へリダイレクト）, `GET /login/callback`（code 交換・会計判定・セッション確立）, `GET /verify-email/confirm`（トークン消費・セッション確立・redirect）, `GET /csrf`（CSRF cookie 発行）, `POST /logout`（セッション破棄・cookie 削除）。
  - **理由**: cookie の発行・削除は h3 の `event` を要するため、oRPC プロシージャ（Response を返すだけで cookie 操作が難しい）ではなく Nitro ルートに置く。
- oRPC: `auth.requestEmailVerification`（`POST /verify-email`、メール送信のみで cookie 不要）, `auth.me`（現在のアクター取得）。
- セッション復元: Nitro の oRPC マウント箇所（`apps/web/server/routes/rpc/[...].ts`）と各 Nitro ルートで、cookie からセッションを引き、oRPC `Context` に `session`（`{ actor: 'user'|'admin', userId?, traqId? } | null`）と `requireUser()` / `requireAdmin()` を載せる。

### D5. oRPC Context 拡張（`packages/api/src/orpc.ts`）

```
interface Context {
  db: Database
  session: SessionActor | null      // { actor: 'user', userId, mailHash } | { actor: 'admin', traqId }
  requireUser(): UserActor          // session が user でなければ ORPCError(UNAUTHORIZED)
  requireAdmin(): AdminActor        // session が admin でなければ ORPCError(FORBIDDEN/UNAUTHORIZED)
}
```

利用者プロシージャは `requireUser()` の戻り値（`userId`/`mailHash`）で「自分のもの」に限定する。CSRF 検証は Nitro 層（oRPC マウント前）でまとめて行う。

### D6. traQ OAuth

traP の traQ OAuth2（authorization code ＋ PKCE）。`GET /login` で `state`＋`code_verifier` を生成し、短命の署名付き cookie かサーバ側に保存 → traQ authorize へリダイレクト。`GET /login/callback` で `state` 検証 → token 交換 → traQ の自分情報取得（traq_id/name）→ `CHECKIN_ACCOUNTANT_TRAQ_IDS` 許可リスト照合 → 会計セッション確立 → `redirect`（同一サイトのみ）へ。エンドポイント URL／client_id／secret／scope は env。HTTP 呼び出しは Nitro の `$fetch`/`ofetch` を使い追加依存を最小化。

### D7. Mailer アダプタ

`interface Mailer { send(params): Promise<void> }`。`LogMailer`（dev、内容をログ）と本番実装（SendGrid 等）を env（例 `MAILER_DRIVER`）で選択。ドメインロジックは `Mailer` のみに依存。SendGrid SDK 採用可否は実装時に確定（HTTP API 直叩きでも可）。

### D8. 環境変数（`.env.example` 追記）

`MAIL_HASH_SECRET`, `ISCT_ALLOWED_EMAIL_DOMAINS`(既定 `m.isct.ac.jp`), `SESSION_*`(任意), `CHECKIN_ACCOUNTANT_TRAQ_IDS`(カンマ区切り), `TRAQ_OAUTH_CLIENT_ID`/`_SECRET`/`_AUTHORIZE_URL`/`_TOKEN_URL`/`_USERINFO_URL`/`_SCOPE`, `APP_ORIGIN`(redirect 検証・絶対 URL 生成), `MAILER_DRIVER`＋送信元アドレス＋(本番)API キー, `EMAIL_VERIFICATION_TTL`/`SESSION_TTL`。

## Risks / Trade-offs

- **`__Host-` cookie は HTTPS 必須** → ローカル開発で Secure cookie が機能しない懸念。Mitigation: 開発時は `localhost` の Secure cookie 許容（主要ブラウザは localhost を安全とみなす）／必要なら dev 限定で cookie 名・属性を緩める切替を用意。
- **MAIL_HASH_SECRET の紛失・変更で対応表が壊れる** → Mitigation: 鍵を不変運用とし、シークレット管理（漏洩時は移行手順が別途必要）を明文化。
- **オープンリダイレクト**（`redirect` 悪用）→ Mitigation: `redirect` は同一サイトの相対パスのみ許可、それ以外は既定先へ。
- **マジックリンクの不正利用**（リンク漏洩・列挙）→ Mitigation: 単回・短命・高エントロピートークン、トークンはハッシュ保存。将来レート制限を追加（本 change 範囲外）。
- **CSRF と SameSite の二重実装の手間** → Mitigation: 多層防御として割り切る（traP 他サービスと整合）。
- **traQ OAuth エンドポイント／scope の差異** → Open Question で確定。

## Migration Plan

1. `packages/db` のスキーマ置換（暫定 `users` → 認証用 `users`＋`sessions`＋`email_verifications`）、`pnpm db:generate` でマイグレーション生成・コミット。
2. まだ実データが無い前提（スキャフォルド）なので破壊的置換で可。既存環境がある場合は暫定 `users` を drop。
3. oRPC Context 拡張 → Nitro でのセッション復元・CSRF 配線 → 認証フロー（email-verification / traQ OAuth）→ `.env.example` 更新の順で実装。
4. ロールバック: 本 change のマイグレーションを revert し、Context 拡張前の状態へ戻す（後続 change 未着手のうちは影響局所）。

## Resolved (ユーザー確定)

- **traQ OAuth**: クライアントは登録済み。接続情報（client_id/secret・authorize/token/userinfo URL・scope）は **env から読み込む**。コードに URL をハードコードしない。
- **セッション保存先**: **MariaDB テーブル**で確定（将来トラフィック増時に KV/Redis を別途検討）。
- **本番 Mailer**: **SendGrid** で確定。実装は dev の `LogMailer` から始め、本番ドライバとして SendGrid 実装を用意。

## Open Questions

- traQ の userinfo レスポンスで traq_id を表すフィールド名（実装時に traP の traQ OAuth レスポンスで確定。env 化はしない）。
- 利用者にもログアウト UI を出すか（API は用意。UI は後続の `/` ページ change で）。
