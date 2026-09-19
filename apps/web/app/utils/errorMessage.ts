import { ORPCError } from '@orpc/client'
import type { CommonORPCErrorCode, ORPCErrorCode } from '@orpc/client'

/**
 * The message shown for one oRPC error code. A function is used where the page
 * shows the message the API itself produced (`/special-invoice` on CONFLICT).
 */
type CodeMessage = string | ((error: ORPCError<ORPCErrorCode, unknown>) => string)

/**
 * What one page shows for each kind of failure. Only this structure is shared:
 * the pages name different operations (発行 / 一覧の取得 / 操作) and address
 * different readers, so the messages live in `pageErrorMessages.ts`.
 */
export interface ErrorMessageSpec {
  /**
   * Consulted first, keyed by `ORPCError.code`. The keys are `CommonORPCErrorCode`
   * so that a mistyped code fails the type check instead of silently never
   * matching; `ORPCErrorCode` cannot do that, because it widens to `string`. The
   * cost is that a code outside oRPC's own set cannot be given a message here.
   */
  byCode: Partial<Record<CommonORPCErrorCode, CodeMessage>>
  /** An `ORPCError` whose code `byCode` does not cover. */
  orpcFallback: string
  /** A caught value that is not an `ORPCError` (network/runtime failure). */
  otherFallback: string
}

/**
 * Narrowing an `unknown` with `instanceof ORPCError` lands on
 * `ORPCError<any, any>`, which this repo's no-unsafe-* rules reject. This guard
 * performs the same runtime check and states the widest sound instantiation.
 */
function isORPCError(error: unknown): error is ORPCError<ORPCErrorCode, unknown> {
  return error instanceof ORPCError
}

/**
 * Build the `errorMessageFor` a page applies to a value it caught from `$orpc`.
 * Auto-imported by Nuxt from `app/utils`.
 */
export function createErrorMessageFor(spec: ErrorMessageSpec): (error: unknown) => string {
  // `error.code` is the wider `ORPCErrorCode`, so the lookup reads the table
  // through a string key. A code with no entry yields `undefined` either way.
  const byCode: Partial<Record<string, CodeMessage>> = spec.byCode
  return (error) => {
    if (!isORPCError(error)) {
      return spec.otherFallback
    }
    const message = byCode[error.code]
    if (message === undefined) {
      return spec.orpcFallback
    }
    return typeof message === 'function' ? message(error) : message
  }
}
