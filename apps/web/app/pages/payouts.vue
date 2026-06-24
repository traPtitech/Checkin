<script setup lang="ts">
import { ORPCError } from '@orpc/client'
import type { PayoutRow } from '@checkin/api'

definePageMeta({ layout: 'default' })

const { $orpc } = useNuxtApp()
const { data: me } = useAuthMe()
const { formatAmount } = useFormatters()

// Server `adminProc` is the real authz; this gate is for navigation/UX only.
const admin = computed(() => me.value?.admin ?? false)

// Accountant (traQ) login is a full-page Nitro route, so use a real <a href>.
const loginHref = `/login?redirect=${encodeURIComponent('/payouts')}`

// --- Status filter ------------------------------------------------------------
// `ALL` is the "すべて" sentinel → sent to the API as `status: undefined`. It must
// NOT be an empty string: @nuxt/ui's USelect reserves '' for clearing/placeholder
// and throws if an item's value is ''.
const ALL = 'all'
type PayoutStatus = 'pending' | 'onboarding_waiting' | 'processing' | 'paid' | 'failed'
const statusItems = [
  { value: ALL, label: 'すべて' },
  { value: 'pending', label: 'pending' },
  { value: 'onboarding_waiting', label: 'onboarding_waiting' },
  { value: 'processing', label: 'processing' },
  { value: 'paid', label: 'paid' },
  { value: 'failed', label: 'failed' },
]
const status = ref<string>(ALL)

// Map payout status to a UBadge color.
function statusColor(s: string): 'success' | 'error' | 'warning' | 'info' | 'neutral' {
  switch (s) {
    case 'paid':
      return 'success'
    case 'failed':
      return 'error'
    case 'onboarding_waiting':
      return 'warning'
    case 'processing':
      return 'info'
    default:
      return 'neutral'
  }
}

// Return a copy of `record` without `key` (avoids dynamic `delete`).
function withoutKey<T>(record: Record<string, T>, key: string): Record<string, T> {
  const { [key]: _omit, ...rest } = record
  return rest
}

function errorMessageFor(e: unknown): string {
  if (e instanceof ORPCError) {
    if (e.code === 'UNAUTHORIZED' || e.code === 'FORBIDDEN') {
      return '会計セッションが必要です。会計でログインしてください。'
    }
    return '操作に失敗しました。Jomon／Stripe の接続状況をご確認ください。'
  }
  return '操作に失敗しました。時間をおいて再度お試しください。'
}

// --- List ---------------------------------------------------------------------
const items = ref<PayoutRow[]>([])
const listPending = ref(false)
const listError = ref<string | null>(null)

// Monotonic request token: a newer refresh (filter change / post-mutation
// reload) supersedes an in-flight one so a stale response can't overwrite the
// list for the current filter. We don't early-return while pending — that would
// drop a filter-change refetch.
let listSeq = 0

async function loadList() {
  const reqId = ++listSeq
  listPending.value = true
  listError.value = null
  try {
    const res = await $orpc.payouts.list({
      status: (status.value === ALL ? undefined : status.value) as PayoutStatus | undefined,
    })
    if (reqId !== listSeq) {
      return
    }
    items.value = res.items
  }
  catch (e) {
    if (reqId === listSeq) {
      listError.value = errorMessageFor(e)
    }
  }
  finally {
    if (reqId === listSeq) {
      listPending.value = false
    }
  }
}

watch(status, () => {
  if (admin.value) {
    void loadList()
  }
})

// --- Jomon 取込・前進 (processApproved) ---------------------------------------
const processing = ref(false)
const processError = ref<string | null>(null)
const processSummary = ref<Record<string, unknown> | null>(null)

// Applications skipped because they have multiple unpaid payees (v1 has no
// per-payee amount, so they are not auto-paid). Surfaced as a manual-action alert.
const multiPayeeRefs = computed<string[]>(() => {
  const v = processSummary.value?.multiPayeeRefs
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
})

async function onProcessApproved() {
  if (processing.value) {
    return
  }
  processing.value = true
  processError.value = null
  processSummary.value = null
  try {
    const summary = await $orpc.payouts.processApproved()
    processSummary.value = summary as unknown as Record<string, unknown>
    await loadList()
  }
  catch (e) {
    processError.value = errorMessageFor(e)
  }
  finally {
    processing.value = false
  }
}

// --- Per-row execute (前進／再試行) -------------------------------------------
const executing = ref<Set<string>>(new Set())
const executeResult = ref<Record<string, Record<string, unknown>>>({})
const executeError = ref<Record<string, string>>({})

async function onExecute(jomonRef: string) {
  if (executing.value.has(jomonRef)) {
    return
  }
  executing.value = new Set(executing.value).add(jomonRef)
  executeError.value = withoutKey(executeError.value, jomonRef)
  try {
    const result = await $orpc.payouts.execute({ jomonRef })
    executeResult.value = { ...executeResult.value, [jomonRef]: result as unknown as Record<string, unknown> }
    await loadList()
  }
  catch (e) {
    executeError.value = { ...executeError.value, [jomonRef]: errorMessageFor(e) }
  }
  finally {
    const next = new Set(executing.value)
    next.delete(jomonRef)
    executing.value = next
  }
}

