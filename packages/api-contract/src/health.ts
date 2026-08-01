import { oc } from '@orpc/contract'
import { z } from 'zod'

export const healthContract = {
  check: oc.output(z.object({ ok: z.boolean(), timestamp: z.string() })),
}
