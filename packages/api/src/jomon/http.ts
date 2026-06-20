import { z } from 'zod'
import type { JomonClient, JomonTransferRequest, JomonWriteBackResult } from './types'

/**
 * Error thrown when a Jomon driver cannot write a settled result back.
 *
 * v2 has NO per-payee write-back API (`paid_at` is read-only), so its
 * `writeBackResult` throws this. The orchestration catches it, logs a warning,
 * KEEPS the local payout `paid`, and leaves `jomon_written_back_at` NULL so the
 * write-back is retried once Jomon v2 adds the endpoint — without re-transferring.
 * (design D3; spec §v2 の書き戻しは未対応として扱う)
 */
export class JomonWriteBackUnsupportedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'JomonWriteBackUnsupportedError'
  }
}

/** Currency Jomon never carries — hardcoded since amounts are always whole yen. */
const JOMON_CURRENCY = 'jpy'

/**
 * STRICT, fail-safe assembly of one normalized {@link JomonTransferRequest}.
 *
 * We REQUIRE every payout-critical field and THROW on anything empty, zero,
 * negative, or the wrong shape — never silently defaulting. A wrong field mapping
 * (e.g. the payee under an unexpected key) MUST fail loudly here so it can never
 * quietly pay the wrong person or a zero amount. (design D4)
 *
 * `jomonRef`/`payeeTraqId` non-empty, `amount` a positive integer; currency is
 * fixed to 'jpy' by the driver, not parsed.
 */
const transferRequestSchema = z.object({
  jomonRef: z.string().trim().min(1, 'missing jomonRef'),
  payeeTraqId: z.string().trim().min(1, 'missing payeeTraqId'),
  amount: z.number().int().positive('amount must be a positive integer'),
})

function toTransferRequest(parts: {
  jomonRef: string
  payeeTraqId: string
  amount: number
}): JomonTransferRequest {
  const parsed = transferRequestSchema.safeParse(parts)
  if (!parsed.success) {
    throw new Error(`Jomon transfer request failed validation: ${parsed.error.message}`)
  }
  return { ...parsed.data, currency: JOMON_CURRENCY }
}

/** Unwrap a list response: a bare array or a `{ data: [...] }` envelope. */
const listEnvelopeSchema = z.union([
  z.array(z.unknown()),
  z.object({ data: z.array(z.unknown()) }).transform(o => o.data),
])

function unwrapList(path: string, body: unknown): unknown[] {
  const parsed = listEnvelopeSchema.safeParse(body)
  if (!parsed.success) {
    throw new Error(`Jomon ${path} returned an unexpected response shape: ${parsed.error.message}`)
  }
  return parsed.data
}

