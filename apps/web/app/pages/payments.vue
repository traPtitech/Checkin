<script setup lang="ts">
import { ORPCError } from '@orpc/client'
import type { PaymentView } from '@checkin/api-contract'

definePageMeta({ layout: 'default' })

const { $orpc } = useNuxtApp()
const { data: me } = useAuthMe()
const { formatAmount, formatDateTime } = useFormatters()

// Server `adminProc` is the real authz; this gate is for navigation/UX only.
const admin = computed(() => me.value?.admin ?? false)

// Accountant (traQ) login is a full-page Nitro route, so use a real <a href>.
const loginHref = `/login?redirect=${encodeURIComponent('/payments')}`

// --- Tabs (請求書 / 決済セッション) ------------------------------------------
type TabKey = 'invoices' | 'checkout-sessions'
const tabItems = [
  { value: 'invoices' as const, label: '請求書', slot: 'invoices' as const },
  { value: 'checkout-sessions' as const, label: '決済セッション', slot: 'checkout-sessions' as const },
]
const activeTab = ref<TabKey>('invoices')

// UTabs types `update:modelValue` as `string | number` (reka-ui's TabsRoot model
// type; the item values are not inferred back into it), so `v-model` cannot write
// into a `Ref<TabKey>` under `strictTemplates`. Narrow the emitted value instead:
// `tabItems` only carries the two keys, so every emitted value passes the guard.
function onTabChange(value: string | number) {
  if (value === 'invoices' || value === 'checkout-sessions') {
    activeTab.value = value
  }
}

// --- Status filters (per tab) -------------------------------------------------
// `ALL` is the "すべて" sentinel → sent to the API as `status: undefined`. It must
// NOT be an empty string: @nuxt/ui's USelect reserves '' for clearing/placeholder
// and throws if an item's value is ''.
const ALL = 'all'
// The status lists are the single source for both the select items and the
// type of the filter, so the two cannot drift apart.
const INVOICE_STATUSES = ['draft', 'open', 'paid', 'uncollectible', 'void'] as const
const CHECKOUT_STATUSES = ['open', 'complete', 'expired'] as const
type InvoiceStatus = typeof INVOICE_STATUSES[number]
type CheckoutStatus = typeof CHECKOUT_STATUSES[number]

const invoiceStatusItems = [
  { value: ALL, label: 'すべて' },
  ...INVOICE_STATUSES.map(s => ({ value: s, label: s })),
]
const checkoutStatusItems = [
  { value: ALL, label: 'すべて' },
  ...CHECKOUT_STATUSES.map(s => ({ value: s, label: s })),
]

// The ref holds either a Stripe status or the `ALL` sentinel, so the request
// below narrows to the contract's status union without an assertion. USelect
// types its model as a plain `string`, so the emitted value is narrowed here
// rather than written straight into the ref by `v-model`.
const invoiceStatus = ref<InvoiceStatus | typeof ALL>(ALL)
const checkoutStatus = ref<CheckoutStatus | typeof ALL>(ALL)

function onInvoiceStatusChange(value: string) {
  invoiceStatus.value = INVOICE_STATUSES.find(s => s === value) ?? ALL
}
function onCheckoutStatusChange(value: string) {
  checkoutStatus.value = CHECKOUT_STATUSES.find(s => s === value) ?? ALL
}

// --- Append-style pagination state (one set per tab) --------------------------
interface ListState {
  items: PaymentView[]
  startingAfter: string | undefined
  hasMore: boolean
  pending: boolean
  error: string | null
}
function emptyState(): ListState {
  return { items: [], startingAfter: undefined, hasMore: false, pending: false, error: null }
}
const invoices = reactive<ListState>(emptyState())
const checkout = reactive<ListState>(emptyState())

function errorMessageFor(e: unknown): string {
  if (e instanceof ORPCError) {
    if (e.code === 'UNAUTHORIZED' || e.code === 'FORBIDDEN') {
      return '会計セッションが必要です。会計でログインしてください。'
    }
    return '一覧の取得に失敗しました。Stripe の設定や接続状況をご確認ください。'
  }
  return '一覧の取得に失敗しました。時間をおいて再度お試しください。'
}

// Monotonic request tokens: a newer load (e.g. a filter change) supersedes an
// in-flight one so a stale response can never overwrite the current filter. We
// deliberately do NOT early-return while pending — that would silently drop a
// filter-change refetch and leave the table showing the previous filter.
let invoiceSeq = 0
let checkoutSeq = 0

// Fetch the invoices list. `reset` clears the accumulated rows + cursor first.
async function loadInvoices(reset: boolean) {
  const reqId = ++invoiceSeq
  invoices.pending = true
  invoices.error = null
  // Snapshot the cursor before any clear; a reset always starts from the head.
  const startingAfter = reset ? undefined : invoices.startingAfter
  if (reset) {
    invoices.items = []
    invoices.startingAfter = undefined
    invoices.hasMore = false
  }
  try {
    const page = await $orpc.payments.listInvoices({
      status: invoiceStatus.value === ALL ? undefined : invoiceStatus.value,
      startingAfter,
    })
    if (reqId !== invoiceSeq) {
      return
    }
    invoices.items = reset ? page.data : [...invoices.items, ...page.data]
    invoices.hasMore = listHasMore(page)
    invoices.startingAfter = page.nextCursor ?? undefined
  }
  catch (e) {
    if (reqId === invoiceSeq) {
      invoices.error = errorMessageFor(e)
    }
  }
  finally {
    if (reqId === invoiceSeq) {
      invoices.pending = false
    }
  }
}

