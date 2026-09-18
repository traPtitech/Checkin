import { oc } from '@orpc/contract'
import { z } from 'zod'
import { listEnvelope } from './params'

/** 払い戻しの状態機械の状態。自前の値なので enum で狭める。 */
const payoutStatus = z.enum(['pending', 'onboarding_waiting', 'processing', 'paid', 'failed'])

/** onboarding の状態機械の状態。自前の値なので enum で狭める。 */
const payoutOnboardingStatus = z.enum(['none', 'requested', 'done'])

/**
 * 払い戻し 1 件の公開 View。出力 allowlist の方針は project.md 参照。
 *
 * 時刻は ISO 8601 の文字列で公開する。ドメイン層の行は jomonWrittenBackAt と manualPaidAt を
 * Date で持つが、そのまま写すと同じ契約の中で時刻の表現が 2 種類(数値の epoch・Date・文字列)に
 * なるので、文字列に揃える。
 */
const payoutView = z.object({
  id: z.string(),
  // Jomon の申請への参照。取り込みの冪等キーであり、単件操作の指定子でもある。
  jomonRef: z.string(),
  // 受取人として解決できた users.id。解決できていなければ null。
  userId: z.string().nullable(),
  amount: z.number(),
  currency: z.string(),
  status: payoutStatus,
  stripeTransferId: z.string().nullable(),
  // 確定した結果を Jomon に書き戻した時刻。未書き戻しなら null。
  jomonWrittenBackAt: z.iso.datetime().nullable(),
  // 決済の手段。Stripe Connect の送金か、手動の銀行振込か。
  payoutMethod: z.enum(['stripe_connect', 'manual_bank']),
  // 手動振込の参照メモ。Stripe 送金では null。
  manualPaidNote: z.string().nullable(),
  // 手動振込を paid として確定した時刻。Stripe 送金では null。
  manualPaidAt: z.iso.datetime().nullable(),
  // 手動振込を記録した会計担当者(users.id)。解決できなければ null。
  manualPaidBy: z.string().nullable(),
})

export type PayoutView = z.infer<typeof payoutView>

/**
 * 単件の払い戻し操作の結果の公開 View。
 *
 * outcome はこの操作が何をしたか、status は操作後に永続化された状態である。2 つを両方載せるのは、
 * 会計担当者が次に何をすべきかが outcome でしか区別できないためである(paid と already_paid、
 * needs_review と skipped_failed は status からは区別できない)。
 */
const payoutStepView = z.object({
  jomonRef: z.string(),
  outcome: z.enum([
    'unresolved',
    'onboarding_waiting',
    'paid',
    'failed',
    'already_paid',
    'needs_review',
    'skipped_failed',
  ]),
  status: payoutStatus,
  // onboarding 待ちになったときだけ付く、ホスト型 onboarding の URL。
  onboardingUrl: z.string().optional(),
})

/**
 * processApproved の実行結果の要約。
 *
 * 9 個のカウントと 2 つの参照の配列だけを公開する。ドメイン層の要約型はこれに加えて
 * listError(Jomon の一覧取得そのものが失敗したときの理由の文字列)を持つが、契約には載せない。
 * Jomon の一覧・HTTP・zod の失敗の内容が公開契約を通って外に出る経路を閉じるためである。
 * 運用中の原因調査はサーバーのログで行う。
 *
 * errors に入るのは、例外で隔離された項目の jomon_ref であって例外の内容ではない。
 */
const processApprovedView = z.object({
  // この実行で取り込んだ承認済み申請の総数。
  ingested: z.number(),
  paid: z.number(),
  onboardingWaiting: z.number(),
  // 受取人を特定できなかった件数(要対応)。
  unresolved: z.number(),
  failed: z.number(),
  // 既に paid で短絡した件数。
  alreadyPaid: z.number(),
  // 手当てが要ると判定した件数(userId の対応が誤っている、他の実行が確保済み等)。
  needsReview: z.number(),
  // failed の行を自動再試行せずに飛ばした件数。
  skippedFailed: z.number(),
  // 例外を投げて隔離された件数。1 件の失敗が実行全体を止めないようにしている。
  errored: z.number(),
  errors: z.array(z.string()),
  // 受取人が 2 人以上いて自動送金しなかった申請の id。needsReview にも数える。
  multiPayeeRefs: z.array(z.string()),
})

export const payoutsContract = {
  // 受取人の Connect アカウントのホスト型 onboarding リンクを発行する。会計担当者のみ。
  createOnboardingLink: oc
    .input(z.object({ userId: z.string().min(1) }))
    .output(z.object({ url: z.string() })),

  // 受取人の onboarding の状態を返す。会計担当者のみ。
  onboardingStatus: oc
    .input(z.object({ userId: z.string().min(1) }))
    .output(
      z.object({
        status: payoutOnboardingStatus,
        hasConnectedAccount: z.boolean(),
      }),
    ),

  // Jomon の承認済み送金申請を取り込み、1 件ずつ 1 段階進める。会計担当者のみ。
  processApproved: oc.output(processApprovedView),

  // 払い戻しの一覧。status は入力フィルタなので enum で狭める。
  //
  // 現在はページネーションを持たないので nextCursor は常に null だが、一覧の形は
  // listEnvelope に揃える。後でページネーションを足すときに入力へ pagination を足すだけで済み、
  // 出力の契約と消費者は変わらない。
  list: oc
    .input(z.object({ status: payoutStatus.optional() }))
    .output(listEnvelope(payoutView)),

  // 単件の払い戻しを進める・再試行する。会計担当者のみ。
  execute: oc
    .input(z.object({ jomonRef: z.string().min(1) }))
    .output(payoutStepView),

  // 手動の銀行振込を paid として記録する。Stripe の送金は行わない。会計担当者のみ。
  markManuallyPaid: oc
    .input(
      z.object({
        jomonRef: z.string().min(1),
        note: z.string().max(255).optional(),
      }),
    )
    .output(payoutStepView),
}
