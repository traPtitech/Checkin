## 1. データモデル

- [x] 1.1 `payouts` テーブル追加（`id` PK, `jomon_ref` unique, `user_id` FK nullable, `amount` int, `currency`, `status` enum(pending/onboarding_waiting/paid/failed) default pending, `stripe_transfer_id` nullable, timestamps）
- [x] 1.2 `pnpm db:generate`（`0004_*`、baseline 0000–0003 保持）→ `pnpm db:migrate`

## 2. Jomon アダプタ（packages/api/src/jomon、v1/v2＋stub）

- [x] 2.1 `JomonClient` インターフェース（`listApprovedTransferRequests` / `writeBackResult`）＋ `JomonTransferRequest` DTO（Jomon 型非依存、`payeeEmail` を本人キーに）
- [x] 2.2 `StubJomonClient`（メモリ/固定データ、機能完結、dev・テスト用）
- [x] 2.3 `JomonV1Client` / `JomonV2Client`（`JOMON_API_BASE_URL`＋`Authorization: Bearer`、フィールドマッピングは TODO 明示）
- [x] 2.4 `JomonConfig` ＋ `createJomonClient(config)`（`JOMON_API_VERSION` stub/v1/v2）。Context に `jomon` を遅延生成で追加

## 3. Stripe 送金アダプタ

- [x] 3.1 `createTransfer(client, {destinationAccountId, amount, currency, idempotencyKey, metadata})`（`transfers.create` ＋ 冪等キー `payout:${jomonRef}`、Stripe 型はアダプタ内）

## 4. 実行ドメイン（packages/api/src/payouts）

- [x] 4.1 `payouts` の冪等 upsert（`jomon_ref`）と読み取り/更新ヘルパ
- [x] 4.2 純粋ロジック: `nextPayoutStatus`（onboarding未完→onboarding_waiting、done→送金結果で paid/failed、paid 終端）
- [x] 4.3 オーケストレーション: 取込→本人特定(mail_hash)→onboarding 判定（未完は get-or-create＋リンク＋waiting）→done は transfer→ 結果で paid/failed → Jomon 書き戻し。`paid` は早期 return（再送金しない）。特定不可は送金せず要対応

## 5. oRPC（会計のみ）

- [x] 5.1 `payouts.processApproved`（`adminProc`＋`assertCsrf`）: 取込→各依頼を1ステップ進める→サマリ返却
- [x] 5.2 `payouts.list`（`adminProc`、status フィルタ）
- [x] 5.3 `payouts.execute`（`adminProc`＋`assertCsrf`、`{jomonRef}`）: 単一 payout の再開/再試行

## 6. 設定・検証

- [x] 6.1 `.env.example` に `JOMON_API_BASE_URL`/`JOMON_API_TOKEN`/`JOMON_API_VERSION`/`PAYOUT_CURRENCY` 追記、`nuxt.config` runtimeConfig に対応キー追加
- [x] 6.2 ユニットテスト: 本人特定（解決/不可）、`nextPayoutStatus`（各遷移・冪等）、`jomon_ref` 冪等 upsert、`StubJomonClient` でのフロー（取込→waiting／done→paid→書き戻し）
- [x] 6.3 `pnpm lint` / `pnpm typecheck` / `pnpm build` / `pnpm test` をグリーンにする
- [x] 6.5 Codex ハードニング修正: 送金前の原子的 execution claim（`processing`）、Jomon 書き戻しの再試行可能化（`jomon_written_back_at`、再送金なし）、Jomon レスポンスの厳格 zod 検証（フェイルセーフ）、`processApproved` のアイテム単位エラー分離、`userId` の不変性、`failed` の明示的リトライ方針（`execute` のみ再試行）。マイグレーション `0005_blushing_blindfold`（enum 値追加＋列追加、baseline 0000–0004 保持）
- [ ] 6.4 （Jomon トークン受け口＋Connect 有効キー後）sandbox で 取込→onboarding→送金→書き戻し の E2E
      <!-- BLOCKED: 実 Jomon のトークン受け口（Bearer サービストークン）も Stripe Connect の有効テストキーも未入手のため実 E2E 不可。
           Checkin 側の機械は stub で完結し、DB 冪等・状態遷移・フローはユニット/DB バックドテストで検証済み。
           入手後に JOMON_API_VERSION=v1|v2 へ切替＋ design §9 の Jomon フィールドマッピング TODO を確定して実施する。 -->
