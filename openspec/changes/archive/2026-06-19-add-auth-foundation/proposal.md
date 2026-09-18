## Why

Checkin の集金・入出金一覧・払い戻しは、いずれも「誰が操作しているか」と「その人が誰か（対応表の本人キー）」を前提にする。
現状はこの土台が無く、本人識別はスプレッドシートの手作業に依存している。最初の change として、後続の全機能が乗る
**認証・本人識別の基盤**を用意する。design.md の原則「人 ↔ Stripe オブジェクトの対応表は自前 DB を source of truth」に従い、
本人キー（`mail_hash`）を Stripe 非依存に定義する。

## What Changes

- **本人識別モデルの導入**: `users` テーブルを `mail_hash`（= HMAC-SHA256(正規化した isct メール, 秘密鍵)）を unique キーとして定義する。メール平文は DB に保持しない。
  - **BREAKING**: スキャフォルドの暫定 `users(id, name, created_at)` を、この本人識別用スキーマに置き換える。
- **isct メール確認（マジックリンク）**: `@m.isct.ac.jp` のみ許可するホワイトリスト検証 → 確認メール送信 → メール内リンクで確認 → 利用者（isct 本人）セッションを確立し、`users` 行が無ければ作成する。メール送信は `Mailer` アダプタ抽象（dev/log 実装 ＋ SendGrid 実装、env で切替）越しに行う。
- **セッション**: サーバ側セッション保存 ＋ httpOnly / Secure / SameSite の `__Host-` cookie。`__Host-checkin_csrf` を使った double-submit CSRF。セッションは「利用者（mail_hash）」と「会計（traQ）」の両アクターを表現できる。
- **会計（管理者）認可**: `GET /login` で traQ OAuth（authorization code ＋ PKCE）→ コールバックで traq_id を取得 → 環境変数の traQ ID 許可リストで会計判定 → 管理者セッションを確立する。`redirect` クエリを保持する。**旧 DB 管理者テーブルは作らない**（deprecated）。
- **認可ヘルパ**: oRPC の `Context` に `requireUser` / `requireAdmin` を用意し、利用者操作は常に「自分のもの」に限定できるようにする。

明確に**スコープ外**（後続 change）: Stripe Customer / Invoice / 集金フロー、入出金一覧、Jomon 連携・払い戻し・Connect onboarding。

## Capabilities

### New Capabilities
- `identity`: サービス内の本人表現。`users` テーブル、`mail_hash` の正規化・導出規則（HMAC-SHA256 ＋ 秘密鍵）、メール平文を保存しない方針、本人行の取得・作成（get-or-create）。
- `email-verification`: isct メールのマジックリンク確認。ドメインホワイトリスト検証、単回・期限付きトークンの発行と消費、`Mailer` アダプタ抽象、確認成功時の利用者セッション確立。
- `admin-authorization`: 会計の認証・認可。traQ OAuth（authorization code ＋ PKCE）、`redirect` 保持、env の traQ ID 許可リストによる会計判定、管理者セッション確立。
- `session`: セッションとアクセス制御の基盤。サーバ側セッション保存、`__Host-` cookie（httpOnly/Secure/SameSite）、`__Host-checkin_csrf` の double-submit CSRF、セッション確立・破棄、`requireUser` / `requireAdmin` 認可ヘルパ。

### Modified Capabilities
<!-- 既存 spec なし（openspec/specs/ は空）。requirement 変更なし。 -->

## Impact

- **DB（`packages/db`）**: 暫定 `users` を置き換え、`sessions`・`email_verifications` テーブルを追加。Drizzle マイグレーションを生成・コミット。
- **API（`packages/api`）**: oRPC `Context` を拡張（`session` / `requireUser` / `requireAdmin`）。`csrf`・`verify-email` 系の oRPC プロシージャを追加。
- **Web/Nitro（`apps/web`）**: ブラウザ遷移・GET ページ・OAuth コールバックは Nitro ルート（`GET /login`, OAuth callback, `GET /verify-email/confirm`）。Nitro ハンドラで cookie からセッションを復元して `Context` を構築。
- **依存・設定**: traQ OAuth クライアント情報、`Mailer`（SendGrid）API キー、`mail_hash` 秘密鍵、許可ドメイン、会計 traQ ID 許可リストを env に追加（`.env.example` 更新）。新規依存の候補: traQ OAuth/HTTP クライアント、メール送信 SDK。
- **横断方針**: 以降の全 capability がこの認証・本人識別を前提にする（集金・一覧・払い戻し）。
