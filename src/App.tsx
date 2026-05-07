import { lazy, Suspense } from 'react'
import { BrowserRouter, Routes, Route, useLocation } from 'react-router-dom'
import { useGoogleLogin } from '@react-oauth/google'
import { create } from 'zustand'
import { useShallow } from 'zustand/react/shallow'
import type { AuthState, BookEntry, SyncStatus, Sidecar } from './types'
import { cacheSidecar, enqueueWrite } from './lib/db'
import { saveSidecar } from './lib/sidecar'
import { ensureLibraryFolder } from './lib/drive'

const LibraryPage = lazy(() => import('./components/Library'))
const ReaderPage = lazy(() => import('./components/Reader'))

interface StoreState {
  auth: AuthState
  books: BookEntry[]
  syncStatus: SyncStatus
  folderId: string | null
  setAuth: (auth: AuthState) => void
  setBooks: (books: BookEntry[]) => void
  setSyncStatus: (status: SyncStatus) => void
  setFolderId: (id: string | null) => void
  commitSidecar: (bookId: string, sidecar: Sidecar) => Promise<void>
}

const SESSION_KEY = 'rdsy_auth'

function loadAuthFromSession(): AuthState {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY)
    if (!raw) return { status: 'unauthenticated' }
    const parsed = JSON.parse(raw) as AuthState
    if (parsed.status === 'authenticated' && parsed.expiresAt > Date.now()) {
      return parsed
    }
  } catch {
    // ignore
  }
  return { status: 'unauthenticated' }
}

export const useStore = create<StoreState>()((set, get) => ({
  auth: loadAuthFromSession(),
  books: [],
  syncStatus: 'idle',
  folderId: null,
  setAuth: (auth) => {
    if (auth.status === 'authenticated') {
      sessionStorage.setItem(SESSION_KEY, JSON.stringify(auth))
    } else {
      sessionStorage.removeItem(SESSION_KEY)
    }
    set({ auth })
  },
  setBooks: (books) => set({ books }),
  setSyncStatus: (syncStatus) => set({ syncStatus }),
  setFolderId: (folderId) => set({ folderId }),
  commitSidecar: async (bookId, sidecar) => {
    // 1. Persist to IDB immediately (durable local write)
    await cacheSidecar(bookId, sidecar)

    // 2. Update the in-memory store
    set((state) => {
      const idx = state.books.findIndex((b) => b.driveId === bookId)
      if (idx === -1) return state
      const next = state.books.slice()
      next[idx] = { ...next[idx], sidecar }
      return { books: next }
    })

    // 3. Enqueue for offline safety
    await enqueueWrite(bookId, sidecar)

    // 4. Push to Drive if online and authenticated
    const { auth, books } = get()
    if (auth.status !== 'authenticated' || !navigator.onLine) return
    const { accessToken } = auth as { accessToken: string; status: 'authenticated'; expiresAt: number }

    try {
      let { folderId } = get()
      if (!folderId) {
        folderId = await ensureLibraryFolder(accessToken)
        set({ folderId })
      }
      const entry = books.find((b) => b.driveId === bookId)
      const newId = await saveSidecar(accessToken, folderId, sidecar, entry?.sidecarDriveId)
      if (newId && newId !== 'queued' && entry && !entry.sidecarDriveId) {
        set((state) => {
          const idx = state.books.findIndex((b) => b.driveId === bookId)
          if (idx === -1) return state
          const next = state.books.slice()
          next[idx] = { ...next[idx], sidecarDriveId: newId }
          return { books: next }
        })
      }
    } catch {
      // Already enqueued — Drive failure is non-fatal
    }
  },
}))

const syncDotStyle: Record<SyncStatus, string> = {
  idle: '#4ade80',
  syncing: '#facc15',
  error: '#f87171',
  offline: '#9ca3af',
}

