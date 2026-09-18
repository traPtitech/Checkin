## Why

[[add-payout-execution]] の Jomon アダプタは仮実装（`/transfer-requests`、payee=メール）で、実 `traPtitech/Jomon` API と不一致だった。実 API 調査で確定した形に合わせ、[[add-traq-member-auth]] で用意した `users.traq_id` を使って payee を本人解決できるようにする。

実 Jomon の要点（調査結果）:
- 振込依頼＝`Application`＋`ApplicationTarget`。承認済み取得は **`GET /api/applications`**（v1 `?current_state=accepted` / v2 `?status=approved`）。`/transfer-requests` は存在しない。
- payee 識別子＝**traQ ID**。v1 は `repaid_to_user.trap_id`（文字列）、v2 は `ApplicationTarget.target`（User UUID）→ `GET /api/users` の `User.name` で traQ ユーザー名に解決。
- 通貨なし（JPY 固定）。
- 書き戻し: v1 は `PUT /api/applications/{id}/states/repaid/{trapId}` body `{repaid_at}`。**v2 は per-payee の paid 設定 API が無い**（`paid_at` 読み取り専用）→ Jomon v2 側に追加が必要。
- 認証: v1/v2 とも traQ OAuth/cookie のみで、**Bearer サービストークン受け口は未実装**（要 Jomon 調整）。

## What Changes

- **Jomon アダプタを実 API へ修正**（payout-execution の MODIFIED）:
  - エンドポイントを `/api/applications`（v1 `current_state=accepted` / v2 `status=approved`）に。
  - `JomonTransferRequest` の payee を **`payeeTraqId`**（traQ ID 文字列）に変更（旧 `payeeEmail` を置換）。v1 は `trap_id`、v2 は `target` UUID→`/api/users`→`name`。
  - `jomon_ref`: v2 は `ApplicationTarget.id`、v1 は `applicationId + trap_id` の合成。
  - 通貨は `jpy` 固定（Jomon に通貨なし）。
  - 書き戻し: v1 は `PUT .../states/repaid/{trapId}`。**v2 は未対応として明示エラー＋警告ログ**（Jomon 側追加待ち。payout の `paid` 状態は保持し、`jomon_written_back_at` は未設定のまま再試行余地を残す）。
- **本人特定を traQ ID 経由に**（MODIFIED）: payee の解決を `deriveMailHash(email)` ではなく **`getUserByTraqId(payeeTraqId)`** で行う。未連結（`users.traq_id` 無し）は送金せず要対応。
- **認証の注記**: Checkin→Jomon は Bearer（`JOMON_API_TOKEN`）を送る前提のままだが、**Jomon 側に Bearer 受け口が無い**ため実接続は要 Jomon 調整。default は `stub`。

明確に**スコープ外**: Jomon リポジトリ側の Bearer 受け口・v2 書き戻し API の実装、UI。

## Capabilities

### New Capabilities
<!-- なし。payout-execution の挙動修正（MODIFIED）。 -->

### Modified Capabilities
- `payout-execution`: Jomon アダプタの実 API 化（`/api/applications`、payee=traQ ID、v1/v2 形状、通貨 jpy、v2 書き戻し未対応の明示）、本人特定を `users.traq_id`（`getUserByTraqId`）経由に変更。

## Impact

- **API（`packages/api`）**: `jomon/types.ts`（`JomonTransferRequest.payeeTraqId`）、`jomon/http.ts`（`/api/applications`、v1/v2 のパス・フィールド・厳格バリデーション、v2 の `/api/users` 解決、v1/v2 write-back、v2 未対応エラー）、`jomon/stub.ts`（payeeTraqId）。`payouts/execute.ts` の本人特定を `getUserByTraqId` に。
- **DB**: 変更なし（`users.traq_id` は [[add-traq-member-auth]] で追加済み、`payouts` も既存）。
- **設定**: 変更なし（`JOMON_*` は既存）。`.env.example` の Jomon コメントを実態（Bearer 受け口は Jomon 未実装／v2 書き戻し未対応）に更新。
- **テスト**: payee 解決（traQ ID）・v1/v2 パース（厳格）・v2 書き戻し未対応・stub フローのユニット更新。実接続は Jomon 調整後。
