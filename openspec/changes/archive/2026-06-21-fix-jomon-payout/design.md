## Context

[[add-payout-execution]] の Jomon アダプタは仮実装。実 `traPtitech/Jomon` API 調査の結果に合わせ、[[add-traq-member-auth]] の `users.traq_id`／`getUserByTraqId` を使って payee を解決する。payout-execution の MODIFIED。

## Goals / Non-Goals

**Goals:**
- Jomon アダプタを実 API（`/api/applications`、payee=traQ ID、通貨 jpy、v1/v2 形状）に修正。
- 本人特定を `getUserByTraqId` に変更。
- v2 書き戻し未対応を明示（失敗＋警告、paid 保持、Jomon 追加待ち）。

**Non-Goals:**
- Jomon リポジトリ側の Bearer 受け口・v2 書き戻し API 実装。UI。実接続 E2E（要 Jomon 調整）。

## Decisions

### D1. DTO（`packages/api/src/jomon/types.ts`）

`JomonTransferRequest = { jomonRef: string, payeeTraqId: string, amount: number, currency: string }`（旧 `payeeEmail` を `payeeTraqId` に置換）。`currency` は常に `'jpy'`。

### D2. v1 クライアント（`JomonV1Client`）

- 一覧: `GET /api/applications?current_state=accepted` → `CompactApplication[]`。compact には per-payee 情報が無いため、各 `application_id` について `GET /api/applications/{id}` → `DetailedApplication.repayment_logs[]`（`repaid_to_user.trap_id`, `repaid_at`）を取得。未払い（`repaid_at` 無し）の payee のみ対象。
- 正規化: 各 (application, trap_id) → `{ jomonRef: '${applicationId}:${trapId}', payeeTraqId: trapId, amount, currency: 'jpy' }`。amount は v1 では application 単位（`ApplicationLog.amount`）。複数 payee に分割が要る場合の扱いは TODO（当面は単一 payee 想定でそのまま、複数時は要確認）。
- 書き戻し: `PUT /api/applications/{applicationId}/states/repaid/{trapId}` body `{ repaid_at: 'YYYY-MM-DD' }`。`jomonRef` から `applicationId`/`trapId` を復元。

### D3. v2 クライアント（`JomonV2Client`）

- 一覧: `GET /api/applications?status=approved` → `Application[]` の `targets`（`ApplicationTarget{ id, amount, target(uuid), paid_at }`）。`paid_at` が無い target のみ対象。
- payee 解決: `GET /api/users` を一度取得し `id(uuid)→name` のマップを作り、`target` を traQ ユーザー名に解決。
- 正規化: 各 target → `{ jomonRef: target.id, payeeTraqId: userName, amount: target.amount, currency: 'jpy' }`。
- 書き戻し: **未対応**。`writeBackResult` は明示エラー（`JomonWriteBackUnsupportedError` 等）を投げる。orchestration はこれを捕捉し警告ログ、payout の `paid` は保持、`jomon_written_back_at` は未設定のまま（将来 Jomon が追加したら成功するようになる）。

### D4. 厳格バリデーション（`jomon/http.ts`）

zod スキーマで v1/v2 のレスポンスを検証。payee（trap_id / 解決後 name）非空、jomonRef 非空、amount 正の整数を要求。欠落・不正は throw（既定値で埋めない＝誤送金防止）。実フィールド名には `// TODO: confirm against live Jomon v1/v2` を残す。

### D5. 本人特定（`packages/api/src/payouts/execute.ts`）

`deriveMailHash(payeeEmail)` を廃し、`getUserByTraqId(db, req.payeeTraqId)` で解決。未解決は `payouts.userId=null`・`pending`（要対応）。userId 不変（既存ロジック維持）。

### D6. 認証注記

`JomonHttpClient` は `Authorization: Bearer ${JOMON_API_TOKEN}` を送るが、Jomon に Bearer 受け口が無いため実接続は Jomon 側追加待ち。`.env.example` の Jomon コメントを実態に更新（Bearer 未実装／v2 書き戻し未対応／default stub）。

## Risks / Trade-offs

- **実 Jomon スキーマの細部未確認** → Mitigation: zod 厳格化＋TODO 明示。fail-loud で誤送金回避。stub default。
- **v1 の amount が application 単位**（payee 分割が要る場合）→ Mitigation: 当面単一 payee 前提、複数時は TODO。実接続前に要確認。
- **v2 書き戻し不可** → Mitigation: 明示エラー＋警告、paid 保持、再試行余地。Jomon 追加で自動解消。
- **Bearer 受け口が Jomon 未実装** → Mitigation: 実接続は要調整（design §9 と整合）。stub で機械は完結。

## Migration Plan

1. `jomon/types.ts`（payeeTraqId）→ `jomon/stub.ts` → `jomon/http.ts`（v1/v2 実 API・厳格化・write-back）→ `payouts/execute.ts`（getUserByTraqId）。
2. ユニット更新（payee 解決 traQ ID、v1/v2 パース、v2 write-back 未対応、stub フロー）。
3. `.env.example` コメント更新。
4. 実接続 E2E は Jomon 側（Bearer 受け口・v2 書き戻し）整備後。

## Open Questions

- v1 で 1 application に複数 payee（`repaid_to_id` 複数）の場合の amount 分配（実接続前に Jomon 仕様で確定）。
- v2 の `GET /api/users` は全件取得。規模次第でページング/キャッシュ（当面は都度取得）。
