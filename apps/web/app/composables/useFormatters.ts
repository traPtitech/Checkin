/**
 * Display formatters shared by the accountant pages (`/payments`, `/payouts`).
 * Auto-imported by Nuxt from `app/composables`. Both helpers guard against
 * null/invalid inputs so a missing Stripe field never crashes a table render.
 */
export function useFormatters() {
  /**
   * Format a minor-unit amount with its currency (JPY has no fractional part,
   * so `Intl.NumberFormat` with `currency: 'JPY'` renders e.g. `￥2,000`).
   * Returns `—` when the amount or currency is missing/invalid.
   */
  function formatAmount(amount: number | null | undefined, currency: string | null | undefined): string {
    if (typeof amount !== 'number' || !Number.isFinite(amount) || !currency) {
      return '—'
    }
    try {
      return new Intl.NumberFormat('ja-JP', {
        style: 'currency',
        currency: currency.toUpperCase(),
      }).format(amount)
    }
    catch {
      // Unknown currency code: fall back to a plain number + raw code.
      return `${amount} ${currency.toUpperCase()}`
    }
  }

  /**
   * Format an ISO date string (or `Date`) for display. Returns `—` for
   * missing/unparseable input.
   */
  function formatDateTime(value: string | Date | null | undefined): string {
    if (!value) {
      return '—'
    }
    const date = value instanceof Date ? value : new Date(value)
    if (Number.isNaN(date.getTime())) {
      return '—'
    }
    return new Intl.DateTimeFormat('ja-JP', {
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(date)
  }

  return { formatAmount, formatDateTime }
}
