## Why

実 Jomon v1（master/ローカル）に対して `processApproved` を叩いたところ、**全申請が skip され `ingested:0`** になった。原因は Checkin の v1 ドライバが各 `repayment_logs[]` に `amount` を要求しているが、**実 v1 の repayment_log は金額を持たず**、金額は申請単位（`current_detail.amount`）にしかないため、strict 検証で弾かれていた（`TODO: confirm against live Jomon` がまさにこれ）。実 Jomon で裏取り済み。

金額が申請単位しか無いため、1 申請に受取人が複数いると「誰にいくら」を機械的に決められない。運用上は受取人は常に 1 人だが、**万一複数入っていた場合に申請額を各人へ送ると過払い**になる。money-safety のため、複数受取人は自動送金せず会計の UI に警告を出して手動対応とする（ユーザー決定）。

## What Changes

- **v1 の金額は `current_detail.amount` から取る**: `v1RepaymentLogSchema` から `amount` 要求を外し、`v1DetailedApplicationSchema` に `current_detail.amount` を追加。1 申請の**未払い受取人が 1 人**のとき、その申請額を払い戻し額として送金へ進める。
- **複数受取人は needs-review＋UI 警告**: 未払い受取人が 2 人以上の申請は自動送金せず（payout 行も作らず）、`processApproved` の集計で needs-review に数え、新フィールド `multiPayeeRefs`（対象 application id）で返す。`/payouts` UI はこれがあるとき警告アラートを表示する。
- 単一受取人の通常フローと冪等・本人特定・原子的クレーム・書き戻しは不変。

明確に**スコープ外**: v2 ドライバ（別系統、変更なし）。複数受取人の自動按分（明示的に不採用）。Jomon 側の改修。

## Capabilities

### Modified Capabilities
- `payout-execution`: v1 の払い戻し金額の出どころ（`current_detail.amount`）と、複数未払い受取人の申請を自動送金せず needs-review＋UI 警告として扱う挙動を追加。

## Impact

- **API（`packages/api`）**: `jomon/http.ts`（v1 スキーマ＋取込ロジック分岐）、`jomon/types.ts`（`JomonTransferRequest.multiPayee?`、`ProcessApprovedSummary.multiPayeeRefs`）、`payouts/execute.ts`（ループで multiPayee を needs-review 集計し送金スキップ）。
- **Web（`apps/web`）**: `app/pages/payouts.vue` に複数受取人警告アラートを追加。
- **DB**: 変更なし（multi-payee は payout 行を作らない）。
- **テスト/検証**: v1 ドライバの単一/複数分岐・金額取得をユニットテスト。実 Jomon v1（ローカル）で単一→`ingested:1`、複数→`needsReview`＋`multiPayeeRefs` を E2E。
