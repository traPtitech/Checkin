<script setup lang="ts">
import { ORPCError } from '@orpc/client'

definePageMeta({ layout: 'default' })

const { $orpc } = useNuxtApp()
const route = useRoute()
const toast = useToast()

// Keep the (sanitized) post-verification redirect so the magic-link returns here.
const redirect = computed(() => {
  const raw = route.query.redirect
  return typeof raw === 'string' ? sanitizeRedirect(raw, '/') : '/'
})

const email = ref('')
const pending = ref(false)
const sent = ref(false)
const errorMessage = ref<string | null>(null)

async function onSubmit() {
  if (pending.value) {
    return
  }
  pending.value = true
  errorMessage.value = null
  try {
    await $orpc.auth.requestEmailVerification({
      email: email.value,
      // Only forward an explicit same-site redirect (default '/' needs no carry).
      redirect: redirect.value === '/' ? undefined : redirect.value,
    })
    sent.value = true
    toast.add({
      title: '確認メールを送信しました',
      description: 'メール内のリンクから続行してください。',
      color: 'success',
      icon: 'i-lucide-mail-check',
    })
  }
  catch (e) {
    errorMessage.value = e instanceof ORPCError
      ? e.message
      : 'メールの送信に失敗しました。時間をおいて再度お試しください。'
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
        メールアドレスの確認
      </h1>
      <p class="text-muted text-sm">
        学籍メールアドレス（@m.isct.ac.jp）を入力してください。確認用のリンクを送信します。
      </p>
    </section>

    <UAlert
      v-if="sent"
      color="success"
      variant="subtle"
      icon="i-lucide-mail-check"
      title="確認メールを送信しました"
      description="メール内のリンクから続行してください。"
    />

    <UAlert
      v-if="errorMessage"
      color="error"
      variant="subtle"
      icon="i-lucide-circle-alert"
      :title="errorMessage"
    />

    <UForm
      :state="{ email }"
      class="space-y-4"
      @submit="onSubmit"
    >
      <UFormField
        label="メールアドレス"
        name="email"
        required
      >
        <UInput
          v-model="email"
          type="email"
          placeholder="you@m.isct.ac.jp"
          autocomplete="email"
          required
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
        確認メールを送信
      </UButton>
    </UForm>
  </div>
</template>
