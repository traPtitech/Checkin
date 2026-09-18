/**
 * Cursor-pagination helper for the contract's list envelope
 * (`packages/api-contract/src/params.ts` `listEnvelope`: `{ data, nextCursor }`).
 * Auto-imported by Nuxt from `app/composables`.
 */

/**
 * Whether a list response has a next page — i.e. whether the page should offer
 * its 「もっと読む」 action.
 *
 * The envelope carries no `hasMore` field, so `nextCursor` alone reports the
 * next page: the server returns the last row's id when there is more and null
 * when there is not (`packages/api/src/payments/pagination.ts`). The row count
 * must not stand in for it: that helper returns null whenever the upstream list
 * reports no further rows, whatever the page's length, and it also returns null
 * when the upstream reports further rows but sends none — the single state this
 * envelope cannot express.
 *
 * Takes the whole envelope rather than the cursor alone, so callers pass the
 * response through unchanged and the decision stays in this one place.
 */
export function listHasMore(page: { data: readonly unknown[], nextCursor: string | null }): boolean {
  return page.nextCursor !== null
}
