<script setup lang="ts">
const route = useRoute()
// TODO: rework in add-member-ui — minimal adaptation to the dual-identity auth.me.
const { data: me } = useAuthMe()
const { logout } = useCsrf()

const authenticated = computed(() => me.value?.authenticated ?? false)
const isAdmin = computed(() => me.value?.admin ?? false)
const traqId = computed(() => me.value?.traqId ?? null)

// Accountant (traQ) login is a full-page Nitro route, so use a real <a href>.
// Preserve where the user currently is so they return after OAuth.
const loginHref = computed(() => `/login?redirect=${encodeURIComponent(route.fullPath)}`)

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
  <div class="min-h-screen bg-default text-default flex flex-col">
    <header class="border-b border-default">
      <div class="mx-auto max-w-3xl w-full px-4 h-16 flex items-center justify-between gap-4">
        <NuxtLink
          to="/"
          class="text-lg font-bold text-highlighted"
        >
          Checkin
        </NuxtLink>

        <nav class="flex items-center gap-3 text-sm">
          <template v-if="authenticated">
            <span class="text-muted">
              <template v-if="isAdmin">会計: {{ traqId }}</template>
              <template v-else>ログイン中</template>
            </span>
            <UButton
              color="neutral"
              variant="subtle"
              size="sm"
              :loading="loggingOut"
              :disabled="loggingOut"
              @click="onLogout"
            >
              ログアウト
            </UButton>
          </template>
          <template v-else>
            <UButton
              to="/membership"
              color="primary"
              variant="solid"
              size="sm"
            >
              部費を払う
            </UButton>
            <UButton
              :href="loginHref"
              color="neutral"
              variant="link"
              size="sm"
              external
            >
              会計の方はこちら
            </UButton>
          </template>
        </nav>
      </div>
    </header>

    <main class="flex-1">
      <div class="mx-auto max-w-3xl w-full px-4 py-8">
        <slot />
      </div>
    </main>
  </div>
</template>
