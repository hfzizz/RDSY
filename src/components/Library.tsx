import { useEffect, useRef, useState, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { useShallow } from 'zustand/react/shallow'
import { useStore } from '../App'
import type { BookEntry } from '../types'
import { syncLibrary, pushPendingWrites } from '../lib/sync'
import { ensureLibraryFolder } from '../lib/drive'
import { uploadPDF, downloadBlob } from '../lib/drive'
import { setPinned, removeCachedPDF, cachePDF } from '../lib/db'

const SYNC_INTERVAL_MS = 5 * 60 * 1000

interface BookCardProps {
  book: BookEntry
  onPin: (driveId: string, currentlyPinned: boolean) => void
  onOpen: (driveId: string) => void
  pinLoading: boolean
}

function BookCard({ book, onPin, onOpen, pinLoading }: BookCardProps) {
  const [hovered, setHovered] = useState(false)

  const progressPage = book.sidecar?.progress.page ?? null
  const hasProgress = progressPage !== null && progressPage > 1

  // Strip .pdf extension for display
  const displayName = book.name.replace(/\.pdf$/i, '')

  return (
    <div
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        background: hovered ? 'var(--card-hover)' : 'var(--card)',
        border: '1px solid var(--border)',
        borderLeft: `3px solid ${hovered ? 'var(--gold)' : 'var(--border-mid)'}`,
        borderRadius: '4px',
        padding: '18px 16px 14px',
        display: 'flex',
        flexDirection: 'column',
        gap: '8px',
        transition: 'background var(--transition), border-color var(--transition)',
        position: 'relative',
        cursor: 'default',
      }}
    >
      {/* Title */}
      <div
        style={{
          color: 'var(--text)',
          fontSize: '13px',
          fontWeight: '500',
          lineHeight: '1.4',
          overflow: 'hidden',
          display: '-webkit-box',
          WebkitLineClamp: 2,
          WebkitBoxOrient: 'vertical',
          paddingRight: '24px',
          letterSpacing: '0.01em',
          minHeight: '36px',
        }}
        title={displayName}
      >
        {displayName}
      </div>

      {/* Progress + offline badge */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '6px', minHeight: '16px' }}>
        {hasProgress && (
          <span style={{
            fontSize: '10px',
            color: 'var(--gold)',
            letterSpacing: '0.06em',
            textTransform: 'uppercase',
            fontWeight: '500',
          }}>
            p. {progressPage}
          </span>
        )}
        {!hasProgress && (
          <span style={{ fontSize: '10px', color: 'var(--text-dim)', letterSpacing: '0.04em' }}>
            unread
          </span>
        )}
        {book.pinnedOffline && (
          <span style={{
            fontSize: '9px',
            color: 'var(--gold-dim)',
            border: '1px solid var(--gold-dim)',
            borderRadius: '2px',
            padding: '1px 4px',
            letterSpacing: '0.06em',
            textTransform: 'uppercase',
          }}>offline</span>
        )}
      </div>

      {/* Open button */}
      <button
        onClick={() => onOpen(book.driveId)}
        style={{
          marginTop: '4px',
          padding: '8px',
          background: hovered ? 'var(--gold)' : 'transparent',
          border: `1px solid ${hovered ? 'var(--gold)' : 'var(--border-mid)'}`,
          borderRadius: '3px',
          color: hovered ? 'var(--bg)' : 'var(--text-mid)',
          fontSize: '11px',
          fontFamily: "'DM Sans', sans-serif",
          fontWeight: '500',
          letterSpacing: '0.08em',
          textTransform: 'uppercase',
          cursor: 'pointer',
          transition: 'background var(--transition), color var(--transition), border-color var(--transition)',
        }}
      >
        Open
      </button>

      {/* Pin button */}
      <button
        onClick={() => onPin(book.driveId, book.pinnedOffline)}
        disabled={pinLoading}
        title={book.pinnedOffline ? 'Unpin from offline' : 'Pin for offline'}
        style={{
          position: 'absolute',
          top: '10px',
          right: '10px',
          background: 'none',
          border: 'none',
          cursor: pinLoading ? 'wait' : 'pointer',
          padding: '4px',
          opacity: book.pinnedOffline ? 0.9 : 0.25,
          transition: 'opacity var(--transition)',
          lineHeight: 1,
          fontSize: '13px',
        }}
        onMouseEnter={(e) => { if (!pinLoading) e.currentTarget.style.opacity = '0.8' }}
        onMouseLeave={(e) => { if (!pinLoading) e.currentTarget.style.opacity = book.pinnedOffline ? '0.9' : '0.25' }}
        aria-label={book.pinnedOffline ? 'Unpin' : 'Pin offline'}
      >
        ⬡
      </button>
    </div>
  )
}

