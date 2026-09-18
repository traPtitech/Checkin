// run_sp07_ui.mjs — RE-VERIFY 特-07 through the REAL UI form after the fix at
// apps/web/app/pages/special-invoice.vue:63 (String(form.activityYear ?? '').trim()).
//
// Two UI submissions (no direct RPC envelope — we drive the actual form):
//   (A) email + coverage=前期(zenki) + 活動年度=2027 → expect status 200,
//       success alert + hosted invoice URL shown, NO「発行に失敗」, and Stripe
//       metadata.activity_year='2027'.
//   (B) email + coverage=zenki + 活動年度 EMPTY → still issues (server default year).
//
// READ-ONLY w.r.t. app/spec code. Run:  node scripts/e2e/run_sp07_ui.mjs
import { launch, newCtx, devLogin, freshEmail, shot, BASE } from './harness.mjs'
import { getInvoice } from './pay.mjs'

const browser = await launch()
const results = []
const log = (...a) => console.log(...a)
const rec = (id, verdict, observed, note = '') => {
  results.push({ id, verdict, observed, note })
  log(`\n[${id}] ${verdict} :: ${observed}${note ? ' // ' + note : ''}`)
}
const sleep = ms => new Promise(r => setTimeout(r, ms))

try {
  // ---------------------------------------------------------------------------
  // (A) UI form WITH 活動年度=2027 — the case the bug used to break.
  // ---------------------------------------------------------------------------
  let invA = null
  {
    const ctx = await newCtx(browser); const page = await ctx.newPage()
    await devLogin(ctx, { as: 'admin' })
    await page.goto(BASE + '/special-invoice', { waitUntil: 'networkidle' })
    await page.waitForTimeout(400)
    const email = freshEmail('sp07ui2027')

    // Capture whether the RPC actually fires (the old bug threw before sending).
    let reqBody = null
    page.on('request', r => {
      if (r.url().includes('issueSpecialInvoiceByEmail')) reqBody = r.postData()
    })
    const respP = page.waitForResponse(
      r => r.url().includes('/rpc/membership/issueSpecialInvoiceByEmail'),
      { timeout: 30000 },
    ).catch(() => null)

    await page.locator('input[type=email]').first().fill(email)
    const numInput = page.locator('input[type=number]').first()
    await numInput.click(); await numInput.fill(''); await numInput.type('2027', { delay: 20 })
    // coverage default = zenki (前期); leave as-is.
    await shot(page, 'sp07-ui-2027-before')
    await page.locator('button[type=submit]').first().click().catch(() => {})

    const resp = await respP
    let status = null, body = null
    if (resp) { status = resp.status(); body = await resp.json().catch(() => null) }
    const inv = body?.json
    await page.waitForTimeout(1500)

    const successAlert = await page.locator('text=特別請求書を発行しました').count()
    const errAlert = await page.locator('text=発行に失敗').count()
    const urlInput = await page.locator('input[readonly]').first().inputValue().catch(() => null)
    const hostedShown = !!(urlInput && urlInput.startsWith('http'))
    await shot(page, 'sp07-ui-2027-after')

    invA = { email, invoiceId: inv?.invoiceId }
    const si = getInvoice(inv?.invoiceId)
    const md = si?.metadata || {}

    const requestFired = !!reqBody
    const ok = requestFired && status === 200 && !!inv?.invoiceId
      && successAlert > 0 && errAlert === 0 && hostedShown
      && md.activity_year === '2027' && md.variant === 'special' && si?.amount_due === 2000
    rec('特-07(UI/年度2027)', ok ? 'PASS' : 'FAIL',
      `requestFired=${requestFired} status=${status} invoiceId=${inv?.invoiceId} successAlert=${successAlert > 0} errAlert=${errAlert > 0} hostedUrlShown=${hostedShown} | Stripe amount_due=${si?.amount_due} metadata=${JSON.stringify(md)}`,
      'UI で活動年度=2027 を入力 → RPC が飛び status 200・hosted URL 表示・「発行に失敗」出ず・metadata.activity_year=2027（修正 String(...).trim() で TypeError 解消）')
    await ctx.close()
  }

  // ---------------------------------------------------------------------------
  // (B) UI form with 活動年度 EMPTY — must still issue (regression guard).
  // ---------------------------------------------------------------------------
  {
    const ctx = await newCtx(browser); const page = await ctx.newPage()
    await devLogin(ctx, { as: 'admin' })
    await page.goto(BASE + '/special-invoice', { waitUntil: 'networkidle' })
    await page.waitForTimeout(400)
    const email = freshEmail('sp07uiempty')

    const respP = page.waitForResponse(
      r => r.url().includes('/rpc/membership/issueSpecialInvoiceByEmail'),
      { timeout: 30000 },
    ).catch(() => null)
    await page.locator('input[type=email]').first().fill(email)
    // leave 活動年度 empty
    await page.locator('button[type=submit]').first().click().catch(() => {})
    const resp = await respP
    let status = null, body = null
    if (resp) { status = resp.status(); body = await resp.json().catch(() => null) }
    const inv = body?.json
    await page.waitForTimeout(1200)
    const successAlert = await page.locator('text=特別請求書を発行しました').count()
    const errAlert = await page.locator('text=発行に失敗').count()
    await shot(page, 'sp07-ui-empty-after')
    const si = getInvoice(inv?.invoiceId)
    const md = si?.metadata || {}
    const ok = status === 200 && !!inv?.invoiceId && successAlert > 0 && errAlert === 0
      && md.variant === 'special'
    rec('特-07(UI/年度空欄)', ok ? 'PASS' : 'FAIL',
      `status=${status} invoiceId=${inv?.invoiceId} successAlert=${successAlert > 0} errAlert=${errAlert > 0} | Stripe metadata.activity_year=${md.activity_year} (server default)`,
      '活動年度 空欄でも従来どおり発行（サーバ既定年度）')
    await ctx.close()
  }

  log('\n\n===== SUMMARY =====')
  log('| ID | 判定 | 観測 |')
  for (const r of results) log(`| ${r.id} | ${r.verdict} | ${r.observed}${r.note ? ' // ' + r.note : ''} |`)
}
catch (e) {
  console.error('RUN FAIL', e.stack)
}
finally {
  await browser.close()
}
