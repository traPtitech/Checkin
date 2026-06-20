<script setup lang="ts">
import { ORPCError } from '@orpc/client'

definePageMeta({ layout: 'default' })

const { $orpc } = useNuxtApp()
const route = useRoute()
const { data: me } = useAuthMe()

// Dual identity (auth.me): drives the §5.1 branching.
const authenticated = computed(() => me.value?.authenticated ?? false)
const member = computed(() => me.value?.member ?? false)
const hasUser = computed(() => me.value?.hasUser ?? false)

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

// --- Logged-out: choose a category, then route per §5.1 ----------------------
// 新規入部・再入部 → isct メール確認、現役 → traQ ログイン（会員セッション）。
function chooseCategory(category: Category) {
  if (category === 'continuation') {
    // 現役 is a traQ member: a full-page Nitro OAuth route.
    return navigateTo('/login?redirect=/membership', { external: true })
  }
  const target = `/membership?type=${category}`
  return navigateTo(`/verify-email?redirect=${encodeURIComponent(target)}`)
}

// Link prompt for a traQ member who has no billable user yet.
const linkVerifyHref = '/verify-email?redirect=/membership'

// --- Logged-in (hasUser): invoice form ---------------------------------------
const feeTypeOptions = [
  { label: '新規入部 / 再入部', value: 'new' as const },
  { label: '現役', value: 'continuation' as const },
]

// Preselect 区分 from the `?type` carried over from the logged-out choice.
function feeTypeFromQuery(raw: unknown): FeeType {
  if (typeof raw !== 'string') {
    return 'continuation'
  }
  const hit = CATEGORIES.find(c => c.value === raw)
  return hit ? hit.feeType : (raw === 'new' ? 'new' : 'continuation')
}

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
    // Map known cases; fall back to a generic message for Stripe/config errors.
    errorMessage.value = errorMessageFor(e)
  }
  finally {
    pending.value = false
  }
}

function errorMessageFor(e: unknown): string {
  if (e instanceof ORPCError) {
    // mail_hash mismatch (FORBIDDEN) — the resubmitted email is not the verified one.
    if (e.code === 'FORBIDDEN') {
      return '確認したメールと一致しません。確認時と同じメールアドレスを入力してください。'
    }
    return '発行に失敗しました。時間をおいて再度お試しください。'
  }
  return '発行に失敗しました。時間をおいて再度お試しください。'
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

    <!-- 1) Not authenticated: choose 新規入部 / 再入部 / 現役. -->
    <section
      v-if="!authenticated"
      class="space-y-3"
    >
      <p class="text-default text-sm">
        区分を選択してください。新規入部・再入部はメールアドレスの確認後、現役は traQ ログイン後に支払いへ進めます。
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

    <!-- 2) traQ member but no linked user: prompt to link via isct verification. -->
    <section
      v-else-if="member && !hasUser"
      class="space-y-4"
    >
      <UAlert
        color="info"
        variant="subtle"
        icon="i-lucide-link"
        title="メールアドレスの確認が必要です"
        description="部費を支払うには、学籍メールアドレス（@m.isct.ac.jp）の確認でアカウントを連結してください。次回以降は traQ ログインだけで支払えます。"
      />
      <UButton
        :to="linkVerifyHref"
        color="primary"
        size="lg"
        block
        icon="i-lucide-mail-check"
      >
        メールアドレスを確認する
      </UButton>
    </section>

    <!-- 3) hasUser: invoice form. -->
    <section
      v-else-if="hasUser"
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

    <!-- 4) Fallback (e.g. accountant-only session): no member invoice flow. -->
    <section
      v-else
      class="space-y-3"
    >
      <UAlert
        color="neutral"
        variant="subtle"
        icon="i-lucide-info"
        title="この画面では請求書を発行できません"
        description="部費の支払いは利用者として行ってください。"
      />
    </section>
  </div>
</template>
