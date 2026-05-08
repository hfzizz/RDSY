# RDSY — Architecture

> Last updated after all 5 refactor phases. Reflects the current codebase.
> Open issues are sourced from REVIEW.md and tracked with their current status.

---

## Current Component Map

```
src/
├── main.tsx                     (10 lines  — React root, mounts <App />)
├── App.tsx                      (90 lines  — auth shell, routing, silent sign-in)
├── index.css                    (91 lines  — design tokens, CSS variables, animations)
│
├── store/
│   └── index.ts                 (36 lines  — Zustand store, pure state + setters only)
│
├── types/
│   ├── auth.ts                  — AuthState
│   ├── book.ts                  — BookEntry, BookProgress, DriveFile, constants
│   ├── sidecar.ts               — Sidecar, Bookmark, Highlight, helpers
│   └── sync.ts                  — SyncStatus
├── types.ts                     — re-export barrel (existing imports don't break)
│
├── components/
│   ├── Library.tsx              (465 lines — book grid, upload, offline pin, 5-min sync)
│   ├── Reader.tsx               (324 lines — thin coordinator composing 4 hooks)
│   └── Bookmarks.tsx            (293 lines — bookmark panel, add/delete, jump-to-page)
│
├── hooks/
│   ├── useBookLoader.ts         (110 lines — PDF + sidecar load, OPFS cache, StrictMode guard)
│   ├── usePDFRenderer.ts        (107 lines — offscreen canvas, atomic swap, resize)
│   ├── useReadingProgress.ts    (118 lines — page/zoom state, debounce, unmount session save)
│   └── useCrossDeviceSync.ts    ( 34 lines — 60s poll + visibilitychange)
│
└── lib/
    ├── auth.ts                  ( 96 lines — GIS token client singleton, loadStoredAuth, saveAuth)
    ├── drive.ts                 (228 lines — Google Drive API v3 wrapper)
    ├── sidecar.ts               (140 lines — loadSidecar, mergeSidecars, saveSidecar)
    ├── db.ts                    ( 64 lines — Dexie: sidecars, meta, writeQueue)
    ├── opfs.ts                  ( 41 lines — OPFS: cachePDF, getCachedPDF, hasCachedPDF, removeCachedPDF)
    ├── readerStorage.ts         ( 64 lines — localStorage helpers, reader constants)
    ├── SyncManager.ts           ( 66 lines — singleton coordinator for all Drive writes)
    └── sync.ts                  ( 81 lines — syncLibrary, pushPendingWrites)
```

Total: ~2,100 LOC TypeScript, ~90 LOC CSS.

---

## Current Stack

| Layer | Choice | Notes |
|---|---|---|
| UI | React 19 + TypeScript | Strict mode on in dev |
| Build | Vite 8 + vite-plugin-pwa | `autoUpdate` SW, precaches JS/CSS/HTML |
| Routing | React Router v7 | `/` library, `/reader/:bookId` reader |
| State | Zustand 5 | Pure state only — no async actions |
| PDF | pdfjs-dist 5 | Renders in Web Worker, offscreen canvas swap |
| Structured DB | Dexie 4 (IndexedDB) | Sidecars, meta, write queue |
| Binary cache | OPFS | PDF blobs, separate quota from IDB |
| Cloud sync | Google Drive API v3 | Scope: `drive.file` only |
| Auth | Google Identity Services (GIS) | Token client, no implicit flow |
| Offline | Workbox (via vite-plugin-pwa) | Service worker, precache |

---

## Current Data Flow

