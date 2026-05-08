# RDSY — Developer Onboarding

Welcome to RDSY. This doc explains what the project is, how everything fits together, why each tool was chosen, and the non-obvious things that will trip you up if nobody tells you first.

---

## What is RDSY?

RDSY is a cross-device PDF reader that runs entirely in the browser. You sign in with Google, your PDFs live in Google Drive, and the app syncs your reading position, bookmarks, and highlights across all your devices automatically.

It is a **PWA (Progressive Web App)**, which means it can be installed on your phone or desktop and works offline. There is no server — everything is either in your browser's local storage or in your own Google Drive account.

---

## Running it locally

```bash
npm install
npm run dev        # starts dev server at http://localhost:5173
npm run build      # production build → dist/
npx tsc --noEmit  # type-check without building
```

You need a `.env` file at the project root:

```
VITE_GOOGLE_CLIENT_ID=your-google-oauth-client-id
```

You get that from the Google Cloud Console → APIs & Services → Credentials → OAuth 2.0 Client ID.

---

## Tech stack — what and why

### Vite
Build tool and dev server. It is fast because it uses native ES modules in development instead of bundling everything first. You will not feel it unless the build breaks — then check `vite.config.ts`.

### React 19 + TypeScript
UI library. You already know this. TypeScript is strict here — if `tsc --noEmit` fails, the production build will also fail.

### React Router v7
Handles `/` (library page) and `/reader/:bookId` (reader page). The `:bookId` parameter is the Google Drive file ID of the PDF.

### Zustand
Global state management. Simpler than Redux — just a plain object with setters. The store lives in `src/store/index.ts`. You call `useStore(selector)` from any component to read or update state. No providers, no boilerplate.

### pdfjs-dist
Mozilla's PDF renderer. It reads PDF bytes and draws them onto an HTML `<canvas>`. This is the heaviest dependency — 400+ KB gzipped. It runs its actual render work in a Web Worker (`pdf.worker.mjs`) so the UI thread never freezes.

