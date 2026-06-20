## Why

Jomon の払い戻しは受取人を **traQ ID** で渡してくる（v1 `trap_id` / v2 は User UUID→`name`、実 API 調査で確定）。しかし Checkin の `users` は `mail_hash`（isct メール）だけで識別し traQ ID を持たないため、payout を本人に解決できない。

解決策（ユーザー決定）: **traQ ログインを「現役会員セッション」にも使い**、現役が **traQ 認証済みで支払った時に `users.traq_id` を保存**して、isct アイデンティティ（mail_hash）と traQ アイデンティティを 1 本に紐付ける。以後 payout は `traQ ID → users.traq_id → connected account` で解決できる。これは旧 §2「traQ=会計のみ」を更新し、design §5.1 の「現役→traQ ログイン」フローを正とする。認証済み traQ ID のみ信頼する（フォーム入力の traQ ID は §4.1 通り非信頼）。

## What Changes

- **traQ ログイン＝会員セッション**: `GET /login`（traQ OAuth）成立で**会員**セッションを確立する。会計（管理者）は env 許可リストに含まれる traQ ID の**サブセット**（`isAdmin`）。許可リスト外でもログインは成立し、会員として扱う。
  - **BREAKING（admin-authorization 更新）**: 旧「許可リスト外はセッション確立せず」を改め、会員セッションは確立しつつ会計権限のみ許可リストで判定。
- **デュアル・アイデンティティのセッション**: セッションは **traqId（traQ 認証）** と **user（mail_hash 由来の userId）** の双方を保持できる。`requireUser` は請求可能な user（userId）を要求、`requireAdmin` は `isAdmin` を要求。
  - traQ ログイン時、`users.traq_id` が一致する行があれば user も解決してセッションに載せる（紐付け済み現役は再確認不要）。
  - isct メール確認時、既存セッションに traqId があれば、その user 行に traqId を**連結**し、同一セッションに user を載せる。
- **本人キーの拡張**: `users` に `traq_id`（nullable, unique）を追加。**BREAKING（identity 更新）**: 非 PII 参照として traq_id を保持してよい（認証済み traQ ID のみ）。
- **支払い時の連結（membership-billing 更新）**: `issueInvoice` がセッションに traqId と user を併せ持つとき、`users.traq_id` を保存し、Customer の metadata にも traQ ID を入れる（参照キーは引き続き mail_hash／customer_id）。

明確に**スコープ外**（後続）: Jomon アダプタの実 API 修正（`fix-jomon-payout`）、UI（`add-member-ui`）、許可リストの traQ グループ移行。

## Capabilities

### New Capabilities
<!-- なし。既存 capability の挙動変更（MODIFIED）として扱う。 -->

### Modified Capabilities
- `admin-authorization`: traQ OAuth は**会員セッション**を確立し、会計はその許可リスト・サブセット（`isAdmin`）。許可リスト外もログイン成立（会員）。
- `session`: セッションは traqId と user（userId/mailHash）の双方＋`isAdmin` を保持可能。`requireUser`=user 必須、`requireAdmin`=isAdmin 必須。`requireMember`（traQ 認証）を追加。
- `identity`: `users.traq_id`（nullable, unique）を追加。認証済み traQ ID の連結ルール（一致で解決、支払い時に保存）。
- `membership-billing`: traQ 認証済みで支払うと `users.traq_id` を保存（Customer metadata にも traQ ID）。請求の認可は user（mail_hash 一致）に加え、紐付け済み traQ 会員も自分の請求を出せる。

## Impact

- **DB（`packages/db`）**: `users.traq_id varchar(255)` nullable **unique** 追加。マイグレーション生成・適用。
- **API（`packages/api`）**: `SessionActor`/session 作成・復元を**デュアル・アイデンティティ**へ拡張（traqId/userId/mailHash/isAdmin）。`requireUser`/`requireAdmin`/`requireMember` と `userProc`/`adminProc`/`memberProc`。`identity` に traq_id 連結ヘルパ（`getUserByTraqId`、`linkTraqId` 競合安全）。`membership.issueInvoice` で連結保存。
- **Web/Nitro（`apps/web`）**: `GET /login/callback` を会員セッション確立へ（許可リストは isAdmin 判定に降格）。`GET /verify-email/confirm` を「既存 traQ セッションに user を連結」に対応。`auth.me` 返却に会員/会計の区別と user 有無を含める。
- **既存 change との関係**: auth-foundation/membership-collection の挙動を MODIFIED で更新。payout-execution の payee 解決を traq_id 経由にするのは後続 `fix-jomon-payout`。
- **テスト/検証**: セッションのデュアル解決・連結・許可リスト降格・issueInvoice 連結保存をユニット＋ローカル E2E（traQ はテスト困難なため連結ロジックは関数単位で検証）。
