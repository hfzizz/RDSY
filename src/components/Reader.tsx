import { useEffect, useRef, useState, useCallback } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import * as pdfjsLib from 'pdfjs-dist'
import type { PDFDocumentProxy, RenderTask } from 'pdfjs-dist'
import { useStore } from '../App'
import { useShallow } from 'zustand/react/shallow'
import type { Sidecar } from '../types'
import { getDeviceId } from '../types'
import { getCachedPDF, cachePDF } from '../lib/db'
import { downloadBlob } from '../lib/drive'
import { loadSidecar } from '../lib/sidecar'
import { BookmarksPanel } from './Bookmarks'

// Configure PDF.js worker
pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.mjs',
  import.meta.url
).href

const DEBOUNCE_MS = 2000

const VIEW_MODE_KEY = 'rdsy:viewMode'
const ZOOM_KEY_PREFIX = 'rdsy:zoom:'
const SCROLL_KEY_PREFIX = 'rdsy:scroll:'
const SPREAD_GAP_PX = 8
const MIN_ZOOM = 0.5
const MAX_ZOOM = 4
const ZOOM_STEP = 0.25

type ViewMode = 'single' | 'spread'

function readViewMode(): ViewMode {
  const v = typeof localStorage !== 'undefined' ? localStorage.getItem(VIEW_MODE_KEY) : null
  return v === 'spread' ? 'spread' : 'single'
}

function readZoom(bookId: string | undefined): number {
  if (!bookId || typeof localStorage === 'undefined') return 1
  const raw = localStorage.getItem(ZOOM_KEY_PREFIX + bookId)
  const n = raw ? parseFloat(raw) : NaN
  if (!isFinite(n) || n <= 0) return 1
  return Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, n))
}

function readScroll(bookId: string | undefined): { x: number; y: number } | null {
  if (!bookId || typeof localStorage === 'undefined') return null
  const raw = localStorage.getItem(SCROLL_KEY_PREFIX + bookId)
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as { x: number; y: number }
    if (typeof parsed.x === 'number' && typeof parsed.y === 'number') return parsed
  } catch { /* ignore */ }
  return null
}

const PAGE_KEY_PREFIX = 'rdsy:page:'

type LocalPage = { page: number; updatedAt: string }

function readPageLocal(bookId: string | undefined): LocalPage | null {
  if (!bookId || typeof localStorage === 'undefined') return null
  const raw = localStorage.getItem(PAGE_KEY_PREFIX + bookId)
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as LocalPage
    if (typeof parsed.page === 'number' && typeof parsed.updatedAt === 'string') return parsed
  } catch { /* ignore */ }
  return null
}

function savePageLocal(bookId: string | undefined, page: number) {
  if (!bookId || typeof localStorage === 'undefined') return
  try {
    localStorage.setItem(
      PAGE_KEY_PREFIX + bookId,
      JSON.stringify({ page, updatedAt: new Date().toISOString() })
    )
  } catch { /* ignore */ }
}