```
App bootstrap
  └─ loadStoredAuth()         reads localStorage[rdsy_auth]
  └─ if unauthenticated →
       trySilentSignIn()      GIS prompt:'' — no popup if prior consent
         ├─ success → setAuth(token) → saveAuth() → localStorage
         └─ failure → show SignInScreen

Library mount
  └─ loadBookList() IDB       show cached books immediately (TODO: not yet implemented)
  └─ syncManager.syncLibrary()
       └─ ensureLibraryFolder() → listPDFs() + listSidecars() + getPinnedIds()  [parallel]
       └─ per book: loadSidecar() → mergeSidecars(IDB, Drive)                   [parallel, N requests]
       └─ hasCachedPDF() OPFS  (one stat per book)
       └─ setBooks()
  └─ syncManager.flushQueue() — push any pending offline writes
  └─ 5-min interval repeats syncLibrary

Reader mount (useBookLoader)
  └─ getCachedPDF() OPFS      fast path — no Drive call
       └─ miss: downloadBlob() Drive → cachePDF() OPFS [fire-and-forget]
  └─ loadSidecar() Drive + IDB merge                   [parallel with PDF load via Promise.all]
  └─ localStorage tiebreaker  readPageLocal() — guards against IDB async write race
  └─ hasLoadedRef.current = true
  └─ setLoading(false) → render begins

Page turn (useReadingProgress)
  └─ setCurrentPage()
  └─ savePageLocal() localStorage  [synchronous — survives unmount race]
  └─ debounce 2s → saveProgress()
       └─ syncManager.commitSidecar()
            ├─ cacheSidecar() IDB        always first
            ├─ if offline: enqueueWrite() IDB
            └─ if online:  upsertJSON() Drive → clearQueueEntry()
       └─ updateSidecar() Zustand store

Reader unmount (useReadingProgress cleanup)
  └─ if (!hasLoadedRef.current) return   StrictMode guard
  └─ record session in sidecar
  └─ savePageLocal() localStorage
  └─ commitSidecar() → IDB + Drive

Cross-device sync (useCrossDeviceSync)
  └─ every 60s + visibilitychange
  └─ loadSidecar() Drive
  └─ if remote.updatedAt > local.updatedAt → setSidecar() + setCurrentPage()
```

---

## What Was Done (Completed Phases)

All 5 planned refactor phases are merged to `main`.

| Phase | Commit | What changed |
|---|---|---|
| 1 — Storage | `c16516e` | OPFS replaces IDB for PDF blobs. `idb` replaced by Dexie with v2 schema migration. |
| 2 — Reader hooks | `d4aae5d` | `Reader.tsx` 954 → 324 lines. 4 hooks extracted: `useBookLoader`, `usePDFRenderer`, `useReadingProgress`, `useCrossDeviceSync`. |
| 3 — SyncManager | `440990d` | `commitSidecar` removed from Zustand store. `SyncManager` singleton owns all Drive writes with sync lock. |
| 4 — GIS auth | `3c4ddfb` | Implicit flow (token-in-URL-hash) replaced with GIS token client. ~65 lines of hash parsing and redirect hacks removed. |
| 5 — Structure | `09f5ece` | Store extracted to `src/store/index.ts`. Types split to `src/types/`. `App.tsx` is now a pure routing shell. |
| Fix — imports | `3544c59` | `Library.tsx` and `Reader.tsx` import `useStore` from `../store`, not `../App`. |

---

## Open Issues

Sourced from `REVIEW.md`. Grouped by severity and annotated with current status.

---

### CRITICAL

#### 1. OAuth token persisted in `localStorage`
**File:** `src/lib/auth.ts:29` — `SESSION_KEY = 'rdsy_auth'`

`localStorage` is readable by any JavaScript on the page — a supply chain compromise, a malicious PDF exploit, or a DOM injection bug leaks the live access token.

**Fix:** Switch to `sessionStorage`. GIS `trySilentSignIn(prompt:'')` restores the session silently on new tabs. One-time migration: `loadStoredAuth` reads `sessionStorage` first, falls back to `localStorage`, then migrates and removes the old key.

---

### HIGH

#### 2. No token refresh — silent failure after 1 hour
**File:** `src/lib/auth.ts` — missing

GIS tokens expire in ~3600s. No refresh is scheduled. When the token expires mid-session, Drive calls throw but nothing re-auths the user. Progress saves silently fail.

**Fix:** Add `scheduleRefresh(expiresAt, onRefreshed)` — sets a `setTimeout` to call `trySilentSignIn` 5 minutes before expiry. Call it from `App.tsx` whenever `setAuth` is called with an authenticated token. Also add a 401 check in `drive.ts:assertOk` to fire an `rdsy:auth-expired` event so the UI can react.

---

#### 3. Offline write queue creates duplicate Drive files
**File:** `src/lib/db.ts:4`, `src/lib/sync.ts:74`

