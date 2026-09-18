/** A half of the activity year. (membership-billing spec: §活動年度に基づく期判定) */
export type Term = 'zenki' | 'kouki'

/**
 * Decide the half-term for a date. The activity year runs Apr 1 – Mar 31:
 *   - Apr–Sep (months 4–9)  → `zenki`  (前期)
 *   - Oct–Dec & Jan–Mar      → `kouki`  (後期)
 *
 * Deterministic and uniquely determined by the month alone.
 */
export function computeTerm(date: Date): Term {
  const month = date.getMonth() + 1 // getMonth() is 0-based
  return month >= 4 && month <= 9 ? 'zenki' : 'kouki'
}

/**
 * The activity year a date falls in, labelled by its starting calendar year.
 * Apr–Dec belong to the year that started this Apr; Jan–Mar belong to the year
 * that started the *previous* Apr. Useful as an invoice metadata label.
 */
export function computeActivityYear(date: Date): number {
  const year = date.getFullYear()
  const month = date.getMonth() + 1
  return month >= 4 ? year : year - 1
}
