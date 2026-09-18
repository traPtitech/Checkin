import { describe, expect, it } from 'vitest'
import { useFormatters } from './useFormatters'

const { formatDateTime } = useFormatters()

/**
 * The payout contract publishes `jomonWrittenBackAt` and `manualPaidAt` as ISO
 * 8601 strings (`z.iso.datetime()`), where the page previously received `Date`
 * objects. These cases fix the rendering to the instant, not to the input's
 * type, so the switch leaves the displayed text unchanged.
 *
 * The expected text is built with the same locale and options rather than
 * written out, because the rendering resolves the ambient time zone and a
 * literal would only hold in the zone it was written in.
 */
describe('formatDateTime', () => {
  const iso = '2026-06-21T03:04:05.000Z'
  const instant = new Date(iso)
  const expected = new Intl.DateTimeFormat('ja-JP', { dateStyle: 'medium', timeStyle: 'short' }).format(instant)

  it('renders an ISO 8601 string as the instant it denotes', () => {
    expect(formatDateTime(iso)).toBe(expected)
  })

  it('renders an ISO 8601 string exactly as it rendered the Date it replaces', () => {
    expect(formatDateTime(iso)).toBe(formatDateTime(instant))
  })

  it('renders a null timestamp as the placeholder', () => {
    expect(formatDateTime(null)).toBe('—')
  })
})
