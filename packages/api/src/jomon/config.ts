/**
 * Jomon configuration. Like the auth/billing config, values originate from
 * environment variables and are resolved by the host (Nitro reads runtimeConfig).
 * The domain depends only on this typed shape — never on `process.env` or the
 * framework. (design D6)
 */
export interface JomonConfig {
  /** Driver to use: in-memory `stub` (dev/tests) or live `v1` / `v2` HTTP. */
  version: 'stub' | 'v1' | 'v2'
  /** Jomon API base URL (live drivers only). */
  baseUrl: string
  /** Bearer service token for Checkin→Jomon calls (live drivers only, one-way). */
  token: string
  /** Default payout currency (`PAYOUT_CURRENCY`, e.g. 'jpy') for requests that omit one. */
  payoutCurrency: string
  /**
   * Seed data for {@link StubJomonClient}: approved requests the stub serves
   * from memory in dev/tests. Empty by default. (config-driven, no env parsing
   * of structured data — set programmatically in tests.)
   */
  stubApproved?: import('./types').JomonTransferRequest[]
}
