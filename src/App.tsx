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

const syncColors: Record<SyncStatus, string> = {
  idle:    'var(--green)',
  syncing: 'var(--yellow)',
  error:   'var(--red)',
  offline: 'var(--grey)',
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
    onError: (err) => console.error('[auth] onError:', err),
    onNonOAuthError: (err) => console.error('[auth] onNonOAuthError:', err),
  })

  return (
    <div style={{
      minHeight: '100vh',
      background: 'var(--bg)',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      padding: '24px',
    }}>
      {/* Radial warm glow behind the card */}
      <div style={{
        position: 'fixed',
        top: '50%',
        left: '50%',
        transform: 'translate(-50%, -60%)',
        width: '600px',
        height: '600px',
        background: 'radial-gradient(ellipse at center, rgba(200,168,75,0.07) 0%, transparent 70%)',
        pointerEvents: 'none',
      }} />

      <div style={{
        background: 'var(--surface)',
        border: '1px solid var(--border)',
        borderRadius: '12px',
        padding: '56px 48px',
        textAlign: 'center',
        maxWidth: '380px',
        width: '100%',
        animation: 'fadeUp 0.5s ease both',
        position: 'relative',
      }}>
        {/* Top gold rule */}
        <div style={{
          position: 'absolute',
          top: 0,
          left: '48px',
          right: '48px',
          height: '1px',
          background: 'linear-gradient(90deg, transparent, var(--gold-dim), transparent)',
        }} />

        <h1 style={{
          fontFamily: "'Playfair Display', serif",
          fontSize: '52px',
          fontWeight: '700',
          color: 'var(--gold)',
          letterSpacing: '0.06em',
          marginBottom: '10px',
          lineHeight: 1,
        }}>RDSY</h1>

        <p style={{
          fontFamily: "'Playfair Display', serif",
          fontStyle: 'italic',
          color: 'var(--text-dim)',
          fontSize: '14px',
          marginBottom: '40px',
          lineHeight: '1.6',
          letterSpacing: '0.01em',
        }}>Your library, everywhere you read.</p>

        {/* Divider */}
        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: '12px',
          marginBottom: '28px',
        }}>
          <div style={{ flex: 1, height: '1px', background: 'var(--border)' }} />
          <span style={{ fontSize: '10px', color: 'var(--text-dim)', letterSpacing: '0.12em', textTransform: 'uppercase' }}>continue with</span>
          <div style={{ flex: 1, height: '1px', background: 'var(--border)' }} />
        </div>

        <button
          onClick={() => login()}
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: '10px',
            width: '100%',
            padding: '13px 20px',
            borderRadius: 'var(--radius)',
            border: '1px solid var(--border-mid)',
            background: 'var(--card)',
            color: 'var(--text)',
            fontSize: '14px',
            fontWeight: '400',
            fontFamily: "'DM Sans', sans-serif",
            cursor: 'pointer',
            transition: 'border-color var(--transition), background var(--transition)',
            letterSpacing: '0.01em',
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = 'var(--card-hover)'
            e.currentTarget.style.borderColor = 'var(--gold-dim)'
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = 'var(--card)'
            e.currentTarget.style.borderColor = 'var(--border-mid)'
          }}
        >
          <svg width="17" height="17" viewBox="0 0 18 18" aria-hidden="true">
            <path fill="#4285F4" d="M17.64 9.2c0-.637-.057-1.251-.164-1.84H9v3.481h4.844c-.209 1.125-.843 2.078-1.796 2.717v2.258h2.908c1.702-1.567 2.684-3.874 2.684-6.615z"/>
            <path fill="#34A853" d="M9 18c2.43 0 4.467-.806 5.956-2.184l-2.908-2.258c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332A8.997 8.997 0 0 0 9 18z"/>
            <path fill="#FBBC05" d="M3.964 10.707A5.41 5.41 0 0 1 3.682 9c0-.593.102-1.17.282-1.707V4.961H.957A8.996 8.996 0 0 0 0 9c0 1.452.348 2.827.957 4.039l3.007-2.332z"/>
            <path fill="#EA4335" d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0A8.997 8.997 0 0 0 .957 4.961L3.964 7.293C4.672 5.163 6.656 3.58 9 3.58z"/>
          </svg>
          Google
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
      padding: '0 24px',
      height: '50px',
      background: 'var(--surface)',
      borderBottom: '1px solid var(--border)',
      flexShrink: 0,
    }}>
      <span style={{
        fontFamily: "'Playfair Display', serif",
        fontWeight: '700',
        fontSize: '20px',
        color: 'var(--gold)',
        letterSpacing: '0.06em',
      }}>
        RDSY
      </span>

      <div style={{ display: 'flex', alignItems: 'center', gap: '20px' }}>
        {/* Sync status */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
          <span style={{
            width: '6px',
            height: '6px',
            borderRadius: '50%',
            background: syncColors[syncStatus],
            display: 'inline-block',
            boxShadow: `0 0 5px ${syncColors[syncStatus]}`,
            animation: syncStatus === 'syncing' ? 'pulse 1s ease-in-out infinite' : 'none',
          }} />
          <span style={{ fontSize: '11px', color: 'var(--text-dim)', letterSpacing: '0.05em' }}>{syncStatus}</span>
        </div>

        <button
          onClick={handleSignOut}
          style={{
            padding: '5px 12px',
            borderRadius: 'var(--radius)',
            border: '1px solid var(--border)',
            background: 'transparent',
            color: 'var(--text-dim)',
            fontSize: '12px',
            fontFamily: "'DM Sans', sans-serif",
            cursor: 'pointer',
            transition: 'color var(--transition), border-color var(--transition)',
            letterSpacing: '0.02em',
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.color = 'var(--text)'
            e.currentTarget.style.borderColor = 'var(--border-mid)'
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.color = 'var(--text-dim)'
            e.currentTarget.style.borderColor = 'var(--border)'
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
