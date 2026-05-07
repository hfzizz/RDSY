import { useEffect, useRef, useState, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { useShallow } from 'zustand/react/shallow'
import { useStore } from '../App'
import type { BookEntry } from '../types'
import { syncLibrary, pushPendingWrites } from '../lib/sync'
import { ensureLibraryFolder } from '../lib/drive'
import { uploadPDF, downloadBlob } from '../lib/drive'
import { setPinned, removeCachedPDF, cachePDF } from '../lib/db'

const SYNC_INTERVAL_MS = 5 * 60 * 1000 // 5 minutes

function SyncDot({ status }: { status: string }) {
  const colors: Record<string, string> = {
    idle: '#4ade80',
    syncing: '#facc15',
    error: '#f87171',
    offline: '#9ca3af',
  }
  const color = colors[status] ?? '#9ca3af'

  return (
    <span
      title={status}
      style={{
        display: 'inline-block',
        width: '8px',
        height: '8px',
        borderRadius: '50%',
        background: color,
        boxShadow: `0 0 6px ${color}`,
        flexShrink: 0,
        animation: status === 'syncing' ? 'pulse 1s ease-in-out infinite' : 'none',
      }}
    />
  )
}

interface BookCardProps {
  book: BookEntry
  onPin: (driveId: string, currentlyPinned: boolean) => void
  onOpen: (driveId: string) => void
  pinLoading: boolean
}

function BookCard({ book, onPin, onOpen, pinLoading }: BookCardProps) {
  const [cardHovered, setCardHovered] = useState(false)

  const progressPage = book.sidecar?.progress.page ?? null
  const progressLabel =
    progressPage && progressPage > 1 ? `Page ${progressPage}` : 'Not started'

  return (
    <div
      onMouseEnter={() => setCardHovered(true)}
      onMouseLeave={() => setCardHovered(false)}
      style={{
        background: cardHovered ? '#1e2d52' : '#16213e',
        border: '1px solid #2a2a4e',
        borderRadius: '8px',
        padding: '16px',
        display: 'flex',
        flexDirection: 'column',
        gap: '10px',
        transition: 'background 0.15s',
        position: 'relative',
      }}
    >
      {/* Book name */}
      <div
        style={{
          color: '#e0e0e0',
          fontSize: '14px',
          fontWeight: '600',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          paddingRight: '28px', // room for pin button
        }}
        title={book.name}
      >
        {book.name}
      </div>

      {/* Progress */}
      <div style={{ color: '#9ca3af', fontSize: '12px' }}>{progressLabel}</div>

      {/* Actions row */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginTop: '2px' }}>
        <button
          onClick={() => onOpen(book.driveId)}
          style={{
            flex: 1,
            padding: '8px 12px',
            background: '#e94560',
            border: 'none',
            borderRadius: '6px',
            color: '#fff',
            fontSize: '13px',
            fontWeight: '600',
            cursor: 'pointer',
            minHeight: '36px',
            transition: 'background 0.15s',
          }}
          onMouseEnter={(e) => (e.currentTarget.style.background = '#d63652')}
          onMouseLeave={(e) => (e.currentTarget.style.background = '#e94560')}
        >
          Open
        </button>
      </div>

      {/* Pin button — absolute top-right */}
      <button
        onClick={() => onPin(book.driveId, book.pinnedOffline)}
        disabled={pinLoading}
        title={book.pinnedOffline ? 'Unpin from offline' : 'Pin for offline'}
        style={{
          position: 'absolute',
          top: '12px',
          right: '12px',
          background: 'none',
          border: 'none',
          cursor: pinLoading ? 'wait' : 'pointer',
          fontSize: '16px',
          padding: '4px',
          opacity: book.pinnedOffline ? 1 : 0.35,
          transition: 'opacity 0.15s',
          minWidth: '28px',
          minHeight: '28px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          borderRadius: '4px',
        }}
        onMouseEnter={(e) => {
          if (!pinLoading) e.currentTarget.style.opacity = '1'
        }}
        onMouseLeave={(e) => {
          if (!pinLoading) e.currentTarget.style.opacity = book.pinnedOffline ? '1' : '0.35'
        }}
        aria-label={book.pinnedOffline ? 'Unpin' : 'Pin offline'}
      >
        📌
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

  // Detect iOS Safari for "Add to Home Screen" banner
  useEffect(() => {
    const ua = navigator.userAgent
    const isIosSafari =
      ua.includes('Safari') && !ua.includes('Chrome') && !ua.includes('CriOS')
    const isStandalone = window.matchMedia('(display-mode: standalone)').matches
    const dismissed = sessionStorage.getItem('rdsy_ios_banner_dismissed')
    if (isIosSafari && !isStandalone && !dismissed) {
      setShowIosBanner(true)
    }
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

  // Initial sync + pending writes on mount
  useEffect(() => {
    if (auth.status !== 'authenticated') return
    const { accessToken } = auth

    doSync()

    // Push pending writes silently
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

  // Auto-sync every 5 minutes
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
        // Download and cache the PDF blob
        const blob = await downloadBlob(auth.accessToken, driveId)
        await cachePDF(driveId, blob)
      } else {
        await removeCachedPDF(driveId)
      }

      // Update local books state
      setBooks(
        books.map((b) =>
          b.driveId === driveId
            ? { ...b, pinnedOffline: newPinned, cachedLocally: newPinned }
            : b
        )
      )
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
      // Re-sync to include the new book
      await doSync()
    } catch (err) {
      console.error('[Library] upload failed:', err)
    } finally {
      setUploading(false)
      // Reset the file input so the same file can be re-selected
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }

  const filteredBooks: BookEntry[] = books.filter((b) =>
    b.name.toLowerCase().includes(search.toLowerCase())
  )

  const isInitialLoading = syncStatus === 'syncing' && books.length === 0

  return (
    <div
      style={{
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
        background: '#1a1a2e',
        minHeight: 0,
      }}
    >
      {/* iOS "Add to Home Screen" banner */}
      {showIosBanner && (
        <div
          style={{
            background: '#0f3460',
            borderBottom: '1px solid #2a2a4e',
            padding: '10px 16px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: '12px',
            flexShrink: 0,
          }}
        >
          <span style={{ color: '#e0e0e0', fontSize: '13px', lineHeight: '1.4' }}>
            Install RDSY: tap the Share button then "Add to Home Screen"
          </span>
          <button
            onClick={() => {
              setShowIosBanner(false)
              sessionStorage.setItem('rdsy_ios_banner_dismissed', '1')
            }}
            style={{
              background: 'none',
              border: 'none',
              color: '#9ca3af',
              fontSize: '18px',
              cursor: 'pointer',
              flexShrink: 0,
              padding: '4px 6px',
              minWidth: '32px',
              minHeight: '32px',
            }}
            aria-label="Dismiss banner"
          >
            ×
          </button>
        </div>
      )}

      {/* Toolbar: sync status + search */}
      <div
        style={{
          padding: '12px 16px',
          display: 'flex',
          alignItems: 'center',
          gap: '10px',
          flexShrink: 0,
          borderBottom: '1px solid #1e2a4a',
        }}
      >
        <SyncDot status={syncStatus} />
        <input
          type="search"
          placeholder="Search books…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          style={{
            flex: 1,
            padding: '8px 12px',
            background: '#16213e',
            border: '1px solid #2a2a4e',
            borderRadius: '8px',
            color: '#e0e0e0',
            fontSize: '14px',
            outline: 'none',
          }}
          onFocus={(e) => (e.currentTarget.style.borderColor = '#e94560')}
          onBlur={(e) => (e.currentTarget.style.borderColor = '#2a2a4e')}
        />
      </div>

      {/* Content area */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '16px', position: 'relative' }}>
        {/* Inline pulse keyframe via a style tag approach — inject once */}
        <style>{`
          @keyframes pulse {
            0%, 100% { opacity: 1; }
            50% { opacity: 0.4; }
          }
        `}</style>

        {isInitialLoading ? (
          /* Loading state */
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '16px',
              paddingTop: '80px',
              color: '#9ca3af',
              fontSize: '14px',
            }}
          >
            <span style={{ fontSize: '32px', animation: 'pulse 1.2s ease-in-out infinite' }}>
              📚
            </span>
            Loading your library…
          </div>
        ) : filteredBooks.length === 0 ? (
          /* Empty state */
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '12px',
              paddingTop: '80px',
              color: '#9ca3af',
              fontSize: '14px',
              textAlign: 'center',
              lineHeight: '1.5',
            }}
          >
            <span style={{ fontSize: '40px' }}>📖</span>
            {search
              ? `No books match "${search}"`
              : 'No books yet. Upload a PDF to start.'}
          </div>
        ) : (
          /* Book grid */
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))',
              gap: '12px',
            }}
          >
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
        title="Upload PDF"
        style={{
          position: 'fixed',
          bottom: '24px',
          right: '24px',
          width: '56px',
          height: '56px',
          borderRadius: '50%',
          background: uploading ? '#9ca3af' : '#e94560',
          border: 'none',
          color: '#fff',
          fontSize: '28px',
          fontWeight: '300',
          cursor: uploading ? 'wait' : 'pointer',
          boxShadow: '0 4px 16px rgba(233,69,96,0.4)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          transition: 'background 0.15s, transform 0.1s',
          zIndex: 50,
          lineHeight: '1',
        }}
        onMouseEnter={(e) => {
          if (!uploading) {
            e.currentTarget.style.background = '#d63652'
            e.currentTarget.style.transform = 'scale(1.06)'
          }
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.background = uploading ? '#9ca3af' : '#e94560'
          e.currentTarget.style.transform = 'scale(1)'
        }}
        aria-label={uploading ? 'Uploading…' : 'Upload PDF'}
      >
        {uploading ? '…' : '+'}
      </button>
    </div>
  )
}
