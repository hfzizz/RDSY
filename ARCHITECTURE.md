# RDSY — Architecture Review

## Component Map

```
src/
├── main.tsx                    (10 lines — React root)
├── App.tsx                     (375 lines — Router, Zustand store, auth, sync status UI)
├── types.ts                    (105 lines — All type definitions, flat)
├── index.css                   (91 lines — Design tokens, animations)
├── components/
│   ├── Library.tsx             (462 lines — Book grid, upload, offline pin, 5-min sync)
│   ├── Reader.tsx              (954 lines — PDF render, page nav, zoom, sync poll)
│   └── Bookmarks.tsx           (293 lines — Bookmark panel, add/delete, jump to page)
└── lib/
    ├── db.ts                   (124 lines — IndexedDB: pdfBlobs, sidecars, meta, writeQueue)
    ├── drive.ts                (228 lines — Google Drive API wrapper)
    ├── sidecar.ts              (140 lines — Load/merge/save sidecar: Drive + IDB + default)
    └── sync.ts                  (80 lines — Full library sync, push pending writes)
```

Total: ~2,300 LOC TypeScript, ~280 LOC CSS.

---

## Current Stack

| Layer | Choice |
|-------|--------|
| UI | React 19 + TypeScript |
| Build | Vite 8 + vite-plugin-pwa |
| Routing | React Router 7 |
| State | Zustand 5 |
| PDF | PDF.js (pdfjs-dist 5) |
| Storage | IndexedDB via `idb` + localStorage snapshots |
| Cloud sync | Google Drive API v3 (scope: `drive.file`) |
| Auth | OAuth 2.0 implicit flow (`@react-oauth/google`) |
| Offline | Workbox service worker |

---

## Data Flow

```
Bootstrap
  └─ extractHashToken() → localStorage[rdsy_auth]
  └─ If expired → silent refresh (prompt=none redirect)

Library mount
  └─ list Drive files → loadSidecar() per book → setBooks()
  └─ 5-min interval repeats

Reader mount
  └─ getCachedPDF() from IDB (fast path)
  │   └─ Miss: downloadBlob() from Drive → cachePDF() IDB
  └─ loadSidecar() in parallel (Drive + IDB merge)
  └─ renderView(page)

Page turn
  └─ setCurrentPage() → renderView()
  └─ debounce 2s → saveProgress() → commitSidecar()
      └─ cacheSidecar() IDB
      └─ set Zustand state
      └─ enqueueWrite() IDB
      └─ upsertJSON() Drive (if online)

Cross-device sync (Reader)
  └─ poll every 60s + visibilitychange
  └─ if remote.updatedAt > local → jump to remote page
```

---

## Issues & Recommendations

### 1. `Reader.tsx` is a God Component (Priority: High)

954 lines with 10+ concerns in one place: PDF.js lifecycle, canvas render loop, zoom, page nav, spread view, sidecar load/save, cross-device sync polling, bookmark panel, top-bar auto-hide, StrictMode guards.

The bugs documented in `CLAUDE.md` (page-1 regression, StrictMode fake-unmount) exist because these concerns are entangled. When the unmount cleanup fires, it touches state from the render loop, the save cycle, and the load lifecycle simultaneously.

**Fix:** Extract into custom hooks:

```
useBookLoader(bookId, accessToken)   → loads PDF + sidecar, returns {pdf, sidecar, loading}
usePDFRenderer(pdf, canvasRef)       → render loop, zoom, spread, canvas swap
useReadingProgress(sidecar, bookId)  → page state, debounced save, commitSidecar call
useCrossDeviceSync(bookId, sidecar)  → 60s poll, visibilitychange handler
```

Reader.tsx becomes a thin coordinator composing these hooks. Each hook has a single clear contract and can be unit-tested.

---

### 2. Side Effects Inside the Zustand Store (Priority: High)

