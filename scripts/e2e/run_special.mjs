// 特別対応（会計発行 ¥2,000・半期1つ） — feeType:'continuation' variant:'special'.
// Entry /special-invoice (会計ナビ「特別発行」). API:
//   membership.issueSpecialInvoiceByEmail({email, name?, coverage, activityYear?}) — adminProc
//   membership.issueSpecialInvoice({userId, name?, email?, coverage, activityYear?}) — adminProc
// coverage ∈ {zenki(前期のみ), kouki(後期追加)} — 通期は無い。activityYear 任意（既定 2026）。
//
// UI-level real-behavior verification. READ-ONLY: does not modify app/spec code.
// Run from repo root:  cd /home/kaitoyama/Checkin && node scripts/e2e/run_special.mjs
//
// NOTE on metadata keys (verified against packages/api/src/router.ts issueSpecialForRow):
//   fee_type='continuation', variant='special', coverage=<zenki|kouki>, activity_year=<string>.
//   There is NO `term` key on special invoices (only standard issuance writes `term`).
import { launch, newCtx, devLogin, freshEmail, authMe, shot, BASE } from './harness.mjs'
import { createHmac } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

const browser = await launch()
const results = []
const log = (...a) => console.log(...a)
const rec = (id, verdict, observed, note = '') => {
  results.push({ id, verdict, observed, note })
  log(`\n[${id}] ${verdict} :: ${observed}${note ? ' // ' + note : ''}`)
}

// ---- helpers ---------------------------------------------------------------