// --- Per-row onboarding link (createOnboardingLink) ---------------------------
const onboardingLinking = ref<Set<string>>(new Set())
const onboardingUrl = ref<Record<string, string>>({})
const onboardingError = ref<Record<string, string>>({})

async function onCreateOnboardingLink(userId: string) {
  if (onboardingLinking.value.has(userId)) {
    return
  }
  onboardingLinking.value = new Set(onboardingLinking.value).add(userId)
  onboardingError.value = withoutKey(onboardingError.value, userId)
  try {
    const res = await $orpc.payouts.createOnboardingLink({ userId })
    // Display only — never auto-send and never log the URL (sensitive).
    onboardingUrl.value = { ...onboardingUrl.value, [userId]: res.url }
    // Issuing a link advances onboarding to `requested` server-side; refresh
    // so the list reflects the state change (spec: 状態変更操作後は一覧を再取得).
    await loadList()
  }
  catch (e) {
    onboardingError.value = { ...onboardingError.value, [userId]: errorMessageFor(e) }
  }
  finally {
    const next = new Set(onboardingLinking.value)
    next.delete(userId)
    onboardingLinking.value = next
  }
}

// --- Per-row onboarding status (onboardingStatus) -----------------------------
const onboardingChecking = ref<Set<string>>(new Set())
const onboardingStatus = ref<Record<string, { status: string, hasConnectedAccount: boolean }>>({})

async function onCheckOnboardingStatus(userId: string) {
  if (onboardingChecking.value.has(userId)) {
    return
  }
  onboardingChecking.value = new Set(onboardingChecking.value).add(userId)
  onboardingError.value = withoutKey(onboardingError.value, userId)
  try {
    const res = await $orpc.payouts.onboardingStatus({ userId })
    onboardingStatus.value = { ...onboardingStatus.value, [userId]: res }
  }
  catch (e) {
    onboardingError.value = { ...onboardingError.value, [userId]: errorMessageFor(e) }
  }
  finally {
    const next = new Set(onboardingChecking.value)
    next.delete(userId)
    onboardingChecking.value = next
  }
}

function writtenBack(value: PayoutRow['jomonWrittenBackAt']): string {
  return value ? '書き戻し済み' : '未'
}

onMounted(() => {
  if (admin.value) {
    void loadList()
  }
})
</script>

