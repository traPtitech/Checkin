# Checkin — プロジェクトコンテキスト

OpenSpec の変更提案のためのコンテキスト。スペック・設計・タスクを作成する前に読むこと。

## これは何か

`Checkin` は TypeScript モノレポである。機能はスペックファーストで開発される: あらゆる変更は
OpenSpec の提案(`/opsx:propose`)として始まり → 適用(`/opsx:apply`) → アーカイブ
(`/opsx:archive`) される。

## 技術スタック

- **言語**: TypeScript(strict)、Node.js 24、ESM。
- **モノレポ**: pnpm workspaces(Turborepo は使用しない)。パッケージは `workspace:*` で
  互いを参照する。
- **フロントエンド + サーバー**: Nuxt 4(`apps/web`)。バックエンドは独立したサービス**では
  ない** — API は Nuxt の Nitro サーバー内でホストされる。
- **API / RPC**: oRPC、コントラクトファースト。コントラクト(`@orpc/contract` の `oc`)は
  `packages/api-contract` にあり、`packages/api` が `implement(contract)` を通じてそれを
  実装し、Nitro ルート `apps/web/server/routes/rpc/[...].ts` にマウントされる。
  `apps/web/app/plugins/orpc.ts` の型付きクライアントは、サーバー実装ではなくコントラクトに
  リンクする。
- **データベース**: Drizzle ORM(`drizzle-orm/mysql2`、dialect `mysql`)経由の MariaDB を
  `packages/db` で使用。マイグレーションは `packages/db/drizzle/` にありコミットされる。
- **Lint/format**: リポジトリルートの ESLint フラット設定(`@nuxt/eslint`、stylistic 有効、
  型を考慮したルール)。`knip` が未使用のファイル・エクスポート・依存関係をチェックする。
- **テスト**: vitest。テストファイルはソースの隣に `*.test.ts` として置く。`pnpm test` が
  ワークスペース全体のスイートを実行する。
- **Git フック**: husky の pre-commit で gitleaks(シークレットスキャン。未インストールなら
  コミットを拒否)+ lint-staged(ステージされたファイルへの `eslint --fix`)、続けて
  `pnpm typecheck` と `pnpm test` を毎コミット実行する。

## 構成

```
apps/web               Nuxt アプリ(UI + oRPC をホストする Nitro サーバー)
packages/api-contract  oRPC コントラクト(プロシージャの入出力・エラー仕様、実装なし)
packages/api           oRPC ルーター — packages/api-contract を実装、リクエスト Context
packages/db            Drizzle スキーマ、MariaDB クライアント、マイグレーション
```

## 規約

- 新しい oRPC プロシージャ: まず `packages/api-contract/src/` に、入出力・エラースキーマ用の
  `oc`(`@orpc/contract`)を使って機能(capability)単位でグループ化しコントラクトを定義する。
  次に `packages/api/src/router.ts`(`appRouter.<capability>.<procedure>`)で実装し、
  `pub`(`packages/api/src/orpc.ts`、`implement(contract).$context<Context>()`)からハンドラを
  構築する。DB へは `context.db` 経由でアクセスする。
- 新しいテーブル: `packages/db/src/schema.ts` に定義し、その後 `pnpm db:generate` して
  マイグレーションをコミットする。生成されたマイグレーション SQL を手動編集しないこと。
- クライアントはコントラクト(`@checkin/api-contract`)を `@orpc/contract` の
  `ContractRouterClient` で型付けしてインポートする — `apps/web` の UI コードに
  `@checkin/api`(サーバー実装)を絶対にインポートしないこと。
- API 層のフィールド名は camelCase に統一する。この API を消費するのは型付き oRPC クライアント
  経由の TypeScript / Vue コードで、契約の型が `result.unitAmount` のようにそのまま参照される。
  camelCase は JS/TS のプロパティ命名の標準なので、クライアント側での読み替えや命名 lint の抑制なしに
  自然に扱える。対抗案は snake_case(Stripe ドキュメントと名前が一致する)だったが、出力を allowlist に
  して全フィールドを手書きする以上 Stripe との一致は自動では得られず、その利点は小さい。ハンドラの
  変換層で Stripe の snake_case を camelCase の View 名へ、入力も Stripe パラメータ名へ変換する。
  Stripe の enum の値(`one_time`・`send_invoice` 等)はフィールド名でなくデータ値なので変換しない。
