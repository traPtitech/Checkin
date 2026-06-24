// 横断シナリオ（認証 5.3 / 会計UI一覧 5.4 / 台帳・入金webhook 5.1 / 口座振込 5.2）の
// UI/HTTP レベル実挙動検証。READ-ONLY: app/spec を改変しない。台帳・webhook の不変条件は
// vitest で裏取り（別途）。実送金・Jomon 書き戻しはしない。
//   cd /home/kaitoyama/Checkin && node scripts/e2e/run_cross.mjs
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { launch, newCtx, devLogin, freshEmail, authMe, shot, BASE } from './harness.mjs'

const DEV_LOG = '/tmp/checkin-dev.log'
const SK = (() => {
  const env = readFileSync('/home/kaitoyama/Checkin/.env', 'utf8')
  const m = env.match(/^STRIPE_SECRET_KEY="?([^"\n]*)"?/m)
  return m ? m[1] : ''
})()

const results = []
const log = (...a) => console.log(...a)
const rec = (id, verdict, observed, note = '') => {
  results.push({ id, verdict, observed, note })
  log(`\n[${id}] ${verdict} :: ${observed}${note ? ' // ' + note : ''}`)
}

// Read the dev log size now, so we can scan only NEW lines appended after.
function logMark() {
  try { return readFileSync(DEV_LOG, 'utf8').length } catch { return 0 }
}
function logSince(mark) {
  try { return readFileSync(DEV_LOG, 'utf8').slice(mark) } catch { return '' }
}
// Pull the LAST magic-link confirm URL appearing in a chunk of the dev log.
function lastConfirmLink(chunk) {
  const re = /https?:\/\/[^\s"']*\/verify-email\/confirm\?token=[^\s"'\\)]+/g
  const all = chunk.match(re)
  return all ? all[all.length - 1] : null
}

// Submit the verify-email form via the in-page oRPC client (carries injected
// session + CSRF). Returns the page-visible state.
async function submitVerifyEmail(page, email) {
  await page.locator('input[type=email]').first().fill(email)
  await page.getByRole('button', { name: '確認メールを送信' }).click()
  await page.waitForTimeout(1200)
  const sentVisible = await page.locator('text=確認メールを送信しました').count()
  const errVisible = await page.locator('.text-error, [class*="error"]').filter({ hasText: /許可|allowed|失敗|エラー/ }).count()
  return { sentVisible: sentVisible > 0, errVisible: errVisible > 0 }
}

// @nuxt/ui USelect renders a button trigger + a portal listbox (NO native
// <select>). Drive it by opening the trigger and clicking the option whose label
// matches. `label` is the visible text ('すべて' | 'draft' | 'open' | 'paid' | …).
async function pickFilter(page, label) {
  const trigger = page.locator('button', { hasText: /^(すべて|draft|open|paid|uncollectible|void|complete|expired)$/ }).first()
  await trigger.click()
  await page.waitForTimeout(150)
  await page.locator('[role=option]', { hasText: new RegExp(`^${label}$`) }).first().click()
}

// curl a Nitro route with explicit cookies/headers (bypasses browser __Host- limits).
function curl(args) {
  return execFileSync('curl', ['-s', ...args], { encoding: 'utf8' })
}
// Mint a dev session token directly (for raw HTTP scenarios).
function mintToken(as, email) {
  const u = new URL(BASE + '/dev/login')
  u.searchParams.set('as', as)
  if (email) u.searchParams.set('email', email)
  u.searchParams.set('redirect', '/')
  const hdrs = curl(['-i', u.toString()])
  const m = hdrs.match(/set-cookie:\s*__Host-checkin_session=([^;]+)/i)
  if (!m) throw new Error('dev/login no session cookie')
  return m[1]
}

const browser = await launch()
try {
  // ===========================================================================
  // 認証 (5.3)
  // ===========================================================================

  // 横-07: /verify-email で isct メール送信 → 「確認メールを送信しました」+ ログにリンク
  {
    const ctx = await newCtx(browser); const page = await ctx.newPage()
    await devLogin(ctx, { as: 'member' }) // any session carries CSRF cookie; pub proc + assertCsrf
    const email = freshEmail('x07')
    const mark = logMark()
    await page.goto(BASE + '/verify-email', { waitUntil: 'networkidle' })
    const st = await submitVerifyEmail(page, email)
    await page.waitForTimeout(500)
    const chunk = logSince(mark)
    const link = lastConfirmLink(chunk)
    await shot(page, 'cross-07-verify-send')
    const ok = st.sentVisible && !!link
    rec('横-07', ok ? 'PASS' : 'FAIL',
      `sentBanner=${st.sentVisible} magicLinkInLog=${!!link} link=${link ? link.slice(0, 70) + '…' : null}`)
    await ctx.close()
  }

  // 横-08: /verify-email?redirect=/membership → リンク GET 後の Location が redirect を保持
  //   NOTE: link URL 自体には token のみ（redirect は DB 保存）。実挙動は confirm の
  //   302 Location を観測して redirect 反映を検証する。
  let confirmLink08 = null
  {
    const ctx = await newCtx(browser); const page = await ctx.newPage()
    await devLogin(ctx, { as: 'member' })
    const email = freshEmail('x08')
    const mark = logMark()
    await page.goto(BASE + '/verify-email?redirect=/membership', { waitUntil: 'networkidle' })
    const st = await submitVerifyEmail(page, email)
    await page.waitForTimeout(500)
    confirmLink08 = lastConfirmLink(logSince(mark))
    // Do NOT GET the link here (single-use): consuming it would invalidate 横-10's
    // "actually GET the link" check. The link URL carries only ?token=; the
    // redirect is stored server-side and is proven (Location=/membership) in 横-10.
    await shot(page, 'cross-08-redirect')
    const ok = st.sentVisible && !!confirmLink08
    rec('横-08', ok ? 'PASS' : 'FAIL',
      `sentBanner=${st.sentVisible} magicLinkInLog=${!!confirmLink08} link=${confirmLink08 ? confirmLink08.slice(0, 70) + '…' : null}`,
      'redirect=/membership で送信→リンク発行（redirect は DB 保存、反映は 横-10 の 302 Location で確認）')
    await ctx.close()
  }

  // 横-09: 許可ドメイン外 foo@example.com → エラー表示・ログにリンク出ない
  {
    const ctx = await newCtx(browser); const page = await ctx.newPage()
    await devLogin(ctx, { as: 'member' })
    const mark = logMark()
    await page.goto(BASE + '/verify-email', { waitUntil: 'networkidle' })
    const st = await submitVerifyEmail(page, 'foo@example.com')
    await page.waitForTimeout(500)
    const link = lastConfirmLink(logSince(mark))
    // Also capture the visible error banner text.
    const errText = await page.locator('.text-error, [role=alert], h3, [class*="title"]')
      .filter({ hasText: /許可|allowed|domain|失敗/ }).first().textContent().catch(() => null)
    await shot(page, 'cross-09-bad-domain')
    const ok = !link && (st.errVisible || !!errText)
    rec('横-09', ok ? 'PASS' : 'FAIL',
      `errBanner=${st.errVisible || !!errText} errText=${(errText || '').trim().slice(0, 40)} magicLinkInLog=${!!link}`,
      ok ? 'メール未送信（リンク無し）' : '')
    await ctx.close()
  }

  // 横-10: 横-07/08 のリンクを実際に GET → セッションに userId 連結 → auth.me hasUser=true → redirect 先
  //   confirmLink08 (redirect=/membership) を使う。anon で GET → Set-Cookie session を拾い、
  //   その session で auth.me を叩く。
  let usedLink10 = null
  {
    if (!confirmLink08) {
      rec('横-10', 'BLOCKED', '横-08 のリンク未取得（先行依存）')
    } else {
      usedLink10 = confirmLink08
      const path = confirmLink08.replace(/^https?:\/\/[^/]+/, '')
      const head = curl(['-i', BASE + path])
      const status = (head.match(/HTTP\/[\d.]+ (\d+)/) || [])[1]
      const location = (head.match(/^location:\s*(\S+)/im) || [])[1]
      const sess = (head.match(/set-cookie:\s*__Host-checkin_session=([^;]+)/i) || [])[1]
      // auth.me with that session via curl.
      let me = null
      if (sess) {
        const body = curl([
          '-X', 'POST', BASE + '/rpc/auth/me',
          '-H', 'content-type: application/json',
          '-H', `cookie: __Host-checkin_session=${sess}`,
          '--data', '{}',
        ])
        try { me = JSON.parse(body).json } catch { me = body }
      }
      const ok = status === '302' && location === '/membership' && me?.hasUser === true && me?.authenticated === true
      rec('横-10', ok ? 'PASS' : 'FAIL',
        `confirmStatus=${status} Location=${location} sessionSet=${!!sess} auth.me=${JSON.stringify(me)}`)
    }
  }

  // 横-20: 横-10 で使ったリンクを再 GET → 拒否（単回）。不正トークンの confirm も拒否。
  {
    if (!usedLink10) {
      rec('横-20', 'BLOCKED', '横-10 で消費したリンク未取得')
    } else {
      const path = usedLink10.replace(/^https?:\/\/[^/]+/, '')
      const head = curl(['-i', BASE + path]) // reuse the now-consumed link
      const status = (head.match(/HTTP\/[\d.]+ (\d+)/) || [])[1]
      const location = (head.match(/^location:\s*(\S+)/im) || [])[1]
      const reusedSess = (head.match(/set-cookie:\s*__Host-checkin_session=([^;]+)/i) || [])[1]
      // bogus token
      const head2 = curl(['-i', BASE + '/verify-email/confirm?token=deadbeefnope'])
      const status2 = (head2.match(/HTTP\/[\d.]+ (\d+)/) || [])[1]
      const location2 = (head2.match(/^location:\s*(\S+)/im) || [])[1]
      const bogusSess = (head2.match(/set-cookie:\s*__Host-checkin_session=([^;]+)/i) || [])[1]
      // Rejected = redirected to /?verify=invalid AND no fresh session minted.
      const reuseRejected = /verify=invalid/.test(location || '') && !reusedSess
      const bogusRejected = /verify=invalid/.test(location2 || '') && !bogusSess
      const ok = reuseRejected && bogusRejected
      rec('横-20', ok ? 'PASS' : 'FAIL',
        `reuse: status=${status} Location=${location} sessionMinted=${!!reusedSess} | bogus: status=${status2} Location=${location2} sessionMinted=${!!bogusSess}`,
        ok ? '単回・不正とも拒否（/?verify=invalid, セッション未確立）' : '')
    }
  }

  // 横-18: traQ OAuth state 不一致 → /login/callback?state=wrong&code=x (state cookie 無し) → 拒否
  {
    const head = curl(['-i', BASE + '/login/callback?state=wrong&code=x'])
    const status = (head.match(/HTTP\/[\d.]+ (\d+)/) || [])[1]
    const location = (head.match(/^location:\s*(\S+)/im) || [])[1]
    const sess = (head.match(/set-cookie:\s*__Host-checkin_session=([^;]+)/i) || [])[1]
    // Handler redirects to /?login=error and mints no session when state mismatches.
    const ok = /login=error/.test(location || '') && !sess
    rec('横-18', ok ? 'PASS' : 'FAIL',
      `status=${status} Location=${location} sessionMinted=${!!sess}`,
      ok ? 'state 不一致 → /?login=error, セッション未確立' : '')
  }

  // 横-19: CSRF — 会計セッション付きで x-csrf-token を外す/書き換えて状態変更直叩き → 拒否
  {
    const token = mintToken('admin')
    // (a) header 無し
    const noHdr = curl([
      '-i', '-X', 'POST', BASE + '/rpc/payouts/processApproved',
      '-H', 'content-type: application/json',
      '-H', `cookie: __Host-checkin_session=${token}; __Host-checkin_csrf=e2e-csrf-token-fixed`,
      '--data', '{"json":{}}',
    ])
    const noHdrStatus = (noHdr.match(/HTTP\/[\d.]+ (\d+)/) || [])[1]
    const noHdrCode = (noHdr.match(/"code":"([A-Z_]+)"/) || [])[1]
    // (b) header 不一致
    const badHdr = curl([
      '-i', '-X', 'POST', BASE + '/rpc/payouts/processApproved',
      '-H', 'content-type: application/json',
      '-H', 'x-csrf-token: MISMATCH',
      '-H', `cookie: __Host-checkin_session=${token}; __Host-checkin_csrf=e2e-csrf-token-fixed`,
      '--data', '{"json":{}}',
    ])
    const badHdrStatus = (badHdr.match(/HTTP\/[\d.]+ (\d+)/) || [])[1]
    const badHdrCode = (badHdr.match(/"code":"([A-Z_]+)"/) || [])[1]
    const rejected = (s, c) => s === '403' || c === 'FORBIDDEN' || /CSRF/i.test(noHdr + badHdr)
    const ok = rejected(noHdrStatus, noHdrCode) && rejected(badHdrStatus, badHdrCode)
    rec('横-19', ok ? 'PASS' : 'FAIL',
      `noHeader: status=${noHdrStatus} code=${noHdrCode} | mismatch: status=${badHdrStatus} code=${badHdrCode}`,
      'admin session 有・CSRF header 欠落/不一致で processApproved 直叩き')
  }

  // 横-26: ログアウト — 会計ログイン → POST /logout → 同 cookie で auth.me → unauthenticated
  {
    const token = mintToken('admin')
    const cookie = `__Host-checkin_session=${token}; __Host-checkin_csrf=e2e-csrf-token-fixed`
    // me BEFORE logout
    const before = JSON.parse(curl([
      '-X', 'POST', BASE + '/rpc/auth/me', '-H', 'content-type: application/json',
      '-H', `cookie: ${cookie}`, '--data', '{}',
    ])).json
    // POST /logout (Nitro, requires CSRF header == cookie)
    const lo = curl([
      '-i', '-X', 'POST', BASE + '/logout',
      '-H', 'x-csrf-token: e2e-csrf-token-fixed',
      '-H', `cookie: ${cookie}`,
    ])
    const loStatus = (lo.match(/HTTP\/[\d.]+ (\d+)/) || [])[1]
    // me AFTER logout with the SAME session token (server-side invalidation)
    const after = JSON.parse(curl([
      '-X', 'POST', BASE + '/rpc/auth/me', '-H', 'content-type: application/json',
      '-H', `cookie: ${cookie}`, '--data', '{}',
    ])).json
    const ok = before?.admin === true && loStatus === '200' && after?.authenticated === false
    rec('横-26', ok ? 'PASS' : 'FAIL',
      `before.admin=${before?.admin} logoutStatus=${loStatus} after.authenticated=${after?.authenticated}`,
      'サーバ側セッション無効化（同トークンで再 auth.me が unauthenticated）')
  }

  // ===========================================================================
  // 会計UI一覧 (5.4)
  // ===========================================================================

  // 横-11: 未ログイン / 会員のみで /payments → 会計データ非表示・要会計ログイン
  {
    // anon
    const ctxA = await newCtx(browser); const pA = await ctxA.newPage()
    await pA.goto(BASE + '/payments', { waitUntil: 'networkidle' })
    await pA.waitForTimeout(600)
    const anonPrompt = await pA.locator('text=会計ログインが必要').count()
    const anonTable = await pA.locator('table').count()
    const anonLoginBtn = await pA.locator('text=会計でログイン').count()
    await shot(pA, 'cross-11-anon')
    await ctxA.close()
    // member-only
    const ctxM = await newCtx(browser); const pM = await ctxM.newPage()
    await devLogin(ctxM, { as: 'member' })
    await pM.goto(BASE + '/payments', { waitUntil: 'networkidle' })
    await pM.waitForTimeout(600)
    const memPrompt = await pM.locator('text=会計ログインが必要').count()
    const memTable = await pM.locator('table').count()
    await shot(pM, 'cross-11-member')
    await ctxM.close()
    const ok = anonPrompt > 0 && anonTable === 0 && anonLoginBtn > 0 && memPrompt > 0 && memTable === 0
    rec('横-11', ok ? 'PASS' : 'FAIL',
      `anon: prompt=${anonPrompt > 0} table=${anonTable} loginBtn=${anonLoginBtn > 0} | member: prompt=${memPrompt > 0} table=${memTable}`,
      '会計データ非表示・会計ログイン導線のみ（admin 専用）')
  }

  // 横-12: 会計で /payments 請求書タブ → listInvoices が表表示（直近 test invoice が出る）、各行 Dashboard リンク
  let firstInvoiceDashUrl = null
  {
    const ctx = await newCtx(browser); const page = await ctx.newPage()
    await devLogin(ctx, { as: 'admin' })
    await page.goto(BASE + '/payments', { waitUntil: 'networkidle' })
    await page.waitForTimeout(1500)
    // Data rows = rows that carry a Dashboard link (the empty-state row has none).
    // NOTE: each row has TWO font-mono.text-xs cells (ID + 支払いID), so counting
    // those double-counts; count rows by their first-column ID cell instead.
    const dataRows = await page.locator('tbody tr td:first-child.font-mono').count()
    const dashLinks = await page.locator('tbody a[target="_blank"], tbody a[href*="dashboard.stripe"]').count()
    // capture first row dashboard href for 横-25
    firstInvoiceDashUrl = await page.locator('tbody tr').first().locator('a').first().getAttribute('href').catch(() => null)
    await shot(page, 'cross-12-invoices')
    const ok = dataRows > 0 && dashLinks === dataRows
    rec('横-12', ok ? 'PASS' : 'FAIL',
      `dataRows=${dataRows} dashboardLinks=${dashLinks} firstDashHref=${firstInvoiceDashUrl}`,
      '直近 test invoice が表に表示・各行にちょうど 1 つの Dashboard リンク')
    await ctx.close()
  }

  // 横-25: 行の Dashboard リンク URL が test モードで /test/ を含む
  {
    let href = firstInvoiceDashUrl
    if (!href) {
      const ctx = await newCtx(browser); const page = await ctx.newPage()
      await devLogin(ctx, { as: 'admin' })
      await page.goto(BASE + '/payments', { waitUntil: 'networkidle' })
      await page.waitForTimeout(1500)
      href = await page.locator('tbody tr').first().locator('a').first().getAttribute('href').catch(() => null)
      await ctx.close()
    }
    const ok = !!href && href.includes('dashboard.stripe.com') && href.includes('/test/')
    rec('横-25', ok ? 'PASS' : (href ? 'FAIL' : 'BLOCKED'),
      `dashboardUrl=${href}`,
      ok ? 'test モードなので /test/ を含む（sk_test_）' : (href ? '' : '請求書行ゼロ'))
  }

  // 横-13: 決済セッションタブ → listCheckoutSessions 結果表示
  {
    const ctx = await newCtx(browser); const page = await ctx.newPage()
    await devLogin(ctx, { as: 'admin' })
    await page.goto(BASE + '/payments', { waitUntil: 'networkidle' })
    await page.getByRole('tab', { name: '決済セッション' }).click().catch(async () => {
      await page.locator('text=決済セッション').first().click()
    })
    await page.waitForTimeout(1500)
    // The checkout tab is now active: look at its table/empty-state.
    const dataRows = await page.locator('tbody tr td.font-mono.text-xs').count()
    const emptyMsg = await page.locator('text=表示できる決済セッションがありません').count()
    const errBanner = await page.locator('text=一覧の取得に失敗').count()
    await shot(page, 'cross-13-checkout')
    // PASS if the tab rendered a list (rows) OR a clean empty-state (no error).
    const ok = errBanner === 0 && (dataRows > 0 || emptyMsg > 0)
    rec('横-13', ok ? 'PASS' : 'FAIL',
      `dataRows=${dataRows} emptyState=${emptyMsg > 0} errorBanner=${errBanner > 0}`,
      dataRows > 0 ? 'セッション行表示' : 'クリーンな空表示（エラー無し）')
    await ctx.close()
  }

  // 横-14: status を paid に変更 → status:'paid' で再取得・カーソルリセットで先頭から
  {
    const ctx = await newCtx(browser); const page = await ctx.newPage()
    await devLogin(ctx, { as: 'admin' })
    // capture the outgoing listInvoices request payloads
    const reqs = []
    page.on('request', (r) => {
      if (r.url().includes('/rpc/payments/listInvoices') && r.method() === 'POST') {
        reqs.push(r.postData())
      }
    })
    await page.goto(BASE + '/payments', { waitUntil: 'networkidle' })
    await page.waitForTimeout(1200)
    // change USelect to paid (button + portal listbox; no native <select>)
    const before = reqs.length
    await pickFilter(page, 'paid')
    await page.waitForTimeout(1500)
    const paidReq = reqs.slice(before).find(p => p && /"status":"paid"/.test(p))
    // cursor reset: the paid refetch must NOT carry startingAfter (head fetch)
    const noCursor = paidReq ? !/"startingAfter":"[^"]+"/.test(paidReq) : false
    const rows = await page.locator('tbody tr td.font-mono.text-xs').count()
    await shot(page, 'cross-14-paid-filter')
    const ok = !!paidReq && noCursor
    rec('横-14', ok ? 'PASS' : 'FAIL',
      `paidRequestSent=${!!paidReq} cursorReset(noStartingAfter)=${noCursor} rowsAfter=${rows} payload=${paidReq ? paidReq.slice(0, 80) : 'n/a'}`,
      'status:paid で再取得・先頭から（startingAfter 無し）')
    await ctx.close()
  }

  // 横-17 (⚠️重要): status「すべて」を選んでも 500 にならない（ALL='all' センチネル）。
  //   実ブラウザでページが落ちず、listInvoices に status を渡さない（undefined）こと、
  //   console error / HTTP 500 が出ないことを監視。
  {
    const ctx = await newCtx(browser); const page = await ctx.newPage()
    await devLogin(ctx, { as: 'admin' })
    const consoleErrors = []
    const http500 = []
    const listReqs = []
    page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()) })
    page.on('response', (r) => {
      if (r.url().includes('/rpc/payments/listInvoices')) {
        if (r.status() >= 500) http500.push(`${r.status()} ${r.url()}`)
      }
    })
    page.on('request', (r) => {
      if (r.url().includes('/rpc/payments/listInvoices') && r.method() === 'POST') listReqs.push(r.postData())
    })
    await page.goto(BASE + '/payments', { waitUntil: 'networkidle' })
    await page.waitForTimeout(1000)
    // switch to 'paid' then back to 'すべて' (ALL) to exercise the sentinel.
    await pickFilter(page, 'paid')
    await page.waitForTimeout(1000)
    await pickFilter(page, 'すべて')
    await page.waitForTimeout(1500)
    // The "all" refetch must send NO status (undefined), not status:'' nor status:'all'.
    const allReq = [...listReqs].reverse().find(p => p && !/"startingAfter"/.test(p))
    const sentEmptyStatus = listReqs.some(p => p && /"status":""/.test(p))
    const sentAllSentinel = listReqs.some(p => p && /"status":"all"/.test(p))
    const errBanner = await page.locator('text=一覧の取得に失敗').count()
    const pageAlive = await page.locator('h1', { hasText: '入出金一覧' }).count()
    await shot(page, 'cross-17-all-sentinel')
    const ok = http500.length === 0 && errBanner === 0 && pageAlive > 0
      && !sentEmptyStatus && !sentAllSentinel
    rec('横-17', ok ? 'PASS' : 'FAIL',
      `HTTP500count=${http500.length} consoleErrors=${consoleErrors.length} errBanner=${errBanner} pageAlive=${pageAlive > 0} sentStatusEmpty=${sentEmptyStatus} sentStatusAll=${sentAllSentinel}`,
      http500.length ? `500s: ${http500.join('; ')}` : '500 無し・status は undefined で送信（空文字/all を送らない）')
  }

  // 横-15: ページネーション — hasMore true のとき「もっと読む」→ startingAfter で次ページ。
  //   データ不足で導線が出ない場合は「末尾で導線出ない」を確認（部分でも可）。
  {
    const ctx = await newCtx(browser); const page = await ctx.newPage()
    await devLogin(ctx, { as: 'admin' })
    const listReqs = []
    page.on('request', (r) => {
      if (r.url().includes('/rpc/payments/listInvoices') && r.method() === 'POST') listReqs.push(r.postData())
    })
    await page.goto(BASE + '/payments', { waitUntil: 'networkidle' })
    await page.waitForTimeout(1500)
    const moreBtn = page.locator('button', { hasText: 'もっと読む' })
    const hasMore = await moreBtn.count()
    let secondPageHadCursor = null, rowsBefore = null, rowsAfter = null
    if (hasMore > 0) {
      rowsBefore = await page.locator('tbody tr td.font-mono.text-xs').count()
      const before = listReqs.length
      await moreBtn.first().click()
      await page.waitForTimeout(1500)
      rowsAfter = await page.locator('tbody tr td.font-mono.text-xs').count()
      const nextReq = listReqs.slice(before).find(Boolean)
      secondPageHadCursor = nextReq ? /"startingAfter":"[^"]+"/.test(nextReq) : false
      const ok = secondPageHadCursor && rowsAfter > rowsBefore
      rec('横-15', ok ? 'PASS' : 'FAIL',
        `hasMore=true rowsBefore=${rowsBefore} rowsAfter=${rowsAfter} 2ndPageSentStartingAfter=${secondPageHadCursor}`,
        'もっと読む → startingAfter で追記読み込み')
    } else {
      // No more-button: confirm it is genuinely absent at the tail (partial PASS).
      const rows = await page.locator('tbody tr td.font-mono.text-xs').count()
      rec('横-15', 'PARTIAL',
        `hasMore=false rows=${rows} 「もっと読む」ボタン非表示`,
        '末尾で導線が出ないことを確認（全件 ≤ 1 ページ分）')
    }
    await ctx.close()
  }

  // 横-16: フィルタ高速変更で古い応答が表示に勝たない（request-seq）。
  //   draft→open→paid→all を高速連打し、最終表示と最後のリクエストが整合することを確認。
  {
    const ctx = await newCtx(browser); const page = await ctx.newPage()
    await devLogin(ctx, { as: 'admin' })
    const listReqs = []
    page.on('request', (r) => {
      if (r.url().includes('/rpc/payments/listInvoices') && r.method() === 'POST') listReqs.push(r.postData())
    })
    // Capture each list RESPONSE's request-status + first returned row id, in order,
    // so we can prove the LAST-issued filter's response is the one reflected.
    const responses = []
    page.on('response', async (r) => {
      if (r.url().includes('/rpc/payments/listInvoices') && r.request().method() === 'POST') {
        const reqStatus = (r.request().postData() || '').match(/"status":"([a-z]+)"/)?.[1] ?? 'ALL'
        responses.push({ reqStatus, httpStatus: r.status() })
      }
    })
    await page.goto(BASE + '/payments', { waitUntil: 'networkidle' })
    await page.waitForTimeout(1500)
    // Rapid filter changes via the USelect button+listbox. Each pick fires its own
    // listInvoices request; with the small inter-pick gap several are in flight at
    // once. Final filter = 'paid' (deterministic: every displayed row must read
    // 支払い状況=paid if the latest response won; a stale 'all'/'draft'/'open'
    // response winning would show mixed statuses → that's what request-seq prevents).
    await pickFilter(page, 'draft'); await page.waitForTimeout(80)
    await pickFilter(page, 'open'); await page.waitForTimeout(80)
    await pickFilter(page, 'すべて'); await page.waitForTimeout(80)
    await pickFilter(page, 'paid')
    await page.waitForTimeout(3000)
    const statuses = await page.locator('tbody tr td:nth-child(6)').allTextContents().catch(() => [])
    const cleaned = statuses.map(s => s.trim()).filter(Boolean)
    const errBanner = await page.locator('text=一覧の取得に失敗').count()
    await shot(page, 'cross-16-rapid-filter')
    const lastReqStatus = responses.length ? responses[responses.length - 1].reqStatus : null
    // The displayed table must match the FINAL selection (paid): no stale row wins.
    const allPaidOrEmpty = cleaned.length === 0 || cleaned.every(s => s === 'paid')
    const ok = errBanner === 0 && responses.length >= 2 && allPaidOrEmpty
    rec('横-16', ok ? 'PASS' : 'FAIL',
      `responsesFired=${responses.length} reqStatusOrder=${JSON.stringify(responses.map(r => r.reqStatus))} lastReqStatus=${lastReqStatus} displayedStatuses=${JSON.stringify(cleaned.slice(0, 8))} errBanner=${errBanner}`,
      ok ? '高速変更後の表示は最終フィルタ(paid)のみ＝古い応答が勝たない (invoiceSeq ガード)' : '')
    await ctx.close()
  }

  // ===========================================================================
  // 台帳・入金webhook (5.1) / 口座振込 (5.2)
  // ===========================================================================

  // 横-21: POST /webhook/invoice-paid に署名欠落/不正 → 4xx 拒否（処理しない）
  {
    // (a) 署名ヘッダ無し
    const noSig = curl([
      '-i', '-X', 'POST', BASE + '/webhook/invoice-paid',
      '-H', 'content-type: application/json',
      '--data', '{"id":"evt_fake","type":"invoice.paid"}',
    ])
    const noSigStatus = (noSig.match(/HTTP\/[\d.]+ (\d+)/) || [])[1]
    // (b) 署名不正
    const badSig = curl([
      '-i', '-X', 'POST', BASE + '/webhook/invoice-paid',
      '-H', 'content-type: application/json',
      '-H', 'stripe-signature: t=123,v1=deadbeef',
      '--data', '{"id":"evt_fake","type":"invoice.paid"}',
    ])
    const badSigStatus = (badSig.match(/HTTP\/[\d.]+ (\d+)/) || [])[1]
    const ok = noSigStatus === '400' && badSigStatus === '400'
    rec('横-21', ok ? 'PASS' : 'FAIL',
      `noSignature=${noSigStatus} badSignature=${badSigStatus}`,
      ok ? '署名欠落/不正とも 400（invalid Stripe signature）で処理せず拒否' : '')
  }

  // 横-05: 自分で発行した test invoice の payment_settings.payment_method_types に
  //   card と customer_balance が含まれ、customer_balance funding が jp_bank_transfer。
  {
    // Issue a FRESH standard invoice as a user via the UI path.
    const ctx = await newCtx(browser); const page = await ctx.newPage()
    const email = freshEmail('x05')
    await devLogin(ctx, { as: 'user', email })
    await page.goto(BASE + '/membership', { waitUntil: 'networkidle' })
    const issued = await page.evaluate(async ({ base, email }) => {
      const m = document.cookie.match(/(?:^|;\s*)__Host-checkin_csrf=([^;]+)/)
      const r = await fetch(base + '/rpc/membership/issueInvoice', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-csrf-token': m ? m[1] : '' },
        body: JSON.stringify({ json: { email, name: 'X05 Bank Transfer', feeType: 'new' } }),
      })
      const b = await r.json().catch(() => null)
      return { status: r.status, invoiceId: b?.json?.invoiceId }
    }, { base: BASE, email })
    await ctx.close()
    let methods = null, funding = null
    if (issued.invoiceId && SK) {
      const raw = curl([`https://api.stripe.com/v1/invoices/${issued.invoiceId}`, '-u', `${SK}:`])
      try {
        const inv = JSON.parse(raw)
        methods = inv?.payment_settings?.payment_method_types || null
        funding = inv?.payment_settings?.payment_method_options?.customer_balance?.bank_transfer?.type
          || inv?.payment_settings?.payment_method_options?.customer_balance?.funding_type
          || null
      } catch { /* parse error */ }
    }
    const hasCard = Array.isArray(methods) && methods.includes('card')
    const hasBalance = Array.isArray(methods) && methods.includes('customer_balance')
    const okFunding = funding === 'jp_bank_transfer'
    const ok = hasCard && hasBalance && okFunding
    rec('横-05', ok ? 'PASS' : 'FAIL',
      `invoiceId=${issued.invoiceId} methods=${JSON.stringify(methods)} customer_balance.funding=${funding}`,
      ok ? 'card + customer_balance(jp_bank_transfer) が請求書に設定' : '')
  }

  // 横-06: 口座振込の非同期着金合流 → 実着金が要る → BLOCKED（横-05 で手段提示済み）
  rec('横-06', 'BLOCKED',
    '実際の銀行振込（jp_bank_transfer）着金が必要。Stripe test では funding 確認まで（横-05）。',
    '検証に必要: test 銀行送金のシミュレート（Stripe Dashboard の「Pay invoice」test bank transfer）または webhook の invoice.paid を実署名で投入できる経路')

  // domain 不変条件（UI で安全に作れない）→ vitest 裏取りは run_cross の外で別途実行。
  for (const id of ['横-01', '横-02', '横-03', '横-04', '横-22', '横-23', '横-24'])
    rec(id, 'DEFER-UT', 'domain/webhook 不変条件 → vitest で裏取り（本スクリプト外）')

  // ===========================================================================
  log('\n\n===== SUMMARY =====')
  log('| ID | 判定 | 観測 |')
  for (const r of results) log(`| ${r.id} | ${r.verdict} | ${r.observed}${r.note ? ' // ' + r.note : ''} |`)
} catch (e) {
  console.error('RUN FAIL', e.stack)
} finally {
  await browser.close()
}
