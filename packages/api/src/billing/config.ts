/**
 * Billing configuration. Like {@link AuthConfig}, values originate from
 * environment variables and are resolved by the host (Nitro reads runtimeConfig).
 * The domain layer depends only on this typed shape — never on `process.env`,
 * the framework, or the Stripe SDK.
 */
export interface BillingConfig {
  /** The four Price ids that the pricing rule selects between. */
  prices: {
    /** 新規入部費・前期 (¥4,000). */
    shinkiZenki: string
    /** 新規入部費・後期 (¥2,000). */
    shinkiKouki: string
    /** 継続(部費)標準 (¥4,000). */
    keizokuStandard: string
    /** 継続(部費)特別 (¥2,000). 管理者のみ発行可. */
    keizokuSpecial: string
  }
  /** Stripe secret key (test mode to start). Empty until billing is configured. */
  stripeSecretKey: string
  /** Stripe webhook signing secret for `invoice.paid` verification. */
  stripeWebhookSecret: string
  /**
   * Stripe webhook signing secret for Connect `account.updated` verification.
   * May differ from {@link stripeWebhookSecret} when Connect events use a
   * separate endpoint (set the same value if they share one). (design D6)
   */
  connectWebhookSecret: string
  /** Days until an issued invoice is due (`send_invoice` collection). */
  invoiceDaysUntilDue: number
}