/**
 * Shared HTTP plumbing for the live Jomon drivers (`v1` / `v2`).
 *
 * Auth is a one-way Bearer service token (`JOMON_API_TOKEN`) against
 * `JOMON_API_BASE_URL`. NOTE: live Jomon currently has only traQ OAuth/cookie
 * auth and NO Bearer receiver, so this header is forward-looking — a real
 * connection requires a Jomon-side addition (design D6). The transport plus
 * STRICT zod validation are shared; the v1/v2 list/normalize/write-back shapes
 * diverge in the subclasses.
 *
 * TODO: confirm field names/paths against live Jomon v1/v2 (design §9).
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

  abstract listApprovedTransferRequests(): Promise<JomonTransferRequest[]>
  abstract writeBackResult(jomonRef: string, result: JomonWriteBackResult): Promise<void>

  /** Issue an authenticated request against the Jomon API and return parsed JSON. */
  protected async getJson(path: string): Promise<unknown> {
    const res = await this.request('GET', path)
    return res.json() as unknown
  }

  /** Issue an authenticated JSON request against the Jomon API. */
  protected async request(method: string, path: string, body?: unknown): Promise<Response> {
    const url = `${this.baseUrl.replace(/\/$/, '')}${path}`
    const res = await fetch(url, {
      method,
      headers: {
        // Forward-looking: live Jomon has no Bearer receiver yet (design D6).
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

// --- v1 -------------------------------------------------------------------

/**
 * Strict v1 schemas. The list (`CompactApplication`) lacks per-payee data, so
 * each application is re-fetched as `DetailedApplication` for its
 * `repayment_logs[]`. `repaid_at` present ⇒ already repaid ⇒ skip.
 *
 * TODO: confirm field names/paths against live Jomon v1 (design §9).
 */
const v1CompactApplicationSchema = z.object({
  // CompactApplication.application_id — used only to fetch the detailed record.
  application_id: z.string().trim().min(1),
})

const v1RepaymentLogSchema = z.object({
  repaid_to_user: z.object({ trap_id: z.string().trim().min(1) }),
  amount: z.number().int().positive(),
  repaid_at: z.string().nullish(),
})

const v1DetailedApplicationSchema = z.object({
  application_id: z.string().trim().min(1),
  repayment_logs: z.array(v1RepaymentLogSchema),
})

/** Live Jomon v1 driver. (design D2 — confirm against live Jomon, §9.) */
export class JomonV1Client extends JomonHttpClient {
  async listApprovedTransferRequests(): Promise<JomonTransferRequest[]> {
    // 1. List accepted applications (compact, no per-payee data).
    const listPath = '/api/applications?current_state=accepted'
    const rawList = unwrapList(listPath, await this.getJson(listPath))

    const out: JomonTransferRequest[] = []
    for (const rawCompact of rawList) {
      const compact = v1CompactApplicationSchema.safeParse(rawCompact)
      if (!compact.success) {
        throw new Error(`Jomon v1 application list failed validation: ${compact.error.message}`)
      }
      const appId = compact.data.application_id

      // Per-application isolation: one bad detail fetch/parse must NOT abort
      // pulling the rest. On error, warn with the applicationId and SKIP this
      // application, continuing with the others — a skipped app moves no money,
      // it just isn't processed this run. The zod schema stays STRICT within an
      // application: a malformed app becomes a logged skip, never a silent wrong
      // payment. (Codex hardening: §batch-abort, per-application level)
      try {
        // 2. Fetch the detailed application for its repayment_logs[].
        const detailPath = `/api/applications/${encodeURIComponent(appId)}`
        const detail = v1DetailedApplicationSchema.safeParse(await this.getJson(detailPath))
        if (!detail.success) {
          throw new Error(`Jomon v1 application ${appId} failed validation: ${detail.error.message}`)
        }

        // 3. One DTO per still-unpaid (no repaid_at) repayment log.
        for (const log of detail.data.repayment_logs) {
          if (log.repaid_at) {
            continue
          }
          const trapId = log.repaid_to_user.trap_id
          out.push(toTransferRequest({
            jomonRef: `${appId}:${trapId}`,
            payeeTraqId: trapId,
            amount: log.amount,
          }))
        }
      }
      catch (err) {
        const reason = err instanceof Error ? err.message : String(err)
        console.warn(`[jomon] v1 skipping application ${appId}; detail fetch/parse failed: ${reason}`)
        continue
      }
    }
    return out
  }

  /**
   * v1 write-back: mark a payee repaid on its application.
   * `PUT /api/applications/{applicationId}/states/repaid/{trapId}` `{ repaid_at }`.
   * The `applicationId`/`trapId` are recovered from `jomonRef` (`${appId}:${trapId}`).
   * Only a `paid` result is written back (a `failed` result has nothing to mark).
   *
   * TODO: confirm path/body against live Jomon v1 (design §9).
   */
  async writeBackResult(jomonRef: string, result: JomonWriteBackResult): Promise<void> {
    if (result.status !== 'paid') {
      // Nothing to mark repaid on a failed payout; v1 has no "failed" state to set.
      return
    }
    const sep = jomonRef.indexOf(':')
    if (sep <= 0 || sep >= jomonRef.length - 1) {
      throw new Error(`Jomon v1 jomonRef is not '\${appId}:\${trapId}': ${jomonRef}`)
    }
    const appId = jomonRef.slice(0, sep)
    const trapId = jomonRef.slice(sep + 1)
    const repaidAt = new Date().toISOString().slice(0, 10) // YYYY-MM-DD
    await this.request(
      'PUT',
      `/api/applications/${encodeURIComponent(appId)}/states/repaid/${encodeURIComponent(trapId)}`,
      { repaid_at: repaidAt },
    )
  }
}

// --- v2 -------------------------------------------------------------------

/**
 * Strict v2 schemas. Approved applications carry `targets` (`ApplicationTarget`);
 * `paid_at` present ⇒ already paid ⇒ skip. `target` is a User UUID resolved to a
 * traQ username via `GET /api/users`.
 *
 * TODO: confirm field names/paths against live Jomon v2 (design §9).
 */
const v2ApplicationTargetSchema = z.object({
  id: z.string().trim().min(1),
  target: z.string().trim().min(1),
  amount: z.number().int().positive(),
  paid_at: z.string().nullish(),
})

const v2ApplicationSchema = z.object({
  targets: z.array(v2ApplicationTargetSchema),
})

const v2UserSchema = z.object({
  id: z.string().trim().min(1),
  name: z.string().trim().min(1),
})

/** Live Jomon v2 driver. (design D3 — confirm against live Jomon, §9.) */
export class JomonV2Client extends JomonHttpClient {
  async listApprovedTransferRequests(): Promise<JomonTransferRequest[]> {
    // 1. Build a uuid -> traQ username map from the users directory.
    const usersPath = '/api/users'
    const rawUsers = unwrapList(usersPath, await this.getJson(usersPath))
    const uuidToName = new Map<string, string>()
    for (const rawUser of rawUsers) {
      const user = v2UserSchema.safeParse(rawUser)
      if (!user.success) {
        throw new Error(`Jomon v2 user failed validation: ${user.error.message}`)
      }
      uuidToName.set(user.data.id, user.data.name)
    }

    // 2. List approved applications and normalize each unpaid target.
    const listPath = '/api/applications?status=approved'
    const rawList = unwrapList(listPath, await this.getJson(listPath))

    const out: JomonTransferRequest[] = []
    for (const rawApp of rawList) {
      const app = v2ApplicationSchema.safeParse(rawApp)
      if (!app.success) {
        throw new Error(`Jomon v2 application failed validation: ${app.error.message}`)
      }
      for (const target of app.data.targets) {
        if (target.paid_at) {
          continue
        }
        const traqId = uuidToName.get(target.target)
        if (!traqId) {
          throw new Error(`Jomon v2 target ${target.id} references unknown user uuid: ${target.target}`)
        }
        out.push(toTransferRequest({
          jomonRef: target.id,
          payeeTraqId: traqId,
          amount: target.amount,
        }))
      }
    }
    return out
  }

  /**
   * v2 has NO per-payee write-back API (`paid_at` is read-only), so this is
   * UNSUPPORTED and throws {@link JomonWriteBackUnsupportedError}. The
   * orchestration catches it, keeps the payout `paid`, and leaves
   * `jomon_written_back_at` NULL for retry once Jomon v2 adds the endpoint.
   * (design D3)
   */
  async writeBackResult(_jomonRef: string, _result: JomonWriteBackResult): Promise<void> {
    throw new JomonWriteBackUnsupportedError(
      'Jomon v2 has no per-payee write-back API (paid_at is read-only); '
      + 'awaiting a Jomon v2 addition (design D3).',
    )
  }
}
