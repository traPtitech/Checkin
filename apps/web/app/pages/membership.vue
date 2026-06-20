<script setup lang="ts">
import { ORPCError } from '@orpc/client'

const { $orpc } = useNuxtApp()
const route = useRoute()
// TODO: rework in add-member-ui — minimal adaptation to the dual-identity auth.me.
const { data: me } = useAuthMe()

// A billable isct user (hasUser) can issue their own invoice.
const isUser = computed(() => me.value?.hasUser ?? false)

// --- Membership categories (区分) ---------------------------------------------
// 新規入部 / 再入部 → feeType 'new'; 現役 → feeType 'continuation'.
// The special ¥2,000 fee is accountant-only and never shown here.
type Category = 'new' | 'rejoin' | 'continuation'
type FeeType = 'new' | 'continuation'

const CATEGORIES: { value: Category, label: string, feeType: FeeType, description: string }[] = [
  { value: 'new', label: '新規入部', feeType: 'new', description: '今年度から新しく入部する方' },
  { value: 'rejoin', label: '再入部', feeType: 'new', description: '一度退部して再び入部する方' },
  { value: 'continuation', label: '現役', feeType: 'continuation', description: '継続して在籍している方' },
]

function feeTypeOf(category: Category): FeeType {
  return CATEGORIES.find(c => c.value === category)?.feeType ?? 'continuation'
}

// `type` query carried over from the logged-out choice maps to invoice feeType.
function feeTypeFromQuery(raw: unknown): FeeType {
  return raw === 'new' ? 'new' : 'continuation'
}

// --- Logged-out: choose a category, then route to email verification ---------
function chooseCategory(category: Category) {
  const target = `/membership?type=${feeTypeOf(category)}`
  return navigateTo(`/verify-email?redirect=${encodeURIComponent(target)}`)
}

// --- Logged-in: invoice form -------------------------------------------------
const feeTypeOptions = [
  { label: '新規入部 / 再入部', value: 'new' as const },
  { label: '現役', value: 'continuation' as const },
]

const form = reactive({
  email: '',
  name: '',
  feeType: feeTypeFromQuery(route.query.type),
})

const pending = ref(false)
const errorMessage = ref<string | null>(null)
const hostedInvoiceUrl = ref<string | null>(null)

async function onSubmit() {
  if (pending.value) {
    return
  }
  pending.value = true
  errorMessage.value = null
  hostedInvoiceUrl.value = null
  try {
    const result = await $orpc.membership.issueInvoice({
      email: form.email,
      name: form.name,
      feeType: form.feeType,
    })
    hostedInvoiceUrl.value = result.hostedInvoiceUrl
  }
  catch (e) {
    errorMessage.value = e instanceof ORPCError
      ? e.message
      : '請求書の発行に失敗しました。時間をおいて再度お試しください。'
  }
  finally {
    pending.value = false
  }
}
</script>

<template>
  <div class="max-w-md mx-auto space-y-6">
    <section class="space-y-2">
      <h1 class="text-xl font-bold text-highlighted">
        部費の支払い
      </h1>
      <p class="text-muted text-sm">
        部費・入部費をオンラインで支払えます。
      </p>
    </section>

    <!-- Logged out (isct unverified): choose a category → email verification. -->
    <section
      v-if="!isUser"
      class="space-y-3"
    >
      <p class="text-default text-sm">
        まずは区分を選択してください。メールアドレスの確認後、支払いに進めます。
      </p>
      <div class="grid gap-3">
        <UCard
          v-for="c in CATEGORIES"
          :key="c.value"
          class="cursor-pointer transition hover:ring-2 hover:ring-primary"
          @click="chooseCategory(c.value)"
        >
          <div class="flex items-center justify-between gap-3">
            <div>
              <p class="font-semibold text-highlighted">
                {{ c.label }}
              </p>
              <p class="text-sm text-muted">
                {{ c.description }}
              </p>
            </div>
            <UIcon
              name="i-lucide-chevron-right"
              class="text-dimmed size-5 shrink-0"
            />
          </div>
        </UCard>
      </div>
    </section>

    <!-- Logged in (isct verified): invoice form. -->
    <section
      v-else
      class="space-y-4"
    >
      <UAlert
        v-if="hostedInvoiceUrl"
        color="success"
        variant="subtle"
        icon="i-lucide-check"
        title="請求書を発行しました"
        description="下のボタンから支払いページへ進んでください。"
      />

      <UButton
        v-if="hostedInvoiceUrl"
        :to="hostedInvoiceUrl"
        target="_blank"
        external
        color="primary"
        size="lg"
        block
        icon="i-lucide-external-link"
      >
        支払いページへ進む
      </UButton>

      <template v-else>
        <UAlert
          v-if="errorMessage"
          color="error"
          variant="subtle"
          icon="i-lucide-circle-alert"
          :title="errorMessage"
        />

        <UForm
          :state="form"
          class="space-y-4"
          @submit="onSubmit"
        >
          <UFormField
            label="メールアドレス"
            name="email"
            description="確認したメールアドレスを再入力してください。"
            required
          >
            <UInput
              v-model="form.email"
              type="email"
              placeholder="you@m.isct.ac.jp"
              autocomplete="email"
              required
              class="w-full"
            />
          </UFormField>

          <UFormField
            label="氏名"
            name="name"
            required
          >
            <UInput
              v-model="form.name"
              placeholder="科学 太郎"
              autocomplete="name"
              required
              class="w-full"
            />
          </UFormField>

          <UFormField
            label="区分"
            name="feeType"
            required
          >
            <USelect
              v-model="form.feeType"
              :items="feeTypeOptions"
              class="w-full"
            />
          </UFormField>

          <UButton
            type="submit"
            color="primary"
            block
            :loading="pending"
            :disabled="pending"
          >
            請求書を発行する
          </UButton>
        </UForm>
      </template>
    </section>
  </div>
</template>
