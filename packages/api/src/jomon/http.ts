import { FetchError, ofetch } from 'ofetch'
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
 * Milliseconds one attempt may wait for a Jomon response to start arriving.
 *
 * Passed to ofetch as `timeout`, which aborts a request that has not completed
 * in time; the option is disabled by default (ofetch README, "Timeout"), and
 * before this the drivers set no bound of their own on one request either, so
 * how long a payout run could stall on Jomon was left to the runtime.
 *
 * What this does NOT bound: ofetch clears the timeout in the `finally` of the
 * `fetch` call and reads the response body after that, so the timeout covers
 * only the wait for the response head. Measured against `ofetch@1.5.1`: when the
 * head arrives at once and the body then stalls, the attempt's signal is never
 * aborted and the read does not settle, however long it waits. A Jomon that
 * answers and then stops sending is therefore still bounded by nothing but the
 * runtime, exactly as it was before this change. Bounding that needs a second
 * mechanism around the body and is out of scope here.
 *
 * 10s is a choice, not a measurement: these drivers have never run against live
 * Jomon, so no round-trip figure for it exists. It is meant to sit well clear of
 * a healthy call to a service on the same network while still bounding how long
 * one attempt waits to hear anything back.
 */
export const JOMON_REQUEST_TIMEOUT_MS = 10_000

/**
 * Extra attempts allowed for a READ, passed to ofetch as `retry`.
 *
 * An answered request is retried only when its status is in `retryStatusCodes`,
 * which defaults to 408, 409, 425, 429, 500, 502, 503, 504 (ofetch README, "Auto
 * Retry"). That default is kept: it covers the transient and rate-limit answers,
 * while a wrong token or a wrong path (401/403/404) fails on the first attempt
 * instead of three times. 409 and 425 are in the default too; re-asking on those
 * costs only time, because a read changes nothing on the Jomon side.
 *
 * ofetch's own default is 1 retry for a read. 2 is used so that one more attempt
 * is made, separated by {@link JOMON_RETRY_DELAY_MS}, before the run gives up on
 * the request; what the extra attempt adds to the wait for a response head is
 * bounded by that delay and by {@link JOMON_REQUEST_TIMEOUT_MS}.
 */
export const JOMON_READ_RETRIES = 2

/**
 * Milliseconds between two attempts, passed to ofetch as `retryDelay`.
 *
 * ofetch defaults it to 0 (ofetch README, "Auto Retry"), which re-sends in the
 * same instant the attempt failed, so every attempt of a read lands at once.
 * 500ms spreads them out instead.
 */
export const JOMON_RETRY_DELAY_MS = 500

/**
 * The single ofetch instance the Jomon drivers issue every request through.
 *
 * Behaviour of ofetch that its README does not state, which this instance and
 * the Jomon tests depend on. Read off the published `ofetch@1.5.1` build;
 * re-check it when that version changes.
 *
 * - The Node entry point resolves `globalThis.fetch` on each call rather than
 *   once at import time, so replacing `globalThis.fetch` after this module is
 *   imported is observed. The README only says that `globalThis.fetch` is used
 *   when it is available. The tests replace it to serve canned responses.
 * - ofetch arms `timeout` only when the request carries no `signal`, and it
 *   passes the options of the failed attempt — including the `AbortSignal` it
 *   installed — into the retry. A retried attempt would therefore run under the
 *   first attempt's signal, which by then is either already aborted or has had
 *   its timer cleared and can never fire. Dropping `signal` in `onRequest`,
 *   which ofetch calls at the start of every attempt, makes it arm a fresh
 *   timeout each time. Nothing here passes a caller-supplied `signal`, so there
 *   is none to lose.
 * - An attempt that produced no response at all — a timeout, a refused
 *   connection — is retried too: having no status, it is counted as a 500, which
 *   is in the default `retryStatusCodes`. The README describes `retryStatusCodes`
 *   only for answered requests. The one failure ofetch does NOT retry is an
 *   `AbortError` raised when no `timeout` was set; the abort a `timeout` raises
 *   is named `TimeoutError` instead, so it is retried.
 * - `timeout` bounds only the wait for the response head, not the reading of the
 *   body; see {@link JOMON_REQUEST_TIMEOUT_MS}.
 *
 * With the timeout armed per attempt, one read spends at most
 * `(JOMON_READ_RETRIES + 1) * JOMON_REQUEST_TIMEOUT_MS` plus
 * `JOMON_READ_RETRIES * JOMON_RETRY_DELAY_MS` waiting for response heads. That
 * is NOT an upper bound on the read as a whole: the body is read outside the
 * timeout, so a body that stalls adds time the sum does not count, and nothing
 * here bounds it.
 */
const jomonFetch = ofetch.create({
  timeout: JOMON_REQUEST_TIMEOUT_MS,
  retryDelay: JOMON_RETRY_DELAY_MS,
  onRequest({ options }) {
    delete options.signal
  },
})

/** Render a response body for an error message; an absent body renders empty. */
function describeResponseBody(data: unknown): string {
  if (data === undefined || data === null) {
    return ''
  }
  return typeof data === 'string' ? data : JSON.stringify(data)
}

/**
 * Render why a Jomon request failed.
 *
 * A response that came back is reported as `<status> <body>`, the same shape the
 * drivers reported before they moved to ofetch. A timeout or a connection
 * failure has no response, so its message is reported instead.
 */