- 出力は allowlist にする。Stripe オブジェクトをそのまま透過すると、customer_email 等の PII・内部
  フラグ・将来 Stripe が追加するフィールドが、レビューを経ずに公開契約へ流れ込む。公開 View を
  `z.object` で明示列挙すれば、露出する各フィールドが意図的な選択になり、Stripe 側の追加は既定では
  契約に入らない(opt-in)。代償はリソースごとの変換コードだが、漏洩を型で締める価値が上回る。
  フィールドの語彙は Stripe に合わせるが、決済プロバイダの移行容易化は目的にしない(移行時は入力語彙・
  カーソル・ハンドラの書き換えも要るため、allowlist だけでは移植性は得られない)。
- 入力は選択的透過にする。とくに `expand` は受け付けない。expand を通すと Stripe がネストした
  オブジェクト(`product.metadata` 等)をレスポンスに展開し、出力 allowlist を迂回して PII や内部
  データが漏れる経路になるため。対応済みのパラメータだけを明示的に受け、未知キーは zod が除去する。
- ユーザー同定(traq_id)は自前 DB を単一ソースとし、Stripe metadata には持たせない/出力もしない。
  metadata に持たせないのは、Stripe metadata がクライアントから書き換え可能で権威を持てず、同定の
  根拠にすると偽装や不整合の余地が生じるため。出力にも載せないのは、traq_id が Stripe を経由しない内部の
  同定子で、決済 API のレスポンスに出すと customer ID ↔ traq_id の対応が利用者に露出して名寄せ・相関の
  攻撃面を広げる一方、現在この値を必要とする消費者が無いため。必要時は DB を正本に customer ID から
  逆引きする(#18)。
- 公開 View の文字列フィールド(status・type 等)は Stripe の値をそのまま透過し、enum で狭めない。
  出力を今日の値集合で `z.enum` に固定すると、Stripe が新しい値を追加した時に正当な Stripe オブジェクトを
  出力検証が弾いて 500 になり、実データで壊れる。`z.string()` なら新値も通る。入力フィルタは自分が受理
  する値を決められるので enum で狭めてよい。
- 現状すべてのプロシージャは無認証(`pub`)。変更系(作成・更新)は既定で無効化する
  (`mutationsEnabled` / `assertMutationsEnabled`)。無認証のまま変更系を出すと、デプロイ済みの main では
  「到達できない」ことだけが歯止めになり、Invoice 確定のような金銭・破壊的操作を誰でも叩ける。既定オフで
  fail-closed にし、認可(#15)導入時に本来のチェックへ置き換える。
- API の消費者は現状 `apps/web` の型付きクライアントのみで、契約とクライアントは常に同時
  デプロイされる。この前提(内部専用・co-deploy)を確定し、破壊的変更を許容してバージョニング
  機構は持たない。外部消費者を許すなら、その時点で互換性維持ポリシーを別途定める。
- 現状の Stripe 系エンドポイント(prices・products・invoices・checkout)は Stripe を allowlist で
  薄く包む管理・配管層であって、会員向けのドメイン API ではない。`customer` や checkout session は
  Stripe の概念そのものなので、会員向けには「会費を払う・自分の支払い状況」といったドメイン言語の
  API を別に建て、Stripe をバックエンドの裏に隠す(#27/#28/#35)。フロントがこの Stripe 形状の上に
  会員向け UX を直接組むと密結合が固まるので避ける。
- ビルドを常にグリーンに保つこと: `pnpm lint`、`pnpm knip`、`pnpm typecheck`、`pnpm test`、
  `pnpm build`。

## 意思決定の指針

何を「今詰めるか、暫定にして後で詰めるか」は、**後で変える時のコスト**と**今その決定に足る情報が
あるか**の2軸で決める。

- 後で変えるコストが高い・不可逆なもの(公開契約・永続化スキーマ・セキュリティ境界・お金の記録方法
  など、後続実装やデータが積み上がって固まっていくもの)は、情報が揃っているなら今決める。
- 後から加算的・非破壊に変えられ、かつ機能要求やフロントエンドの実装が固まらないと詰められないものは、
  暫定の仕様・実装にして後で決める。
- 「後で安い」は過小評価しがちなので、暫定にするものは設計で可逆に保つ(seam の裏に隔離する、加算的な
  拡張パスを用意する、消費側を固定しない)。迷ったら、固まるのが速い契約・永続化・セキュリティの境界は
  今決める側へ倒す。
- 「変更コストが高い × 今は情報不足」のものは、全面保留にせず最小の可逆な骨格だけ今コミットして隔離し、
  決めるための情報(該当するフロントエンドのスライス等)を早く取りに行く。
- 暫定は黙って恒久化するので、暫定である印と見直す条件を必ず残す(issue 化、コメントに制約と拡張パスを
  明記する)。

## ローカル開発

```bash
pnpm install
cp .env.example .env
docker compose up -d        # MariaDB
pnpm db:migrate             # マイグレーションを適用
pnpm dev                    # http://localhost:3000 で Nuxt を起動
```
