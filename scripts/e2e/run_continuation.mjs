// 継続(部費) 機能 (feeType:'continuation', entry /membership 区分=現役) —
// UI-level real-behavior verification. READ-ONLY: does not modify app/spec code.
// Run from repo root:
//   cd /home/kaitoyama/Checkin && node scripts/e2e/run_continuation.mjs
//
// Spec under test: 継続 is ALWAYS ¥4,000 通期 and occupies the NEXT activity year
// (今日は前期=活動年度 2026 ⇒ 継続 = 2027). Issuance API is the same as 入部
// (membership.issueInvoice, userProc, own mail_hash only). Form 区分 "現役" maps to
// feeType:'continuation'; "新規入部/再入部" maps to 'new'.
import { launch, newCtx, devLogin, freshEmail, authMe, shot, BASE } from './harness.mjs'

const browser = await launch()
const results = []
const log = (...a) => console.log(...a)
const rec = (id, verdict, observed, note = '') => {
  results.push({ id, verdict, observed, note })
  log(`\n[${id}] ${verdict} :: ${observed}${note ? ' // ' + note : ''}`)
}

// Call issueInvoice via in-page fetch using the oRPC RPC envelope ({"json":{...}}),
// mirroring the app's $orpc client. Carries injected cookies + CSRF header.
// Returns {status, ok:{invoiceId,hostedInvoiceUrl}|undefined, code, body}.
async function issueInvoice(page, payload, { csrf = true } = {}) {
  return page.evaluate(async ({ base, payload, csrf }) => {
    const headers = { 'content-type': 'application/json' }
    if (csrf) {
      const m = document.cookie.match(/(?:^|;\s*)__Host-checkin_csrf=([^;]+)/)
      headers['x-csrf-token'] = m ? m[1] : ''
    }
    const r = await fetch(base + '/rpc/membership/issueInvoice', {
      method: 'POST', headers, body: JSON.stringify({ json: payload }),
    })
    let parsed
    try { parsed = await r.json() } catch { parsed = await r.text().catch(() => null) }
    const ok = parsed?.json && parsed.json.invoiceId ? parsed.json : undefined
    const code = parsed?.json?.code
    return { status: r.status, ok, code, body: parsed }
  }, { base: BASE, payload, csrf })
}

const collected = {} // invoiceIds we want to inspect in Stripe afterwards

