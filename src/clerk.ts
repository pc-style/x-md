export type ClerkInstance = {
  user: {
    id: string
    primaryEmailAddress?: { emailAddress: string } | null
    username?: string | null
    fullName?: string | null
  } | null
  session?: { getToken: () => Promise<string | null> } | null
  addListener: (listener: () => void) => void
  openSignUp: (props?: { forceRedirectUrl?: string }) => void
  openSignIn: (props?: { forceRedirectUrl?: string }) => void
  redirectToSignUp: (props?: { forceRedirectUrl?: string }) => Promise<unknown>
  redirectToSignIn: (props?: { forceRedirectUrl?: string }) => Promise<unknown>
  mountUserButton: (node: HTMLDivElement, props?: { showName?: boolean }) => void
  unmountUserButton: (node: HTMLDivElement) => void
  signOut: () => Promise<void>
}

export const CLERK_PUBLISHABLE_KEY = (
  import.meta.env.VITE_CLERK_PUBLISHABLE_KEY ??
  import.meta.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY ??
  ''
) as string

export async function loadClerk(): Promise<ClerkInstance | null> {
  if (!CLERK_PUBLISHABLE_KEY) return null
  const { Clerk } = await import('@clerk/clerk-js')
  const clerk = new Clerk(CLERK_PUBLISHABLE_KEY)
  await clerk.load()
  return clerk as unknown as ClerkInstance
}

export async function beginClerkAuth(
  clerk: ClerkInstance,
  mode: 'sign-in' | 'sign-up',
  forceRedirectUrl = window.location.href,
): Promise<void> {
  try {
    if (mode === 'sign-in') {
      await clerk.redirectToSignIn({ forceRedirectUrl })
      return
    }
    await clerk.redirectToSignUp({ forceRedirectUrl })
  } catch (error) {
    console.error('Unable to start Clerk redirect flow.', error)
    if (mode === 'sign-in') {
      clerk.openSignIn({ forceRedirectUrl })
    } else {
      clerk.openSignUp({ forceRedirectUrl })
    }
  }
}

export async function fetchWithClerkToken(
  clerk: ClerkInstance,
  path: string,
  init: RequestInit = {},
): Promise<{ ok: boolean; status: number; payload: Record<string, unknown> }> {
  const token = await clerk.session?.getToken()
  const headers = new Headers(init.headers)
  if (token) headers.set('Authorization', `Bearer ${token}`)
  const response = await fetch(path, { ...init, headers })
  const payload = await response.json().catch(() => ({})) as Record<string, unknown>
  return { ok: response.ok, status: response.status, payload }
}