<template>
  <div class="space-y-6">
    <section class="space-y-2">
      <h1 class="text-xl font-bold text-highlighted">
        払い戻し管理
      </h1>
      <p class="text-muted text-sm">
        Jomon 承認済み振込依頼の取込・実行と、onboarding の発行・状態確認（会計のみ）。
      </p>
    </section>

    <!-- Not an accountant: no data, just a login prompt. -->
    <section
      v-if="!admin"
      class="space-y-4"
    >
      <UAlert
        color="warning"
        variant="subtle"
        icon="i-lucide-lock"
        title="会計ログインが必要です"
        description="このページは会計（管理）のみが利用できます。会計アカウントでログインしてください。"
      />
      <UButton
        :href="loginHref"
        color="primary"
        external
        icon="i-lucide-log-in"
      >
        会計でログイン
      </UButton>
    </section>

    <!-- Accountant: filter + ingest + table. -->
    <section
      v-else
      class="space-y-4"
    >
      <div class="flex flex-wrap items-center gap-3">
        <USelect
          v-model="status"
          :items="statusItems"
          class="w-56"
        />
        <UButton
          color="neutral"
          variant="subtle"
          size="sm"
          icon="i-lucide-refresh-cw"
          :loading="listPending"
          :disabled="listPending"
          @click="loadList"
        >
          再取得
        </UButton>
        <UButton
          color="primary"
          icon="i-lucide-download"
          :loading="processing"
          :disabled="processing"
          @click="onProcessApproved"
        >
          Jomon 取込・前進
        </UButton>
      </div>

      <UAlert
        v-if="processError"
        color="error"
        variant="subtle"
        icon="i-lucide-circle-alert"
        :title="processError"
      />

      <UAlert
        v-if="processSummary"
        color="success"
        variant="subtle"
        icon="i-lucide-check"
        title="取込・前進が完了しました"
      >
        <template #description>
          <dl class="grid grid-cols-2 gap-x-4 gap-y-1 text-sm sm:grid-cols-3">
            <div
              v-for="(value, key) in processSummary"
              :key="key"
              class="flex justify-between gap-2"
            >
              <dt class="text-muted">
                {{ key }}
              </dt>
              <dd class="font-medium">
                {{ Array.isArray(value) ? value.join(', ') || '—' : String(value) }}
              </dd>
            </div>
          </dl>
        </template>
      </UAlert>

      <UAlert
        v-if="multiPayeeRefs.length"
        color="warning"
        variant="subtle"
        icon="i-lucide-triangle-alert"
        title="複数受取人の申請があります（自動処理されません・手動対応が必要）"
        :description="`対象の申請ID: ${multiPayeeRefs.join(', ')}`"
      />

      <UAlert
        v-if="listError"
        color="error"
        variant="subtle"
        icon="i-lucide-circle-alert"
        :title="listError"
      />

      <div class="overflow-x-auto rounded border border-default">
        <table class="w-full text-sm">
          <thead class="text-left text-muted border-b border-default">
            <tr>
              <th class="px-3 py-2 font-medium">
                jomonRef
              </th>
              <th class="px-3 py-2 font-medium">
                userId
              </th>
              <th class="px-3 py-2 font-medium">
                金額
              </th>
              <th class="px-3 py-2 font-medium">
                通貨
              </th>
              <th class="px-3 py-2 font-medium">
                status
              </th>
              <th class="px-3 py-2 font-medium">
                transfer ID
              </th>
              <th class="px-3 py-2 font-medium">
                Jomon 書き戻し
              </th>
              <th class="px-3 py-2 font-medium">
                操作
              </th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="row in items"
              :key="row.id"
              class="border-b border-default/60 align-top last:border-0"
            >
              <td class="px-3 py-2 font-mono text-xs">
                {{ row.jomonRef }}
              </td>
              <td class="px-3 py-2 font-mono text-xs">
                {{ row.userId ?? '—' }}
              </td>
              <td class="px-3 py-2 whitespace-nowrap">
                {{ formatAmount(row.amount, row.currency) }}
              </td>
              <td class="px-3 py-2 uppercase">
                {{ row.currency }}
              </td>
              <td class="px-3 py-2">
                <UBadge
                  :color="statusColor(row.status)"
                  variant="subtle"
                  size="sm"
                >
                  {{ row.status }}
                </UBadge>
              </td>
              <td class="px-3 py-2 font-mono text-xs">
                {{ row.stripeTransferId ?? '—' }}
              </td>
              <td class="px-3 py-2">
                {{ writtenBack(row.jomonWrittenBackAt) }}
              </td>
              <td class="px-3 py-2">
                <div class="space-y-2">
                  <div class="flex flex-wrap gap-2">
                    <UButton
                      v-if="row.status !== 'paid'"
                      color="primary"
                      variant="subtle"
                      size="xs"
                      icon="i-lucide-play"
                      :loading="executing.has(row.jomonRef)"
                      :disabled="executing.has(row.jomonRef)"
                      @click="onExecute(row.jomonRef)"
                    >
                      {{ row.status === 'failed' ? '再試行' : '実行' }}
                    </UButton>
                    <template v-if="row.userId">
                      <UButton
                        color="neutral"
                        variant="subtle"
                        size="xs"
                        icon="i-lucide-link"
                        :loading="onboardingLinking.has(row.userId)"
                        :disabled="onboardingLinking.has(row.userId)"
                        @click="onCreateOnboardingLink(row.userId)"
                      >
                        onboarding リンク発行
                      </UButton>
                      <UButton
                        color="neutral"
                        variant="subtle"
                        size="xs"
                        icon="i-lucide-info"
                        :loading="onboardingChecking.has(row.userId)"
                        :disabled="onboardingChecking.has(row.userId)"
                        @click="onCheckOnboardingStatus(row.userId)"
                      >
                        onboarding 状態
                      </UButton>
                    </template>
                  </div>

                  <!-- Execute result / error (per row). -->
                  <UAlert
                    v-if="executeError[row.jomonRef]"
                    color="error"
                    variant="subtle"
                    size="sm"
                    icon="i-lucide-circle-alert"
                    :title="executeError[row.jomonRef]"
                  />
                  <p
                    v-else-if="executeResult[row.jomonRef]"
                    class="text-xs text-muted"
                  >
                    実行結果:
                    <span
                      v-for="(value, key) in executeResult[row.jomonRef]"
                      :key="key"
                      class="mr-2"
                    >
                      {{ key }}={{ String(value) }}
                    </span>
                  </p>

                  <!-- Onboarding link (display only; do not auto-send/log). -->
                  <div
                    v-if="row.userId && onboardingUrl[row.userId]"
                    class="space-y-1"
                  >
                    <p class="text-xs text-muted">
                      onboarding URL（本人へ転送してください）
                    </p>
                    <UInput
                      :model-value="onboardingUrl[row.userId]"
                      readonly
                      size="sm"
                      class="w-full"
                    />
                  </div>

                  <!-- Onboarding status (per row). -->
                  <p
                    v-if="row.userId && onboardingStatus[row.userId]"
                    class="text-xs text-muted"
                  >
                    onboarding 状態: {{ onboardingStatus[row.userId]?.status }} ／ connected account:
                    {{ onboardingStatus[row.userId]?.hasConnectedAccount ? 'あり' : 'なし' }}
                  </p>

                  <UAlert
                    v-if="row.userId && onboardingError[row.userId]"
                    color="error"
                    variant="subtle"
                    size="sm"
                    icon="i-lucide-circle-alert"
                    :title="onboardingError[row.userId]"
                  />
                </div>
              </td>
            </tr>
            <tr v-if="!items.length && !listPending">
              <td
                colspan="8"
                class="px-3 py-6 text-center text-muted"
              >
                表示できる払い戻しがありません。
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>
  </div>
</template>
