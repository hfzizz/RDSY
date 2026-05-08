import { useState, useRef, useEffect } from 'react'
import * as pdfjsLib from 'pdfjs-dist'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import type { Sidecar } from '../types'
import { getCachedPDF, cachePDF } from '../lib/opfs'
import { downloadBlob } from '../lib/drive'
import { loadSidecar } from '../lib/sidecar'
import { readPageLocal, readScroll } from '../lib/readerStorage'

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.mjs',
  import.meta.url
).href

export interface BookLoaderResult {
  pdfDocRef: React.MutableRefObject<PDFDocumentProxy | null>
  sidecar: Sidecar | null
  setSidecar: React.Dispatch<React.SetStateAction<Sidecar | null>>
  totalPages: number
  loading: boolean
  renderError: string | null
  startPage: number
  hasLoadedRef: React.MutableRefObject<boolean>
  pendingScrollRef: React.MutableRefObject<{ x: number; y: number } | null>
}

export function useBookLoader(
  bookId: string | undefined,
  accessToken: string,
  sidecarDriveId: string | undefined,
): BookLoaderResult {
  const [loading, setLoading] = useState(true)
  const [renderError, setRenderError] = useState<string | null>(null)
  const [totalPages, setTotalPages] = useState(0)
  const [sidecar, setSidecar] = useState<Sidecar | null>(null)
  const [startPage, setStartPage] = useState(0) // 0 = not loaded yet

  const pdfDocRef = useRef<PDFDocumentProxy | null>(null)
  const objectUrlRef = useRef<string | null>(null)
  const hasLoadedRef = useRef(false)
  const pendingScrollRef = useRef<{ x: number; y: number } | null>(null)

  useEffect(() => {
    if (!bookId || !accessToken) return
    let cancelled = false

    async function loadPDF() {
      setLoading(true)
      setRenderError(null)
      hasLoadedRef.current = false

      try {
        let blob = await getCachedPDF(bookId!)
        if (!blob) {
          blob = await downloadBlob(accessToken, bookId!)
          cachePDF(bookId!, blob).catch(() => {})
        }
        if (cancelled) return

        if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current)
        const blobUrl = URL.createObjectURL(blob)
        objectUrlRef.current = blobUrl

        let [pdf, freshSidecar] = await Promise.all([
          pdfjsLib.getDocument({ url: blobUrl }).promise,
          loadSidecar(accessToken, bookId!, sidecarDriveId),
        ])
        if (cancelled) { pdf.destroy(); return }

        // localStorage snapshot is the tiebreaker for the same-device IDB write race
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
        setStartPage(clamped)
        pendingScrollRef.current = readScroll(bookId)

        // StrictMode guard: only set true after full successful load (see CLAUDE.md)
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
      if (objectUrlRef.current) {
        URL.revokeObjectURL(objectUrlRef.current)
        objectUrlRef.current = null
      }
    }
  }, [bookId, accessToken]) // eslint-disable-line react-hooks/exhaustive-deps

  return { pdfDocRef, sidecar, setSidecar, totalPages, loading, renderError, startPage, hasLoadedRef, pendingScrollRef }
}