async function loadCheckout(reset: boolean) {
  const reqId = ++checkoutSeq
  checkout.pending = true
  checkout.error = null
  const startingAfter = reset ? undefined : checkout.startingAfter
  if (reset) {
    checkout.items = []
    checkout.startingAfter = undefined
    checkout.hasMore = false
  }
  try {
    const page = await $orpc.payments.listCheckoutSessions({
      status: checkoutStatus.value === ALL ? undefined : checkoutStatus.value,
      startingAfter,
    })
    if (reqId !== checkoutSeq) {
      return
    }
    checkout.items = reset ? page.data : [...checkout.items, ...page.data]
    checkout.hasMore = listHasMore(page)
    checkout.startingAfter = page.nextCursor ?? undefined
  }
  catch (e) {
    if (reqId === checkoutSeq) {
      checkout.error = errorMessageFor(e)
    }
  }
  finally {
    if (reqId === checkoutSeq) {
      checkout.pending = false
    }
  }
}

// Row display helpers (Stripe fields can be null/empty).
function customerLabel(row: PaymentView): string {
  return row.customer.name ?? row.customer.id ?? '—'
}
function productLabel(row: PaymentView): string {
  return row.product.description ?? row.product.priceId ?? '—'
}

// Changing status resets that tab's list and refetches from the start.
watch(invoiceStatus, () => {
  if (admin.value) {
    void loadInvoices(true)
  }
})
watch(checkoutStatus, () => {
  if (admin.value) {
    void loadCheckout(true)
  }
})

// Initial load for the active tab + lazily load the other tab on first switch.
const checkoutLoaded = ref(false)
watch(activeTab, (tab) => {
  if (tab === 'checkout-sessions' && admin.value && !checkoutLoaded.value) {
    checkoutLoaded.value = true
    void loadCheckout(true)
  }
})

onMounted(() => {
  if (admin.value) {
    void loadInvoices(true)
  }
})
</script>

