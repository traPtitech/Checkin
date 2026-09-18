<script setup lang="ts">
definePageMeta({ layout: 'default' })

const { data: me } = useAuthMe()
const { logout } = useCsrf()

// Dual identity (auth.me).
const authenticated = computed(() => me.value?.authenticated ?? false)
const member = computed(() => me.value?.member ?? false)
const isAdmin = computed(() => me.value?.admin ?? false)
const hasUser = computed(() => me.value?.hasUser ?? false)
const traqId = computed(() => me.value?.traqId ?? null)

// Accountant (traQ) login is a full-page Nitro route, so use a real <a href>.
const loginHref = `/login?redirect=${encodeURIComponent('/')}`

const actorTitle = computed(() => {
  if (isAdmin.value) {
    return `会計としてログイン中${traqId.value ? `: ${traqId.value}` : ''}`
  }
  if (member.value) {
    return `traQ ログイン中${traqId.value ? `: ${traqId.value}` : ''}`
  }
  return 'ログイン中'
})

const loggingOut = ref(false)
async function onLogout() {
  if (loggingOut.value) {
    return
  }
  loggingOut.value = true
  try {
    await logout()
  }
  finally {
    loggingOut.value = false
  }
}
</script>

<template>
  <div class="space-y-8">
    <section class="space-y-2">
      <h1 class="text-2xl font-bold text-highlighted">
        Checkin
      </h1>
      <p class="text-muted">
        部費・入部費のオンライン集金サービスです。
      </p>
    </section>

    <!-- Logged out: service description + primary CTA + accountant login. -->
    <section
      v-if="!authenticated"
      class="space-y-4"
    >
      <p class="text-default">
        部費の支払いはこちらから。学籍メールアドレスの確認後、支払いページへ進めます。
      </p>
      <div class="flex flex-wrap items-center gap-3">
        <UButton
          to="/membership"
          color="primary"
          size="lg"
          icon="i-lucide-credit-card"
        >
          部費を払う
        </UButton>
        <UButton
          :href="loginHref"
          color="neutral"
          variant="link"
          external
        >
          会計／現役の方はログイン
        </UButton>
      </div>
    </section>

    <!-- Logged in: actor (member/admin/hasUser) display + main links + logout. -->
    <section
      v-else
      class="space-y-4"
    >
      <UAlert
        color="primary"
        variant="subtle"
        icon="i-lucide-circle-user"
        :title="actorTitle"
      />
      <ul class="text-sm text-muted space-y-1">
        <li>会員 (traQ): {{ member ? 'はい' : 'いいえ' }}</li>
        <li>会計: {{ isAdmin ? 'はい' : 'いいえ' }}</li>
        <li>支払い可能 (利用者連結): {{ hasUser ? 'はい' : 'いいえ' }}</li>
      </ul>
      <div class="flex flex-wrap items-center gap-3">
        <UButton
          to="/membership"
          color="primary"
          size="lg"
          icon="i-lucide-credit-card"
        >
          部費を払う
        </UButton>
        <UButton
          color="neutral"
          variant="subtle"
          :loading="loggingOut"
          :disabled="loggingOut"
          @click="onLogout"
        >
          ログアウト
        </UButton>
      </div>

      <!-- Accountant-only links (server adminProc is the real authz). -->
      <div
        v-if="isAdmin"
        class="space-y-2"
      >
        <h2 class="text-sm font-semibold text-highlighted">
          会計メニュー
        </h2>
        <div class="flex flex-wrap items-center gap-3">
          <UButton
            to="/payments"
            color="neutral"
            variant="subtle"
            icon="i-lucide-receipt"
          >
            入出金一覧
          </UButton>
          <UButton
            to="/payouts"
            color="neutral"
            variant="subtle"
            icon="i-lucide-banknote"
          >
            払い戻し管理
          </UButton>
        </div>
      </div>
    </section>
  </div>
</template>
