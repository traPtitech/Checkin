import { computeActivityYear } from '../billing/term'
import type { FeeType } from '../billing/pricing'
import type { Term } from '../billing/term'

/**
 * Coverage span of a membership payment (issuance-ledger spec: §coverage の決定).
 * Principle: ¥4,000 = 通期 (`full` = both halves), ¥2,000 = one half.
 */
export type Coverage = 'full' | 'zenki' | 'kouki'

/** A half of the activity year occupied by a ledger slot. */
export type Half = 'zenki' | 'kouki'

/** The set of half-slots a coverage occupies (`full` → both). */
export function halvesForCoverage(coverage: Coverage): Half[] {
  return coverage === 'full' ? ['zenki', 'kouki'] : [coverage]
}

/**
 * Coverage for a STANDARD (self-serve) issuance from 費目・期:
 *   - 入部・復旧 前期 (¥4,000) → 通期
 *   - 入部・復旧 後期 (¥2,000) → 後期のみ
 *   - 継続 (¥4,000)           → 通期
 * (復旧/再入部 are priced as `new`.) Special (¥2,000) is NOT derived here — the
 * accountant passes the half explicitly. (issuance-ledger spec: §coverage の決定)
 */
export function standardCoverage(feeType: FeeType, term: Term): Coverage {
  if (feeType === 'continuation') {
    return 'full'
  }
  return term === 'zenki' ? 'full' : 'kouki'
}

/**
 * The activity year a STANDARD issuance covers (membership-billing spec:
 * §発行がカバーする活動年度の決定). Entry/recovery cover the current year;
 * 継続 (collected by the accountant in 後期) covers the NEXT year's renewal.
 */
export function standardActivityYear(now: Date, feeType: FeeType): number {
  const base = computeActivityYear(now)
  return feeType === 'continuation' ? base + 1 : base
}
