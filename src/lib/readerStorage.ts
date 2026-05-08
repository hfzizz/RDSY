export type ViewMode = 'single' | 'spread'
export type LocalPage = { page: number; updatedAt: string }

export const MIN_ZOOM = 0.5
export const MAX_ZOOM = 4
export const ZOOM_STEP = 0.25
export const DEBOUNCE_MS = 2000
export const SPREAD_GAP_PX = 8

const VIEW_MODE_KEY = 'rdsy:viewMode'
const ZOOM_KEY_PREFIX = 'rdsy:zoom:'
const SCROLL_KEY_PREFIX = 'rdsy:scroll:'
const PAGE_KEY_PREFIX = 'rdsy:page:'

export function readViewMode(): ViewMode {
  const v = typeof localStorage !== 'undefined' ? localStorage.getItem(VIEW_MODE_KEY) : null
  return v === 'spread' ? 'spread' : 'single'
}

export function saveViewMode(mode: ViewMode): void {
  try { localStorage.setItem(VIEW_MODE_KEY, mode) } catch { /* ignore */ }
}

export function readZoom(bookId: string | undefined): number {
  if (!bookId || typeof localStorage === 'undefined') return 1
  const n = parseFloat(localStorage.getItem(ZOOM_KEY_PREFIX + bookId) ?? '')
  if (!isFinite(n) || n <= 0) return 1
  return Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, n))
}

export function saveZoom(bookId: string | undefined, zoom: number): void {
  if (!bookId) return
  try { localStorage.setItem(ZOOM_KEY_PREFIX + bookId, String(zoom)) } catch { /* ignore */ }
}

export function readScroll(bookId: string | undefined): { x: number; y: number } | null {
  if (!bookId || typeof localStorage === 'undefined') return null
  try {
    const parsed = JSON.parse(localStorage.getItem(SCROLL_KEY_PREFIX + bookId) ?? '')
    if (typeof parsed.x === 'number' && typeof parsed.y === 'number') return parsed
  } catch { /* ignore */ }
  return null
}

export function saveScroll(bookId: string | undefined, x: number, y: number): void {
  if (!bookId) return
  try { localStorage.setItem(SCROLL_KEY_PREFIX + bookId, JSON.stringify({ x, y })) } catch { /* ignore */ }
}

export function readPageLocal(bookId: string | undefined): LocalPage | null {
  if (!bookId || typeof localStorage === 'undefined') return null
  try {
    const parsed = JSON.parse(localStorage.getItem(PAGE_KEY_PREFIX + bookId) ?? '')
    if (typeof parsed.page === 'number' && typeof parsed.updatedAt === 'string') return parsed
  } catch { /* ignore */ }
  return null
}

export function savePageLocal(bookId: string | undefined, page: number): void {
  if (!bookId || typeof localStorage === 'undefined') return
  try {
    localStorage.setItem(PAGE_KEY_PREFIX + bookId, JSON.stringify({ page, updatedAt: new Date().toISOString() }))
  } catch { /* ignore */ }
}
