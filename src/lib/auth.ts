import type { AuthState } from '../types'

declare global {
  interface Window {
    google?: {
      accounts: {
        oauth2: {
          initTokenClient(config: {
            client_id: string
            scope: string
            callback: (response: GISTokenResponse) => void
          }): GISTokenClient
        }
      }
    }
  }
}

interface GISTokenResponse {
  access_token?: string
  expires_in?: string
  error?: string
}

interface GISTokenClient {
  requestAccessToken(overrideConfig?: { prompt?: string }): void
}

const SESSION_KEY = 'rdsy_auth'

type TokenCallback = (accessToken: string, expiresAt: number) => void

let _client: GISTokenClient | null = null
let _onSuccess: TokenCallback | null = null
let _onFailure: (() => void) | null = null

function getClient(): GISTokenClient {
  if (!_client) {
    _client = window.google!.accounts.oauth2.initTokenClient({
      client_id: import.meta.env.VITE_GOOGLE_CLIENT_ID ?? '',
      scope: 'https://www.googleapis.com/auth/drive.file',
      callback: (response: GISTokenResponse) => {
        if (response.error || !response.access_token) {
          _onFailure?.()
        } else {
          _onSuccess?.(
            response.access_token,
            Date.now() + Number(response.expires_in ?? 3600) * 1000,
          )
        }
        _onSuccess = null
        _onFailure = null
      },
    })
  }
  return _client
}

export function signIn(onSuccess: TokenCallback): void {
  _onSuccess = onSuccess
  _onFailure = null
  getClient().requestAccessToken()
}

export function trySilentSignIn(onSuccess: TokenCallback, onFailure: () => void): void {
  if (!window.google?.accounts?.oauth2) {
    onFailure()
    return
  }
  _onSuccess = onSuccess
  _onFailure = onFailure
  try {
    getClient().requestAccessToken({ prompt: '' })
  } catch {
    onFailure()
  }
}

export function loadStoredAuth(): AuthState {
  try {
    const raw = localStorage.getItem(SESSION_KEY)
    if (!raw) return { status: 'unauthenticated' }
    const parsed = JSON.parse(raw) as AuthState
    if (parsed.status === 'authenticated' && parsed.expiresAt > Date.now()) return parsed
  } catch { /* ignore */ }
  return { status: 'unauthenticated' }
}

export function saveAuth(auth: AuthState): void {
  if (auth.status === 'authenticated') {
    localStorage.setItem(SESSION_KEY, JSON.stringify(auth))
  } else {
    localStorage.removeItem(SESSION_KEY)
  }
}
