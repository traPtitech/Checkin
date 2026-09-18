// https://nuxt.com/docs/api/configuration/nuxt-config
export default defineNuxtConfig({
  modules: ['@nuxt/eslint', '@nuxt/ui'],
  devtools: { enabled: true },
  css: ['~/assets/css/main.css'],
  runtimeConfig: {
    // Server-only secrets/config. Override at runtime via NUXT_* env vars.
    // 実行時に NUXT_DATABASE_URL で上書き可能。
    databaseUrl: process.env['DATABASE_URL'] ?? '',
    // Identity / sessions
    mailHashSecret: process.env['MAIL_HASH_SECRET'] ?? '',
    allowedEmailDomains: process.env['ISCT_ALLOWED_EMAIL_DOMAINS'] ?? 'm.isct.ac.jp',
    appOrigin: process.env['APP_ORIGIN'] ?? '',
    emailVerificationTtlSec: process.env['EMAIL_VERIFICATION_TTL'] ?? '1800',
    sessionTtlSec: process.env['SESSION_TTL'] ?? '2592000',
    // Accountant (admin) allow-list
    accountantTraqIds: process.env['CHECKIN_ACCOUNTANT_TRAQ_IDS'] ?? '',
    // NeoShowcase "Soft" member-auth: trust the proxy's X-Forwarded-User header
    // as the traQ identity ('1' to enable). Only safe behind the trusted proxy.
    trustForwardAuth: process.env['CHECKIN_TRUST_FORWARD_AUTH'] ?? '',
    // traQ OAuth (client registered out-of-band; URLs/scope come from env)
    traqClientId: process.env['TRAQ_OAUTH_CLIENT_ID'] ?? '',
    traqClientSecret: process.env['TRAQ_OAUTH_CLIENT_SECRET'] ?? '',
    traqAuthorizeUrl: process.env['TRAQ_OAUTH_AUTHORIZE_URL'] ?? '',
    traqTokenUrl: process.env['TRAQ_OAUTH_TOKEN_URL'] ?? '',
    traqUserinfoUrl: process.env['TRAQ_OAUTH_USERINFO_URL'] ?? '',
    traqScope: process.env['TRAQ_OAUTH_SCOPE'] ?? '',
    traqUserIdField: process.env['TRAQ_OAUTH_USER_ID_FIELD'] ?? 'name',
    // Mailer
    mailerDriver: process.env['MAILER_DRIVER'] ?? 'log',
    mailFrom: process.env['MAIL_FROM'] ?? 'noreply@localhost',
    sendgridApiKey: process.env['SENDGRID_API_KEY'] ?? '',
    // Membership collection / Stripe
    // 実行時に NUXT_STRIPE_SECRET_KEY で上書き可能。サーバー専用(先頭に public を付けない)。
    stripeSecretKey: process.env['STRIPE_SECRET_KEY'] ?? '',
    stripeWebhookSecret: process.env['STRIPE_WEBHOOK_SECRET'] ?? '',
    // Connect (account.updated) webhook signing secret — see add-connect-onboarding.
    stripeConnectWebhookSecret: process.env['STRIPE_CONNECT_WEBHOOK_SECRET'] ?? '',
    priceShinkiZenki: process.env['PRICE_SHINKI_ZENKI'] ?? '',
    priceShinkiKouki: process.env['PRICE_SHINKI_KOUKI'] ?? '',
    priceKeizokuStandard: process.env['PRICE_KEIZOKU_STANDARD'] ?? '',
    priceKeizokuSpecial: process.env['PRICE_KEIZOKU_SPECIAL'] ?? '',
    invoiceDaysUntilDue: process.env['INVOICE_DAYS_UNTIL_DUE'] ?? '7',
    // Payout execution / Jomon integration (OpenSpec: add-payout-execution).
    jomonApiBaseUrl: process.env['JOMON_API_BASE_URL'] ?? '',
    jomonApiToken: process.env['JOMON_API_TOKEN'] ?? '',
    jomonApiVersion: process.env['JOMON_API_VERSION'] ?? 'stub',
    payoutCurrency: process.env['PAYOUT_CURRENCY'] ?? 'jpy',
    // 変更系(作成・更新)プロシージャを許可するか。既定は無効で、無認証の決済系書き込みを
    // 塞ぐ。認可(#15)導入までの暫定措置。有効化は実行時に NUXT_ENABLE_UNSAFE_MUTATIONS=true。
    enableUnsafeMutations: false,
  },
  compatibilityDate: '2025-01-01',
  nitro: {
    typescript: {
      tsConfig: { extends: '../../../tsconfig.base.json' },
    },
  },
  typescript: {
    typeCheck: false,
    // Nuxt は apps/web/.nuxt/ 配下にコンテキストごと(app/shared/node/server)に
    // 別々の tsconfig を生成する。app 用だけでなく、その全てにモノレポの
    // 厳格な base 設定を継承させる。パスは生成後のファイルからの相対パス。
    tsConfig: {
      extends: '../../../tsconfig.base.json',
      vueCompilerOptions: {
        // このリポジトリとは無関係な後方互換の理由からデフォルトは無効。
        // テンプレート内の式・バインディング(props, v-model, イベント
        // ハンドラ)を緩めずに script コードと同じ厳格さで型チェックする。
        strictTemplates: true,
        // コンポーネントのルート要素へフォールスルーする属性(例:
        // ルートが <a> のコンポーネントに `href` を渡す場合)を、
        // defineProps 未宣言の属性として unknown-prop エラーにするのではなく、
        // そのルート要素本来の型に対して型チェックする。
        fallthroughAttributes: true,
      },
    },
    sharedTsConfig: { extends: '../../../tsconfig.base.json' },
    nodeTsConfig: { extends: '../../../tsconfig.base.json' },
  },
  eslint: {
    config: {
      stylistic: true,
      typescript: {
        // このファイルのディレクトリではなく、モノレポルート
        // (eslint の tsconfigRootDir)からの相対パスで解決される。
        tsconfigPath: './apps/web/tsconfig.json',
      },
    },
  },
})
