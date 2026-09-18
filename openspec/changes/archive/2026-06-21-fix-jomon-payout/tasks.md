## 1. DTO・stub

- [x] 1.1 `jomon/types.ts`: `JomonTransferRequest` の `payeeEmail` を `payeeTraqId` に置換（currency は jpy 前提）
- [x] 1.2 `jomon/stub.ts`: payeeTraqId に追従（dev/テスト用データ）

## 2. v1/v2 実 API（jomon/http.ts、厳格バリデーション）

- [x] 2.1 共通: `GET /api/applications`、`Authorization: Bearer`。zod でレスポンス厳格検証（payee/jomonRef 非空、amount 正整数、不正は throw）。実フィールドに `// TODO: confirm against live Jomon`
- [x] 2.2 v1: 一覧 `?current_state=accepted` → 各 `GET /api/applications/{id}` の `repayment_logs[].repaid_to_user.trap_id`（未払いのみ）→ `{jomonRef:'${appId}:${trapId}', payeeTraqId:trapId, amount, currency:'jpy'}`。write-back `PUT /api/applications/{appId}/states/repaid/{trapId}` `{repaid_at}`
- [x] 2.3 v2: 一覧 `?status=approved` → `targets`（paid_at 無しのみ）、`GET /api/users` で `target`(uuid)→`name` 解決 → `{jomonRef:target.id, payeeTraqId:name, amount:target.amount, currency:'jpy'}`。write-back は未対応エラー（`JomonWriteBackUnsupportedError`）

## 3. 本人特定の変更（payouts/execute.ts）

- [x] 3.1 payee 解決を `deriveMailHash(payeeEmail)` から `getUserByTraqId(payeeTraqId)` に変更。未解決は userId=null・pending（要対応）
- [x] 3.2 v2 write-back 未対応エラーを orchestration で捕捉 → 警告ログ、`paid` 保持、`jomon_written_back_at` 未設定のまま（再試行余地）。per-item 分離は維持

## 4. 設定・検証

- [x] 4.1 `.env.example` の Jomon コメントを実態に更新（Bearer 受け口は Jomon 未実装／v2 書き戻し未対応／default stub）
- [x] 4.2 ユニット: payee 解決（traQ ID 解決/未解決）、v1/v2 厳格パース（正常/不正）、v2 write-back 未対応、StubJomonClient フロー
- [x] 4.3 `pnpm lint` / `pnpm typecheck` / `pnpm build` / `pnpm test` をグリーンに
- [x] 4.5 バッチabort耐性: `processApprovedPayouts` の一覧取得を try/catch で包み失敗時は `listError` 付きサマリを返す（throw しない）。v1 は per-application の詳細取得を try/catch で分離し、失敗アプリは warn ログ＋スキップして残りを処理（テスト追加）
- [ ] 4.4 （Jomon の Bearer 受け口＋v2 書き戻し追加後）実接続 E2E — **BLOCKED**: 実 Jomon に Bearer 受け口が無く、v2 の per-payee 書き戻し API も未実装のため実接続不可。両方が Jomon 側に追加され次第、`JOMON_API_VERSION=v1/v2` で実施する。