export default function Library() {
  const { auth, books, syncStatus, folderId, setBooks, setSyncStatus, setFolderId } = useStore(useShallow((s) => ({
    auth: s.auth,
    books: s.books,
    syncStatus: s.syncStatus,
    folderId: s.folderId,
    setBooks: s.setBooks,
    setSyncStatus: s.setSyncStatus,
    setFolderId: s.setFolderId,
  })))

  const navigate = useNavigate()
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [search, setSearch] = useState('')
  const [uploading, setUploading] = useState(false)
  const [pinLoading, setPinLoading] = useState<string | null>(null)
  const [showIosBanner, setShowIosBanner] = useState(false)

  useEffect(() => {
    const ua = navigator.userAgent
    const isIosSafari = ua.includes('Safari') && !ua.includes('Chrome') && !ua.includes('CriOS')
    const isStandalone = window.matchMedia('(display-mode: standalone)').matches
    const dismissed = sessionStorage.getItem('rdsy_ios_banner_dismissed')
    if (isIosSafari && !isStandalone && !dismissed) setShowIosBanner(true)
  }, [])

  const doSync = useCallback(async () => {
    if (auth.status !== 'authenticated') return
    const { accessToken } = auth
    setSyncStatus('syncing')
    try {
      const result = await syncLibrary(accessToken)
      setBooks(result)
      setSyncStatus('idle')
    } catch (err) {
      console.error('[Library] sync failed:', err)
      setSyncStatus(navigator.onLine ? 'error' : 'offline')
    }
  }, [auth, setBooks, setSyncStatus])

  useEffect(() => {
    if (auth.status !== 'authenticated') return
    const { accessToken } = auth
    doSync()
    ;(async () => {
      try {
        const resolved = folderId ?? await ensureLibraryFolder(accessToken)
        if (!folderId) setFolderId(resolved)
        await pushPendingWrites(accessToken, resolved)
      } catch (err) {
        console.warn('[Library] pushPendingWrites failed:', err)
      }
    })()
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const id = setInterval(doSync, SYNC_INTERVAL_MS)
    return () => clearInterval(id)
  }, [doSync])

  async function handlePin(driveId: string, currentlyPinned: boolean) {
    if (auth.status !== 'authenticated') return
    setPinLoading(driveId)
    try {
      const newPinned = !currentlyPinned
      await setPinned(driveId, newPinned)
      if (newPinned) {
        const blob = await downloadBlob(auth.accessToken, driveId)
        await cachePDF(driveId, blob)
      } else {
        await removeCachedPDF(driveId)
      }
      setBooks(books.map((b) =>
        b.driveId === driveId ? { ...b, pinnedOffline: newPinned, cachedLocally: newPinned } : b
      ))
    } catch (err) {
      console.error('[Library] pin toggle failed:', err)
    } finally {
      setPinLoading(null)
    }
  }

  async function handleUpload(e: React.ChangeEvent<HTMLInputElement>) {
    if (auth.status !== 'authenticated') return
    const file = e.target.files?.[0]
    if (!file) return
    setUploading(true)
    try {
      const { accessToken } = auth
      const resolved = folderId ?? await ensureLibraryFolder(accessToken)
      if (!folderId) setFolderId(resolved)
      await uploadPDF(accessToken, resolved, file)
      await doSync()
    } catch (err) {
      console.error('[Library] upload failed:', err)
    } finally {
      setUploading(false)
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }

  const filteredBooks: BookEntry[] = books.filter((b) =>
    b.name.toLowerCase().includes(search.toLowerCase())
  )

  const isInitialLoading = syncStatus === 'syncing' && books.length === 0

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', background: 'var(--bg)', minHeight: 0 }}>

      {/* iOS banner */}
      {showIosBanner && (
        <div style={{
          background: 'var(--surface)',
          borderBottom: '1px solid var(--border)',
          padding: '10px 20px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: '12px',
          flexShrink: 0,
        }}>
          <span style={{ color: 'var(--text-mid)', fontSize: '12px', lineHeight: '1.5', letterSpacing: '0.01em' }}>
            Add to Home Screen for the full experience — tap Share, then "Add to Home Screen"
          </span>
          <button
            onClick={() => { setShowIosBanner(false); sessionStorage.setItem('rdsy_ios_banner_dismissed', '1') }}
            style={{ background: 'none', border: 'none', color: 'var(--text-dim)', fontSize: '18px', cursor: 'pointer', flexShrink: 0, padding: '2px 6px' }}
            aria-label="Dismiss"
          >×</button>
        </div>
      )}

      {/* Search bar */}
      <div style={{
        padding: '14px 20px',
        borderBottom: '1px solid var(--border)',
        flexShrink: 0,
      }}>
        <div style={{ position: 'relative' }}>
          <span style={{
            position: 'absolute',
            left: '12px',
            top: '50%',
            transform: 'translateY(-50%)',
            color: 'var(--text-dim)',
            fontSize: '13px',
            pointerEvents: 'none',
          }}>⌕</span>
          <input
            type="search"
            placeholder="Search your library…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            style={{
              width: '100%',
              padding: '9px 12px 9px 32px',
              background: 'var(--surface)',
              border: '1px solid var(--border)',
              borderRadius: 'var(--radius)',
              color: 'var(--text)',
              fontSize: '13px',
              fontFamily: "'DM Sans', sans-serif",
              outline: 'none',
              transition: 'border-color var(--transition)',
              letterSpacing: '0.01em',
            }}
            onFocus={(e) => (e.currentTarget.style.borderColor = 'var(--gold-dim)')}
            onBlur={(e) => (e.currentTarget.style.borderColor = 'var(--border)')}
          />
        </div>
      </div>

      {/* Content */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '20px' }}>
        {isInitialLoading ? (
          <div style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: '16px',
            paddingTop: '100px',
            color: 'var(--text-dim)',
          }}>
            <div style={{
              width: '28px',
              height: '28px',
              border: '2px solid var(--border-mid)',
              borderTopColor: 'var(--gold)',
              borderRadius: '50%',
              animation: 'spin 0.9s linear infinite',
            }} />
            <span style={{ fontSize: '13px', letterSpacing: '0.04em' }}>Loading your library…</span>
          </div>
        ) : filteredBooks.length === 0 ? (
          <div style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: '14px',
            paddingTop: '100px',
            textAlign: 'center',
          }}>
            <span style={{
              fontFamily: "'Playfair Display', serif",
              fontSize: '32px',
              color: 'var(--border-mid)',
            }}>§</span>
            <p style={{
              color: 'var(--text-dim)',
              fontSize: '13px',
              lineHeight: '1.7',
              maxWidth: '240px',
              letterSpacing: '0.01em',
            }}>
              {search
                ? <>No titles matching <em>"{search}"</em></>
                : 'Your library is empty. Upload a PDF to begin.'}
            </p>
          </div>
        ) : (
          <>
            {/* Book count */}
            <p style={{
              fontSize: '10px',
              color: 'var(--text-dim)',
              letterSpacing: '0.1em',
              textTransform: 'uppercase',
              marginBottom: '14px',
            }}>
              {filteredBooks.length} {filteredBooks.length === 1 ? 'title' : 'titles'}
            </p>

            <div style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))',
              gap: '10px',
            }}>
              {filteredBooks.map((book) => (
                <BookCard
                  key={book.driveId}
                  book={book}
                  onPin={handlePin}
                  onOpen={(id) => navigate(`/reader/${id}`)}
                  pinLoading={pinLoading === book.driveId}
                />
              ))}
            </div>
          </>
        )}
      </div>

      {/* Hidden file input */}
      <input
        ref={fileInputRef}
        type="file"
        accept=".pdf"
        style={{ display: 'none' }}
        onChange={handleUpload}
      />

      {/* FAB */}
      <button
        onClick={() => fileInputRef.current?.click()}
        disabled={uploading}
        title={uploading ? 'Uploading…' : 'Upload PDF'}
        style={{
          position: 'fixed',
          bottom: 'calc(28px + env(safe-area-inset-bottom))',
          right: 'calc(28px + env(safe-area-inset-right))',
          width: '52px',
          height: '52px',
          borderRadius: '50%',
          background: uploading ? 'var(--border-mid)' : 'var(--gold)',
          border: 'none',
          color: uploading ? 'var(--text-dim)' : 'var(--bg)',
          fontSize: '24px',
          fontWeight: '300',
          cursor: uploading ? 'wait' : 'pointer',
          boxShadow: uploading ? 'none' : '0 4px 20px rgba(200,168,75,0.35)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          transition: 'background var(--transition), transform 0.12s, box-shadow var(--transition)',
          zIndex: 50,
          lineHeight: 1,
        }}
        onMouseEnter={(e) => {
          if (!uploading) {
            e.currentTarget.style.background = 'var(--gold-light)'
            e.currentTarget.style.transform = 'scale(1.07)'
          }
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.background = uploading ? 'var(--border-mid)' : 'var(--gold)'
          e.currentTarget.style.transform = 'scale(1)'
        }}
        aria-label={uploading ? 'Uploading…' : 'Upload PDF'}
      >
        {uploading ? (
          <div style={{
            width: '18px',
            height: '18px',
            border: '2px solid rgba(0,0,0,0.2)',
            borderTopColor: 'var(--bg)',
            borderRadius: '50%',
            animation: 'spin 0.8s linear infinite',
          }} />
        ) : '+'}
      </button>
    </div>
  )
}
