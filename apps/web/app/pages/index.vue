<script setup lang="ts">
// TODO: rework in add-member-ui — minimal adaptation to the dual-identity auth.me.
const { data: me } = useAuthMe()

const authenticated = computed(() => me.value?.authenticated ?? false)
const isAdmin = computed(() => me.value?.admin ?? false)
const traqId = computed(() => me.value?.traqId ?? null)

const loginHref = computed(() => `/login?redirect=${encodeURIComponent('/')}`)
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
          会計の方はこちら
        </UButton>
      </div>
    </section>

    <!-- Logged in: actor display + main links. -->
    <section
      v-else
      class="space-y-4"
    >
      <UAlert
        color="primary"
        variant="subtle"
        icon="i-lucide-circle-user"
        :title="isAdmin ? `会計としてログイン中: ${traqId}` : 'ログイン中'"
      />
      <div class="flex flex-wrap items-center gap-3">
        <UButton
          to="/membership"
          color="primary"
          size="lg"
          icon="i-lucide-credit-card"
        >
          部費を払う
        </UButton>
      </div>
    </section>
  </div>
</template>