`commitSidecar` in the store does 4 async operations: IDB write, state mutation, queue enqueue, Drive upload. Stores should be dumb — hold state, expose setters. Side effects and orchestration belong outside.

```typescript
// Current (in store):
commitSidecar: async (bookId, sidecar) => {
  await cacheSidecar(bookId, sidecar)       // IDB
  set(state => { ... })                      // state
  await enqueueWrite(bookId, sidecar)        // queue
  await upsertJSON(accessToken, ...)         // Drive
}
```

**Fix:** Move orchestration into a `useSidecarSync` hook or a plain `SyncService` class. The store receives the final result (`setSidecar(updated)`) and nothing else.

---

### 3. No Centralized Sync Coordinator (Priority: High)

Sync is scattered across three files and two components:
- `Library.tsx` — 5-min interval (library-wide)
- `Reader.tsx` — 60s poll (sidecar only) + visibilitychange
- `sync.ts` — `pushPendingWrites`
- `App.tsx` / store — `commitSidecar` Drive push

If the user navigates Library → Reader, two sync cycles run concurrently with no coordination.

**Fix:** A single `SyncManager` (plain class, not React state) owns all Drive operations. It holds a queue + lock. Components call `syncManager.commitSidecar(...)` and `syncManager.syncLibrary(...)`. Sync status flows back via a Zustand subscription.

---

### 4. OAuth Implicit Flow is Deprecated (Priority: Medium)

The implicit flow puts the access token in the URL hash — logged in browser history, leakable via Referrer. Google deprecated this in 2019. The silent-refresh trick (`prompt=none` redirect) is a workaround for the lack of a refresh token.

**Fix:** Migrate to Google Identity Services `requestAccessToken()` (PKCE-backed token model). No token in the URL, proper refresh support. Removes ~60 lines of hash-parsing and silent-refresh logic from `App.tsx`.

---

### 5. `App.tsx` Has Three Separate Jobs (Priority: Medium)

375 lines, three responsibilities: Zustand store definition, OAuth flow, top-level routing + sync status UI.

**Fix:**
```
src/
  store/index.ts     — Zustand store definition only
  lib/auth.ts        — OAuth token parsing, refresh logic
  App.tsx            — Router + providers only (~80 lines)
```

---

### 6. Storage: IndexedDB for PDF Blobs (Priority: Medium)

IndexedDB stores PDF blobs as opaque binary objects. This works, but the OPFS (Origin Private File System) API is strictly better for large binary files: synchronous access in workers, faster reads/writes, and quota is accounted separately from IDB in most browsers.

See dedicated section below.

---

### 7. Polling vs. Drive Changes API (Priority: Low)

