<script setup lang="ts">
const { $orpc } = useNuxtApp()

// フロント -> Nitro -> oRPC の疎通をエンドツーエンドで検証する。
const { data: health } = await useAsyncData('health', () => $orpc.health.check())
</script>

<template>
  <main style="font-family: sans-serif; padding: 2rem">
    <h1>Checkin</h1>
    <p>モノレポ雛形: Nuxt + oRPC (Nitro) + Drizzle/MariaDB。</p>
    <p>oRPC health.check: <code>{{ health }}</code></p>
  </main>
</template>