function SignInScreen() {
  const setAuth = useStore((s) => s.setAuth)

  const login = useGoogleLogin({
    flow: 'implicit',
    scope: 'https://www.googleapis.com/auth/drive.file',
    onSuccess: (res) => {
      setAuth({
        status: 'authenticated',
        accessToken: res.access_token,
        expiresAt: Date.now() + res.expires_in * 1000,
      })
    },
  })

  return (
    <div style={{
      minHeight: '100vh',
      background: '#1a1a2e',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
    }}>
      <div style={{
        background: '#16213e',
        borderRadius: '16px',
        padding: '48px 40px',
        textAlign: 'center',
        boxShadow: '0 8px 32px rgba(0,0,0,0.4)',
        maxWidth: '360px',
        width: '100%',
      }}>
        <h1 style={{
          fontSize: '48px',
          fontWeight: '700',
          color: '#e0e0e0',
          letterSpacing: '-1px',
          marginBottom: '12px',
        }}>RDSY</h1>
        <p style={{
          color: '#9ca3af',
          fontSize: '15px',
          marginBottom: '36px',
          lineHeight: '1.5',
        }}>Your PDF library, synced across devices</p>
        <button
          onClick={() => login()}
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: '10px',
            width: '100%',
            padding: '12px 20px',
            borderRadius: '8px',
            border: '1px solid #374151',
            background: '#1f2937',
            color: '#e0e0e0',
            fontSize: '15px',
            fontWeight: '500',
            cursor: 'pointer',
            transition: 'background 0.15s',
          }}
          onMouseEnter={(e) => (e.currentTarget.style.background = '#374151')}
          onMouseLeave={(e) => (e.currentTarget.style.background = '#1f2937')}
        >
          <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
            <path fill="#4285F4" d="M17.64 9.2c0-.637-.057-1.251-.164-1.84H9v3.481h4.844c-.209 1.125-.843 2.078-1.796 2.717v2.258h2.908c1.702-1.567 2.684-3.874 2.684-6.615z"/>
            <path fill="#34A853" d="M9 18c2.43 0 4.467-.806 5.956-2.184l-2.908-2.258c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332A8.997 8.997 0 0 0 9 18z"/>
            <path fill="#FBBC05" d="M3.964 10.707A5.41 5.41 0 0 1 3.682 9c0-.593.102-1.17.282-1.707V4.961H.957A8.996 8.996 0 0 0 0 9c0 1.452.348 2.827.957 4.039l3.007-2.332z"/>
            <path fill="#EA4335" d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0A8.997 8.997 0 0 0 .957 4.961L3.964 7.293C4.672 5.163 6.656 3.58 9 3.58z"/>
          </svg>
          Sign in with Google
        </button>
      </div>
    </div>
  )
}

function NavBar() {
  const { syncStatus, setAuth } = useStore(useShallow((s) => ({ syncStatus: s.syncStatus, setAuth: s.setAuth })))

  const handleSignOut = () => {
    setAuth({ status: 'unauthenticated' })
  }

  return (
    <nav style={{
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      padding: '0 20px',
      height: '52px',
      background: '#16213e',
      borderBottom: '1px solid #1e2a4a',
      flexShrink: 0,
    }}>
      <span style={{ fontWeight: '700', fontSize: '18px', color: '#e0e0e0', letterSpacing: '-0.5px' }}>
        RDSY
      </span>
      <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
          <span style={{
            width: '8px',
            height: '8px',
            borderRadius: '50%',
            background: syncDotStyle[syncStatus],
            display: 'inline-block',
            boxShadow: `0 0 6px ${syncDotStyle[syncStatus]}`,
          }} />
          <span style={{ fontSize: '12px', color: '#9ca3af' }}>{syncStatus}</span>
        </div>
        <button
          onClick={handleSignOut}
          style={{
            padding: '6px 12px',
            borderRadius: '6px',
            border: '1px solid #374151',
            background: 'transparent',
            color: '#9ca3af',
            fontSize: '13px',
            cursor: 'pointer',
            transition: 'color 0.15s, border-color 0.15s',
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.color = '#e0e0e0'
            e.currentTarget.style.borderColor = '#6b7280'
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.color = '#9ca3af'
            e.currentTarget.style.borderColor = '#374151'
          }}
        >
          Sign out
        </button>
      </div>
    </nav>
  )
}

function AuthenticatedShell() {
  const location = useLocation()
  const isReader = location.pathname.startsWith('/reader/')
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', overflow: 'hidden' }}>
      {!isReader && <NavBar />}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
        <Suspense fallback={<div style={{ padding: '24px', color: '#9ca3af' }}>Loading…</div>}>
          <Routes>
            <Route path="/" element={<LibraryPage />} />
            <Route path="/reader/:bookId" element={<ReaderPage />} />
          </Routes>
        </Suspense>
      </div>
    </div>
  )
}

export default function App() {
  const auth = useStore((s) => s.auth)

  return (
    <BrowserRouter>
      {auth.status === 'unauthenticated' ? <SignInScreen /> : <AuthenticatedShell />}
    </BrowserRouter>
  )
}