function describeRequestFailure(err: unknown): string {
  if (err instanceof FetchError && err.response) {
    return `${String(err.status)} ${describeResponseBody(err.data)}`
  }
  return err instanceof Error ? err.message : String(err)
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

  /**
   * Read from the Jomon API and return the parsed body.
   *
   * Retried up to {@link JOMON_READ_RETRIES} times: asking the same question
   * again changes nothing on the Jomon side.
   *
   * ofetch parses the body, so a response that is not JSON no longer raises a
   * parse error here. It arrives as whatever ofetch's own parsing made of it and
   * is rejected by the STRICT zod schema the caller applies, so a malformed
   * response still fails loudly.
   */
  protected async getJson(path: string): Promise<unknown> {
    return await this.send('GET', path, { retry: JOMON_READ_RETRIES })
  }

  /**
   * Write to the Jomon API. NEVER retried.
   *
   * Whether Jomon treats a repeated write as a no-op is NOT known: these drivers
   * have never run against live Jomon (see the TODO on this class), and the v1
   * write-back marks a payee repaid — exactly the kind of call a second delivery
   * could duplicate. So a write is sent once and the failure is reported to the
   * caller, where `tryWriteBack` (payouts/execute.ts) already turns it into a
   * warning and leaves the write-back for a later run. Confirming against the
   * real Jomon v1 API what a repeated write-back does is what adding a retry
   * here would need first.
   *
   * `retry: 0` is spelled out rather than left to ofetch's default (already 0
   * for PUT/POST/PATCH/DELETE) so that a default set later on the shared ofetch
   * instance cannot switch retries on for writes.
   */
  protected async writeJson(method: string, path: string, body: Record<string, unknown>): Promise<void> {
    await this.send(method, path, { retry: 0, body })
  }

  /** Issue an authenticated request against the Jomon API under `options.retry`. */
  private async send(
    method: string,
    path: string,
    options: { retry: number, body?: Record<string, unknown> },
  ): Promise<unknown> {
    const url = `${this.baseUrl.replace(/\/$/, '')}${path}`
    try {
      return await jomonFetch<unknown>(url, {
        method,
        retry: options.retry,
        headers: {
          // Forward-looking: live Jomon has no Bearer receiver yet (design D6).
          authorization: `Bearer ${this.token}`,
        },
        // ofetch serializes an object body and sets `content-type:
        // application/json` for a PUT itself (README, "JSON Body").
        ...(options.body !== undefined ? { body: options.body } : {}),
      })
    }
    catch (err) {
      throw new Error(`Jomon ${method} ${path} failed: ${describeRequestFailure(err)}`, { cause: err })
    }
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
  // NOTE: v1 has NO per-payee amount on a repayment log — the amount lives on the
  // application (`current_detail.amount`). `repaid_at` present ⇒ already repaid.
  repaid_at: z.string().nullish(),
})

const v1DetailedApplicationSchema = z.object({
  application_id: z.string().trim().min(1),
  // v1 holds the refund amount at the application level only (no per-payee split).
  current_detail: z.object({ amount: z.number().int().positive() }),
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

        // 3. v1 has only an application-level amount (`current_detail.amount`),
        //    with NO per-payee split. So the decision is by the TOTAL number of
        //    payees on the application, NOT how many are still unpaid:
        //      - all payees already repaid → nothing to do.
        //      - exactly ONE payee on the application → its amount IS the
        //        application amount; emit a normal request (if unpaid).
        //      - MORE THAN ONE payee → `current_detail.amount` is the application
        //        total and cannot be attributed to a single person, so it must
        //        NOT be auto-paid even when only one remains unpaid (paying the
        //        full total to the remainder would overpay). Emit a `multiPayee`
        //        marker → orchestration flags needs-review, UI alerts (no transfer).
        //    (payout-execution: §v1 の払い戻し金額と複数受取人の扱い)
        const amount = detail.data.current_detail.amount
        const logs = detail.data.repayment_logs
        const unpaid = logs.filter(log => !log.repaid_at)
        if (unpaid.length === 0) {
          // Every payee already repaid — nothing to pay (single or multi).
        }
        else if (logs.length > 1) {
          // Multiple payees on one application → no reliable per-payee amount.
          // Marker built directly because `toTransferRequest` requires a non-empty
          // payeeTraqId, which a multi-payee application has none single.
          out.push({ jomonRef: appId, payeeTraqId: '', amount, currency: JOMON_CURRENCY, multiPayee: true })
        }
        else {
          // Exactly one payee on the application (unpaid) → amount = application amount.
          // `unpaid` is non-empty and `logs` has at most one entry here, so this is
          // that entry; the guard exists only because the index type is optional.
          const log = logs[0]
          if (!log) {
            throw new Error(`Jomon v1 application ${appId}: repayment_logs is empty despite an unpaid payee`)
          }
          const trapId = log.repaid_to_user.trap_id
          out.push(toTransferRequest({
            jomonRef: `${appId}:${trapId}`,
            payeeTraqId: trapId,
            amount,
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
    await this.writeJson(
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
  writeBackResult(_jomonRef: string, _result: JomonWriteBackResult): Promise<void> {
    return Promise.reject(new JomonWriteBackUnsupportedError(
      'Jomon v2 has no per-payee write-back API (paid_at is read-only); '
      + 'awaiting a Jomon v2 addition (design D3).',
    ))
  }
}
