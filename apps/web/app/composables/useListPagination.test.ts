import { describe, expect, it } from 'vitest'
import { listHasMore } from './useListPagination'

/**
 * The accountant lists show 「もっと読む」 from `listHasMore`, which replaced the
 * `hasMore` field the pre-contract response carried. Each case pairs a cursor
 * with a row count that would give the opposite answer if the row count were
 * read instead.
 */
describe('listHasMore', () => {
  it('reports a next page when the response carries a cursor', () => {
    expect(listHasMore({ data: [{ id: 'in_1' }, { id: 'in_2' }], nextCursor: 'in_2' })).toBe(true)
  })

  it('reports no next page when the cursor is null although rows were returned', () => {
    expect(listHasMore({ data: [{ id: 'in_1' }, { id: 'in_2' }], nextCursor: null })).toBe(false)
  })

  it('reports a next page when the cursor is set although no rows were returned', () => {
    expect(listHasMore({ data: [], nextCursor: 'in_9' })).toBe(true)
  })

  it('reports no next page for an empty response without a cursor', () => {
    expect(listHasMore({ data: [], nextCursor: null })).toBe(false)
  })
})
