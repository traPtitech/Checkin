<script setup lang="ts">
import { ORPCError } from '@orpc/client'

definePageMeta({ layout: 'default' })

const { $orpc } = useNuxtApp()
const { data: me } = useAuthMe()

// Server `adminProc` is the real authz; this gate is for navigation/UX only.
const admin = computed(() => me.value?.admin ?? false)

// Accountant (traQ) login is a full-page Nitro route, so use a real <a href>.
const loginHref = `/login?redirect=${encodeURIComponent('/special-invoice')}`

// Special (¥2,000) always covers a SINGLE half — the accountant picks which.
// 後期のみ is the niche two-stage case: adding the second half for someone who
// was already issued a first-half-only special. (issuance-ledger spec: 前期のみ→後期追加)
const coverageOptions = [
  { value: 'zenki' as const, label: '前期のみ（¥2,000）' },
  { value: 'kouki' as const, label: '後期のみ（¥2,000・前期特別を出した人の後期追加）' },
]

const form = reactive({
  email: '',
  name: '',
  coverage: 'zenki' as 'zenki' | 'kouki',
  // Free-text; empty → server defaults to the current activity year.
  activityYear: '',
})

const pending = ref(false)
const errorMessage = ref<string | null>(null)
const result = ref<{ invoiceId: string, hostedInvoiceUrl: string | null } | null>(null)

function errorMessageFor(e: unknown): string {
  if (e instanceof ORPCError) {
    if (e.code === 'UNAUTHORIZED' || e.code === 'FORBIDDEN') {
      return '会計セッションが必要です。会計でログインしてください。'
    }
    // CONFLICT / BAD_REQUEST carry a user-facing JA message from the API
    // (既に支払い済み・期間重複／ドメイン不可・メール不一致・設定エラー).
    if (e.code === 'CONFLICT') {
      return e.message
    }
    if (e.code === 'BAD_REQUEST') {
      return 'メールアドレスをご確認ください（許可されたドメイン宛である必要があります）。設定不備の可能性もあります。'
    }
    return '発行に失敗しました。時間をおいて再度お試しください。'
  }
  return '発行に失敗しました。時間をおいて再度お試しください。'
}

async function onSubmit() {
  if (pending.value) {
    return
  }
  pending.value = true
  errorMessage.value = null
  result.value = null
  try {
    const year = form.activityYear.trim()
    const res = await $orpc.membership.issueSpecialInvoiceByEmail({
      email: form.email.trim(),
      name: form.name.trim() || undefined,
      coverage: form.coverage,
      activityYear: year ? Number(year) : undefined,
    })
    result.value = res
  }
  catch (e) {
    errorMessage.value = errorMessageFor(e)
  }
  finally {
    pending.value = false
  }
}

// Issue another one: clear the result so the form shows again.
function issueAnother() {
  result.value = null
  form.email = ''
  form.name = ''
  form.coverage = 'zenki'
  form.activityYear = ''
}
</script>

<template>
  <div class="max-w-md mx-auto space-y-6">
    <section class="space-y-2">
      <h1 class="text-xl font-bold text-highlighted">
        特別請求書の発行
      </h1>
      <p class="text-muted text-sm">
        例外的な継続特別（¥2,000・半期分）の請求書を、メールアドレスを指定して発行します（会計のみ）。
      </p>
    </section>

    <!-- Not an accountant: no form, just a login prompt. -->
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

    <!-- Accountant: issued result, or the issue form. -->
    <section
      v-else
      class="space-y-4"
    >
      <!-- Success: hosted invoice URL to forward to the member. -->
      <template v-if="result">
        <UAlert
          color="success"
          variant="subtle"
          icon="i-lucide-check"
          title="特別請求書を発行しました"
          description="支払いページの URL を対象者へ転送してください。"
        />

        <div
          v-if="result.hostedInvoiceUrl"
          class="space-y-1"
        >
          <p class="text-xs text-muted">
            支払いページ URL（本人へ転送してください）
          </p>
          <UInput
            :model-value="result.hostedInvoiceUrl"
            readonly
            size="sm"
            class="w-full"
          />
          <UButton
            :to="result.hostedInvoiceUrl"
            target="_blank"
            external
            color="primary"
            variant="subtle"
            size="sm"
            icon="i-lucide-external-link"
          >
            支払いページを開く
          </UButton>
        </div>

        <p class="text-xs text-muted">
          請求書 ID: <span class="font-mono">{{ result.invoiceId }}</span>
        </p>

        <UButton
          color="neutral"
          variant="subtle"
          icon="i-lucide-plus"
          @click="issueAnother"
        >
          続けて発行する
        </UButton>
      </template>

      <!-- Form. -->
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
            description="対象者のメールアドレス。初めての方でも入力できます（許可ドメイン宛のみ）。"
            required
          >
            <UInput
              v-model="form.email"
              type="email"
              placeholder="member@m.isct.ac.jp"
              autocomplete="off"
              required
              class="w-full"
            />
          </UFormField>

          <UFormField
            label="氏名"
            name="name"
            description="新規 Customer 作成時に表示名として使用します（任意）。"
          >
            <UInput
              v-model="form.name"
              placeholder="科学 太郎"
              autocomplete="off"
              class="w-full"
            />
          </UFormField>

          <UFormField
            label="対象期間"
            name="coverage"
            description="特別は常に半期分（¥2,000）。通常は「前期のみ」。「後期のみ」は前期のみ特別を発行済みの人に後期分を追加する場合のみ使います。"
            required
          >
            <USelect
              v-model="form.coverage"
              :items="coverageOptions"
              class="w-full"
            />
          </UFormField>

          <UFormField
            label="活動年度"
            name="activityYear"
            description="空欄なら現在の活動年度。後期に開始する継続更新は翌年度（例: 2026）を指定します。"
          >
            <UInput
              v-model="form.activityYear"
              type="number"
              inputmode="numeric"
              placeholder="現在の活動年度"
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
            特別請求書を発行する
          </UButton>
        </UForm>
      </template>
    </section>
  </div>
</template>
