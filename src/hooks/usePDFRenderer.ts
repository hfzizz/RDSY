import { useRef, useCallback, useEffect } from 'react'
import type { PDFDocumentProxy, RenderTask } from 'pdfjs-dist'
import type { ViewMode } from '../lib/readerStorage'
import { SPREAD_GAP_PX } from '../lib/readerStorage'

export function usePDFRenderer(
  pdfDocRef: React.MutableRefObject<PDFDocumentProxy | null>,
  currentPage: number,
  leftPage: number,
  rightPage: number | null,
  zoom: number,
  viewMode: ViewMode,
  loading: boolean,
  leftCanvasRef: React.MutableRefObject<HTMLCanvasElement | null>,
  rightCanvasRef: React.MutableRefObject<HTMLCanvasElement | null>,
  containerRef: React.MutableRefObject<HTMLDivElement | null>,
  canvasWrapperRef: React.MutableRefObject<HTMLDivElement | null>,
) {
  const leftRenderTaskRef = useRef<RenderTask | null>(null)
  const rightRenderTaskRef = useRef<RenderTask | null>(null)

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
      taskRef: React.MutableRefObject<RenderTask | null>,
    ) => {
      if (!canvas) return
      if (pageNum === null || pageNum < 1 || pageNum > pdf.numPages) {
        canvas.width = 0
        canvas.height = 0
        canvas.style.display = 'none'
        return
      }
      canvas.style.display = 'block'

      if (taskRef.current) {
        taskRef.current.cancel()
        taskRef.current = null
      }

      const page = await pdf.getPage(pageNum)
      const baseViewport = page.getViewport({ scale: 1 })
      const fitScale = baseWidth / baseViewport.width
      const v = page.getViewport({ scale: fitScale * zoom * dpr })

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

      // Atomically swap: resize and copy in one paint frame, no blank gap
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

    // Canvas is now at true zoom — remove the CSS preview scale
    if (canvasWrapperRef.current) canvasWrapperRef.current.style.transform = 'none'
  }, [currentPage, viewMode, zoom, leftPage, rightPage]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const onResize = () => { if (!loading && pdfDocRef.current) renderView() }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [renderView, loading]) // eslint-disable-line react-hooks/exhaustive-deps

  return { renderView }
}
