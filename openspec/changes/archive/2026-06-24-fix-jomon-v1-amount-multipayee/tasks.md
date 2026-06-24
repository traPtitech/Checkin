## 1. 型

- [x] 1.1 `packages/api/src/jomon/types.ts`: `JomonTransferRequest` に任意 `multiPayee?: boolean` を追加。`ProcessApprovedSummary` に `multiPayeeRefs: string[]` を追加。

## 2. v1 ドライバ

- [x] 2.1 `packages/api/src/jomon/http.ts`: `v1RepaymentLogSchema` から `amount` を削除。`v1DetailedApplicationSchema` に `current_detail: { amount: positive int }` を追加。
- [x] 2.2 `listApprovedTransferRequests`: 未払い（`repaid_at` 無し）が 0 件→emit しない。**総 payee 数（`repayment_logs.length`）が 2 以上**→`multiPayee:true` のマーカー DTO（`jomonRef=appId`, `payeeTraqId=''`, `amount=current_detail.amount`, `currency=jpy`）を 1 つ（※未払いが 1 件でも、申請額は総額で按分不能のためマーカー＝過払い防止／Codex Q2）。総 payee 数 1（未払い）→通常 DTO（amount=`current_detail.amount`）。

## 3. orchestration

- [x] 3.1 `packages/api/src/payouts/execute.ts`: `processApprovedPayouts` の summary 初期化に `multiPayeeRefs: []` を追加。ループ先頭で `req.multiPayee` を検出したら upsert/送金せず `ingested++`・`needsReview++`・`multiPayeeRefs.push(jomonRef)` して continue。

## 4. UI

- [x] 4.1 `apps/web/app/pages/payouts.vue`: `processApproved` 応答の `multiPayeeRefs` が非空のとき警告 `UAlert`（color=warning）で「複数受取人の申請があります（自動処理されません・手動対応）」＋対象 id を表示。

## 5. テスト・ゲート

- [x] 5.1 v1 ドライバのユニットテスト: 単一受取人→amount=申請額の DTO、複数受取人→`multiPayee` マーカー、全員支払い済み→空、を検証（fetch をモック）。
- [x] 5.2 `pnpm lint` / `typecheck` / `build` / `test` 緑。

## 6. 実 Jomon v1 E2E（ローカル :1323）

- [x] 6.1 単一受取人の accepted 申請で `processApproved` → `ingested:1`（その先の本人解決/onboarding は別途）。
- [x] 6.2 複数受取人の accepted 申請で `processApproved` → `needsReview≥1`＋`multiPayeeRefs` に application id、`/payouts` に警告表示。

## 7. レビュー結果（記録）

- [x] 7.1 Codex money-safety レビューで HIGH（partial-repaid 複数payee の過払い）を検出 → 判定を「未払い数」から「総 payee 数（`logs.length > 1`）」に変更して解消。`executePayout` にも multiPayee ガードを追加。再レビューで RESOLVED・新規問題なしを確認。
- [x] 7.2 実 Jomon v1 で Q2 シナリオ（payees=[devmember,bob]・bob 書き戻し済み・¥8000）を `processApproved` → `multiPayeeRefs` に入り devmember へは未送金。単一は onboarding_waiting。write-back（`PUT states/repaid/{trapId}`）も live で 200。