`enqueueWrite` stores `{ driveId, sidecar }` — no `sidecarDriveId`. When `pushPendingWrites` flushes the queue it calls `upsertJSON` without an `existingId`, so Drive always takes the POST (create) path. Every offline flush creates a new `.rdsy.json` file instead of updating the existing one. Duplicate sidecar files accumulate in Drive; `syncLibrary` picks one arbitrarily, potentially restoring an old page position.

**Fix — three files:**

```typescript
// db.ts: add sidecarDriveId to the queue type
type WriteQueueEntry = { driveId: string; sidecarDriveId?: string; sidecar: Sidecar }
export async function enqueueWrite(driveId: string, sidecar: Sidecar, sidecarDriveId?: string)

// SyncManager.ts: pass it when enqueueing (both offline path and catch block)
await enqueueWrite(bookId, sidecar, sidecarDriveId)

// sync.ts: use it on flush
await upsertJSON(accessToken, folderId, fileName, sidecar, entry.sidecarDriveId)
```

---

#### 4. No Error Boundary around the Reader
**File:** `src/components/Reader.tsx` — missing

Any unhandled render exception propagates up and crashes the entire React tree, showing a blank screen with no recovery path.

**Fix:**
```typescript
// src/components/ErrorBoundary.tsx
class ErrorBoundary extends React.Component<{ children: ReactNode }> {
  state = { error: null as Error | null }
  static getDerivedStateFromError(e: Error) { return { error: e } }
  render() {
    if (this.state.error) return <ErrorFallback />
    return this.props.children
  }
}

// App.tsx
<Route path="/reader/:bookId" element={<ErrorBoundary><ReaderPage /></ErrorBoundary>} />
```

---

#### 5. Library book list not persisted offline
**Files:** `src/store/index.ts`, `src/lib/sync.ts`

`books` starts as `[]`. On a fresh load with no network, `syncLibrary` fails and the library stays empty — even if the user has pinned books available locally in OPFS.

**Fix:** Persist the book list to IDB after each successful sync. Load it from IDB before the Drive sync on startup.

```typescript
// db.ts
export async function saveBookList(books: BookEntry[]): Promise<void>
export async function loadBookList(): Promise<BookEntry[]>

// Library.tsx — load cached list immediately, sync refreshes it
useEffect(() => {
  loadBookList().then(cached => { if (cached.length > 0) setBooks(cached) })
  doSync()
}, [])

// doSync — persist after success
const result = await syncManager.syncLibrary(accessToken)
await saveBookList(result)
setBooks(result)
```

---

#### 6. Zero tests on critical business logic
No tests exist anywhere in the project. `mergeSidecars` has at least 8 distinct code paths (progress tiebreaker, bookmark tombstone-wins, both-deleted, session deduplication). A regression here silently corrupts user data.

**Fix:**
```bash
npm install -D vitest jsdom @testing-library/react
```

Start with pure function tests that need no React:
```typescript
// src/lib/sidecar.test.ts
test('progress: later updatedAt wins')
test('bookmark: tombstone wins over live version')
test('bookmark: both deleted — tombstone preserved')
test('sessions: deduplicates by device+startedAt')
```

---

### MEDIUM

#### 7. Dead dependency `@react-oauth/google` still installed
**File:** `package.json:13`

Phase 4 replaced this package's functionality with the GIS script tag, but never ran `npm uninstall`. The package ships unused code and is a supply chain attack surface.

```bash
npm uninstall @react-oauth/google
```

---

#### 8. No Content Security Policy
**File:** `vite.config.ts` — missing

No CSP means the browser places no restrictions on what scripts can execute or what origins can be contacted. The GIS script from `accounts.google.com` should be explicitly allowlisted.

Add via hosting layer (Netlify `_headers`, Cloudflare, etc.):
```
Content-Security-Policy:
  default-src 'self';
  script-src 'self' https://accounts.google.com;
  connect-src 'self' https://www.googleapis.com https://www.google.com;
  style-src 'self' 'unsafe-inline' https://fonts.googleapis.com;
  font-src https://fonts.gstatic.com;
  worker-src blob:;
  frame-ancestors 'none'
```

---

#### 9. Two sources of truth for `folderId`
**Files:** `src/lib/SyncManager.ts:10`, `src/store/index.ts`

`SyncManager._folderId` and the Zustand `folderId` field are kept in sync manually in `Library.tsx`. If they ever diverge, Drive writes go to the wrong folder.

