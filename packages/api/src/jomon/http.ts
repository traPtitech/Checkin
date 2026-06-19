import { z } from 'zod'
import type { JomonClient, JomonTransferRequest, JomonWriteBackResult } from './types'

/**
 * Strict zod schema for ONE raw Jomon transfer request (fail-safe parsing).
 *
 * We REQUIRE every field that a payout depends on and THROW on anything missing,
 * empty, zero, negative, or the wrong shape — rather than silently defaulting.
 * A wrong field mapping (e.g. the payee identifier under an unexpected key) must
 * fail loudly here so it can never quietly pay the wrong person or a zero amount.
 *
 * TODO: confirm exact v1/v2 field names against live Jomon (design §9). The
 * accepted aliases below are best-effort guesses; the payee identifier in
 * particular (isct email vs traQ id vs internal id) is unconfirmed. When the
 * live schema is known, pin these to the real keys (drop the aliases).
 */
const rawTransferRequestSchema = z
  .object({
    // jomonRef: the opaque source/idempotency key. Required, non-empty.
    jomonRef: z.string().trim().min(1).optional(),
    id: z.union([z.string(), z.number()]).optional(),
    // payee identifier: required, non-empty.
    payeeEmail: z.string().trim().min(1).optional(),
    email: z.string().trim().min(1).optional(),
    // amount: required, positive integer (smallest currency unit).
    amount: z.number().int().positive(),
    // currency: required, non-empty ISO code.
    currency: z.string().trim().min(1),
  })
  .transform((obj, ctx): JomonTransferRequest => {
    const jomonRef = obj.jomonRef ?? (obj.id !== undefined ? String(obj.id).trim() : '')
    if (!jomonRef) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'missing jomonRef/id' })
      return z.NEVER
    }
    const payeeEmail = obj.payeeEmail ?? obj.email ?? ''
    if (!payeeEmail) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'missing payee identifier (payeeEmail/email)' })
      return z.NEVER
    }
    return { jomonRef, payeeEmail, amount: obj.amount, currency: obj.currency }
  })

/** A list response: a bare array or `{ data: [...] }`, of raw transfer requests. */
const listResponseSchema = z.union([
  z.array(z.unknown()),
  z.object({ data: z.array(z.unknown()) }).transform(o => o.data),
])

/**
 * Shared HTTP plumbing for the live Jomon drivers (`v1` / `v2`).
 *
 * Auth is a one-way Bearer service token (`JOMON_API_TOKEN`); the base URL is
 * `JOMON_API_BASE_URL`. The exact Jomon request/response schemas are NOT yet
 * confirmed, so this class implements the transport and JSON plumbing and maps
 * to/from {@link JomonTransferRequest} with STRICT zod validation that throws on
 * any missing/invalid/unknown-shape field (never silently defaults).
 *
 * The v1/v2 difference is currently only the endpoint paths; field mapping is
 * shared until the live schemas diverge. (design §9 — verify against live Jomon,
 * requires Jomon coordination.)
 */
export abstract class JomonHttpClient implements JomonClient {
  constructor(
    protected readonly baseUrl: string,
    protected readonly token: string,
  ) {
    if (!baseUrl) {
      throw new Error('JOMON_API_BASE_URL is not set; refusing to call Jomon')
    }
    if (!token) {
      throw new Error('JOMON_API_TOKEN is not set; refusing to call Jomon')
    }
  }

  /** Path of the "list approved transfer requests" endpoint (version-specific). */
  protected abstract listPath(): string

  /** Path of the "write back result" endpoint for a given ref (version-specific). */
  protected abstract writeBackPath(jomonRef: string): string

  async listApprovedTransferRequests(): Promise<JomonTransferRequest[]> {
    const res = await this.request('GET', this.listPath())
    const body = (await res.json()) as unknown
    // TODO: verify field names/paths against live Jomon v1/v2 (design §9).
    // Strict, fail-safe parsing: an unexpected envelope shape throws here rather
    // than silently yielding an empty list (which would skip real payouts).
    const parsedList = listResponseSchema.safeParse(body)
    if (!parsedList.success) {
      throw new Error(
        `Jomon ${this.listPath()} returned an unexpected response shape: ${parsedList.error.message}`,
      )
    }
    return parsedList.data.map(item => this.toTransferRequest(item))
  }

  async writeBackResult(jomonRef: string, result: JomonWriteBackResult): Promise<void> {
    // TODO: verify the write-back path, method, and payload shape against live
    // Jomon v1/v2 (design §9). Best-effort: POST the settled result as JSON.
    await this.request('POST', this.writeBackPath(jomonRef), {
      status: result.status,
      stripe_transfer_id: result.stripeTransferId,
      message: result.message,
    })
  }

  /**
   * Map a raw Jomon item to the Jomon-type-free DTO via STRICT zod parsing.
   *
   * THROWS on any missing/invalid field (empty payee, missing ref, non-positive
   * amount, missing currency, wrong shape) so a wrong-field mapping fails loudly
   * instead of silently paying the wrong person or a zero amount.
   *
   * TODO: confirm exact v1/v2 field names against live Jomon (design §9).
   */
  protected toTransferRequest(raw: unknown): JomonTransferRequest {
    const parsed = rawTransferRequestSchema.safeParse(raw)
    if (!parsed.success) {
      throw new Error(`Jomon transfer request failed validation: ${parsed.error.message}`)
    }
    return parsed.data
  }

  /** Issue an authenticated JSON request against the Jomon API. */
  private async request(method: string, path: string, body?: unknown): Promise<Response> {
    const url = `${this.baseUrl.replace(/\/$/, '')}${path}`
    const res = await fetch(url, {
      method,
      headers: {
        authorization: `Bearer ${this.token}`,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    })
    if (!res.ok) {
      throw new Error(`Jomon ${method} ${path} failed: ${res.status} ${await res.text()}`)
    }
    return res
  }
}

/** Live Jomon v1 driver. Endpoint paths are best-effort (design §9). */
export class JomonV1Client extends JomonHttpClient {
  // TODO: verify v1 endpoint paths against live Jomon (design §9).
  protected listPath(): string {
    return '/api/v1/transfer-requests?status=approved'
  }

  protected writeBackPath(jomonRef: string): string {
    return `/api/v1/transfer-requests/${encodeURIComponent(jomonRef)}/result`
  }
}

/** Live Jomon v2 driver. Endpoint paths are best-effort (design §9). */
export class JomonV2Client extends JomonHttpClient {
  // TODO: verify v2 endpoint paths against live Jomon (design §9).
  protected listPath(): string {
    return '/api/v2/transfer-requests?status=approved'
  }

  protected writeBackPath(jomonRef: string): string {
    return `/api/v2/transfer-requests/${encodeURIComponent(jomonRef)}/result`
  }
}