export default function Reader() {
  const { bookId } = useParams<{ bookId: string }>()
  const navigate = useNavigate()

  const { auth, books, commitSidecar } = useStore(useShallow((s) => ({ auth: s.auth, books: s.books, commitSidecar: s.commitSidecar })))

  const book = books.find((b) => b.driveId === bookId)

  // PDF state
  const [currentPage, setCurrentPage] = useState(1)
  const [totalPages, setTotalPages] = useState(0)
  const [loading, setLoading] = useState(true)
  const [renderError, setRenderError] = useState<string | null>(null)
  const [bookmarksOpen, setBookmarksOpen] = useState(false)
  const [sidecar, setSidecar] = useState<Sidecar | null>(book?.sidecar ?? null)
  const [viewMode, setViewMode] = useState<ViewMode>(() => readViewMode())
  const [zoom, setZoom] = useState<number>(() => readZoom(bookId))

  // Auto-hide top bar on desktop (hover-capable devices). Touch devices keep it visible.
  const isHoverDevice =
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(hover: hover)').matches
  const [topBarVisible, setTopBarVisible] = useState<boolean>(true)
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Refs
  const pdfDocRef = useRef<PDFDocumentProxy | null>(null)
  const leftCanvasRef = useRef<HTMLCanvasElement | null>(null)
  const rightCanvasRef = useRef<HTMLCanvasElement | null>(null)
  const containerRef = useRef<HTMLDivElement | null>(null)
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const sessionStartRef = useRef<string>(new Date().toISOString())
  const startPageRef = useRef<number>(1)
  const objectUrlRef = useRef<string | null>(null)
  const zoomRef = useRef<number>(zoom)
  useEffect(() => {
    zoomRef.current = zoom
    desiredZoomRef.current = zoom
  }, [zoom])
  const wrapperRef = useRef<HTMLDivElement | null>(null)
  const pendingScrollRef = useRef<{ x: number; y: number } | null>(null)
  const scrollSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const leftRenderTaskRef = useRef<RenderTask | null>(null)
  const rightRenderTaskRef = useRef<RenderTask | null>(null)
  const desiredZoomRef = useRef<number>(zoom)
  const zoomDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const hasLoadedRef = useRef<boolean>(false)
  const canvasWrapperRef = useRef<HTMLDivElement | null>(null)

  // On desktop: schedule the top bar to hide after a brief idle period
  useEffect(() => {
    if (!isHoverDevice) return
    if (hideTimerRef.current) clearTimeout(hideTimerRef.current)
    hideTimerRef.current = setTimeout(() => {
      setTopBarVisible(false)
      hideTimerRef.current = null
    }, 2000)
    return () => {
      if (hideTimerRef.current) {
        clearTimeout(hideTimerRef.current)
        hideTimerRef.current = null
      }
    }
  }, [isHoverDevice])

  function handleWrapperMouseMove(e: React.MouseEvent<HTMLDivElement>) {
    if (!isHoverDevice) return
    const rect = wrapperRef.current?.getBoundingClientRect()
    if (!rect) return
    const y = e.clientY - rect.top
    if (y < 80) {
      if (hideTimerRef.current) {
        clearTimeout(hideTimerRef.current)
        hideTimerRef.current = null
      }
      setTopBarVisible(true)
    } else if (!hideTimerRef.current) {
      hideTimerRef.current = setTimeout(() => {
        setTopBarVisible(false)
        hideTimerRef.current = null
      }, 1200)
    }
  }

  // Persist view mode + zoom + current page
  useEffect(() => {
    try { localStorage.setItem(VIEW_MODE_KEY, viewMode) } catch { /* ignore */ }
  }, [viewMode])
  useEffect(() => {
    if (!bookId) return
    try { localStorage.setItem(ZOOM_KEY_PREFIX + bookId, String(zoom)) } catch { /* ignore */ }
  }, [zoom, bookId])
  useEffect(() => {
    if (!bookId || loading) return
    savePageLocal(bookId, currentPage)
  }, [bookId, currentPage, loading])

  // Spread layout: pair from page 1 → (1,2), (3,4), …
  // leftPage is always odd. If currentPage is even we render the pair starting at currentPage-1.
  const leftPage = viewMode === 'spread' && currentPage % 2 === 0 ? currentPage - 1 : currentPage
  const rightPage = viewMode === 'spread' ? leftPage + 1 : null

  // Load PDF on mount
  useEffect(() => {
    if (!bookId || auth.status !== 'authenticated') return

    let cancelled = false

    async function loadPDF() {
      setLoading(true)
      setRenderError(null)

      try {
        const { accessToken } = auth as { accessToken: string; status: 'authenticated'; expiresAt: number }

        // Try cache first; cache after download if not present
        let blob: Blob | undefined = await getCachedPDF(bookId!)

        if (!blob) {
          blob = await downloadBlob(accessToken, bookId!)
          cachePDF(bookId!, blob).catch(() => {})
        }

        if (cancelled) return

        // Revoke any prior object URL, create a new one for streaming parse
        if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current)
        const blobUrl = URL.createObjectURL(blob)
        objectUrlRef.current = blobUrl

        // Parse PDF and load sidecar in parallel — faster than sequential
        let [pdf, freshSidecar] = await Promise.all([
          pdfjsLib.getDocument({ url: blobUrl }).promise,
          loadSidecar(accessToken, bookId!, book?.sidecarDriveId),
        ])

        if (cancelled) {
          pdf.destroy()
          return
        }

        // Use localStorage snapshot as tiebreaker for same-device IDB race
        const localPage = readPageLocal(bookId)
        if (localPage && localPage.updatedAt > freshSidecar.progress.updatedAt) {
          freshSidecar = {
            ...freshSidecar,
            progress: { ...freshSidecar.progress, page: localPage.page, updatedAt: localPage.updatedAt },
          }
        }

        pdfDocRef.current = pdf
        setTotalPages(pdf.numPages)
        setSidecar(freshSidecar)

        const clamped = Math.max(1, Math.min(freshSidecar.progress.page, pdf.numPages))
        setCurrentPage(clamped)
        startPageRef.current = clamped
        pendingScrollRef.current = readScroll(bookId)

        hasLoadedRef.current = true
        setLoading(false)
      } catch (err) {
        if (cancelled) return
        console.error('[Reader] PDF load error:', err)
        setRenderError('Failed to load PDF. Please try again.')
        setLoading(false)
      }
    }

    loadPDF()

    return () => {
      cancelled = true
    }
  }, [bookId, auth.status]) // eslint-disable-line react-hooks/exhaustive-deps

  // Render the current view (one or two canvases) at current zoom
  const renderView = useCallback(async () => {
    const pdf = pdfDocRef.current
    const container = containerRef.current
    if (!pdf || !container) return

    const containerWidth = container.clientWidth || window.innerWidth
    const dpr = window.devicePixelRatio || 1

    const renderTo = async (
      pageNum: number | null,
      canvas: HTMLCanvasElement | null,
      baseWidth: number,
      taskRef: React.MutableRefObject<RenderTask | null>
    ) => {
      if (!canvas) return
      if (pageNum === null || pageNum < 1 || pageNum > pdf.numPages) {
        canvas.width = 0
        canvas.height = 0
        canvas.style.display = 'none'
        return
      }
      canvas.style.display = 'block'

      // Cancel any in-flight render for this canvas
      if (taskRef.current) {
        taskRef.current.cancel()
        taskRef.current = null
      }

      const page = await pdf.getPage(pageNum)
      const baseViewport = page.getViewport({ scale: 1 })
      const fitScale = baseWidth / baseViewport.width
      const renderScale = fitScale * zoom * dpr
      const v = page.getViewport({ scale: renderScale })

      // Render into an offscreen canvas so the visible canvas never goes blank
      const offscreen = document.createElement('canvas')
      offscreen.width = v.width
      offscreen.height = v.height
      const ctx = offscreen.getContext('2d')
      if (!ctx) return

      const task = page.render({ canvasContext: ctx, viewport: v, canvas: offscreen })
      taskRef.current = task

      try {
        await task.promise
      } catch (err: unknown) {
        taskRef.current = null
        if (err instanceof Error && err.message?.includes('cancelled')) return
        console.error('[Reader] render error:', err)
        return
      }
      taskRef.current = null

      // Atomically swap — resize and copy in one paint frame, no blank gap
      canvas.width = v.width
      canvas.height = v.height
      canvas.style.width = `${v.width / dpr}px`
      canvas.style.height = `${v.height / dpr}px`
      const destCtx = canvas.getContext('2d')
      if (destCtx) destCtx.drawImage(offscreen, 0, 0)
    }

    if (viewMode === 'single') {
      await renderTo(currentPage, leftCanvasRef.current, containerWidth, leftRenderTaskRef)
      await renderTo(null, rightCanvasRef.current, containerWidth, rightRenderTaskRef)
    } else {
      const halfWidth = Math.max(50, (containerWidth - SPREAD_GAP_PX) / 2)
      await Promise.all([
        renderTo(leftPage, leftCanvasRef.current, halfWidth, leftRenderTaskRef),
        renderTo(rightPage, rightCanvasRef.current, halfWidth, rightRenderTaskRef),
      ])
    }
    // Canvas is now rendered at the real zoom level — remove the CSS preview scale
    if (canvasWrapperRef.current) {
      canvasWrapperRef.current.style.transform = 'none'
    }
  }, [currentPage, viewMode, zoom, leftPage, rightPage])

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
  }, [renderView, loading])

  // Debounced save of scroll position per-book
  useEffect(() => {
    const container = containerRef.current
    if (!container || !bookId) return
    const onScroll = () => {
      if (scrollSaveTimerRef.current) clearTimeout(scrollSaveTimerRef.current)
      scrollSaveTimerRef.current = setTimeout(() => {
        try {
          localStorage.setItem(
            SCROLL_KEY_PREFIX + bookId,
            JSON.stringify({ x: container.scrollLeft, y: container.scrollTop })
          )
        } catch { /* ignore */ }
        scrollSaveTimerRef.current = null
      }, 300)
    }
    container.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      container.removeEventListener('scroll', onScroll)
      if (scrollSaveTimerRef.current) {
        clearTimeout(scrollSaveTimerRef.current)
        scrollSaveTimerRef.current = null
      }
    }
  }, [bookId, loading])

  // Re-render on resize
  useEffect(() => {
    const onResize = () => {
      if (!loading && pdfDocRef.current) renderView()
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [renderView, loading])

  // Ctrl+wheel zoom and pinch zoom
  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const clamp = (z: number) => Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, Math.round(z * 100) / 100))

    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return
      e.preventDefault()
      const delta = -Math.sign(e.deltaY) * 0.1
      desiredZoomRef.current = clamp(desiredZoomRef.current + delta)
      // Immediate CSS preview — no PDF.js re-render yet
      if (canvasWrapperRef.current) {
        canvasWrapperRef.current.style.transform = `scale(${desiredZoomRef.current / zoomRef.current})`
      }
      if (zoomDebounceRef.current) clearTimeout(zoomDebounceRef.current)
      zoomDebounceRef.current = setTimeout(() => {
        setZoom(desiredZoomRef.current)
        zoomDebounceRef.current = null
      }, 160)
    }

    let pinchStartDist = 0
    let pinchStartZoom = 1

    const onTouchStart = (e: TouchEvent) => {
      if (e.touches.length === 2) {
        const dx = e.touches[0].clientX - e.touches[1].clientX
        const dy = e.touches[0].clientY - e.touches[1].clientY
        pinchStartDist = Math.hypot(dx, dy)
        pinchStartZoom = zoomRef.current
      }
    }

    const onTouchMove = (e: TouchEvent) => {
      if (e.touches.length === 2 && pinchStartDist > 0) {
        e.preventDefault()
        const dx = e.touches[0].clientX - e.touches[1].clientX
        const dy = e.touches[0].clientY - e.touches[1].clientY
        const dist = Math.hypot(dx, dy)
        const ratio = dist / pinchStartDist
        desiredZoomRef.current = clamp(pinchStartZoom * ratio)
        // Immediate CSS preview
        if (canvasWrapperRef.current) {
          canvasWrapperRef.current.style.transform = `scale(${desiredZoomRef.current / zoomRef.current})`
        }
        if (zoomDebounceRef.current) clearTimeout(zoomDebounceRef.current)
        zoomDebounceRef.current = setTimeout(() => {
          setZoom(desiredZoomRef.current)
          zoomDebounceRef.current = null
        }, 100)
      }
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
      if (zoomDebounceRef.current) {
        clearTimeout(zoomDebounceRef.current)
        zoomDebounceRef.current = null
      }
    }
  }, [])

  // Debounced save progress
  const saveProgress = useCallback(
    (page: number, sc: Sidecar) => {
      if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current)
      debounceTimerRef.current = setTimeout(async () => {
        const updated: Sidecar = {
          ...sc,
          progress: {
            ...sc.progress,
            page,
            updatedAt: new Date().toISOString(),
            updatedBy: getDeviceId(),
          },
        }
        setSidecar(updated)
        await commitSidecar(bookId!, updated)
      }, DEBOUNCE_MS)
    },
    [commitSidecar, bookId]
  )

  function changePage(delta: number) {
    const pdf = pdfDocRef.current
    if (!pdf) return
    const step = viewMode === 'spread' ? Math.sign(delta) * 2 : delta
    const next = Math.max(1, Math.min(currentPage + step, totalPages))
    if (next === currentPage) return
    setCurrentPage(next)
    if (sidecar) saveProgress(next, sidecar)
  }

  function adjustZoom(delta: number) {
    setZoom((z) => Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, Math.round((z + delta) * 100) / 100)))
  }

  function resetZoom() { setZoom(1) }

  function toggleViewMode() {
    setViewMode((m) => (m === 'single' ? 'spread' : 'single'))
  }

  // Session tracking — record on unmount
  useEffect(() => {
    return () => {
      if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current)

      // Skip if PDF never finished loading (e.g. React Strict Mode fake unmount)
      if (!hasLoadedRef.current) return

      const sc = sidecarAtUnmount.current
      if (!sc) return

      const now = new Date().toISOString()
      const session = {
        device: getDeviceId(),
        startedAt: sessionStartRef.current,
        endedAt: now,
        pagesRead: Math.abs(currentPageAtUnmount.current - startPageRef.current),
      }

      const updated: Sidecar = {
        ...sc,
        progress: {
          ...sc.progress,
          page: currentPageAtUnmount.current,
          updatedAt: now,
          updatedBy: getDeviceId(),
        },
        stats: { sessions: [...sc.stats.sessions, session] },
      }

      // Synchronous localStorage snapshot before async IDB write (prevents race on quick re-open)
      savePageLocal(bookId, currentPageAtUnmount.current)

      // Fire-and-forget save via the single writer
      commitSidecar(bookId!, updated).catch(() => {})

      // Revoke object URL
      if (objectUrlRef.current) {
        URL.revokeObjectURL(objectUrlRef.current)
        objectUrlRef.current = null
      }
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Keep mutable refs for unmount closure (avoids stale closure issues)
  const sidecarAtUnmount = useRef<Sidecar | null>(null)
  const currentPageAtUnmount = useRef<number>(1)
  useEffect(() => {
    sidecarAtUnmount.current = sidecar
    currentPageAtUnmount.current = currentPage
  })

  function handleSidecarChange(updated: Sidecar) {
    setSidecar(updated)
    commitSidecar(bookId!, updated).catch(() => {})
  }

  const bookName = book?.name ?? 'Loading…'
  const zoomPct = Math.round(zoom * 100)
  const displayLabel =
    viewMode === 'spread' && rightPage && rightPage <= totalPages
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

  return (
    <div
      ref={wrapperRef}
      onMouseMove={handleWrapperMouseMove}
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        background: 'var(--bg)',
        overflow: 'hidden',
        position: 'relative',
      }}
    >
      {/* Top bar — overlays canvas, auto-hides on desktop */}
      <div
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          right: 0,
          zIndex: 5,
          display: 'flex',
          alignItems: 'center',
          gap: '6px',
          padding: '0 8px',
          height: '50px',
          background: 'rgba(12,10,7,0.92)',
          backdropFilter: 'blur(8px)',
          WebkitBackdropFilter: 'blur(8px)',
          borderBottom: '1px solid var(--border)',
          transform: topBarVisible ? 'translateY(0)' : 'translateY(-100%)',
          transition: 'transform 0.2s ease',
          pointerEvents: topBarVisible ? 'auto' : 'none',
        }}
      >
        {/* Back button */}
        <button
          onClick={() => navigate('/')}
          style={{
            background: 'none',
            border: 'none',
            color: 'var(--text-dim)',
            fontSize: '18px',
            cursor: 'pointer',
            padding: '8px',
            minWidth: '44px',
            minHeight: '44px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            borderRadius: '4px',
            flexShrink: 0,
            transition: 'color var(--transition)',
          }}
          onMouseEnter={(e) => (e.currentTarget.style.color = 'var(--text)')}
          onMouseLeave={(e) => (e.currentTarget.style.color = 'var(--text-dim)')}
          aria-label="Back to library"
        >
          ←
        </button>

        {/* Book name */}
        <div
          style={{
            flex: 1,
            color: 'var(--text-mid)',
            fontSize: '12px',
            fontFamily: "'DM Sans', sans-serif",
            letterSpacing: '0.01em',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            minWidth: 0,
          }}
          title={bookName}
        >
          {bookName.replace(/\.pdf$/i, '')}
        </div>

        {/* Zoom controls */}
        <button
          onClick={() => adjustZoom(-ZOOM_STEP)}
          disabled={zoom <= MIN_ZOOM}
          style={{ ...iconBtnStyle(false), opacity: zoom <= MIN_ZOOM ? 0.4 : 1 }}
          aria-label="Zoom out"
          title="Zoom out (Ctrl+Scroll)"
        >
          −
        </button>
        <button
          onClick={resetZoom}
          style={{
            background: 'none',
            border: 'none',
            color: 'var(--text-dim)',
            fontSize: '11px',
            fontFamily: "'DM Sans', sans-serif",
            letterSpacing: '0.04em',
            cursor: 'pointer',
            padding: '6px 6px',
            minHeight: '36px',
            borderRadius: '4px',
            flexShrink: 0,
            minWidth: '46px',
            fontVariantNumeric: 'tabular-nums',
          }}
          aria-label="Reset zoom"
          title="Reset zoom to 100%"
        >
          {zoomPct}%
        </button>
        <button
          onClick={() => adjustZoom(ZOOM_STEP)}
          disabled={zoom >= MAX_ZOOM}
          style={{ ...iconBtnStyle(false), opacity: zoom >= MAX_ZOOM ? 0.4 : 1 }}
          aria-label="Zoom in"
          title="Zoom in (Ctrl+Scroll)"
        >
          +
        </button>

        {/* View mode toggle */}
        <button
          onClick={toggleViewMode}
          style={iconBtnStyle(viewMode === 'spread')}
          aria-label={viewMode === 'spread' ? 'Single page view' : 'Two-page (spread) view'}
          title={viewMode === 'spread' ? 'Switch to single page' : 'Switch to two-page spread'}
        >
          {viewMode === 'spread' ? '▤' : '▥'}
        </button>

        {/* Bookmarks toggle */}
        <button
          onClick={() => setBookmarksOpen((o) => !o)}
          style={iconBtnStyle(bookmarksOpen)}
          aria-label="Toggle bookmarks"
        >
          ☰
        </button>
      </div>

      {/* Canvas area */}
      <div
        ref={containerRef}
        style={{
          flex: 1,
          overflow: 'auto',
          background: '#111827',
          position: 'relative',
          minHeight: 0,
          touchAction: 'pan-x pan-y',
        }}
      >
        {loading && (
          <div
            style={{
              position: 'absolute',
              inset: 0,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '12px',
              color: '#9ca3af',
              fontSize: '14px',
              background: '#111827',
              zIndex: 10,
            }}
          >
            <div
              style={{
                width: '36px',
                height: '36px',
                border: '3px solid #2a2a4e',
                borderTopColor: '#e94560',
                borderRadius: '50%',
                animation: 'spin 0.8s linear infinite',
              }}
            />
            Loading PDF…
            <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
          </div>
        )}

        {renderError && !loading && (
          <div
            style={{
              padding: '24px',
              color: '#f87171',
              fontSize: '14px',
              textAlign: 'center',
            }}
          >
            {renderError}
          </div>
        )}

        {!loading && !renderError && (
          <div
            style={{
              display: 'flex',
              flexDirection: 'row',
              alignItems: 'flex-start',
              justifyContent: 'center',
              padding: '8px',
              width: 'fit-content',
              minWidth: '100%',
              minHeight: '100%',
              boxSizing: 'border-box',
            }}
          >
            <div
              ref={canvasWrapperRef}
              style={{ display: 'flex', gap: viewMode === 'spread' ? `${SPREAD_GAP_PX}px` : 0, flexShrink: 0, transformOrigin: 'top center' }}
            >
              <canvas
                ref={leftCanvasRef}
                style={{ display: 'block', flexShrink: 0 }}
              />
              <canvas
                ref={rightCanvasRef}
                style={{
                  display: viewMode === 'spread' ? 'block' : 'none',
                  flexShrink: 0,
                }}
              />
            </div>
          </div>
        )}
      </div>

      {/* Page navigation */}
      {!loading && totalPages > 0 && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: '12px',
            padding: '10px 16px',
            background: 'var(--surface)',
            borderTop: '1px solid var(--border)',
            flexShrink: 0,
          }}
        >
          <button
            onClick={() => changePage(-1)}
            disabled={currentPage <= 1}
            style={{
              padding: '8px 18px',
              background: 'transparent',
              border: `1px solid ${currentPage <= 1 ? 'var(--border)' : 'var(--border-mid)'}`,
              borderRadius: '3px',
              color: currentPage <= 1 ? 'var(--text-dim)' : 'var(--text-mid)',
              fontSize: '12px',
              fontFamily: "'DM Sans', sans-serif",
              letterSpacing: '0.04em',
              cursor: currentPage <= 1 ? 'default' : 'pointer',
              minHeight: '38px',
              transition: 'border-color var(--transition), color var(--transition)',
              opacity: currentPage <= 1 ? 0.4 : 1,
            }}
            onMouseEnter={(e) => {
              if (currentPage > 1) {
                e.currentTarget.style.borderColor = 'var(--gold-dim)'
                e.currentTarget.style.color = 'var(--text)'
              }
            }}
            onMouseLeave={(e) => {
              if (currentPage > 1) {
                e.currentTarget.style.borderColor = 'var(--border-mid)'
                e.currentTarget.style.color = 'var(--text-mid)'
              }
            }}
            aria-label="Previous page"
          >
            ← Prev
          </button>

          <span
            style={{
              color: 'var(--text-dim)',
              fontSize: '11px',
              minWidth: '80px',
              textAlign: 'center',
              fontVariantNumeric: 'tabular-nums',
              letterSpacing: '0.04em',
            }}
          >
            {displayLabel}
          </span>

          <button
            onClick={() => changePage(1)}
            disabled={currentPage >= totalPages}
            style={{
              padding: '8px 18px',
              background: 'transparent',
              border: `1px solid ${currentPage >= totalPages ? 'var(--border)' : 'var(--border-mid)'}`,
              borderRadius: '3px',
              color: currentPage >= totalPages ? 'var(--text-dim)' : 'var(--text-mid)',
              fontSize: '12px',
              fontFamily: "'DM Sans', sans-serif",
              letterSpacing: '0.04em',
              cursor: currentPage >= totalPages ? 'default' : 'pointer',
              minHeight: '38px',
              transition: 'border-color var(--transition), color var(--transition)',
              opacity: currentPage >= totalPages ? 0.4 : 1,
            }}
            onMouseEnter={(e) => {
              if (currentPage < totalPages) {
                e.currentTarget.style.borderColor = 'var(--gold-dim)'
                e.currentTarget.style.color = 'var(--text)'
              }
            }}
            onMouseLeave={(e) => {
              if (currentPage < totalPages) {
                e.currentTarget.style.borderColor = 'var(--border-mid)'
                e.currentTarget.style.color = 'var(--text-mid)'
              }
            }}
            aria-label="Next page"
          >
            Next →
          </button>
        </div>
      )}

      {/* Bookmarks panel */}
      {sidecar && (
        <BookmarksPanel
          isOpen={bookmarksOpen}
          sidecar={sidecar}
          currentPage={currentPage}
          onClose={() => setBookmarksOpen(false)}
          onNavigate={(page) => {
            setCurrentPage(page)
            setBookmarksOpen(false)
          }}
          onSidecarChange={handleSidecarChange}
        />
      )}
    </div>
  )
}
