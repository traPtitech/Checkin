/**
 * Shared `auth.me` state. A single `useAsyncData` keyed `auth-me` is reused
 * across the layout and pages so the identity is fetched once (SSR-friendly) and
 * can be refreshed after login/logout. Returns the dual-identity shape
 * `{ authenticated, member, admin, hasUser, traqId }`.
 */
export function useAuthMe() {
  const { $orpc } = useNuxtApp()
  return useAsyncData('auth-me', () => $orpc.auth.me())
}
