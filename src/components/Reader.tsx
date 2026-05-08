import { useCallback, useEffect, useRef, useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useStore } from '../store'
import { useShallow } from 'zustand/react/shallow'
import type { Sidecar } from '../types'
import { useBookLoader } from '../hooks/useBookLoader'
import { usePDFRenderer } from '../hooks/usePDFRenderer'
import { useReadingProgress } from '../hooks/useReadingProgress'
import { useCrossDeviceSync } from '../hooks/useCrossDeviceSync'
import { BookmarksPanel } from './Bookmarks'
import {
  readViewMode, saveViewMode, saveScroll,
  MIN_ZOOM, MAX_ZOOM, ZOOM_STEP, SPREAD_GAP_PX,
} from '../lib/readerStorage'
import { syncManager } from '../lib/SyncManager'

export default function Reader() {
  const { bookId } = useParams<{ bookId: string }>()
  const navigate = useNavigate()
  const { auth, books, updateSidecar } = useStore(useShallow(s => ({
    auth: s.auth,
    books: s.books,
    updateSidecar: s.updateSidecar,
  })))

  const accessToken = auth.status === 'authenticated' ? auth.accessToken : ''
  const book = books.find(b => b.driveId === bookId)

  const commit = useCallback(async (id: string, sidecar: Sidecar) => {
    const newDriveId = await syncManager.commitSidecar(accessToken, id, sidecar, book?.sidecarDriveId)
    updateSidecar(id, sidecar, newDriveId !== 'queued' ? newDriveId : undefined)
  }, [accessToken, book?.sidecarDriveId, updateSidecar])

  // UI state
  const [viewMode, setViewMode] = useState(() => readViewMode())
  const [bookmarksOpen, setBookmarksOpen] = useState(false)
  const isHoverDevice = typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    && window.matchMedia('(hover: hover)').matches
  const [topBarVisible, setTopBarVisible] = useState(true)
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Canvas refs — owned here, passed into renderer
  const leftCanvasRef = useRef<HTMLCanvasElement | null>(null)
  const rightCanvasRef = useRef<HTMLCanvasElement | null>(null)
  const containerRef = useRef<HTMLDivElement | null>(null)
  const canvasWrapperRef = useRef<HTMLDivElement | null>(null)
  const wrapperRef = useRef<HTMLDivElement | null>(null)

  // Zoom gesture refs (for immediate CSS preview before PDF.js re-render)
  const zoomRef = useRef(1)
  const desiredZoomRef = useRef(1)
  const zoomDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // ── Hooks ────────────────────────────────────────────────────────────────
  const {
    pdfDocRef, sidecar, setSidecar,
    totalPages, loading, renderError,
    startPage, hasLoadedRef, pendingScrollRef,
  } = useBookLoader(bookId, accessToken, book?.sidecarDriveId)

  const {
    currentPage, setCurrentPage,
    zoom, setZoom,
    changePage, adjustZoom, resetZoom,
    saveProgress,
  } = useReadingProgress(
    bookId,
    sidecar,
    setSidecar as (s: Sidecar) => void,
    startPage,
    totalPages,
    hasLoadedRef,
    viewMode,
    commit,
  )

  const leftPage = viewMode === 'spread' && currentPage % 2 === 0 ? currentPage - 1 : currentPage
  const rightPage = viewMode === 'spread' ? leftPage + 1 : null

  const { renderView } = usePDFRenderer(
    pdfDocRef, currentPage, leftPage, rightPage,
    zoom, viewMode, loading,
    leftCanvasRef, rightCanvasRef, containerRef, canvasWrapperRef,
  )

  useCrossDeviceSync(bookId, accessToken, auth.status, book?.sidecarDriveId, hasLoadedRef, setSidecar, setCurrentPage)

  // ── Effects ───────────────────────────────────────────────────────────────

  // Keep zoom refs in sync for gesture preview calculations
  useEffect(() => { zoomRef.current = zoom; desiredZoomRef.current = zoom }, [zoom])

  // Persist view mode
  useEffect(() => { saveViewMode(viewMode) }, [viewMode])

  // Trigger render + restore scroll position after load/page/zoom changes
  useEffect(() => {
    if (!loading && pdfDocRef.current) {
      renderView().then(() => {
        const pending = pendingScrollRef.current
        const container = containerRef.current
        if (pending && container) {
          container.scrollLeft = pending.x
          container.scrollTop = pending.y
          pendingScrollRef.current = null
        }
      })
    }
  }, [renderView, loading]) // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-hide top bar on hover-capable devices (desktop)
  useEffect(() => {
    if (!isHoverDevice) return
    if (hideTimerRef.current) clearTimeout(hideTimerRef.current)
    hideTimerRef.current = setTimeout(() => { setTopBarVisible(false); hideTimerRef.current = null }, 2000)
    return () => { if (hideTimerRef.current) { clearTimeout(hideTimerRef.current); hideTimerRef.current = null } }
  }, [isHoverDevice])

  // Debounced scroll position save
  useEffect(() => {
    const container = containerRef.current
    if (!container || !bookId) return
    let timer: ReturnType<typeof setTimeout> | null = null
    const onScroll = () => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => { saveScroll(bookId, container.scrollLeft, container.scrollTop); timer = null }, 300)
    }
    container.addEventListener('scroll', onScroll, { passive: true })
    return () => { container.removeEventListener('scroll', onScroll); if (timer) clearTimeout(timer) }
  }, [bookId, loading])

  // Ctrl+wheel zoom and pinch-to-zoom
  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    const clamp = (z: number) => Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, Math.round(z * 100) / 100))

    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return
      e.preventDefault()
      desiredZoomRef.current = clamp(desiredZoomRef.current + -Math.sign(e.deltaY) * 0.1)
      if (canvasWrapperRef.current) canvasWrapperRef.current.style.transform = `scale(${desiredZoomRef.current / zoomRef.current})`
      if (zoomDebounceRef.current) clearTimeout(zoomDebounceRef.current)
      zoomDebounceRef.current = setTimeout(() => { setZoom(desiredZoomRef.current); zoomDebounceRef.current = null }, 160)
    }

    let pinchStartDist = 0
    let pinchStartZoom = 1
    const onTouchStart = (e: TouchEvent) => {
      if (e.touches.length !== 2) return
      pinchStartDist = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY)
      pinchStartZoom = zoomRef.current
    }
    const onTouchMove = (e: TouchEvent) => {
      if (e.touches.length !== 2 || pinchStartDist === 0) return
      e.preventDefault()
      const dist = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY)
      desiredZoomRef.current = clamp(pinchStartZoom * (dist / pinchStartDist))
      if (canvasWrapperRef.current) canvasWrapperRef.current.style.transform = `scale(${desiredZoomRef.current / zoomRef.current})`
      if (zoomDebounceRef.current) clearTimeout(zoomDebounceRef.current)
      zoomDebounceRef.current = setTimeout(() => { setZoom(desiredZoomRef.current); zoomDebounceRef.current = null }, 100)
    }
    const onTouchEnd = () => { pinchStartDist = 0 }

    container.addEventListener('wheel', onWheel, { passive: false })
    container.addEventListener('touchstart', onTouchStart, { passive: true })
    container.addEventListener('touchmove', onTouchMove, { passive: false })
    container.addEventListener('touchend', onTouchEnd)
    container.addEventListener('touchcancel', onTouchEnd)
    return () => {
      container.removeEventListener('wheel', onWheel)
      container.removeEventListener('touchstart', onTouchStart)
      container.removeEventListener('touchmove', onTouchMove)
      container.removeEventListener('touchend', onTouchEnd)
      container.removeEventListener('touchcancel', onTouchEnd)
      if (zoomDebounceRef.current) { clearTimeout(zoomDebounceRef.current); zoomDebounceRef.current = null }
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Handlers ──────────────────────────────────────────────────────────────

  function handleWrapperMouseMove(e: React.MouseEvent<HTMLDivElement>) {
    if (!isHoverDevice) return
    const rect = wrapperRef.current?.getBoundingClientRect()
    if (!rect) return
    if (e.clientY - rect.top < 80) {
      if (hideTimerRef.current) { clearTimeout(hideTimerRef.current); hideTimerRef.current = null }
      setTopBarVisible(true)
    } else if (!hideTimerRef.current) {
      hideTimerRef.current = setTimeout(() => { setTopBarVisible(false); hideTimerRef.current = null }, 1200)
    }
  }

  function handleSidecarChange(updated: Sidecar) {
    setSidecar(updated)
    commit(bookId!, updated).catch(() => {})
  }

  // ── Derived display values ────────────────────────────────────────────────

  const bookName = book?.name ?? 'Loading…'
  const zoomPct = Math.round(zoom * 100)
  const displayLabel = viewMode === 'spread' && rightPage && rightPage <= totalPages
    ? `${leftPage}–${rightPage} / ${totalPages}`
    : `${currentPage} / ${totalPages}`

  const iconBtnStyle = (active: boolean): React.CSSProperties => ({
    background: active ? 'rgba(200,168,75,0.12)' : 'none',
    border: 'none',
    color: active ? 'var(--gold)' : 'var(--text-dim)',
    fontSize: '16px',
    cursor: 'pointer',
    padding: '6px',
    minWidth: '36px',
    minHeight: '36px',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: '4px',
    flexShrink: 0,
    transition: 'color var(--transition), background var(--transition)',
  })

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div
      ref={wrapperRef}
      onMouseMove={handleWrapperMouseMove}
      style={{ display: 'flex', flexDirection: 'column', height: '100%', background: 'var(--bg)', overflow: 'hidden', position: 'relative' }}
    >
      {/* Top bar */}
      <div style={{
        position: 'absolute', top: 0, left: 0, right: 0, zIndex: 5,
        display: 'flex', alignItems: 'center', gap: '6px',
        padding: 'env(safe-area-inset-top) 8px 0',
        height: 'calc(50px + env(safe-area-inset-top))',
        background: 'rgba(12,10,7,0.92)', backdropFilter: 'blur(8px)', WebkitBackdropFilter: 'blur(8px)',
        borderBottom: '1px solid var(--border)',
        transform: topBarVisible ? 'translateY(0)' : 'translateY(-100%)',
        transition: 'transform 0.2s ease',
        pointerEvents: topBarVisible ? 'auto' : 'none',
      }}>
        <button
          onClick={() => navigate('/')}
          style={{ background: 'none', border: 'none', color: 'var(--text-dim)', fontSize: '18px', cursor: 'pointer', padding: '8px', minWidth: '44px', minHeight: '44px', display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: '4px', flexShrink: 0, transition: 'color var(--transition)' }}
          onMouseEnter={e => (e.currentTarget.style.color = 'var(--text)')}
          onMouseLeave={e => (e.currentTarget.style.color = 'var(--text-dim)')}
          aria-label="Back to library"
        >←</button>

        <div style={{ flex: 1, color: 'var(--text-mid)', fontSize: '12px', fontFamily: "'DM Sans', sans-serif", letterSpacing: '0.01em', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }} title={bookName}>
          {bookName.replace(/\.pdf$/i, '')}
        </div>

        <button onClick={() => adjustZoom(-ZOOM_STEP)} disabled={zoom <= MIN_ZOOM} style={{ ...iconBtnStyle(false), opacity: zoom <= MIN_ZOOM ? 0.4 : 1 }} aria-label="Zoom out" title="Zoom out (Ctrl+Scroll)">−</button>
        <button
          onClick={resetZoom}
          style={{ background: 'none', border: 'none', color: 'var(--text-dim)', fontSize: '11px', fontFamily: "'DM Sans', sans-serif", letterSpacing: '0.04em', cursor: 'pointer', padding: '6px', minHeight: '36px', borderRadius: '4px', flexShrink: 0, minWidth: '46px', fontVariantNumeric: 'tabular-nums' }}
          aria-label="Reset zoom" title="Reset zoom to 100%"
        >{zoomPct}%</button>
        <button onClick={() => adjustZoom(ZOOM_STEP)} disabled={zoom >= MAX_ZOOM} style={{ ...iconBtnStyle(false), opacity: zoom >= MAX_ZOOM ? 0.4 : 1 }} aria-label="Zoom in" title="Zoom in (Ctrl+Scroll)">+</button>
        <button onClick={() => setViewMode(m => m === 'single' ? 'spread' : 'single')} style={iconBtnStyle(viewMode === 'spread')} aria-label={viewMode === 'spread' ? 'Single page view' : 'Two-page spread'} title={viewMode === 'spread' ? 'Switch to single page' : 'Switch to two-page spread'}>{viewMode === 'spread' ? '▤' : '▥'}</button>
        <button onClick={() => setBookmarksOpen(o => !o)} style={iconBtnStyle(bookmarksOpen)} aria-label="Toggle bookmarks">☰</button>
      </div>

      {/* Canvas area */}
      <div ref={containerRef} style={{ flex: 1, overflow: 'auto', background: '#111827', position: 'relative', minHeight: 0, touchAction: 'pan-x pan-y' }}>
        {loading && (
          <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '12px', color: '#9ca3af', fontSize: '14px', background: '#111827', zIndex: 10 }}>
            <div style={{ width: '36px', height: '36px', border: '3px solid #2a2a4e', borderTopColor: '#e94560', borderRadius: '50%', animation: 'spin 0.8s linear infinite' }} />
            Loading PDF…
            <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
          </div>
        )}
        {renderError && !loading && (
          <div style={{ padding: '24px', color: '#f87171', fontSize: '14px', textAlign: 'center' }}>{renderError}</div>
        )}
        {!loading && !renderError && (
          <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'center', padding: '8px', width: 'fit-content', minWidth: '100%', minHeight: '100%', boxSizing: 'border-box' }}>
            <div ref={canvasWrapperRef} style={{ display: 'flex', gap: viewMode === 'spread' ? `${SPREAD_GAP_PX}px` : 0, flexShrink: 0, transformOrigin: 'top center' }}>
              <canvas ref={leftCanvasRef} style={{ display: 'block', flexShrink: 0 }} />
              <canvas ref={rightCanvasRef} style={{ display: viewMode === 'spread' ? 'block' : 'none', flexShrink: 0 }} />
            </div>
          </div>
        )}
      </div>

      {/* Page navigation */}
      {!loading && totalPages > 0 && (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '12px', padding: '10px 16px calc(10px + env(safe-area-inset-bottom))', background: 'var(--surface)', borderTop: '1px solid var(--border)', flexShrink: 0 }}>
          <button
            onClick={() => changePage(-1)} disabled={currentPage <= 1}
            style={{ padding: '8px 18px', background: 'transparent', border: `1px solid ${currentPage <= 1 ? 'var(--border)' : 'var(--border-mid)'}`, borderRadius: '3px', color: currentPage <= 1 ? 'var(--text-dim)' : 'var(--text-mid)', fontSize: '12px', fontFamily: "'DM Sans', sans-serif", letterSpacing: '0.04em', cursor: currentPage <= 1 ? 'default' : 'pointer', minHeight: '38px', transition: 'border-color var(--transition), color var(--transition)', opacity: currentPage <= 1 ? 0.4 : 1 }}
            onMouseEnter={e => { if (currentPage > 1) { e.currentTarget.style.borderColor = 'var(--gold-dim)'; e.currentTarget.style.color = 'var(--text)' } }}
            onMouseLeave={e => { if (currentPage > 1) { e.currentTarget.style.borderColor = 'var(--border-mid)'; e.currentTarget.style.color = 'var(--text-mid)' } }}
            aria-label="Previous page"
          >← Prev</button>
          <span style={{ color: 'var(--text-dim)', fontSize: '11px', minWidth: '80px', textAlign: 'center', fontVariantNumeric: 'tabular-nums', letterSpacing: '0.04em' }}>{displayLabel}</span>
          <button
            onClick={() => changePage(1)} disabled={currentPage >= totalPages}
            style={{ padding: '8px 18px', background: 'transparent', border: `1px solid ${currentPage >= totalPages ? 'var(--border)' : 'var(--border-mid)'}`, borderRadius: '3px', color: currentPage >= totalPages ? 'var(--text-dim)' : 'var(--text-mid)', fontSize: '12px', fontFamily: "'DM Sans', sans-serif", letterSpacing: '0.04em', cursor: currentPage >= totalPages ? 'default' : 'pointer', minHeight: '38px', transition: 'border-color var(--transition), color var(--transition)', opacity: currentPage >= totalPages ? 0.4 : 1 }}
            onMouseEnter={e => { if (currentPage < totalPages) { e.currentTarget.style.borderColor = 'var(--gold-dim)'; e.currentTarget.style.color = 'var(--text)' } }}
            onMouseLeave={e => { if (currentPage < totalPages) { e.currentTarget.style.borderColor = 'var(--border-mid)'; e.currentTarget.style.color = 'var(--text-mid)' } }}
            aria-label="Next page"
          >Next →</button>
        </div>
      )}

      {/* Bookmarks panel */}
      {sidecar && (
        <BookmarksPanel
          isOpen={bookmarksOpen}
          sidecar={sidecar}
          currentPage={currentPage}
          onClose={() => setBookmarksOpen(false)}
          onNavigate={page => { setCurrentPage(page); setBookmarksOpen(false) }}
          onSidecarChange={handleSidecarChange}
        />
      )}
    </div>
  )
}
