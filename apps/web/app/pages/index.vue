<script setup lang="ts">
const { $orpc } = useNuxtApp()

// Verifies the front -> Nitro -> oRPC wiring end-to-end.
const { data: health } = await useAsyncData('health', () => $orpc.health.check())
</script>

<template>
  <main style="font-family: sans-serif; padding: 2rem">
    <h1>Checkin</h1>
    <p>Monorepo scaffold: Nuxt + oRPC (Nitro) + Drizzle/MariaDB.</p>
    <p>oRPC health.check: <code>{{ health }}</code></p>
  </main>
</template>
