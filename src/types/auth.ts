export type AuthState =
  | { status: 'unauthenticated' }
  | { status: 'authenticated'; accessToken: string; expiresAt: number }
