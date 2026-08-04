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
- API 層のフィールド名は camelCase に統一する。消費側(TypeScript / Vue)と DB 層(drizzle も
  camelCase)の慣習に揃える。出力を allowlist で全フィールド手書きしている今、Stripe の snake_case は
  ハンドラの変換層で camelCase の View 名に対応づける(入力フィールドも同様に Stripe のパラメータ名へ
  変換して渡す)。Stripe の enum の値(`one_time`・`send_invoice` 等)はフィールド名ではなくデータ値
  なので変換しない。
- 出力は allowlist にする: 各リソースの公開 View(`packages/api-contract/src/*.ts`)は
  公開するフィールドだけを `z.object` で明示列挙し、外部プロバイダのオブジェクトを透過しない。
  目的は PII・内部・将来増えるフィールドを漏らさないこと(セキュリティ)と、クライアント向けの
  安定した契約。フィールドの語彙は現状 Stripe に合わせているが、決済プロバイダの移行容易化は
  目的としない(移行するなら入力語彙・カーソル・ハンドラの書き換えも要る)。
- 入力は選択的透過にする: 各プロシージャが対応するパラメータだけを受け付ける。とくに `expand` は
  受け付けない(ネストした `product.metadata` 等の漏洩経路になるため)。未知キーは zod が除去する。
- ユーザー同定(traq_id)は自前 DB を単一ソースとし、Stripe の metadata には持たせない。
  そのため API 出力に traq_id は含めない。必要になった時点で customer ID から DB を逆引きして
  解決する(#18)。
- 公開 View の文字列フィールド(status・type 等)は Stripe の値をそのまま透過し、enum で
  狭めない。将来 Stripe が値集合を増やしても契約が壊れないため。一方、入力フィルタ側は既知値に
  enum で狭めてよい。
- 現状すべてのプロシージャは無認証(`pub`)。無認証での決済系書き込みを避けるため、変更系
  (作成・更新)は既定で無効化し(`mutationsEnabled` / `assertMutationsEnabled`)、認可(#15)の
  導入時に本来の認可チェックへ置き換える。
- ビルドを常にグリーンに保つこと: `pnpm lint`、`pnpm knip`、`pnpm typecheck`、`pnpm test`、
  `pnpm build`。

## ローカル開発

```bash
pnpm install
cp .env.example .env
docker compose up -d        # MariaDB
pnpm db:migrate             # マイグレーションを適用
pnpm dev                    # http://localhost:3000 で Nuxt を起動
```
