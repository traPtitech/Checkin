import type { JomonClient, JomonTransferRequest, JomonWriteBackResult } from './types'

/** A recorded write-back, kept in memory for dev visibility and tests. */
export interface StubWriteBack {
  jomonRef: string
  result: JomonWriteBackResult
}

/**
 * In-memory Jomon driver for dev and tests (functionally complete, no network).
 *
 * Approved requests are served from a seeded in-memory list; `writeBackResult`
 * appends to an in-memory log (and removes the request from the approved list,
 * mirroring Jomon "settling" it so a re-pull doesn't return it again). This lets
 * the whole payout machine run end-to-end without live Jomon. (design D1)
 */
export class StubJomonClient implements JomonClient {
  private approved: JomonTransferRequest[]
  /** Append-only log of write-backs, exposed for assertions/dev inspection. */
  readonly writeBacks: StubWriteBack[] = []

  constructor(seed: JomonTransferRequest[] = []) {
    // Copy so callers' arrays aren't mutated under them.
    this.approved = [...seed]
  }

  async listApprovedTransferRequests(): Promise<JomonTransferRequest[]> {
    // Return a copy — callers must not mutate our internal list.
    return [...this.approved]
  }

  async writeBackResult(jomonRef: string, result: JomonWriteBackResult): Promise<void> {
    this.writeBacks.push({ jomonRef, result })
    // Once written back, drop it from "approved" so a subsequent pull is clean.
    this.approved = this.approved.filter(r => r.jomonRef !== jomonRef)
  }
}