**Fix:** Remove `folderId` from the Zustand store. Make `SyncManager.getFolderId(accessToken)` the single owner. Components that need it call the manager.

---

#### 10. `syncLibrary` fires N concurrent Drive requests
**File:** `src/lib/sync.ts:33`

Every sync downloads every sidecar in parallel regardless of whether it changed. For 100 books that is 100 concurrent `fetch` calls. Drive's undocumented rate limit is ~10 req/s per user token — large libraries will hit 429 errors.

The `modifiedTime` field is already returned by `listSidecars` but never used.

**Fix — two changes:**
1. Skip sidecars where `Drive modifiedTime <= IDB sidecar.progress.updatedAt`
2. Process in batches of 5-10 with a small yield between batches

---

#### 11. No service worker update notification
**File:** `vite.config.ts:9` — `registerType: 'autoUpdate'`

New app versions activate silently. Users may run stale JS for an entire session. For an app where logic bugs can corrupt data (the StrictMode guard, sidecar merge rules), this is a real risk.

**Fix:** Switch to `registerType: 'prompt'` and show a refresh banner using the `useRegisterSW` hook from `vite-plugin-pwa`.

---

#### 12. No virtual scrolling in the Library
**File:** `src/components/Library.tsx:389`

All book cards are rendered as DOM nodes. At 200+ books this causes a slow initial paint and high memory use.

**Fix:** Add `@tanstack/react-virtual` to render only the visible rows.

---

#### 13. No TypeScript path aliases
Deep import chains like `../../lib/SyncManager` will appear as the project grows. Add `@/` alias:

```json
// tsconfig.app.json
"paths": { "@/*": ["./src/*"] }
```
```typescript
// vite.config.ts
resolve: { alias: { '@': path.resolve(__dirname, './src') } }
```

---

### LOW

#### 14. No `.gitignore` or `.env.example`
No `.gitignore` was found in the repo root. `.env` (containing the OAuth Client ID) could be accidentally committed. Add both files.

#### 15. PDF.js worker configured inside a hook
**File:** `src/hooks/useBookLoader.ts:10`

`pdfjsLib.GlobalWorkerOptions.workerSrc = ...` is a module-level side effect sitting inside a hook file. Move it to `src/main.tsx` alongside other global setup.

#### 16. Inline styles throughout
All components use inline style objects. Hover states are managed via `onMouseEnter/Leave` → `e.currentTarget.style` mutation — a fragile pattern. CSS Modules would fix this with zero new dependencies.

#### 17. OPFS stat called per book during sync
**File:** `src/lib/sync.ts:40`

`hasCachedPDF()` is called for every book on every sync. Since the pinned list is already in IDB, non-pinned books can be assumed uncached — only check OPFS for `pinnedOffline === true` books.

#### 18. No `engines` field in `package.json`
OPFS requires a modern browser and Node 18+ for tooling. Add `"engines": { "node": ">=18" }`.

---

## Open Issues Priority Order

| Priority | # | Finding | Effort |
|---|---|---|---|
| Fix now | 3 | Offline queue creates duplicate Drive files | Small — 3 files, 1 type change |
| Fix now | 7 | Remove dead `@react-oauth/google` package | 2 minutes |
| Fix now | 1 | Token in `localStorage` → `sessionStorage` | Small — auth.ts only |
| Soon | 2 | Token refresh / 401 re-auth | Small — auth.ts + App.tsx |
| Soon | 4 | Error Boundary around Reader | Small — new component + App.tsx |
| Soon | 5 | Persist book list to IDB for offline | Small — db.ts + Library.tsx |
| Soon | 6 | Write tests for `mergeSidecars` | Medium — setup + coverage |
| Normal | 8 | Content Security Policy | Small — hosting config |
| Normal | 9 | Remove `folderId` from store | Small — SyncManager + store |
| Normal | 10 | Batch sidecar fetches + skip unchanged | Medium — sync.ts |
| Normal | 11 | Service worker update banner | Small — vite.config + App.tsx |
| Normal | 12 | Virtual scrolling in Library | Small — tanstack/react-virtual |
| Normal | 13 | TypeScript path aliases | Small — tsconfig + vite.config |
| Backlog | 14–18 | .gitignore, worker config, inline styles, OPFS stat, engines | Trivial each |
