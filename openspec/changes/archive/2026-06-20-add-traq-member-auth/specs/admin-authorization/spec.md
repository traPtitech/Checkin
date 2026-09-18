## MODIFIED Requirements

### Requirement: traQ OAuth による会計ログイン

利用者（現役会員）・会計はともに traQ OAuth の authorization code フロー（PKCE 併用）でログイン SHALL。`GET /login` は state と PKCE code_verifier を生成・保存して traQ の認可エンドポイントへリダイレクトし、コールバックで `state` を検証し、code を access token に交換して traQ のユーザー情報（traq_id）を取得 MUST。ログイン成立で**会員セッション**を確立する（traQ 認証済み）。`state` 不一致や code 交換失敗時はセッションを確立せずエラーとする SHALL。

#### Scenario: 正常な OAuth ログインで会員セッション

- **WHEN** traQ で認可してコールバックに戻る
- **THEN** `state` が検証され、code が token に交換され、traq_id を持つ会員セッションが確立される

#### Scenario: state 不一致は拒否

- **WHEN** コールバックの `state` が保存値と一致しない
- **THEN** セッションは確立されず、エラーとして扱われる

### Requirement: env 許可リストによる会計判定

システムは、traQ ログインで得た traq_id が環境変数の会計 traQ ID 許可リストに含まれる場合に**会計権限（`isAdmin`）**を付与 SHALL。許可リスト外の traq_id には会計権限を付与しては SHALL NOT が、ログイン自体は成立し**会員セッション**として扱う MUST。会計の管理は DB の管理者テーブルではなく、この許可リスト（将来 traQ グループ連携へ拡張可能）で行う。

#### Scenario: 許可リスト内は会計になる

- **WHEN** 許可リストに含まれる traq_id でログインが完了する
- **THEN** 会員セッションに会計権限（`isAdmin`）が付与される

#### Scenario: 許可リスト外は会員のまま

- **WHEN** 許可リストに含まれない traq_id でログインが完了する
- **THEN** ログインは成立し会員セッションになるが、会計権限は付与されない
