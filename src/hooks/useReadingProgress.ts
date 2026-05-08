import { useState, useRef, useEffect, useCallback } from 'react'
import type { Sidecar } from '../types'
import { getDeviceId } from '../types'
import {
  readZoom, saveZoom, savePageLocal,
  DEBOUNCE_MS, MIN_ZOOM, MAX_ZOOM,
} from '../lib/readerStorage'
import type { ViewMode } from '../lib/readerStorage'

export function useReadingProgress(
  bookId: string | undefined,
  sidecar: Sidecar | null,
  setSidecar: (s: Sidecar) => void,
  startPage: number,
  totalPages: number,
  hasLoadedRef: React.MutableRefObject<boolean>,
  viewMode: ViewMode,
  commitSidecar: (bookId: string, sidecar: Sidecar) => Promise<void>,
) {
  const [currentPage, setCurrentPage] = useState(1)
  const [zoom, setZoom] = useState(() => readZoom(bookId))

  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const sidecarAtUnmount = useRef<Sidecar | null>(null)
  const currentPageAtUnmount = useRef<number>(1)
  const sessionStartRef = useRef(new Date().toISOString())
  const startPageRef = useRef(1)

  // Initialize currentPage once the sidecar + localStorage tiebreaker is resolved
  useEffect(() => {
    if (startPage > 0) {
      setCurrentPage(startPage)
      startPageRef.current = startPage
    }
  }, [startPage])

  // Persist zoom
  useEffect(() => { saveZoom(bookId, zoom) }, [zoom, bookId])

  // Persist page (only after book has loaded)
  useEffect(() => {
    if (startPage === 0) return
    savePageLocal(bookId, currentPage)
  }, [bookId, currentPage, startPage])

  // Keep mutable refs in sync for the unmount closure
  useEffect(() => {
    sidecarAtUnmount.current = sidecar
    currentPageAtUnmount.current = currentPage
  })

  // Unmount: record session + final page save
  // StrictMode fires a fake unmount before load completes — hasLoadedRef guards against it (see CLAUDE.md)
  useEffect(() => {
    return () => {
      if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current)
      if (!hasLoadedRef.current) return
      const sc = sidecarAtUnmount.current
      if (!sc || !bookId) return

      const now = new Date().toISOString()
      const updated: Sidecar = {
        ...sc,
        progress: {
          ...sc.progress,
          page: currentPageAtUnmount.current,
          updatedAt: now,
          updatedBy: getDeviceId(),
        },
        stats: {
          sessions: [
            ...sc.stats.sessions,
            {
              device: getDeviceId(),
              startedAt: sessionStartRef.current,
              endedAt: now,
              pagesRead: Math.abs(currentPageAtUnmount.current - startPageRef.current),
            },
          ],
        },
      }
      savePageLocal(bookId, currentPageAtUnmount.current)
      commitSidecar(bookId, updated).catch(() => {})
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const saveProgress = useCallback(
    (page: number, sc: Sidecar) => {
      if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current)
      debounceTimerRef.current = setTimeout(async () => {
        const updated: Sidecar = {
          ...sc,
          progress: { ...sc.progress, page, updatedAt: new Date().toISOString(), updatedBy: getDeviceId() },
        }
        setSidecar(updated)
        await commitSidecar(bookId!, updated)
      }, DEBOUNCE_MS)
    },
    [commitSidecar, bookId, setSidecar]
  )

  function changePage(delta: number) {
    if (totalPages === 0) return
    const step = viewMode === 'spread' ? Math.sign(delta) * 2 : delta
    const next = Math.max(1, Math.min(currentPage + step, totalPages))
    if (next === currentPage) return
    setCurrentPage(next)
    if (sidecar) saveProgress(next, sidecar)
  }

  function adjustZoom(delta: number) {
    setZoom(z => Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, Math.round((z + delta) * 100) / 100)))
  }

  function resetZoom() { setZoom(1) }

  return { currentPage, setCurrentPage, zoom, setZoom, changePage, adjustZoom, resetZoom, saveProgress }
}
