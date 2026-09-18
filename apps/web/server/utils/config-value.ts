/**
 * Parse a `runtimeConfig` entry as a positive number, falling back when it is
 * not one. Nuxt types those entries as `string`, so the value is parsed as-is.
 *
 * Callers import this explicitly instead of relying on the Nitro auto-import of
 * `server/utils`, because Vitest loads them directly and has no auto-imports.
 */
export function positiveNumberOr(value: string, fallback: number): number {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : fallback
}
