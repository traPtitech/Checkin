import { oc } from '@orpc/contract'
import { z } from 'zod'

/**
 * 発行した請求書の公開 View。3 つの発行プロシージャで同じ形に固定する。
 *
 * この 2 フィールドだけに固定するのは、消費者がこの 2 つしか読まないためである
 * (membership.vue が hostedInvoiceUrl を、special-invoice.vue が hostedInvoiceUrl と
 * invoiceId を読む)。hostedInvoiceUrl は Stripe が請求書を確定した後に付く値で、
 * 確定直後に取得できないことがあるので null を取る。
 */
const issuedInvoiceView = z.object({
  invoiceId: z.string(),
  hostedInvoiceUrl: z.string().nullable(),
})

export const membershipContract = {
  // 本人の標準の会費請求書を発行する。email は本人のものに限る(サーバーが mail_hash で照合)。
  // feeType は入力フィルタなので enum で狭める。
  issueInvoice: oc
    .input(
      z.object({
        email: z.email(),
        name: z.string().min(1),
        feeType: z.enum(['new', 'continuation']),
      }),
    )
    .output(issuedInvoiceView),

  // 継続特別の請求書を userId で対象者を指定して発行する。会計担当者のみ。
  // coverage は前期・後期のどちらか 1 半期で、通期は特別の選択肢にない。
  issueSpecialInvoice: oc
    .input(
      z.object({
        userId: z.string().min(1),
        name: z.string().min(1).optional(),
        email: z.email().optional(),
        coverage: z.enum(['zenki', 'kouki']),
        // 充当する年度。省略時は現在の年度。後期に集める継続特別では翌年度を渡す。
        activityYear: z.number().int().optional(),
      }),
    )
    .output(issuedInvoiceView),

  // 継続特別の請求書をメールアドレスで対象者を指定して発行する。会計担当者のみ。
  // メールアドレスが対象者の指定そのものなので、未登録の相手にもその場で発行できる。
  issueSpecialInvoiceByEmail: oc
    .input(
      z.object({
        email: z.email(),
        name: z.string().min(1).optional(),
        coverage: z.enum(['zenki', 'kouki']),
        activityYear: z.number().int().optional(),
      }),
    )
    .output(issuedInvoiceView),
}
