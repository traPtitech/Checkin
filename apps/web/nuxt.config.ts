// https://nuxt.com/docs/api/configuration/nuxt-config
export default defineNuxtConfig({
  modules: ['@nuxt/eslint', '@nuxt/ui'],
  devtools: { enabled: true },
  css: ['~/assets/css/main.css'],
  runtimeConfig: {
    // Server-only secrets/config. Override at runtime via NUXT_* env vars.
    databaseUrl: process.env.DATABASE_URL ?? '',
    // Identity / sessions
    mailHashSecret: process.env.MAIL_HASH_SECRET ?? '',
    allowedEmailDomains: process.env.ISCT_ALLOWED_EMAIL_DOMAINS ?? 'm.isct.ac.jp',
    appOrigin: process.env.APP_ORIGIN ?? '',
    emailVerificationTtlSec: process.env.EMAIL_VERIFICATION_TTL ?? '1800',
    sessionTtlSec: process.env.SESSION_TTL ?? '2592000',
    // Accountant (admin) allow-list
    accountantTraqIds: process.env.CHECKIN_ACCOUNTANT_TRAQ_IDS ?? '',
    // traQ OAuth (client registered out-of-band; URLs/scope come from env)
    traqClientId: process.env.TRAQ_OAUTH_CLIENT_ID ?? '',
    traqClientSecret: process.env.TRAQ_OAUTH_CLIENT_SECRET ?? '',
    traqAuthorizeUrl: process.env.TRAQ_OAUTH_AUTHORIZE_URL ?? '',
    traqTokenUrl: process.env.TRAQ_OAUTH_TOKEN_URL ?? '',
    traqUserinfoUrl: process.env.TRAQ_OAUTH_USERINFO_URL ?? '',
    traqScope: process.env.TRAQ_OAUTH_SCOPE ?? '',
    traqUserIdField: process.env.TRAQ_OAUTH_USER_ID_FIELD ?? 'name',
    // Mailer
    mailerDriver: process.env.MAILER_DRIVER ?? 'log',
    mailFrom: process.env.MAIL_FROM ?? 'noreply@localhost',
    sendgridApiKey: process.env.SENDGRID_API_KEY ?? '',
    // Membership collection / Stripe
    stripeSecretKey: process.env.STRIPE_SECRET_KEY ?? '',
    stripeWebhookSecret: process.env.STRIPE_WEBHOOK_SECRET ?? '',
    // Connect (account.updated) webhook signing secret — see add-connect-onboarding.
    stripeConnectWebhookSecret: process.env.STRIPE_CONNECT_WEBHOOK_SECRET ?? '',
    priceShinkiZenki: process.env.PRICE_SHINKI_ZENKI ?? '',
    priceShinkiKouki: process.env.PRICE_SHINKI_KOUKI ?? '',
    priceKeizokuStandard: process.env.PRICE_KEIZOKU_STANDARD ?? '',
    priceKeizokuSpecial: process.env.PRICE_KEIZOKU_SPECIAL ?? '',
    invoiceDaysUntilDue: process.env.INVOICE_DAYS_UNTIL_DUE ?? '7',
    // Payout execution / Jomon integration (OpenSpec: add-payout-execution).
    jomonApiBaseUrl: process.env.JOMON_API_BASE_URL ?? '',
    jomonApiToken: process.env.JOMON_API_TOKEN ?? '',
    jomonApiVersion: process.env.JOMON_API_VERSION ?? 'stub',
    payoutCurrency: process.env.PAYOUT_CURRENCY ?? 'jpy',
  },
  compatibilityDate: '2025-01-01',
  typescript: {
    typeCheck: false,
  },
  eslint: {
    config: {
      stylistic: true,
    },
  },
})
