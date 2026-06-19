/** Smallest page size accepted by Stripe list endpoints. */
const MIN_LIMIT = 1
/** Largest page size accepted by Stripe list endpoints. */
const MAX_LIMIT = 100
/** Default page size when the caller omits `limit`. */
const DEFAULT_LIMIT = 20

/**
 * Clamp a requested page size to Stripe's 1..100 range, defaulting to 20 when
 * unset (design D3). Non-integers are floored so we never send a fractional
 * `limit` to Stripe.
 */
export function clampLimit(limit?: number): number {
  if (limit === undefined) {
    return DEFAULT_LIMIT
  }
  const floored = Math.floor(limit)
  return Math.min(MAX_LIMIT, Math.max(MIN_LIMIT, floored))
}

/**
 * Compute the next cursor for cursor pagination (design D3): when Stripe reports
 * more rows, the last row's id is the `starting_after` for the next page;
 * otherwise there is no next page.
 */
export function nextCursor(items: { id: string }[], hasMore: boolean): string | null {
  if (!hasMore) {
    return null
  }
  return items.at(-1)?.id ?? null
}