// Read a key from repo .env (strip surrounding quotes).
function envVal(key) {
  const t = readFileSync('/home/kaitoyama/Checkin/.env', 'utf8')
  const m = t.match(new RegExp('^' + key + '=(.*)$', 'm'))
  return m ? m[1].replace(/^['"]|['"]$/g, '') : ''
}
const MAIL_HASH_SECRET = envVal('MAIL_HASH_SECRET')
const STRIPE_SECRET_KEY = envVal('STRIPE_SECRET_KEY')

// Replicate @checkin/api deriveMailHash: HMAC-SHA256(secret, email.trim().toLowerCase()) hex.
function deriveMailHash(email) {
  return createHmac('sha256', MAIL_HASH_SECRET).update(email.trim().toLowerCase()).digest('hex')
}

// Resolve userId from MySQL by mail_hash (for the userId-based 特-05 scenario).
function userIdForEmail(email) {
  const hash = deriveMailHash(email)
  const out = execFileSync('mysql', [
    '-h', '127.0.0.1', '-P', '3306', '-u', 'checkin', '-ppassword', 'checkin',
    '-N', '-B', '-e', `SELECT id FROM users WHERE mail_hash='${hash}' LIMIT 1;`,
  ], { encoding: 'utf8' }).trim()
  return out || null
}

// Call an oRPC membership endpoint via in-page fetch using the RPC envelope
// ({"json":{...}}), mirroring the app's $orpc client. Carries injected cookies +
// CSRF header. Returns {status, ok:{invoiceId,hostedInvoiceUrl}|undefined, code, body}.
async function rpc(page, method, payload, { csrf = true } = {}) {
  return page.evaluate(async ({ base, method, payload, csrf }) => {
    const headers = { 'content-type': 'application/json' }
    if (csrf) {
      const m = document.cookie.match(/(?:^|;\s*)__Host-checkin_csrf=([^;]+)/)
      headers['x-csrf-token'] = m ? m[1] : ''
    }
    const r = await fetch(base + '/rpc/membership/' + method, {
      method: 'POST', headers, body: JSON.stringify({ json: payload }),
    })
    let parsed
    try { parsed = await r.json() } catch { parsed = await r.text().catch(() => null) }
    const ok = parsed?.json && parsed.json.invoiceId ? parsed.json : undefined
    const code = parsed?.json?.code ?? parsed?.code ?? parsed?.defined?.code
    return { status: r.status, ok, code, body: parsed }
  }, { base: BASE, method, payload, csrf })
}

// Fetch a Stripe invoice via REST (test mode). Returns the parsed object.
function stripeInvoice(invoiceId) {
  if (!invoiceId) return null
  const out = execFileSync('curl', [
    '-s', `https://api.stripe.com/v1/invoices/${invoiceId}`,
    '-u', `${STRIPE_SECRET_KEY}:`,
  ], { encoding: 'utf8' })
  try { return JSON.parse(out) } catch { return { _raw: out.slice(0, 200) } }
}

const collected = {} // invoiceIds for Stripe inspection

try {
  // ===========================================================================
  // 特-10: /special-invoice の coverage 選択肢が 前期/後期 のみで 通期が無いこと（UI）
  // ===========================================================================
  {
    const ctx = await newCtx(browser); const page = await ctx.newPage()
    await devLogin(ctx, { as: 'admin' })
    await page.goto(BASE + '/special-invoice', { waitUntil: 'networkidle' })
    await page.waitForTimeout(500)
    // USelect renders a native <select> (the coverage one). Enumerate option labels.
    const select = page.locator('select').first()
    const optionLabels = await select.locator('option').allTextContents().catch(() => [])
    const optionValues = await select.evaluate(s =>
      Array.from(s.options).map(o => o.value)).catch(() => [])
    await shot(page, 'special-10-coverage-options')
    const hasZenki = optionValues.includes('zenki')
    const hasKouki = optionValues.includes('kouki')
    const hasTsuki = optionValues.some(v => /tsuki|annual|full|year|通期/.test(v))
      || optionLabels.some(l => l.includes('通期'))
    const ok = hasZenki && hasKouki && !hasTsuki && optionValues.length === 2
    rec('特-10', ok ? 'PASS' : 'FAIL',
      `optionValues=${JSON.stringify(optionValues)} labels=${JSON.stringify(optionLabels)} 通期=${hasTsuki}`,
      '前期(zenki)/後期(kouki) のみ・通期なし')
    await ctx.close()
  }

  // ===========================================================================
  // 特-01 + 特-03: admin が 初見 fresh email・coverage=前期(zenki) を REAL UI FORM で発行
  //   → status 200・hosted invoice URL 表示。事前 user 行が無くても発行成功（特-03）。
  //   Stripe で amount_due=2000 jpy・metadata を確認（特-01）。
  // ===========================================================================
  let inv01 = null
  {
    const ctx = await newCtx(browser); const page = await ctx.newPage()
    await devLogin(ctx, { as: 'admin' })
    const email = freshEmail('sp01')
    // Sanity: this fresh person has NO prior user row (特-03 precondition).
    const preexisting = userIdForEmail(email)
    await page.goto(BASE + '/special-invoice', { waitUntil: 'networkidle' })
    await page.waitForTimeout(400)
    // Real form fill: email + name; coverage default = zenki (前期のみ).
    await page.locator('input[type=email]').first().fill(email)
    await page.locator('input[name="name"], input[placeholder*="太郎"]').first().fill('Special Zenki').catch(() => {})
    const coverageBefore = await page.locator('select').first().inputValue().catch(() => null)
    await shot(page, 'special-01-form-before')
    const respP = page.waitForResponse(
      r => r.url().includes('/rpc/membership/issueSpecialInvoiceByEmail'), { timeout: 30000 },
    ).catch(() => null)
    await page.locator('button[type=submit]').first().click().catch(() => {})
    const resp = await respP
    let status = null, body = null
    if (resp) { status = resp.status(); body = await resp.json().catch(() => null) }
    const inv = body?.json
    await page.waitForTimeout(1200)
    const successAlert = await page.locator('text=特別請求書を発行しました').count()
    const urlInput = await page.locator('input[readonly]').first().inputValue().catch(() => null)
    const hostedShown = !!(urlInput && urlInput.startsWith('http'))
    const idShown = await page.locator('text=請求書 ID').count()
    await shot(page, 'special-01-after')
    inv01 = { email, invoiceId: inv?.invoiceId, hostedInvoiceUrl: inv?.hostedInvoiceUrl }
    collected.sp01 = inv?.invoiceId
    const ok01 = status === 200 && typeof inv?.hostedInvoiceUrl === 'string'
      && inv.hostedInvoiceUrl.startsWith('http') && successAlert > 0 && hostedShown
    rec('特-01', ok01 ? 'PASS' : 'FAIL',
      `coverage(form)=${coverageBefore} status=${status} invoiceId=${inv?.invoiceId} hostedShownInUI=${hostedShown} idShown=${idShown > 0} hostedUrl=${inv?.hostedInvoiceUrl ? inv.hostedInvoiceUrl.slice(0, 46) + '…' : inv?.hostedInvoiceUrl}`,
      'Stripe amount/metadata は下の特-01(Stripe) 行で確認')
    const ok03 = !preexisting && status === 200 && !!inv?.invoiceId
    const afterUserId = userIdForEmail(email)
    rec('特-03', ok03 ? 'PASS' : 'FAIL',
      `preexistingUserRow=${preexisting ? 'YES(' + preexisting + ')' : 'none'} → issue status=${status} invoiceId=${inv?.invoiceId} → userRowNow=${afterUserId ? 'created(' + afterUserId + ')' : 'none'}`,
      '事前 user 行無し → get-or-create して発行成功')
    await ctx.close()
  }

  // Stripe verification for 特-01: amount_due=2000 jpy + metadata.
  {
    const si = stripeInvoice(inv01?.invoiceId)
    const md = si?.metadata || {}
    const ok = si && si.amount_due === 2000 && (si.currency === 'jpy')
      && md.fee_type === 'continuation' && md.variant === 'special'
      && md.coverage === 'zenki' && md.activity_year === '2026'
    rec('特-01(Stripe)', ok ? 'PASS' : 'FAIL',
      `invoiceId=${inv01?.invoiceId} amount_due=${si?.amount_due} currency=${si?.currency} status=${si?.status} metadata=${JSON.stringify(md)}`,
      'fee_type=continuation+variant=special が特別/¥2000 を示す（special 専用 priceId）。term キーは special には無い（仕様）。coverage=zenki / activity_year=2026')
  }

  // ===========================================================================
  // 特-09: 同一 fresh email・同 coverage=zenki を 2回 発行（未払い）→ 2回目 同一 invoiceId。
  // ===========================================================================
  {
    const ctx = await newCtx(browser); const page = await ctx.newPage()
    await devLogin(ctx, { as: 'admin' })
    await page.goto(BASE + '/special-invoice', { waitUntil: 'networkidle' })
    const email = freshEmail('sp09')
    const r1 = await rpc(page, 'issueSpecialInvoiceByEmail', { email, name: 'Reuse SP', coverage: 'zenki' })
    const r2 = await rpc(page, 'issueSpecialInvoiceByEmail', { email, name: 'Reuse SP', coverage: 'zenki' })
    await shot(page, 'special-09-reuse')
    const i1 = r1.ok, i2 = r2.ok
    const ok = r1.status === 200 && r2.status === 200
      && !!i1?.invoiceId && i1.invoiceId === i2?.invoiceId
    rec('特-09', ok ? 'PASS' : 'FAIL',
      `1st status=${r1.status} invoiceId=${i1?.invoiceId} | 2nd status=${r2.status} invoiceId=${i2?.invoiceId} sameInvoiceId=${i1?.invoiceId === i2?.invoiceId}`,
      'open invoice 再利用（dedup 不変条件 = invoiceId）')
    await ctx.close()
  }

  // ===========================================================================
  // 特-02 (部分検証): 同一 fresh email に coverage=zenki と coverage=kouki を別々に発行
  //   → 両方 status 200・別 invoiceId（前期/後期スロットが別で両立）。
  //   ※「前期 paid 済みの上で後期追加」の完全形は paid state 必要 → BLOCKED 注記。
  // ===========================================================================
  {
    const ctx = await newCtx(browser); const page = await ctx.newPage()
    await devLogin(ctx, { as: 'admin' })
    await page.goto(BASE + '/special-invoice', { waitUntil: 'networkidle' })
    const email = freshEmail('sp02')
    const rZ = await rpc(page, 'issueSpecialInvoiceByEmail', { email, name: 'Both SP', coverage: 'zenki' })
    const rK = await rpc(page, 'issueSpecialInvoiceByEmail', { email, name: 'Both SP', coverage: 'kouki' })
    await shot(page, 'special-02-both-halves')
    const iZ = rZ.ok, iK = rK.ok
    collected.sp02_zenki = iZ?.invoiceId
    collected.sp02_kouki = iK?.invoiceId
    const distinct = !!iZ?.invoiceId && !!iK?.invoiceId && iZ.invoiceId !== iK.invoiceId
    const ok = rZ.status === 200 && rK.status === 200 && distinct
    rec('特-02', ok ? 'PASS' : 'FAIL',
      `zenki status=${rZ.status} invoiceId=${iZ?.invoiceId} | kouki status=${rK.status} invoiceId=${iK?.invoiceId} distinct=${distinct}`,
      '前期/後期スロットが別なので両立（別 invoiceId）。"前期 paid 済みの上で後期追加" の完全形は paid state 必要 ⇒ その部分は BLOCKED')
    await ctx.close()
  }

  // ===========================================================================
  // 特-04: 認可 — ① as:user で /special-invoice を開く → 会計データ出さず「要会計ログイン」
  //   ② as:user セッションで POST issueSpecialInvoiceByEmail 直叩き → 認可エラー
  //   ③ 利用者 UI(/membership) に特別の導線が無いこと。
  // ===========================================================================
  {
    const ctx = await newCtx(browser); const page = await ctx.newPage()
    const email = freshEmail('sp04user')
    await devLogin(ctx, { as: 'user', email })
    // ① UI gate.
    await page.goto(BASE + '/special-invoice', { waitUntil: 'networkidle' })
    await page.waitForTimeout(500)
    const me = (await authMe(page)).body?.json
    const hasLoginPrompt = await page.locator('text=会計ログインが必要です').count()
    const hasForm = await page.locator('input[type=email]').count()
    const hasSubmit = await page.locator('button[type=submit]').count()
    await shot(page, 'special-04-user-gate')
    // ② direct RPC.
    const r = await rpc(page, 'issueSpecialInvoiceByEmail', { email, name: 'Sneaky', coverage: 'zenki' })
    // ③ /membership には特別の導線が無いこと.
    await page.goto(BASE + '/membership', { waitUntil: 'networkidle' })
    await page.waitForTimeout(400)
    const membershipBody = await page.locator('body').innerText().catch(() => '')
    const hasSpecialLink = await page.locator('a[href="/special-invoice"]').count()
    const mentionsSpecial = membershipBody.includes('特別')
    await shot(page, 'special-04-membership-no-link')
    const uiOk = me?.admin === false && hasLoginPrompt > 0 && hasForm === 0 && hasSubmit === 0
    const rpcOk = r.status === 401 || r.status === 403 || r.code === 'FORBIDDEN' || r.code === 'UNAUTHORIZED'
    const navOk = hasSpecialLink === 0 && !mentionsSpecial
    const ok = uiOk && rpcOk && navOk
    rec('特-04', ok ? 'PASS' : 'FAIL',
      `[UI] admin=${me?.admin} loginPrompt=${hasLoginPrompt > 0} form=${hasForm} submit=${hasSubmit} | [RPC] status=${r.status} code=${r.code} msg=${r.body?.json?.message} | [nav] /membership specialLink=${hasSpecialLink} mentions特別=${mentionsSpecial}`)
    await ctx.close()
  }

  // ===========================================================================
  // 特-06: admin が 許可ドメイン外メール (foo@example.com) で ByEmail 発行
  //   → ドメインガードで拒否（junk person を作らない）。
  // ===========================================================================
  {
    const ctx = await newCtx(browser); const page = await ctx.newPage()
    await devLogin(ctx, { as: 'admin' })
    await page.goto(BASE + '/special-invoice', { waitUntil: 'networkidle' })
    const badEmail = `e2e-sp06-${process.pid}@example.com`
    const r = await rpc(page, 'issueSpecialInvoiceByEmail', { email: badEmail, name: 'Junk', coverage: 'zenki' })
    // Confirm no junk user row was created.
    const junkRow = userIdForEmail(badEmail)
    await shot(page, 'special-06-domain-guard')
    const ok = (r.status === 400 || r.code === 'BAD_REQUEST') && !junkRow
    rec('特-06', ok ? 'PASS' : 'FAIL',
      `status=${r.status} code=${r.code} msg=${r.body?.json?.message} junkUserRowCreated=${junkRow ? 'YES(' + junkRow + ')' : 'no'}`,
      'ドメインガードで拒否・person 行は作られない')
    await ctx.close()
  }

  // ===========================================================================
  // 特-07: admin が activityYear=2027 を指定して発行。
  //   観測: (A) UI フォーム経由 — 活動年度に 2027 を入力して発行ボタン → リクエストが
  //         1件も飛ばず「発行に失敗しました」を表示（client-side bug）。
  //         (B) API 直叩き（envelope）— activityYear:2027 を渡すと status 200 で発行成功、
  //         Stripe metadata.activity_year=2027 を確認（サーバは正しい）。
  //   → UI 経由は FAIL（活動年度を入れると必ず失敗）、API 直叩きは期待どおり。
  // ===========================================================================
  let inv07 = null
  {
    // (A) Realistic UI form path: type a year, submit, observe what happens.
    const ctx = await newCtx(browser); const page = await ctx.newPage()
    await devLogin(ctx, { as: 'admin' })
    await page.goto(BASE + '/special-invoice', { waitUntil: 'networkidle' })
    await page.waitForTimeout(400)
    const uiEmail = freshEmail('sp07ui')
    const uiReqs = []
    page.on('request', r => { if (r.url().includes('issueSpecialInvoiceByEmail')) uiReqs.push(r.postData()) })
    await page.locator('input[type=email]').first().fill(uiEmail)
    const numInput = page.locator('input[type=number]').first()
    await numInput.click(); await numInput.type('2027', { delay: 20 })
    await shot(page, 'special-07-form-2027')
    await page.locator('button[type=submit]').first().click().catch(() => {})
    await page.waitForTimeout(2500)
    const uiErr = await page.locator('text=発行に失敗').count()
    const uiOk = await page.locator('text=特別請求書を発行しました').count()
    await shot(page, 'special-07-ui-after')
    const uiRequestFired = uiReqs.length > 0

    // (B) API path (envelope): same activityYear=2027 must succeed + carry metadata.
    const apiEmail = freshEmail('sp07api')
    const r = await rpc(page, 'issueSpecialInvoiceByEmail', { email: apiEmail, name: 'Year2027', coverage: 'zenki', activityYear: 2027 })
    inv07 = { email: apiEmail, invoiceId: r.ok?.invoiceId }
    collected.sp07 = r.ok?.invoiceId
    const si = stripeInvoice(r.ok?.invoiceId)
    const md = si?.metadata || {}
    const apiOk = r.status === 200 && !!r.ok?.invoiceId && md.activity_year === '2027'
      && md.variant === 'special' && si?.amount_due === 2000
    // Overall verdict reflects the USER-FACING UI behavior (the assigned scope):
    // the UI path fails, so 特-07 is FAIL at the UI level even though the API is correct.
    const verdict = (!uiRequestFired && uiErr > 0 && apiOk) ? 'FAIL' : (uiOk > 0 && apiOk ? 'PASS' : 'FAIL')
    rec('特-07', verdict,
      `[UI] typed活動年度=2027 → requestFired=${uiRequestFired} errAlert=${uiErr > 0} successAlert=${uiOk > 0} | [API] status=${r.status} invoiceId=${r.ok?.invoiceId} amount_due=${si?.amount_due} metadata=${JSON.stringify(md)}`,
      'UI で活動年度を入力すると RPC が一切送られず「発行に失敗しました」。原因: UInput type=number の v-model が form.activityYear を数値にし、onSubmit の form.activityYear.trim() が TypeError → catch されて汎用エラー表示・送信されない（apps/web/app/pages/special-invoice.vue:61,239）。API 直叩きでは activity_year=2027 で正常発行（サーバは正しい）')
    await ctx.close()
  }

  // ===========================================================================
  // 特-05: userId 指定でメール不一致 → 拒否（API 試行）。
  //   fresh user を dev login で作り userId を取得（Customer 未作成）、admin で
  //   別 isct メールを指定 → mail_hash 不一致 → BAD_REQUEST 'email does not match'.
  // ===========================================================================
  {
    // 1) create a fresh user row (no Stripe Customer yet) via dev login.
    const targetEmail = freshEmail('sp05target')
    const otherEmail = freshEmail('sp05other')
    const uctx = await newCtx(browser)
    await devLogin(uctx, { as: 'user', email: targetEmail })
    await uctx.close()
    const userId = userIdForEmail(targetEmail)
    // 2) admin calls issueSpecialInvoice({userId, email: a DIFFERENT isct email}).
    const ctx = await newCtx(browser); const page = await ctx.newPage()
    await devLogin(ctx, { as: 'admin' })
    await page.goto(BASE + '/special-invoice', { waitUntil: 'networkidle' })
    let r = null
    if (userId) {
      r = await rpc(page, 'issueSpecialInvoice', { userId, email: otherEmail, name: 'Mismatch', coverage: 'zenki' })
    }
    await shot(page, 'special-05-userid-mismatch')
    const ok = !!userId && (r?.status === 400 || r?.code === 'BAD_REQUEST')
      && /does not match/i.test(r?.body?.json?.message || '')
    rec('特-05', ok ? 'PASS' : (userId ? 'FAIL' : 'BLOCKED'),
      userId
        ? `userId=${userId} suppliedEmail=<different isct> status=${r?.status} code=${r?.code} msg=${r?.body?.json?.message}`
        : 'could not resolve a fresh userId from MySQL (mail_hash lookup failed)',
      'userId の person と指定 email の mail_hash 不一致 → 別の email/Customer に誤リンクを防ぐため拒否')
    await ctx.close()
  }

  // ===========================================================================
  // 特-08 / 特-11: BLOCKED — 実支払い + invoice.paid webhook で paid 化が必要。
  // ===========================================================================
  rec('特-08', 'BLOCKED',
    '同半期 paid → 再発行拒否を観測するには、対象 invoice を実 Stripe 決済 + invoice.paid webhook で paid 化する必要がある（UI/open では paid state を作れない）',
    '実支払い + webhook があれば検証可能')
  rec('特-11', 'BLOCKED',
    'special paid → 該当半期スロット paid 化 + 通知 を観測するには、実 Stripe 決済 + invoice.paid webhook が必要',
    '実支払い + webhook があれば検証可能')

  log('\n\n===== INVOICE IDS FOR STRIPE CHECK (JSON) =====')
  log(JSON.stringify(collected))

  log('\n\n===== SUMMARY =====')
  log('| ID | 判定 | 観測 |')
  for (const r of results) log(`| ${r.id} | ${r.verdict} | ${r.observed}${r.note ? ' // ' + r.note : ''} |`)
} catch (e) {
  console.error('RUN FAIL', e.stack)
} finally {
  await browser.close()
}
