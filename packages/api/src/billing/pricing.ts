import type { BillingConfig } from './config'
import type { Term } from './term'

/** 費目: 新規入部費 (`new`) か 継続(部費) (`continuation`). */
export type FeeType = 'new' | 'continuation'

/** 区分: 標準 (`standard`) か 特別 (`special`). 特別は継続のみ・管理者発行. */
export type Variant = 'standard' | 'special'

export interface SelectPriceInput {
  feeType: FeeType
  /** Required for `feeType: 'new'` (前期/後期 で price が変わる). */
  term?: Term
  /** Defaults to `standard`. `special` only valid with `continuation`. */
  variant?: Variant
}

/**
 * Map 費目・期・区分 to a configured Price id (membership-billing spec:
 * §費目と期・区分から price を決定):
 *   - new → term==='zenki' ? 前期(¥4,000) : 後期(¥2,000)
 *   - continuation + standard → 継続標準 (¥4,000)
 *   - continuation + special  → 継続特別 (¥2,000)
 *
 * The domain selects the `price_id`, never a raw amount — a Product alone does
 * not pin an amount (design.md D4).
 */
export function selectPriceId(config: BillingConfig, input: SelectPriceInput): string {
  const variant: Variant = input.variant ?? 'standard'

  let priceId: string
  if (input.feeType === 'new') {
    if (!input.term) {
      throw new Error('term is required to price a new-membership fee')
    }
    priceId = input.term === 'zenki' ? config.prices.shinkiZenki : config.prices.shinkiKouki
  }
  else {
    // continuation (部費)
    priceId = variant === 'special' ? config.prices.keizokuSpecial : config.prices.keizokuStandard
  }

  // Guard against an unconfigured Price: issuing with an empty id would fail
  // opaquely at Stripe, so fail clearly here pointing at the missing env var.
  if (!priceId) {
    const term = input.term ?? '-'
    throw new Error(`missing price id for ${input.feeType}/${variant}/${term}; check PRICE_* env`)
  }
  return priceId
}
