# NeoShowcase へ Jomon + Checkin を dev デプロイする手順

> traP の PaaS「NeoShowcase」(https://ns.trap.jp) に **Checkin** と **Jomon（フォーク `kaitoyama/Jomon`）** を
> それぞれ 1 Runtime アプリとしてデプロイし、Checkin→Jomon の払い戻し連携を dev で動かす手順。
> 構成: 各アプリ＝1 コンテナ（Checkin=Nuxt SSR が UI＋API＋webhook、Jomon=Go が UI(client/dist)＋`/api` を配信）。

## 方針サマリ（実装済み）

- **認証は NeoShowcase の Soft member-auth に寄せる**（自前 traQ OAuth は使わない）。proxy が付ける `X-Forwarded-User` を**両アプリが信頼**して traQ identity にする。**実装済み**（Checkin: `CHECKIN_TRUST_FORWARD_AUTH=1`、Jomon: `TRUST_FORWARD_AUTH=1`）。
- **Swift は無い** → Jomon は **production ビルド（`!debug`, Bearer 有効）**で動かし、**Swift env が無ければ LocalStorage にフォールバック**（実装済み）。画像は揮発するが払い戻しフローに画像は不要。
- **Docker（Dockerfile 記述）を避ける** → Checkin は **Runtime Command / Buildpack**。Jomon は client もビルドするため**既存 root `Dockerfile` を流用**（新規記述ではない）。
- **dev のメールリンクは traQ bot で投げ込む** → Checkin `MAILER_DRIVER=log`（リンクをログ出力→bot が拾って traQ へ）。

## 認証の仕組み（Soft forward-auth）

member auth は **両アプリ Soft**（Off でも Hard でもなく Soft）。理由:
- **Soft は非強制** → traQ 認証していない Stripe webhook と Checkin→Jomon の Bearer 呼び出しは**そのまま通る**（各アプリが署名/Bearer で自前認証）。Hard だと proxy がこれらを弾く。
- **Soft は認証済みブラウザに `X-Forwarded-User` を付与** → アプリがそれを traQ identity として採用。

| 経路 | 認証 |
|---|---|
| ブラウザ利用者（会計/会員） | **Soft forward-auth**: `/_oauth/login` 後に proxy が `X-Forwarded-User` を付与。Checkin は会計許可リスト照合、Jomon は admin リスト照合 |
| 集金の利用者（isct 学生） | **isct メール magic link**（traQ とは別軸の本人キー `mail_hash`）。Soft 非強制なので非部員でもアクセス可 |
| Stripe webhook | **署名検証**（traQ 不要、Soft で素通り） |
| Checkin → Jomon | **Bearer サービストークン**（traQ 不要、Soft で素通り。ヘッダが付かないので forward-auth ではなく Bearer 経路） |

> 各アプリは `X-Forwarded-User` を**`TRUST_FORWARD_AUTH=1`/`CHECKIN_TRUST_FORWARD_AUTH=1` のときだけ信頼**する（proxy 経由のみ到達する前提でのスプーフ対策）。

---

## 0. 共通の前提

- 各アプリは NeoShowcase の **ビルトイン MariaDB**（「Use MariaDB」）→ `NS_MARIADB_USER/PASSWORD/HOSTNAME/PORT/DATABASE` が env 発行。
- **member auth は両方 Soft**。
- **ファイルシステムは再起動で初期化**。永続データは MariaDB。Jomon 画像(LocalStorage)は揮発前提。
- **Runtime 上限: 1 CPU / 150MiB**（`traPtitech/manifest` の `ns-system/config/ns.yaml` の `components.controller.k8s.resources.limits` が `cpu: "1"`・`memory: "150Mi"`。この値は `resourceRequirements`（`pkg/infrastructure/backend/k8simpl/config.go`）を通ってアプリのコンテナの `Resources` になる）。**この上限はアプリ側から変更できない**。アプリの実行時設定は公開 API の `RuntimeConfig`（`api/proto/neoshowcase/protobuf/gateway.proto`）で渡すが、そのフィールドは `use_mariadb`・`use_mongodb`・`entrypoint`・`command`・`auto_shutdown` の 5 つで CPU とメモリの項目が無く、`gateway.proto` 全体を `cpu`・`memory`・`resource`・`limit` で大文字小文字を無視して探しても、当たるのは取得件数と期間を指定する `limit`・`limit_seconds` の 3 箇所だけである。ここで `gateway.proto` を公開 API として扱えるのは、同じディレクトリにある 3 つの `.proto` のうち、この 1 つだけが `service APIService` を宣言し、`controller.proto` のほうは `ControllerService` ほか NeoShowcase 内部のサービスを宣言しているからである。Go は余裕、Nuxt Node は低負荷なら可（OOM 注意）。**ただしこの 2 つの見込みは測っていない。**
- **自動シャットダウンを有効にすると常時稼働しなくなる**。有効時、NeoShowcase は StatefulSet を `replicas` 0 で作り、起動を sablier のミドルウェアに委ねる（`pkg/infrastructure/backend/k8simpl/synchronize_runtime.go` が `useSablier`（同じディレクトリの `backend.go`）の真のときに `replicas` を 0 にする）。`useSablier` が真になるのは、sablier が設定で有効であることと、アプリの `DeployType` が `DeployTypeRuntime` であることと、`RuntimeConfig` の `AutoShutdown.Enabled` が真であることの 3 つが揃ったときである。traP の設定では sablier が有効である（`ns.yaml` の `components.controller.k8s.middleware.sablier`）。
- **アクセス URL はワイルドカードの直下 1 ラベルにする**（例 `checkin-dev.trap.show`）。`WildcardDomains` 型のメソッド `TLSTargetDomain`（`pkg/domain/backend.go`）は、**設定されたワイルドカードドメインのどれかに FQDN が一致したときだけ**最左のラベルを `*` に置き換え、一致しなければ FQDN をそのまま返す（一致の判定は `pkg/domain/app_website.go` の `ContainsDomain`）。traP が登録しているワイルドカードドメインは `*.trap.show` と `*.trap.games` である（`ns.yaml` の `components.controller.k8s.tls.certManager.wildcard.domains`。この項目は `pkg/infrastructure/backend/k8simpl/config.go` の定義に付いたコメントのとおり cert-manager が DNS レコードを設定できるドメインの宣言であって、発行済みの証明書の一覧ではない）。証明書は丸めた後の名前 1 つにつき 1 件で、`pkg/infrastructure/backend/k8simpl/synchronize.go` の `SynchronizeShared` が `TLSTargetDomains` の各要素から 1 件ずつ作る。重複を除いているのは `SynchronizeShared` ではなく、`TLSTargetDomains` を組む `pkg/usecase/cdservice/app_deploy_helper.go` の `_collectSharedResources` が `map[string]struct{}` を経由する処理のほうである。直下 1 ラベルなら `*.trap.show` に丸まるので、**同じ名前に丸まる他のアプリと 1 件の証明書を共有することになり、アプリを増やしても証明書は増えない**。2 段以上の名前（`dev.checkin.trap.show`）は `*.checkin.trap.show` に丸まるので、その名前の証明書が別に 1 件要る。**発行元は本番の Let's Encrypt** なので（`ns.yaml` の `components.controller.k8s.tls.certManager.issuer.name` が `cluster-issuer`、`traPtitech/manifest` の `cert-manager/cluster-issuer.yaml` の ACME `server` が `https://acme-v02.api.letsencrypt.org/directory`）、発行数には Let's Encrypt の規定の上限がかかる。公式のレート制限のページ（`https://letsencrypt.org/docs/rate-limits/`。2026-09-21 に取得、HTTP 200）の "New Certificates per Registered Domain" は、登録ドメイン 1 つにつき 7 日ごとに 50 件までで、これはどのアカウントからの要求も数える全体の上限だと述べている。**`trap.show` が登録ドメインなので、この枠は同じドメインの下にある traP の全アプリで共有される**。

> 上の各項のうち、**挙動についての結論（Runtime 上限をアプリ側から変更できないこと、自動シャットダウンで `replicas` が 0 になること、証明書が丸めた後の名前 1 つにつき 1 件であること）は、NeoShowcase のリポジトリの `docs/` に記載が無く、実装から読んだものである**。`docs/` を `resource`・`memory`・`replicas`・`sablier`・`TLSTargetDomain` で大文字小文字を無視して再帰的に探すと一致は 0 件で、`certificate` の 1 件は `docs/architecture.md` の「Compatibility with Various Backends」の表の行、`wildcard` の 2 件は `docs/development.md` のローカル開発用ドメインの記述であり、いずれも上の結論を述べたものではない。設定項目そのもの（`auto_shutdown` を含む）は `docs/dbschema/application_config.md` に載っている。読んだ版は `traPtitech/NeoShowcase` の `ac0776e`、設定は `traPtitech/manifest` の `33131ea`。

---

## 1. Jomon のデプロイ（フォーク `kaitoyama/Jomon`）

### 1-1. リポジトリ登録
- `kaitoyama/Jomon` は**個人 GitHub リポ**（traP-jp org でない）→「Add New App」で:
  - public なら「**認証を使用しない**」＋`https://github.com/kaitoyama/Jomon.git`／private なら「**SSH公開鍵認証**」＋表示鍵を Deploy keys に登録
  - 即時ビルドしたいなら GitHub Webhook に `https://ns.trap.jp/api/webhook/github`（無ければ定期ポーリング）
- **ブランチ/ref = `local/checkin-dev-env`**（forward-auth＋Bearer＋Swift フォールバックが載ったブランチ）

### 1-2. ビルド設定
- **Runtime → Dockerfile**、Dockerfile Name = `Dockerfile`（root。`!debug`＝forward-auth/Bearer 有効、server＋client/dist を 1 コンテナ配信）、Context = `.`

### 1-3. アクセスURL
- 例 `https://jomon-dev.trap.show`、**HTTP Port = `1323`**（`main.go` 固定）、Path Prefix = `/`、**member auth = Soft**

### 1-4. 環境変数
| env | 値 | 備考 |
|---|---|---|
| `MARIADB_USERNAME/PASSWORD/HOSTNAME/DATABASE` | NS_MARIADB_* の値 | Jomon は `MARIADB_*` を読む（`model/db.go`）。NS の値をコピー、または ENTRYPOINT で `NS_MARIADB_*`→`MARIADB_*` に変換 |
| **`TRUST_FORWARD_AUTH`** | `1` | **Soft の `X-Forwarded-User` を信頼**（forward-auth 有効化） |
| **`SERVICE_TOKEN`** | 長い乱数 | **Checkin の `JOMON_API_TOKEN` と同値**。Bearer 共有秘密 |
| **`SERVICE_USER_TRAP_ID`** | 例 `checkin` | **Jomon に admin 登録した trap_id**。書き戻しが `IsAdmin` 要求＋実行者として記録 |
| `WEBHOOK_SECRET`/`WEBHOOK_CHANNEL_ID`/`WEBHOOK_ID` | traQ 通知用 | dev は空で可 |
| ~~`TRAQ_CLIENT_ID`~~ | — | **不要**（UI 認証は forward-auth、サービスは Bearer。自前 OAuth を使わない） |
| **`INITIAL_ADMIN_TRAP_IDS`** | `<あなたのtraQ_ID>`（カンマ区切り可） | **起動時に admin 自動シード**。`SERVICE_USER_TRAP_ID` も自動で admin になる |
| ~~`TRAQ_CLIENT_ID`~~ | — | **不要**（UI 認証は forward-auth、サービスは Bearer。自前 OAuth を使わない） |
| ~~`OS_*`（Swift）~~ | — | **不要**（未設定なら LocalStorage にフォールバック。`UPLOAD_DIR` 任意） |

- DB は **起動時 auto-migrate**（`model.Migrate()`）＝マイグレーション手順不要。
- **admin シードは env で自動**: `INITIAL_ADMIN_TRAP_IDS`（カンマ区切り）＋ `SERVICE_USER_TRAP_ID` を起動時に administrators 登録（冪等）。**手動 SQL は不要**。
  - 最低限 `INITIAL_ADMIN_TRAP_IDS=<あなたのtraQ_ID>` を入れれば、自分が Jomon admin・`checkin`（書き戻し用）も自動で admin。
  - 手動でやる場合（任意）: Adminer（https://adminer.ns.trap.jp）か SSH で `INSERT INTO administrators (trap_id) VALUES ('checkin'), ('<あなた>');`（テーブルは初回起動の auto-migrate 後）。

---

## 2. Checkin のデプロイ（`traPtitech/Checkin`）

### 2-1. リポジトリ登録
- `traPtitech/Checkin` は traP-jp org → **自動同期**（何もしない）、push 即ビルド。
- **ブランチ/ref = `main`**（統合済み）

### 2-2. ビルド設定（Dockerfile 不要）
**A. Runtime Command（推奨）**
- Base Image: `node:24-alpine`（`.nvmrc` が `24`。**`.nvmrc` を上げたらこの版も追随させる**）
- Build Command: `corepack enable && pnpm install --frozen-lockfile && pnpm build`
- Entrypoint（`NS_MARIADB_*`→`DATABASE_URL` 生成→migrate→起動）:
  ```sh
  sh -lc 'export DATABASE_URL="mysql://${NS_MARIADB_USER}:${NS_MARIADB_PASSWORD}@${NS_MARIADB_HOSTNAME}:${NS_MARIADB_PORT}/${NS_MARIADB_DATABASE}"; export NUXT_DATABASE_URL="$DATABASE_URL"; pnpm db:migrate && node apps/web/.output/server/index.mjs'
  ```
- `pnpm db:migrate`(drizzle-kit) は `DATABASE_URL` を、Nuxt サーバは runtimeConfig 上書きの **`NUXT_DATABASE_URL`** を読むので**両方 export**する。
- 単一イメージなので **drizzle-kit(devDep) が runtime に残り migrate が通る**（Command 推奨の理由）。

**B. Runtime Buildpack**（Base Image も不要）
- Context `.`。ただし Paketo は devDep を prune するので `pnpm db:migrate` が落ちうる → root `package.json` に `"start"` を足し **migration は初回 SSH で実行**、または `drizzle-kit` を `dependencies` に移す。

> Nuxt は `PORT`/`NITRO_PORT` を尊重（既定 3000）。NeoShowcase の HTTP Port をそれに合わせる。

### 2-3. アクセスURL
- 例 `https://checkin-dev.trap.show`、HTTP Port = entrypoint の PORT（既定 3000）、Path Prefix = `/`、**member auth = Soft**

### 2-4. 環境変数（**すべて `NUXT_` 接頭辞**）

Checkin は値を Nuxt runtimeConfig から読む。runtimeConfig は**ビルド時に焼かれる**ので、ランタイムで確実に効かせるには **`NUXT_` 接頭辞**で渡す（無印だとビルド時の空値が焼かれて効かない）。`DATABASE_URL`/`NUXT_DATABASE_URL` は entrypoint が生成。

| env | 値 | 備考 |
|---|---|---|
| **`NUXT_TRUST_FORWARD_AUTH`** | `1` | **Soft の `X-Forwarded-User` を traQ identity に**（forward-auth 有効化） |
| `NUXT_MAIL_HASH_SECRET` | 不変の長い乱数（`openssl rand -hex 32`） | 本人キー導出。運用中変えない |
| `NUXT_APP_ORIGIN` | `https://checkin-dev.trap.show` | 自サイト URL（リンク/Account Link 戻り先） |
| `NUXT_ACCOUNTANT_TRAQ_IDS` | 会計の traQ ID（カンマ区切り） | `X-Forwarded-User` と照合して admin 判定 |
| `NUXT_MAILER_DRIVER` | `log` | リンクをログ出力→bot が traQ へ中継（dev） |
| `NUXT_JOMON_API_BASE_URL` | `https://jomon-dev.trap.show` | Jomon の URL |
| `NUXT_JOMON_API_VERSION` | `v1` | **未設定だと stub にフォールバック**して実 Jomon を叩かない |
| `NUXT_JOMON_API_TOKEN` | **Jomon の `SERVICE_TOKEN` と同値** | Bearer サービストークン |
| `NUXT_STRIPE_SECRET_KEY` | `sk_test_…` | |
| `NUXT_STRIPE_WEBHOOK_SECRET` | `whsec_…` | invoice-paid 用 |
| `NUXT_STRIPE_CONNECT_WEBHOOK_SECRET` | `whsec_…` | account-updated 用 |
| `NUXT_PRICE_SHINKI_ZENKI` / `NUXT_PRICE_SHINKI_KOUKI` / `NUXT_PRICE_KEIZOKU_STANDARD` / `NUXT_PRICE_KEIZOKU_SPECIAL` | `price_…` ×4 | 新規前期¥4,000(通期)/新規後期¥2,000/継続¥4,000/特別¥2,000 |
| ~~`NUXT_TRAQ_*`~~ | — | **不要**（`/login` は `/_oauth/login` に転送、自前 OAuth を使わない） |

> `CHECKIN_DEV_LOGIN` は設定しない（本番ビルドで 404 だが念のため）。

> **`NUXT_JOMON_API_BASE_URL` には公開 URL を使う**。`traPtitech/manifest` の `ns-apps/network-policy.yaml` は `Egress` のみを定め、ユーザーアプリが置かれる `ns-apps` 名前空間宛ての規則を持たない。インターネット向けの 2 本は `cidr` が `0.0.0.0/0` と `::/0` なので `cidr` だけを見ると全て許可に見えるが、どちらにも `except` が付いている。IPv6 側の `except` は `fc00::/7`・`fe80::/10` と、`# Pod CIDR`・`# Service CIDR` とコメントされた 2 つなので、**クラスター内のアドレス宛てがこの規則から外れることは宣言から読める**。IPv4 側の `except` はプライベート IPv4 アドレスの 3 つ（`10.0.0.0/8`・`172.16.0.0/12`・`192.168.0.0/16`）だけで、`ns-apps` の Pod と Service の IPv4 アドレスがそこに入るかは、`clusterCIDR`・`serviceCIDR`・`podCIDR`・`cluster-cidr`・`service-cidr` を manifest 全体に当てた一致が 0 件で CIDR の宣言が無いため、**この宣言からは確かめられない**。確かめたのはこのポリシーの宣言の内容だけで、公開 URL への通信が実際に到達することは測っていない。

---

## 3. 相互配線とデプロイ後の確認

1. `SERVICE_TOKEN`(Jomon) == `JOMON_API_TOKEN`(Checkin) を同じ乱数に。
2. `JOMON_API_BASE_URL`(Checkin) = Jomon のホスト。
3. `SERVICE_USER_TRAP_ID` を Jomon admin に登録。
4. 両アプリ member auth = **Soft**、`*_TRUST_FORWARD_AUTH=1`。
5. Stripe Dashboard の webhook 宛先:
   - `https://checkin-dev.trap.show/webhook/invoice-paid`（→ `STRIPE_WEBHOOK_SECRET`）
   - `https://checkin-dev.trap.show/webhook/account-updated`（→ `STRIPE_CONNECT_WEBHOOK_SECRET`）
6. 疎通確認:
   - Checkin `/` →（未ログインなら）`/login`→`/_oauth/login` で Soft 認証→会計なら `/payments`・`/payouts` が見える。
   - `/membership` 発行→test card 支払い→`invoice.paid` 通知。
   - 会計 `/payouts`「Jomon 取込」→ Jomon が **Bearer を検証**して accepted 申請を返す→取込/onboarding/送金。
   - Jomon UI は `/_oauth/login` 後に `X-Forwarded-User` で認証される。

---

## 4. 注意・落とし穴

- **forward-auth は `*_TRUST_FORWARD_AUTH=1` のときだけ有効**。proxy 経由のみ到達する NeoShowcase 前提（直アクセス可能な環境で有効化しない）。
- **`NS_MARIADB_*` → アプリ期待名へのマッピング**: Checkin は entrypoint で `DATABASE_URL` 生成。Jomon は `MARIADB_*` を読むので値コピー or ENTRYPOINT 変換。
- **member auth は Soft**（Off だとブラウザの traQ identity が取れない／Hard だと webhook・Bearer が弾かれる）。
- **再起動でディスク揮発**: Jomon 画像（LocalStorage）は消える。払い戻しに無関係。
- **Runtime のメモリ上限**: Nuxt Node の OOM は低負荷運用で対処する。上限の値と出どころは §0。
- **自動シャットダウン**: 有効にしたときの挙動は §0。メモリ上限への対処を決める前に読む。
- **実装状況**: forward-auth/Swift フォールバック（Jomon `local/checkin-dev-env`）と forward-auth（Checkin `main`）は実装・コミット済み。Checkin は Dockerfile 不要（Command/Buildpack）。

---

## 5. トラブルシュート（実機で出たもの）

### Jomon `panic: dial tcp [::1]:3306: connect: connection refused`（`main.go`）
- **原因**: `MARIADB_HOSTNAME` 等が未設定で localhost(:3306) を見ている。
- **対処**: `MARIADB_USERNAME/PASSWORD/HOSTNAME/DATABASE` を NeoShowcase の `NS_MARIADB_*` の値で設定（§1-4）。`NS_MARIADB_*` は Adminer のログイン情報か SSH `env` で確認。手コピーを避けたいなら ENTRYPOINT 変換ラッパ化（要相談）。

### Jomon `panic: dir doesn't exist`（`router/service.go` `newImageRepository`）
- **原因**: Swift 無しフォールバックの LocalStorage が `./uploads` を**作らず**参照していた（`NewLocalStorage` は既存ディレクトリ必須）。**修正済み**（`local/checkin-dev-env` commit `b41808e`：`os.MkdirAll` でディレクトリ作成）。
- **対処**: Jomon を**最新の `local/checkin-dev-env` で再ビルド**（push 即ビルド未設定なら NeoShowcase で手動同期/再ビルド）。

### Jomon UI で `{"message":"ClientID: cannot be blank."}`
- **原因**: Jomon の Vue クライアントが**自前 traQ OAuth**（`GET /api/auth/genpkce`）を起動するが、Soft 運用で `TRAQ_CLIENT_ID` を設定していないため。
- **対処**: **修正済み**（`local/checkin-dev-env` commit `408644d`）。クライアントのログイン導線を NeoShowcase の **`/_oauth/login?redirect=…`** 転送に変更。未ログイン者は強制 traQ 認証→`X-Forwarded-User` で `/api/users/me` 成功＝**全ページ要ログイン**を維持。**最新ブランチで再ビルド**すれば解消。member auth は **Soft のまま**（Hard にすると Checkin→Jomon の Bearer が弾かれる）。

### Checkin の env が効かない（設定したのに空扱い）
- **原因**: 無印 env はビルド時の空値が焼かれている。
- **対処**: **`NUXT_` 接頭辞**で設定（§2-4）。特に `NUXT_JOMON_API_VERSION=v1` を忘れると stub にフォールバックして実 Jomon を叩かない。