try {
  // ---------------------------------------------------------------------------
  // 継-01: fresh user, REAL UI FORM — fill own email + name, select 区分=現役,
  //        submit → status 200 + hostedInvoiceUrl. (Stripe amount/metadata checked
  //        out-of-band via the printed invoiceId.)
  // 継-07: selecting 区分=現役 issues feeType:'continuation' — proven below by
  //        (a) the form's select value being 'continuation', (b) the issued
  //        invoice's metadata fee_type=continuation (checked in Stripe step).
  // ---------------------------------------------------------------------------
  let invoice01 = null
  {
    const ctx = await newCtx(browser); const page = await ctx.newPage()
    const email = freshEmail('cont01')
    await devLogin(ctx, { as: 'user', email })
    await page.goto(BASE + '/membership', { waitUntil: 'networkidle' })
    const me = (await authMe(page)).body?.json
    // Fill the real form.
    await page.locator('input[type=email]').first().fill(email)
    // name input: the text/non-email input.
    const nameInput = page.locator('input:not([type=email])').first()
    await nameInput.fill('E2E Continuation Test')
    // 区分 USelect renders a native <select>; select value='continuation' (現役).
    const select = page.locator('select').first()
    const selectCount = await select.count()
    let selectedValue = null
    if (selectCount) {
      await select.selectOption('continuation').catch(() => {})
      selectedValue = await select.inputValue().catch(() => null)
    }
    await shot(page, 'cont-01-form-before-submit')
    // Submit via the actual button, capture the issueInvoice response.
    const respP = page.waitForResponse(
      r => r.url().includes('/rpc/membership/issueInvoice'), { timeout: 25000 },
    ).catch(() => null)
    await page.locator('button[type=submit]').first().click().catch(() => {})
    const resp = await respP
    let status = null, inv = null
    if (resp) {
      status = resp.status()
      const b = await resp.json().catch(() => null)
      inv = b?.json
    }
    // Wait for the success UI (支払いページへ進む button) to appear.
    await page.waitForTimeout(1200)
    const successBtn = await page.locator('text=支払いページへ進む').count()
    const successAlert = await page.locator('text=請求書を発行しました').count()
    await shot(page, 'cont-01-after-submit')
    invoice01 = { email, invoiceId: inv?.invoiceId, hostedInvoiceUrl: inv?.hostedInvoiceUrl }
    collected.cont01 = inv?.invoiceId
    const ok = status === 200 && typeof inv?.hostedInvoiceUrl === 'string'
      && inv.hostedInvoiceUrl.startsWith('http') && successBtn > 0
    rec('継-01', ok ? 'PASS' : 'FAIL',
      `formSubmit status=${status} selectValue=${selectedValue} invoiceId=${inv?.invoiceId} hostedInvoiceUrl=${inv?.hostedInvoiceUrl ? inv.hostedInvoiceUrl.slice(0, 48) + '…' : inv?.hostedInvoiceUrl} successBtn=${successBtn > 0} successAlert=${successAlert > 0}`,
      `me=${JSON.stringify(me)}`)
    // 継-07 (UI-side proof): form select carried value 'continuation'.
    rec('継-07', selectedValue === 'continuation' ? 'PASS' : 'FAIL',
      `区分=現役 → form feeType select value=${selectedValue} (expect 'continuation'); metadata fee_type confirmed in Stripe step`)
    await ctx.close()
  }

  // ---------------------------------------------------------------------------
  // 継-04: same fresh user, issue 区分=現役 (continuation) TWICE (unpaid) →
  //        2nd reuses the open invoice (same invoiceId).
  // ---------------------------------------------------------------------------
  {
    const ctx = await newCtx(browser); const page = await ctx.newPage()
    const email = freshEmail('cont04')
    await devLogin(ctx, { as: 'user', email })
    await page.goto(BASE + '/membership', { waitUntil: 'networkidle' })
    const r1 = await issueInvoice(page, { email, name: 'Reuse Cont', feeType: 'continuation' })
    const r2 = await issueInvoice(page, { email, name: 'Reuse Cont', feeType: 'continuation' })
    const i1 = r1.ok, i2 = r2.ok
    await shot(page, 'cont-04-reuse')
    const ok = r1.status === 200 && r2.status === 200
      && !!i1?.invoiceId && i1.invoiceId === i2?.invoiceId
    rec('継-04', ok ? 'PASS' : 'FAIL',
      `1st status=${r1.status} invoiceId=${i1?.invoiceId} | 2nd status=${r2.status} invoiceId=${i2?.invoiceId} sameInvoiceId=${i1?.invoiceId === i2?.invoiceId}`,
      'open invoice reused (dedup invariant = invoiceId)')
    await ctx.close()
  }

  // ---------------------------------------------------------------------------
  // 継-06: fresh user, submit a DIFFERENT isct email with 区分=現役 → FORBIDDEN
  //        (own mail_hash mismatch).
  // ---------------------------------------------------------------------------
  {
    const ctx = await newCtx(browser); const page = await ctx.newPage()
    const me = freshEmail('cont06self')
    const other = freshEmail('cont06other')
    await devLogin(ctx, { as: 'user', email: me })
    await page.goto(BASE + '/membership', { waitUntil: 'networkidle' })
    const r = await issueInvoice(page, { email: other, name: 'Not Me', feeType: 'continuation' })
    await shot(page, 'cont-06-forbidden')
    const ok = r.status === 403 || r.code === 'FORBIDDEN'
    rec('継-06', ok ? 'PASS' : 'FAIL',
      `status=${r.status} code=${r.code} msg=${r.body?.json?.message}`)
    await ctx.close()
  }

  // ---------------------------------------------------------------------------
  // 継-03 (partial / open-level): same fresh user issues BOTH 区分=新規入部
  //        ('new', covers 2026 通期) AND 区分=現役 ('continuation', covers 2027 通期)
  //        → both status 200, DIFFERENT invoiceIds (different activity years ⇒ no
  //        slot collision). Full form (今年度 paid 済み の上で) needs paid state ⇒
  //        BLOCKED note; here we observe the open-level year-key non-collision.
  // ---------------------------------------------------------------------------
  {
    const ctx = await newCtx(browser); const page = await ctx.newPage()
    const email = freshEmail('cont03')
    await devLogin(ctx, { as: 'user', email })
    await page.goto(BASE + '/membership', { waitUntil: 'networkidle' })
    const rNew = await issueInvoice(page, { email, name: 'Both New', feeType: 'new' })
    const rCont = await issueInvoice(page, { email, name: 'Both Cont', feeType: 'continuation' })
    const iNew = rNew.ok, iCont = rCont.ok
    collected.cont03_new = iNew?.invoiceId
    collected.cont03_cont = iCont?.invoiceId
    await shot(page, 'cont-03-both')
    const distinct = !!iNew?.invoiceId && !!iCont?.invoiceId
      && iNew.invoiceId !== iCont.invoiceId
    const ok = rNew.status === 200 && rCont.status === 200 && distinct
    rec('継-03', ok ? 'PASS' : 'FAIL',
      `new status=${rNew.status} invoiceId=${iNew?.invoiceId} | continuation status=${rCont.status} invoiceId=${iCont?.invoiceId} distinctInvoiceIds=${distinct}`,
      'open-level: 年度キー(2026 vs 2027)が衝突せず両立。"今年度 paid 済みの上で" の完全形は paid state 必要 ⇒ BLOCKED')
  }

  // ---------------------------------------------------------------------------
  // 継-05: BLOCKED — continuation paid (翌年度) → re-issue rejected. Requires real
  //        payment + webhook to flip invoice to paid (open-level only here).
  // ---------------------------------------------------------------------------
  rec('継-05', 'BLOCKED',
    'paid state required: needs a real Stripe payment + invoice.paid webhook to mark the 2027 continuation invoice paid, then a re-issue to observe rejection',
    'cannot be reproduced at the UI/open level')

  log('\n\n===== INVOICE IDS FOR STRIPE CHECK (JSON) =====')
  log(JSON.stringify(collected))

  // ---------------------------------------------------------------------------
  // Summary table
  // ---------------------------------------------------------------------------
  log('\n\n===== SUMMARY =====')
  log('| ID | 判定 | 観測 |')
  for (const r of results) log(`| ${r.id} | ${r.verdict} | ${r.observed}${r.note ? ' // ' + r.note : ''} |`)
} catch (e) {
  console.error('RUN FAIL', e.stack)
} finally {
  await browser.close()
}