<template>
  <div class="space-y-6">
    <section class="space-y-2">
      <h1 class="text-xl font-bold text-highlighted">
        入出金一覧
      </h1>
      <p class="text-muted text-sm">
        請求書・決済セッションの一覧と Stripe ダッシュボードへのリンク（会計のみ）。
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

    <!-- Accountant: tabs (請求書 / 決済セッション). -->
    <section v-else>
      <UTabs
        :model-value="activeTab"
        :items="tabItems"
        class="w-full"
        @update:model-value="onTabChange"
      >
        <template #invoices>
          <div class="space-y-4 pt-4">
            <div class="flex items-center gap-3">
              <USelect
                :model-value="invoiceStatus"
                :items="invoiceStatusItems"
                class="w-48"
                @update:model-value="onInvoiceStatusChange"
              />
              <UButton
                color="neutral"
                variant="subtle"
                size="sm"
                icon="i-lucide-refresh-cw"
                :loading="invoices.pending"
                :disabled="invoices.pending"
                @click="loadInvoices(true)"
              >
                再取得
              </UButton>
            </div>

            <UAlert
              v-if="invoices.error"
              color="error"
              variant="subtle"
              icon="i-lucide-circle-alert"
              :title="invoices.error"
            />

            <div class="overflow-x-auto rounded border border-default">
              <table class="w-full text-sm">
                <thead class="text-left text-muted border-b border-default">
                  <tr>
                    <th class="px-3 py-2 font-medium">
                      ID
                    </th>
                    <th class="px-3 py-2 font-medium">
                      金額
                    </th>
                    <th class="px-3 py-2 font-medium">
                      通貨
                    </th>
                    <th class="px-3 py-2 font-medium">
                      日時
                    </th>
                    <th class="px-3 py-2 font-medium">
                      customer
                    </th>
                    <th class="px-3 py-2 font-medium">
                      支払い状況
                    </th>
                    <th class="px-3 py-2 font-medium">
                      支払い ID
                    </th>
                    <th class="px-3 py-2 font-medium">
                      商品
                    </th>
                    <th class="px-3 py-2 font-medium">
                      Dashboard
                    </th>
                  </tr>
                </thead>
                <tbody>
                  <tr
                    v-for="row in invoices.items"
                    :key="row.id"
                    class="border-b border-default/60 last:border-0"
                  >
                    <td class="px-3 py-2 font-mono text-xs">
                      {{ row.id }}
                    </td>
                    <td class="px-3 py-2 whitespace-nowrap">
                      {{ formatAmount(row.amount, row.currency) }}
                    </td>
                    <td class="px-3 py-2 uppercase">
                      {{ row.currency }}
                    </td>
                    <td class="px-3 py-2 whitespace-nowrap">
                      {{ formatDateTime(row.createdAt) }}
                    </td>
                    <td class="px-3 py-2">
                      {{ customerLabel(row) }}
                    </td>
                    <td class="px-3 py-2">
                      {{ row.paymentStatus }}
                    </td>
                    <td class="px-3 py-2 font-mono text-xs">
                      {{ row.paymentId ?? '—' }}
                    </td>
                    <td class="px-3 py-2">
                      {{ productLabel(row) }}
                    </td>
                    <td class="px-3 py-2">
                      <UButton
                        :to="row.dashboardUrl"
                        target="_blank"
                        external
                        color="neutral"
                        variant="link"
                        size="xs"
                        icon="i-lucide-external-link"
                      >
                        開く
                      </UButton>
                    </td>
                  </tr>
                  <tr v-if="!invoices.items.length && !invoices.pending">
                    <td
                      colspan="9"
                      class="px-3 py-6 text-center text-muted"
                    >
                      表示できる請求書がありません。
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>

            <div
              v-if="invoices.hasMore"
              class="flex justify-center"
            >
              <UButton
                color="neutral"
                variant="subtle"
                :loading="invoices.pending"
                :disabled="invoices.pending"
                @click="loadInvoices(false)"
              >
                もっと読む
              </UButton>
            </div>
          </div>
        </template>

        <template #checkout-sessions>
          <div class="space-y-4 pt-4">
            <div class="flex items-center gap-3">
              <USelect
                :model-value="checkoutStatus"
                :items="checkoutStatusItems"
                class="w-48"
                @update:model-value="onCheckoutStatusChange"
              />
              <UButton
                color="neutral"
                variant="subtle"
                size="sm"
                icon="i-lucide-refresh-cw"
                :loading="checkout.pending"
                :disabled="checkout.pending"
                @click="loadCheckout(true)"
              >
                再取得
              </UButton>
            </div>

            <UAlert
              v-if="checkout.error"
              color="error"
              variant="subtle"
              icon="i-lucide-circle-alert"
              :title="checkout.error"
            />

            <div class="overflow-x-auto rounded border border-default">
              <table class="w-full text-sm">
                <thead class="text-left text-muted border-b border-default">
                  <tr>
                    <th class="px-3 py-2 font-medium">
                      ID
                    </th>
                    <th class="px-3 py-2 font-medium">
                      金額
                    </th>
                    <th class="px-3 py-2 font-medium">
                      通貨
                    </th>
                    <th class="px-3 py-2 font-medium">
                      日時
                    </th>
                    <th class="px-3 py-2 font-medium">
                      customer
                    </th>
                    <th class="px-3 py-2 font-medium">
                      支払い状況
                    </th>
                    <th class="px-3 py-2 font-medium">
                      支払い ID
                    </th>
                    <th class="px-3 py-2 font-medium">
                      商品
                    </th>
                    <th class="px-3 py-2 font-medium">
                      Dashboard
                    </th>
                  </tr>
                </thead>
                <tbody>
                  <tr
                    v-for="row in checkout.items"
                    :key="row.id"
                    class="border-b border-default/60 last:border-0"
                  >
                    <td class="px-3 py-2 font-mono text-xs">
                      {{ row.id }}
                    </td>
                    <td class="px-3 py-2 whitespace-nowrap">
                      {{ formatAmount(row.amount, row.currency) }}
                    </td>
                    <td class="px-3 py-2 uppercase">
                      {{ row.currency }}
                    </td>
                    <td class="px-3 py-2 whitespace-nowrap">
                      {{ formatDateTime(row.createdAt) }}
                    </td>
                    <td class="px-3 py-2">
                      {{ customerLabel(row) }}
                    </td>
                    <td class="px-3 py-2">
                      {{ row.paymentStatus }}
                    </td>
                    <td class="px-3 py-2 font-mono text-xs">
                      {{ row.paymentId ?? '—' }}
                    </td>
                    <td class="px-3 py-2">
                      {{ productLabel(row) }}
                    </td>
                    <td class="px-3 py-2">
                      <UButton
                        :to="row.dashboardUrl"
                        target="_blank"
                        external
                        color="neutral"
                        variant="link"
                        size="xs"
                        icon="i-lucide-external-link"
                      >
                        開く
                      </UButton>
                    </td>
                  </tr>
                  <tr v-if="!checkout.items.length && !checkout.pending">
                    <td
                      colspan="9"
                      class="px-3 py-6 text-center text-muted"
                    >
                      表示できる決済セッションがありません。
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>

            <div
              v-if="checkout.hasMore"
              class="flex justify-center"
            >
              <UButton
                color="neutral"
                variant="subtle"
                :loading="checkout.pending"
                :disabled="checkout.pending"
                @click="loadCheckout(false)"
              >
                もっと読む
              </UButton>
            </div>
          </div>
        </template>
      </UTabs>
    </section>
  </div>
</template>