The 60s and 5-min polls are simple but inefficient. The [Drive Changes API](https://developers.google.com/drive/api/guides/manage-changes) supports a `pageToken` + long-poll model that pushes change notifications instead of polling. Reduces unnecessary network traffic, especially on mobile.

For same-device multi-tab sync, a `BroadcastChannel` is free and instant.

---

### 8. `makeSidecar` Epoch Timestamp is a Smell (Priority: Low)

The default `updatedAt: new Date(0).toISOString()` exists only to ensure the fallback sidecar always loses the tiebreaker against a localStorage snapshot. This is implicit coupling — the merge logic in `sidecar.ts` depends on a magic value in `makeSidecar`.

**Fix:** Add an explicit `source: 'drive' | 'idb' | 'default'` field to `Sidecar`. The merge function uses source priority directly, not timestamp tricks.

---

### 9. Flat `types.ts` (Priority: Low)

All types in one file is fine now, will become painful.

**Fix:** `src/types/auth.ts`, `book.ts`, `sidecar.ts`, `sync.ts`.

---

## Priority Summary

| # | Change | Effort | Impact |
|---|--------|--------|--------|
| 1 | Decompose `Reader.tsx` into hooks | Medium | High — removes bug surface |
| 2 | Move `commitSidecar` out of the store | Low | High — clean state/effect separation |
| 3 | Centralize sync in `SyncManager` | Medium | High — prevents concurrent sync races |
| 4 | Migrate auth to GIS token model | Medium | Medium — security + cleaner code |
| 5 | Split `App.tsx` | Low | Medium — clarity |
| 6 | OPFS for PDF blobs | Medium | Medium — performance + quota |
| 7 | Drive Changes API | High | Low — nice-to-have |
| 8 | Explicit `source` field in Sidecar | Low | Low — removes implicit coupling |
| 9 | Split `types.ts` | Low | Low — organization |

---

## Implementation Plan

Phases are ordered so each one leaves the app in a working, shippable state. Do not skip phases or merge them — each phase is a standalone PR.

---

### Phase 1 — Storage Layer (OPFS + Dexie)

**Goal:** Replace IndexedDB blob storage with OPFS for PDFs, and replace the `idb` library with Dexie for structured data. The rest of the app is unchanged.

**Install:**
```
npm install dexie
npm uninstall idb
```

**1a. New file: `src/lib/opfs.ts`**

Replaces `cachePDF`, `getCachedPDF`, `removeCachedPDF`, `hasCachedPDF` from `db.ts`.

```typescript
const PDFS_DIR = 'pdfs'

async function getPdfsDir(): Promise<FileSystemDirectoryHandle> {
  const root = await navigator.storage.getDirectory()
  return root.getDirectoryHandle(PDFS_DIR, { create: true })
}

export async function cachePDF(driveId: string, blob: Blob): Promise<void> {
  const dir = await getPdfsDir()
  const file = await dir.getFileHandle(`${driveId}.pdf`, { create: true })
  const writable = await file.createWritable()
  await writable.write(blob)
  await writable.close()
}

export async function getCachedPDF(driveId: string): Promise<Blob | undefined> {
  try {
    const dir = await getPdfsDir()
    const file = await dir.getFileHandle(`${driveId}.pdf`)
    return await file.getFile()
  } catch {
    return undefined
  }
}

export async function hasCachedPDF(driveId: string): Promise<boolean> {
  try {
    const dir = await getPdfsDir()
    await dir.getFileHandle(`${driveId}.pdf`)
    return true
  } catch {
    return false
  }
}

export async function removeCachedPDF(driveId: string): Promise<void> {
  try {
    const dir = await getPdfsDir()
    await dir.removeEntry(`${driveId}.pdf`)
  } catch { /* already gone */ }
}
```

**1b. Rewrite `src/lib/db.ts` with Dexie**

Remove the `pdfBlobs` store entirely. Keep `sidecars` and `meta`. Add a version 2 migration so existing IDB data from `idb` is preserved (Dexie uses the same underlying IDB database and store names — existing records are still there).

```typescript
import Dexie, { type Table } from 'dexie'
import type { Sidecar } from '../types'

type WriteQueueEntry = { driveId: string; sidecar: Sidecar }

class RdsyDatabase extends Dexie {
  sidecars!: Table<Sidecar, string>        // keyed by bookId
  meta!: Table<any, string>

  constructor() {
    super('rdsy-db')
    // Version 1 schema mirrors the old idb schema (no changes — existing data intact)
    this.version(1).stores({
      pdfBlobs: '',      // keep declared so Dexie doesn't drop it during migration
      sidecars: '',
      meta: '',
    })
    // Version 2: drop pdfBlobs (moved to OPFS), add updatedAt index on sidecars
    this.version(2).stores({
      pdfBlobs: null,    // null = delete the store
      sidecars: ',updatedAt',
      meta: '',
    })
  }
}

export const db = new RdsyDatabase()

export async function getCachedSidecar(bookId: string): Promise<Sidecar | undefined> {
  return db.sidecars.get(bookId)
}

export async function cacheSidecar(bookId: string, sidecar: Sidecar): Promise<void> {
  await db.sidecars.put(sidecar, bookId)
}

export async function getPinnedIds(): Promise<Set<string>> {
  const pinned = await db.meta.get('pinned')
  if (!pinned) return new Set()
  return new Set(pinned as string[])
}

export async function setPinned(driveId: string, isPinned: boolean): Promise<void> {
  const current = await getPinnedIds()
  isPinned ? current.add(driveId) : current.delete(driveId)
  await db.meta.put(Array.from(current), 'pinned')
}

export async function enqueueWrite(driveId: string, sidecar: Sidecar): Promise<void> {
  const queue: WriteQueueEntry[] = (await db.meta.get('writeQueue')) ?? []
  const idx = queue.findIndex(e => e.driveId === driveId)
  if (idx !== -1) queue[idx] = { driveId, sidecar }
  else queue.push({ driveId, sidecar })
  await db.meta.put(queue, 'writeQueue')
}

export async function dequeueWrites(): Promise<WriteQueueEntry[]> {
  return (await db.meta.get('writeQueue')) ?? []
}

export async function clearQueueEntry(driveId: string): Promise<void> {
  const queue: WriteQueueEntry[] = (await db.meta.get('writeQueue')) ?? []
  await db.meta.put(queue.filter(e => e.driveId !== driveId), 'writeQueue')
}
```

**1c. Update all callers**

- `Library.tsx`: change PDF imports from `'../lib/db'` → `'../lib/opfs'`
- `Reader.tsx`: same
- `sidecar.ts`: no change (already imports from `db`)
- `sync.ts`: change `hasCachedPDF` import → `'./opfs'`
- Delete `initDB()` export (no longer needed — Dexie opens lazily)

**Migration path for existing users:** PDFs already cached in the old IDB `pdfBlobs` store will be silently dropped when version 2 runs (the store is deleted). On next open, the app will re-download from Drive as normal. No data loss — PDFs are always in Drive; the local cache is expendable.

**What doesn't change:** `sidecar.ts`, `sync.ts`, `drive.ts`, all components. The public API of `db.ts` (`getCachedSidecar`, `cacheSidecar`, etc.) stays identical.

---

### Phase 2 — Decompose `Reader.tsx`

**Goal:** Break the 954-line God component into a thin coordinator + 4 focused hooks. Each hook owns exactly one concern and has a defined input/output contract.

**New files under `src/hooks/`:**

**`useBookLoader.ts`** — PDF and sidecar loading
```typescript
// Input:  bookId, accessToken, sidecarDriveId
// Output: { pdf, sidecar, setSidecar, blobUrl, loading, error }
// Owns:   IDB cache check, Drive download, PDF.js init,
//         loadSidecar() parallel call, hasLoadedRef, StrictMode guard
```

**`usePDFRenderer.ts`** — canvas rendering
```typescript
// Input:  pdf, currentPage, zoom, spread, canvasRef, overlayCanvasRef
// Output: { renderView, totalPages }
// Owns:   offscreen canvas, renderPage(), atomic swap, resize observer
```

**`useReadingProgress.ts`** — page state + save lifecycle
```typescript
// Input:  sidecar, bookId, accessToken, folderId
// Output: { currentPage, changePage, zoom, setZoom }
// Owns:   localStorage snapshots, 2s debounce, commitSidecar call,
//         unmount save (guarded by hasLoadedRef)
```

**`useCrossDeviceSync.ts`** — background sync
```typescript
// Input:  bookId, accessToken, sidecarDriveId, onRemoteUpdate(sidecar)
// Output: void
// Owns:   60s poll, visibilitychange listener, updatedAt comparison
```

**`Reader.tsx` after decomposition (~120 lines):**
```typescript
export default function Reader() {
  const { bookId } = useParams()
  const { auth, books } = useStore(...)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const book = books.find(b => b.driveId === bookId)

  const { pdf, sidecar, setSidecar, loading } = useBookLoader(bookId, accessToken, book?.sidecarDriveId)
  const { renderView, totalPages }            = usePDFRenderer(pdf, currentPage, zoom, spread, canvasRef)
  const { currentPage, changePage, zoom }     = useReadingProgress(sidecar, bookId, accessToken, folderId)

  useCrossDeviceSync(bookId, accessToken, book?.sidecarDriveId, setSidecar)

  if (loading) return <LoadingScreen />
  return <ReaderLayout ... />
}
```

**Key rules during extraction:**
- `hasLoadedRef` lives in `useBookLoader` and is passed to `useReadingProgress` for the unmount guard — do not duplicate it
- `currentPageAtUnmount` lives in `useReadingProgress` only
- The StrictMode guard pattern from `CLAUDE.md` must be preserved exactly — copy the comment into `useBookLoader.ts`

---

### Phase 3 — Centralized Sync (`SyncManager`)

**Goal:** Remove all Drive-touching logic from the Zustand store and components. One class owns all writes.

**New file: `src/lib/SyncManager.ts`**

```typescript
class SyncManager {
  private lock = false
  private accessToken = ''
  private folderId = ''

  configure(accessToken: string, folderId: string) {
    this.accessToken = accessToken
    this.folderId = folderId
  }

  async commitSidecar(bookId: string, sidecar: Sidecar): Promise<string> {
    await cacheSidecar(bookId, sidecar)          // IDB first (durable)
    await enqueueWrite(bookId, sidecar)          // queue (offline safety)
    if (!navigator.onLine || !this.accessToken) return 'queued'

    const driveId = await upsertJSON(this.accessToken, this.folderId, `${bookId}.rdsy.json`, sidecar)
    await clearQueueEntry(bookId)
    return driveId
  }

  async syncLibrary(): Promise<BookEntry[]> {
    if (this.lock) return []
    this.lock = true
    try {
      return await syncLibrary(this.accessToken)
    } finally {
      this.lock = false
    }
  }

  async flushQueue(): Promise<void> {
    if (!navigator.onLine || !this.accessToken) return
    await pushPendingWrites(this.accessToken, this.folderId)
  }
}

export const syncManager = new SyncManager()  // singleton
```

**Changes to Zustand store in `App.tsx`:**
- Remove `commitSidecar` action entirely
- Add `setSidecar(bookId, sidecar)` — dumb setter that updates `books[].sidecar` in state
- Store becomes pure state, zero side effects

**Changes to components:**
- `Reader.tsx` / `useReadingProgress.ts`: call `syncManager.commitSidecar(...)`, then call `store.setSidecar(bookId, result)`
- `Library.tsx`: call `syncManager.syncLibrary()` instead of importing `syncLibrary` directly
- `App.tsx`: on `window.onfocus` / online event: call `syncManager.flushQueue()`

---

### Phase 4 — Auth Cleanup (GIS Token Model)

**Goal:** Remove implicit flow token-in-hash, remove silent-refresh redirect hack.

**Install:**
```
npm uninstall @react-oauth/google
```
GIS is loaded via script tag — no npm package needed.

**New file: `src/lib/auth.ts`**

```typescript
// Wraps window.google.accounts.oauth2.initTokenClient
export function requestAccessToken(callback: (token: string, expiresIn: number) => void): void {
  const client = google.accounts.oauth2.initTokenClient({
    client_id: import.meta.env.VITE_GOOGLE_CLIENT_ID,
    scope: 'https://www.googleapis.com/auth/drive.file',
    callback: (response) => {
      callback(response.access_token, Number(response.expires_in))
    },
  })
  client.requestAccessToken()
}

export function loadAuthFromStorage(): AuthState {
  // same localStorage logic as today, minus hash parsing
}

export function saveAuthToStorage(auth: AuthState): void { ... }
export function clearAuth(): void { ... }
```

**Removes from `App.tsx`:**
- `extractHashToken()` — ~25 lines
- `loadAuthFromSession()` / silent refresh redirect — ~35 lines
- Hash cleanup `window.history.replaceState` call

**What stays the same:** `localStorage[rdsy_auth]` format, token expiry check, `AuthState` type.

**Note:** GIS `requestAccessToken` always shows the Google account picker. For a seamless re-auth (token refresh), pass `{ prompt: '' }` if the user has already granted consent — GIS will skip the picker if a valid session exists.

---

### Phase 5 — Structural Cleanup

**Goal:** Each file has one job.

**5a. Extract store to `src/store/index.ts`**

Move the `create(...)` call and `StoreState` interface out of `App.tsx`. `App.tsx` imports `useStore` from `'./store'`.

**5b. Split `App.tsx` into:**
```
App.tsx         — GoogleOAuthProvider wrapper, Routes, sync status dot (~80 lines)
```
Auth flow calls `auth.ts`, store mutations call `store/index.ts`.

**5c. Split `src/types.ts` into `src/types/` directory:**
```
src/types/
  index.ts      — re-exports everything (so existing imports don't break)
  auth.ts       — AuthState
  book.ts       — BookEntry, DriveFile, BookProgress
  sidecar.ts    — Sidecar, Bookmark, Highlight, HighlightRect, ReadingSession, BookStats
  sync.ts       — SyncStatus, WriteQueueEntry
```
All existing imports (`from '../types'`) continue to work via the re-export barrel.

**5d. Add `source` field to `Sidecar` (removes epoch timestamp smell):**
```typescript
// In src/types/sidecar.ts
export interface Sidecar {
  version: number
  bookId: string
  source: 'drive' | 'idb' | 'default'   // ← new
  progress: BookProgress
  bookmarks: Bookmark[]
  highlights: Highlight[]
  stats: BookStats
}
```
`makeSidecar()` sets `source: 'default'`. `loadSidecar()` sets `source: 'drive'` or `'idb'`. `mergeSidecars()` uses `source` priority instead of comparing `updatedAt` against epoch.

---

### Target File Structure After All Phases

```
src/
├── main.tsx
├── App.tsx                     (~80 lines — router + providers only)
├── store/
│   └── index.ts                (Zustand store — pure state, no side effects)
├── types/
│   ├── index.ts                (re-export barrel)
│   ├── auth.ts
│   ├── book.ts
│   ├── sidecar.ts
│   └── sync.ts
├── components/
│   ├── Library.tsx
│   ├── Reader.tsx              (~120 lines — thin coordinator)
│   └── Bookmarks.tsx
├── hooks/
│   ├── useBookLoader.ts        (PDF + sidecar load, StrictMode guard)
│   ├── usePDFRenderer.ts       (canvas render loop, zoom, spread)
│   ├── useReadingProgress.ts   (page state, debounce, save lifecycle)
│   └── useCrossDeviceSync.ts   (60s poll, visibilitychange)
└── lib/
    ├── auth.ts                 (GIS token client, localStorage helpers)
    ├── db.ts                   (Dexie: sidecars, meta, writeQueue)
    ├── opfs.ts                 (OPFS: cachePDF, getCachedPDF, etc.)
    ├── drive.ts                (Drive API wrapper — unchanged)
    ├── sidecar.ts              (load, merge, save — unchanged)
    ├── sync.ts                 (syncLibrary, pushPendingWrites — unchanged)
    └── SyncManager.ts          (singleton coordinator for all Drive writes)
```

---

### Do Not Do (Deferred Indefinitely)

- **Drive Changes API** — adds significant complexity (change token management, long-poll connection) for minimal real-world gain given the app's current user scale. Keep the 60s poll.
- **wa-sqlite / PGlite** — overkill until there's a concrete need for relational queries (e.g., reading stats dashboard, full-text search). Dexie on IDB is sufficient.
- **BroadcastChannel for same-tab sync** — low value add; most users read on one tab at a time.
