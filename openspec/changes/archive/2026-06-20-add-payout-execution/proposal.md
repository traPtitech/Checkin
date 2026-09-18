## Why

第一弾スコープ③「払い戻し」の後半。Jomon で**承認済み**の振込依頼を取り込み、[[add-connect-onboarding]] で整えた connected account を使って Stripe で送金（transfer/payout）し、結果を Jomon に書き戻す。責任分界は確定（design.md §5.3）: **承認・申請は Jomon、Checkin は実行のみ**。即時性は不要なので pull 方式。

Jomon の現行 API バージョンが未確定（v1 の可能性）なため、**v1/v2 両対応**の `JomonClient` アダプタを定義し、まず**スタブ実装**で Checkin 側の機械を完成させ、実接続は Jomon 側の Bearer トークン受け口が整ってから差し替える（[[jomon-integration]]）。

## What Changes

- **Jomon アダプタ（pull, v1/v2 両対応＋stub）**: `JomonClient` インターフェース（承認済み振込依頼の取得・結果の書き戻し）。実装は `stub`（dev/テスト）・`v1`・`v2` を env で選択。Checkin→Jomon は **Bearer サービストークン**（env、片方向）。
- **Payouts テーブル（新規）**: `jomon_ref`（unique）/ `user_id` / `amount` / `currency` / `status`（`pending`/`onboarding_waiting`/`paid`/`failed`）/ `stripe_transfer_id` / timestamps。取込は `jomon_ref` で冪等。
- **払い戻しの実行フロー（会計トリガ）**:
  1. 承認済み依頼を取込 → 本人特定（対応表＝`mail_hash`）→ Payouts を upsert（`jomon_ref` 冪等）。
  2. 受取人の `payout_onboarding_status` が `done` でなければ connected account を get-or-create ＋ onboarding リンクを発行し、Payouts を `onboarding_waiting` に。
  3. `done` なら Stripe で transfer 実行（`jomon_ref` を冪等キー）→ 成功で `paid`＋`stripe_transfer_id`、失敗で `failed`。
  4. 結果（送金済み/失敗）を Jomon に書き戻し。
- **待機分の再開**: onboarding 完了後に `onboarding_waiting` を実行へ進める（会計の再実行で拾う。account.updated からの自動再開は将来拡張）。
- **認可**: 取込・実行・状態確認は会計（管理者）のみ（`adminProc`）。

明確に**スコープ外**: Jomon 側のトークン受け口実装（Jomon リポジトリ側）、資金繰り（残高補填）、`/payouts` UI、catch-all の汎用 transfers 一覧、account.updated からの自動再開（将来）。

## Capabilities

### New Capabilities
- `payout-execution`: 承認済み振込依頼の取込（Jomon pull, v1/v2＋stub）、本人特定、Payouts の冪等管理と状態機械（pending/onboarding_waiting/paid/failed）、onboarding 未完なら onboarding へ誘導、Stripe transfer 実行（冪等）、Jomon への結果書き戻し、会計のみの操作。

### Modified Capabilities
<!-- なし（connect-onboarding はアダプタを再利用するのみ。新規 Payouts テーブル＋新 capability） -->

## Impact

- **DB（`packages/db`）**: `payouts` テーブル追加。マイグレーション生成・コミット。
- **API（`packages/api`）**: `jomon/`（`JomonClient` インターフェース＋`stub`/`v1`/`v2` 実装、`JomonConfig`）、`payouts/` 実行ドメイン（本人特定・状態遷移・実行オーケストレーション）、Stripe アダプタに `createTransfer`（connected account への送金、冪等キー）。oRPC `payouts.processApproved` / `payouts.list` / `payouts.execute`（会計のみ）。Context に `jomon` クライアントを追加。
- **設定**: `JOMON_API_BASE_URL` / `JOMON_API_TOKEN` / `JOMON_API_VERSION`(`stub`|`v1`|`v2`) を env / runtimeConfig に追加。
- **テスト/検証**: 本人特定・状態遷移・冪等・stub クライアントはユニットテスト。実 Jomon 接続と実 transfer は、トークン受け口・Connect 有効キー入手後に E2E。
- **未確定（要 Jomon 調整）**: Jomon の振込依頼が返す**受取人識別子 → `mail_hash` の対応**（isct メール等）。本 change ではアダプタ契約として定義し、実フィールドは実接続時に確定（design.md §9）。