### Dexie
A TypeScript-friendly wrapper around **IndexedDB** (the browser's built-in key-value database). Used to cache sidecar files (your reading progress, bookmarks, highlights) and a write queue for offline support. Raw IndexedDB has a painful callback-based API — Dexie gives you `await db.sidecars.get(id)` instead.

### OPFS (Origin Private File System)
A browser file system API used to cache PDF blobs locally. Think of it as a private folder on disk that only your app can see. Faster and higher-capacity than storing binary blobs in IndexedDB. When you open a book, the app checks OPFS first — if the PDF is there, it loads instantly without hitting Drive. Lives in `src/lib/opfs.ts`.

### Google Identity Services (GIS)
Google's modern OAuth library. It handles the "Sign in with Google" flow. The old way was redirecting the user to Google and getting a token back in the URL — that is gone. Now you load a `<script>` tag from Google, call `initTokenClient`, and Google shows a popup. The token comes back via a callback. Lives in `src/lib/auth.ts`.

---

## Directory structure

```
src/
├── App.tsx               # Root component: auth shell + routing
├── main.tsx              # React entry point (mounts <App />)
├── index.css             # Global CSS variables + base styles
│
├── store/
│   └── index.ts          # Zustand global store (auth, books, syncStatus)
│
├── types/                # TypeScript type definitions, split by concern
│   ├── auth.ts           # AuthState
│   ├── book.ts           # BookEntry, BookProgress, DriveFile, constants
│   ├── sidecar.ts        # Sidecar, Bookmark, Highlight + helper functions
│   └── sync.ts           # SyncStatus
├── types.ts              # Re-export barrel (just re-exports from types/)
│
├── components/
│   ├── Library.tsx       # Book list, upload, pin-to-offline
│   ├── Reader.tsx        # PDF reader shell, composes the 4 hooks below
│   └── Bookmarks.tsx     # Bookmarks sidebar panel
│
├── hooks/
│   ├── useBookLoader.ts      # Loads the PDF + sidecar, owns StrictMode guard
│   ├── usePDFRenderer.ts     # Renders pages to canvas, handles resize
│   ├── useReadingProgress.ts # Page/zoom state, debounced saves, session record
│   └── useCrossDeviceSync.ts # 60-second poll for remote page updates
│
└── lib/
    ├── auth.ts           # GIS token client singleton, loadStoredAuth, saveAuth
    ├── drive.ts          # All Google Drive API calls (list, upload, download)
    ├── sidecar.ts        # loadSidecar, mergeSidecars (conflict resolution)
    ├── db.ts             # Dexie database: sidecar cache + write queue
    ├── opfs.ts           # OPFS PDF blob cache (cachePDF, getCachedPDF, …)
    ├── readerStorage.ts  # localStorage helpers for zoom, scroll, page
    ├── SyncManager.ts    # Singleton that coordinates all Drive writes
    └── sync.ts           # syncLibrary (Drive → store), pushPendingWrites
```

---

## How the auth flow works

1. App loads → `loadStoredAuth()` reads a previously saved token from `localStorage`.
2. If the token exists and is not expired, the user goes straight to the library.
3. If there is no token (or it expired), `App.tsx` calls `trySilentSignIn()`, which asks Google to issue a token silently without showing a popup. This works if the user already granted access recently.
4. If silent sign-in fails, the Sign In screen appears. The user clicks "Google" → `signIn()` → Google popup → token arrives via callback → stored in `localStorage` via `saveAuth()`.

The token is a short-lived OAuth access token (~1 hour). On expiry the user has to sign in again (silent sign-in will usually succeed without a visible popup).

**Where to look:** `src/lib/auth.ts`, `src/App.tsx`

---

## What is a "sidecar"?

A sidecar is a small JSON file that stores everything about your relationship with a book:

```
- progress:    your current page + scroll position + timestamp
- bookmarks:   list of bookmarks you created
- highlights:  list of highlighted passages
- stats:       reading sessions (start time, end time, pages read)
```

Each book has one sidecar. The sidecar is named `<driveFileId>.rdsy.json` and stored in the same Google Drive folder as your PDFs. A local copy is also kept in IndexedDB (via Dexie) so it works offline.

When you turn a page, RDSY does not save immediately — it debounces by 2 seconds, then writes to IDB first, then pushes to Drive. If you are offline, the write is queued in IDB and flushed the next time you come online.

**Where to look:** `src/types/sidecar.ts` (the type definition), `src/lib/sidecar.ts` (load + merge logic), `src/lib/db.ts` (IDB cache)

---

## How a book loads (the loading sequence)

When you open `/reader/:bookId`:

1. `useBookLoader` runs. It checks OPFS for a cached PDF blob.
   - If found → load instantly.
   - If not found → download from Drive, then cache it in OPFS in the background.

2. At the same time (via `Promise.all`), it calls `loadSidecar()` which:
   - Downloads the sidecar JSON from Drive (if a `sidecarDriveId` is known)
   - Merges it with the IDB-cached copy
   - Falls back to a fresh default sidecar if neither exists

3. A localStorage snapshot is checked as a tiebreaker. If the local page timestamp is newer than the sidecar's timestamp (which can happen when the IDB async write races with the unmount), localStorage wins. This avoids jumping back to page 1 on reload.

4. The start page is set. `setLoading(false)`. Rendering begins.

**Critical rule:** `hasLoadedRef.current` is set to `true` only after this entire sequence completes. Cleanup functions check this flag before saving — this is the StrictMode guard (explained below).

**Where to look:** `src/hooks/useBookLoader.ts`

---

## The StrictMode guard — why it exists

React's `<StrictMode>` (used in development) intentionally unmounts and remounts every component immediately after it mounts. This means the unmount cleanup in `Reader.tsx` fires while the PDF is still loading.

Without a guard, the cleanup would see `currentPage = 1` (the initial state value, before loading finished) and write `page: 1` to localStorage with a fresh timestamp. On the next load, that fresh timestamp would beat the real IDB/Drive data in the tiebreaker, and the book would always open at page 1 in development.

The guard is a ref: `hasLoadedRef.current`. It starts `false`, is set to `true` only after `loadPDF()` fully completes, and every cleanup function checks it before doing anything:

```typescript
// In cleanup:
if (!hasLoadedRef.current) return  // StrictMode fake unmount — skip
```

This guard is documented in `CLAUDE.md` — read that file for the full explanation.

---

## How sync works across devices

**On save (every page turn, debounced 2 seconds):**

```
useReadingProgress → saveProgress() → SyncManager.commitSidecar()
                                        ├── cacheSidecar()  (IDB, always first)
                                        ├── if offline: enqueueWrite()
                                        └── if online: upsertJSON() → Drive
```

The `SyncManager` (a singleton in `src/lib/SyncManager.ts`) is the single point that writes to Drive. Nothing else should call `upsertJSON` directly for sidecars. This prevents race conditions where two parts of the code try to write simultaneously.

**On load (polling for remote updates):**

`useCrossDeviceSync` polls Drive every 60 seconds and on every tab focus change (`visibilitychange`). If the remote sidecar has a newer `updatedAt` timestamp, it updates the local sidecar state and jumps to the new page.

---

## Conflict resolution rules

When two devices have both edited a sidecar (e.g. you read on phone and desktop while offline), `mergeSidecars()` resolves conflicts:

- **Progress (current page):** last-write-wins by `updatedAt` timestamp
- **Bookmarks / Highlights:** merged by `id`, tombstones (deleted items) always win
- **Reading sessions:** concatenated, deduplicated by `device + startedAt`

**Where to look:** `src/lib/sidecar.ts` → `mergeSidecars()`

---

## The Zustand store

The store (`src/store/index.ts`) holds the runtime state of the app:

| State | Type | Meaning |
|---|---|---|
| `auth` | `AuthState` | Current auth token + expiry, or `{ status: 'unauthenticated' }` |
| `books` | `BookEntry[]` | The library — one entry per PDF in Drive |
| `syncStatus` | `'idle' \| 'syncing' \| 'error' \| 'offline'` | Shown as the dot in the nav bar |
| `folderId` | `string \| null` | The Drive ID of the RDSY-Library folder |

Components access it like this:

```typescript
const { auth, setAuth } = useStore(useShallow(s => ({ auth: s.auth, setAuth: s.setAuth })))
```

`useShallow` prevents re-renders when unrelated state changes. You will want this any time you are selecting more than one field.

The store does **not** do any async work. It is pure state + setters. All Drive calls go through `src/lib/` and `SyncManager`.

---

## Where data lives

| What | Where | Why |
|---|---|---|
| PDF files | OPFS | Fast binary reads, large quota, no IDB overhead |
| Sidecar JSON (offline copy) | IndexedDB via Dexie | Structured, queryable, survives app restarts |
| Sidecar JSON (source of truth) | Google Drive | Cross-device sync |
| Auth token | localStorage | Survives page refresh, checked at startup |
| Zoom level per book | localStorage | Tiny value, instant read |
| Last-read page (tiebreaker) | localStorage | Written synchronously at unmount before IDB async write lands |
| Pinned books list | IndexedDB (meta table) | Small set, needs to survive offline |
| Write queue (offline) | IndexedDB (meta table) | Persists across browser restarts |

---

## Common things you will need to do

### Adding a new field to Sidecar

1. Add the field to the `Sidecar` interface in `src/types/sidecar.ts`.
2. Add a default value in `makeSidecar()` in the same file.
3. Update `mergeSidecars()` in `src/lib/sidecar.ts` with the conflict resolution rule for the new field.
4. Bump `version` in `makeSidecar()` if the schema change is breaking.

### Adding a new Drive API call

Add a function to `src/lib/drive.ts`. All Drive calls must include `Authorization: Bearer ${accessToken}` in the headers. Use `assertOk()` to throw a readable error on non-2xx responses.

### Adding a new library screen route

1. Create your component in `src/components/`.
2. Add a `<Route path="..." element={<YourComponent />} />` in `AuthenticatedShell` in `src/App.tsx`.
3. If you need the nav bar to hide in your route (like the reader does), add your path to the `isReader` check in `AuthenticatedShell`.

---

## Files to read first

If you only have time to read a few files, read these in order:

1. `CLAUDE.md` — the two critical rules (sidecar must never be null, StrictMode guard)
2. `src/types/sidecar.ts` — the Sidecar type is the core data model
3. `src/lib/sidecar.ts` — how loading and merging works
4. `src/store/index.ts` — the global state shape
5. `src/hooks/useBookLoader.ts` — where the loading sequence lives
6. `src/lib/SyncManager.ts` — where all Drive writes go through
