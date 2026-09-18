## Context

実 Jomon v1（master）に接続したところ、`GET /api/applications?current_state=accepted` と詳細取得は 200 で通る（接続・認証バイパス OK）が、Checkin の `v1RepaymentLogSchema` が各 log に `amount` を要求するため strict 検証で全件 skip → `ingested:0`。実 v1 の repayment_log は `{repaid_to_user.trap_id, repaid_at, ...}` で金額を持たず、金額は `current_detail.amount`（申請単位）にのみ存在することを実機で確認した。運用上は受取人 1 人が前提（ユーザー確定）。

## Goals / Non-Goals

**Goals:**
- v1 で `current_detail.amount` を払い戻し額として使い、単一受取人の申請を取り込めるようにする。
- 複数受取人の申請を自動送金せず、会計 UI に警告として出す（過払い防止）。

**Non-Goals:**
- 複数受取人の自動按分（不採用）。v2 ドライバ。Jomon 側改修。payouts テーブルのスキーマ変更。

## Decisions

### D1: 金額は `current_detail.amount` から取得
`v1RepaymentLogSchema` から `amount` を外し、`v1DetailedApplicationSchema` に `current_detail: { amount: positive int }` を追加。DTO の amount は申請額を使う。
- 理由: 実 v1 に per-payee 金額が無い。単一受取人なら申請額＝その人の払い戻し額で一意。

### D2: 複数受取人はドライバでフラグ化、orchestration で needs-review、UI で警告
- ドライバ: 未払い log を数え、1 件→通常 DTO、2 件以上→`multiPayee:true` のマーカー DTO（`jomonRef=appId`、`payeeTraqId=''`、`amount=current_detail.amount`）を 1 つ emit。0 件→何も emit しない。
- 型: `JomonTransferRequest.multiPayee?`（任意）。マーカーは `payeeTraqId` 空のため `toTransferRequest`（非空必須）を通さず直接構築する。
- orchestration: ループ先頭で `req.multiPayee` を検出したら **upsert/本人特定/送金を一切せず** `needsReview++` と `multiPayeeRefs.push(jomonRef)` のみ。payout 行を作らない（multi-payee には単一 user_id が無いため、テーブル制約とも整合）。
- 集計: `ProcessApprovedSummary.multiPayeeRefs: string[]` を追加。
- UI: `/payouts` は `processApproved` の結果に `multiPayeeRefs` があれば警告 `UAlert` を表示（既存の汎用 summary 表示に加え、明示の警告）。
- 代替案: payouts 行に needs-review 状態で永続化 → user_id 必須・単一 payee 前提のテーブルに複数受取人を収められず不整合。アクション応答ベースの警告で十分（会計が取込時に確認）。

### D3: money-safety 不変条件は不変
冪等（jomon_ref upsert）・本人特定・原子的クレーム・Stripe 冪等キー・書き戻し再試行は単一受取人パスのまま変更しない。multi-payee は送金経路に**入れない**ことで安全側に倒す。

## Risks / Trade-offs

- **警告がアクション応答ベースで非永続**（取込実行直後にのみ表示）→ 会計は取込時に確認する運用。永続表示が要れば別 change（payouts 行 or 専用テーブル）。
- **単一受取人で金額を申請額にする前提**は「1 申請=1 受取人」運用に依存 → 複数時は送金しないので過払いは起きない（安全側）。

## Migration Plan

- 追加・分岐のみ（DB/ env 変更なし）。ロールバックは差分 revert。
- ゲート: lint/typecheck/build/test。実 Jomon v1（ローカル :1323）で単一→`ingested:1`、複数→`needsReview`＋`multiPayeeRefs` を確認。

## Open Questions

- なし（按分は不採用、警告はアクション応答ベースで合意済み）。
