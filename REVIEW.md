# RDSY — Senior Developer Review

> Reviewed against actual source code, not just the docs.
> Findings are split into: Security, Architecture, Performance, and Developer Experience.
> Each finding includes severity, the exact file and line it comes from, and a concrete fix.

---

## Security

### CRITICAL — OAuth access token persisted in localStorage

**File:** `src/lib/auth.ts:29`

```typescript
const SESSION_KEY = 'rdsy_auth'
// ...
localStorage.setItem(SESSION_KEY, JSON.stringify(auth))
```

`localStorage` is readable by any JavaScript running on the page. A single XSS vulnerability (from a malicious PDF, a dependency compromise, or a DOM injection bug) leaks the access token, which grants full `drive.file` write access to the user's library.

**Fix — store in `sessionStorage` instead.** It is automatically cleared when the tab closes, so tokens do not persist across browser sessions. Silent re-auth (GIS `prompt: ''`) will restore it transparently on the next load. This is the right trade-off for a token that expires in 1 hour anyway.

```typescript
// auth.ts
sessionStorage.setItem(SESSION_KEY, JSON.stringify(auth))
sessionStorage.removeItem(SESSION_KEY)
```

Update `loadStoredAuth` to read from `sessionStorage` and fall back to `localStorage` for a one-time migration of existing sessions.

---

### HIGH — No token expiry handling mid-session

**File:** `src/lib/auth.ts` — missing

The GIS access token expires in 3600 seconds (1 hour). There is no proactive refresh scheduled when the app loads. When the token expires during a reading session, all Drive calls silently fail — progress saves are lost, sync stops working, and the user sees no feedback.

`drive.ts:assertOk` throws a generic error on 401 but nothing upstream interprets it as an auth failure.

**Fix — schedule a refresh before expiry.**

```typescript
// auth.ts
export function scheduleRefresh(expiresAt: number, onRefreshed: TokenCallback): void {
  const msUntilExpiry = expiresAt - Date.now()
  const refreshAt = msUntilExpiry - 5 * 60 * 1000 // 5 min before expiry
  if (refreshAt <= 0) { trySilentSignIn(onRefreshed, () => {}); return }
  setTimeout(() => trySilentSignIn(onRefreshed, () => {}), refreshAt)
}
```

Call it from `App.tsx` whenever `setAuth` stores a new token. Also add a 401 interceptor in `drive.ts:assertOk` that dispatches a custom event (`rdsy:auth-expired`) so `App.tsx` can prompt re-authentication.

---

### HIGH — Offline write queue loses `sidecarDriveId`, creating duplicate files

**File:** `src/lib/sync.ts:74`

```typescript
// pushPendingWrites — no existingId passed
await upsertJSON(accessToken, folderId, fileName, sidecar)
//                                                        ↑ always creates a NEW file
```

`enqueueWrite` stores `{ driveId, sidecar }` but not `sidecarDriveId`. When the queue flushes, `upsertJSON` always takes the POST (create) path because it has no `existingId`. Result: every offline flush creates a duplicate `.rdsy.json` file in the user's Drive folder. After a few offline sessions the folder accumulates multiple sidecar files for the same book.

**Fix — store `sidecarDriveId` in the queue entry.**

```typescript
// db.ts
type WriteQueueEntry = { driveId: string; sidecarDriveId?: string; sidecar: Sidecar }

export async function enqueueWrite(driveId: string, sidecar: Sidecar, sidecarDriveId?: string)

// SyncManager.ts — pass it in
await enqueueWrite(bookId, sidecar, sidecarDriveId)

// sync.ts — use it on flush
await upsertJSON(accessToken, folderId, fileName, sidecar, entry.sidecarDriveId)
```

---

### MEDIUM — Dead dependency is an unnecessary attack surface

**File:** `package.json:13`

```json
"@react-oauth/google": "^0.13.5"
```

This package is imported nowhere in `src/`. It ships ~45 KB of code that is never executed. Every dependency is a potential supply chain attack vector. Remove it.

```bash
npm uninstall @react-oauth/google
```

---

### MEDIUM — No Content Security Policy

**File:** `vite.config.ts` — missing

The app loads `https://accounts.google.com/gsi/client` from a third-party CDN at runtime (`index.html`). Without a CSP header, the browser places no restrictions on what scripts can execute or what origins can be contacted. If the hosting layer supports custom headers, add:

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

For Vite, this can be added via the `vite-plugin-csp` plugin or as response headers in your hosting config (Netlify `_headers`, Cloudflare Workers, etc.).

---

### LOW — No `.gitignore` or `.env.example`

No `.gitignore` was found in the repository root. The `.env` file containing `VITE_GOOGLE_CLIENT_ID` could be accidentally committed. Add:

```gitignore
# .gitignore
node_modules/
dist/
.env
.env.local
```

And add a companion:

```bash
# .env.example
VITE_GOOGLE_CLIENT_ID=your-oauth-client-id-here
```

The OAuth Client ID is not actually a secret (it is embedded in the built JS bundle and visible in network traffic), but committing `.env` files sets a dangerous precedent.

---

## Architecture

### HIGH — No Error Boundary around the Reader

**File:** `src/components/Reader.tsx` — missing

`Reader.tsx` composes four hooks and renders a canvas. Any unhandled render-time exception (e.g. `pdfDocRef.current` unexpectedly null, a hook throwing) will propagate up and crash the entire React tree, showing a blank white screen with no recovery path.

**Fix — wrap at the route level.**

```typescript
// ErrorBoundary.tsx
class ErrorBoundary extends React.Component<...> {
  state = { error: null }
  static getDerivedStateFromError(error) { return { error } }
  render() {
    if (this.state.error) return <ErrorScreen onBack={() => navigate('/')} />
    return this.props.children
  }
}

// App.tsx — wrap the reader route
<Route path="/reader/:bookId" element={<ErrorBoundary><ReaderPage /></ErrorBoundary>} />
```

---

### HIGH — Library is not persisted offline

**File:** `src/lib/sync.ts`, `src/store/index.ts`

The Zustand store initialises `books: []`. The book list is rebuilt from Drive on every load via `syncLibrary`. If the user opens the app offline, `syncLibrary` throws (or returns `[]` from the lock guard), and the library is empty — even if the user had pinned books locally that they can still read.

The book entries (including sidecar data) already exist in IDB. The missing piece is saving the last-known book list to IDB so it can be shown while Drive is unreachable.

**Fix — persist the book list to IDB.**

```typescript
// db.ts
export async function saveBookList(books: BookEntry[]): Promise<void> {
  await db.meta.put(books, 'bookList')
}
export async function loadBookList(): Promise<BookEntry[]> {
  return (await db.meta.get('bookList')) ?? []
}

// Library.tsx — load from IDB first, then refresh from Drive
useEffect(() => {
  loadBookList().then(cached => { if (cached.length > 0) setBooks(cached) })
  doSync()
}, [])

// doSync — save after successful sync
const result = await syncManager.syncLibrary(accessToken)
await saveBookList(result)
setBooks(result)
```

---

### MEDIUM — Two sources of truth for `folderId`

**Files:** `src/lib/SyncManager.ts:10`, `src/store/index.ts`

`SyncManager` caches `_folderId` privately. The Zustand store also has `folderId`. They are kept in sync manually in `Library.tsx`:

```typescript
// Library.tsx
const resolved = folderId ?? await ensureLibraryFolder(accessToken)
if (!folderId) setFolderId(resolved)
syncManager.setFolderId(resolved)
```

If a component ever sets `folderId` in the store without calling `syncManager.setFolderId`, they drift. This has already nearly caused a bug — the `Library.tsx` initialisation effect calls them separately.

**Fix — remove `folderId` from the store entirely.** Let `SyncManager` be the single owner. Components that need the folder ID should call `syncManager.getFolderId(accessToken)` (make it public) instead of reading it from the store.

---

### MEDIUM — `syncLibrary` fires N Drive requests simultaneously

**File:** `src/lib/sync.ts:33`

```typescript
const entries = await Promise.all(
  pdfs.map(async (pdf) => {
    const sidecar = await loadSidecar(accessToken, pdf.id, matchedSidecar?.id)
    // ...
  })
)
```

For a library with 100 books, this fires 100 concurrent `downloadJSON` requests to Drive. Google Drive has undocumented rate limits around 10 requests/second per user. A large library will hit 429 errors and cause partial sync failures.

Also, every sync re-downloads every sidecar regardless of whether it changed. The Drive API returns `modifiedTime` in the file listing — this is already being fetched but never used.

**Fix — use `modifiedTime` to skip unchanged sidecars, and batch requests.**

```typescript
// Skip if Drive version not newer than IDB version
const cached = await getCachedSidecar(pdf.id)
if (cached && matchedSidecar?.modifiedTime &&
    new Date(matchedSidecar.modifiedTime) <= new Date(cached.progress.updatedAt)) {
  return { /* use cached */ }
}
```

For rate limiting, process in batches of 5-10 with a small delay between batches.

---

### MEDIUM — No service worker update notification

**File:** `vite.config.ts:9`

```typescript
registerType: 'autoUpdate'
```

`autoUpdate` causes the service worker to install and activate silently. Users may be running stale JS for an entire session without knowing it. This is particularly risky for this app since logic bugs (the StrictMode guard, merge rules) are encoded in the JS — a user running an old version could corrupt their sidecar data.

**Fix — switch to `'prompt'` and show a refresh banner.**

```typescript
// vite.config.ts
registerType: 'prompt'

// App.tsx — use the useRegisterSW hook from vite-plugin-pwa
const { needRefresh, updateServiceWorker } = useRegisterSW()
// Show a banner: "A new version is available" + "Refresh" button
```

---

### LOW — `pdfjs-dist` worker configured inside a hook

**File:** `src/hooks/useBookLoader.ts:10`

```typescript
pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.mjs',
  import.meta.url
).href
```

This is a module-level side effect placed inside a hook file. It runs once (module evaluation) which is fine, but it is confusing to find it here rather than in `main.tsx`. Move it to `src/main.tsx` alongside other global configuration:

```typescript
// main.tsx
import * as pdfjsLib from 'pdfjs-dist'
pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.mjs', import.meta.url
).href
```

---

### LOW — Inline styles make the UI hard to maintain

Every component (`Library.tsx`, `Reader.tsx`, `App.tsx`, `Bookmarks.tsx`) uses inline style objects. There are no CSS classes, no CSS modules, and no design tokens outside of CSS variables in `index.css`. Hover states are managed by `onMouseEnter/Leave` manipulating `e.currentTarget.style` directly — a fragile pattern.

**Options ranked by adoption cost:**
1. **CSS Modules** (zero new dependencies, co-located with components) — lowest friction
2. **Tailwind CSS** (utility-first, works well with Vite) — larger adoption but very fast day-to-day
3. **vanilla-extract** (type-safe, zero-runtime) — best long-term for a TypeScript-first project

The existing CSS variables (`var(--gold)`, `var(--bg)`, etc.) are a good foundation — they just need to be used from class-based rules instead of inline objects.

---

## Performance

### MEDIUM — No virtual scrolling in the Library

**File:** `src/components/Library.tsx:389`

```typescript
{filteredBooks.map((book) => <BookCard key={book.driveId} ... />)}
```

All book cards are rendered as DOM nodes. At 200+ books this will cause a noticeable initial paint delay and increased memory use. Add `@tanstack/react-virtual` or `react-window` to render only the visible rows.

---

### LOW — `hasCachedPDF` called for every book during sync

**File:** `src/lib/sync.ts:40`

```typescript
const cachedLocally = await hasCachedPDF(pdf.id)
```

This is an OPFS stat call per book, fired in parallel for the whole library. OPFS calls are fast, but at 100+ books this adds up. Since the pinned book list is already tracked in IDB (`meta.pinned`), consider deriving `cachedLocally` from that list for non-pinned books (they would not be cached) and only checking OPFS for books where `pinnedOffline === true`.

---

## Developer Experience

### HIGH — No tests

The most complex logic in the project — `mergeSidecars`, `loadSidecar`, and the StrictMode guard — has zero test coverage. `mergeSidecars` alone has at least 8 distinct code paths (progress tiebreaker, bookmark delete-wins, both-deleted, session deduplication). A subtle regression here silently loses user data.

**Recommended setup (zero config with Vite):**

```bash
npm install -D vitest @testing-library/react @testing-library/user-event jsdom
```

Start with pure function tests — no React needed:

```typescript
// src/lib/sidecar.test.ts
import { mergeSidecars } from './sidecar'

test('progress: later updatedAt wins', () => { ... })
test('bookmark: tombstone wins over live', () => { ... })
test('sessions: deduplicates by device+startedAt', () => { ... })
```

---

### MEDIUM — No TypeScript path aliases

Every import in `src/hooks/` uses `../lib/` and `../types`. As the project grows, `../../` chains appear. Add path aliases in `tsconfig.json` and `vite.config.ts`:

```json
// tsconfig.app.json
"paths": { "@/*": ["./src/*"] }
```

```typescript
// vite.config.ts
resolve: { alias: { '@': path.resolve(__dirname, './src') } }
```

Then imports become `import { syncManager } from '@/lib/SyncManager'` — readable from anywhere in the tree.

---

### LOW — No `engines` field in `package.json`

The project uses the OPFS API which requires Node 18+ for tooling and a modern browser at runtime. Without an `engines` field, `npm install` will not warn a developer on Node 16.

```json
"engines": { "node": ">=18" }
```

---

## Summary table

| # | Severity | Area | Finding |
|---|---|---|---|
| 1 | CRITICAL | Security | OAuth token in localStorage (XSS-readable) |
| 2 | HIGH | Security | No token refresh — silent failures after 1 hour |
| 3 | HIGH | Security | Offline flush creates duplicate Drive sidecar files |
| 4 | HIGH | Architecture | No Error Boundary — Reader crashes the whole app |
| 5 | HIGH | Architecture | Library not persisted offline — empty on fresh offline load |
| 6 | HIGH | DX | Zero tests on the most critical business logic |
| 7 | MEDIUM | Security | Dead `@react-oauth/google` dependency |
| 8 | MEDIUM | Security | No Content Security Policy |
| 9 | MEDIUM | Architecture | Two sources of truth for `folderId` |
| 10 | MEDIUM | Architecture | N parallel Drive requests during library sync — rate limit risk |
| 11 | MEDIUM | Architecture | No service worker update UI — users run stale code silently |
| 12 | MEDIUM | Performance | No virtual scrolling for large libraries |
| 13 | MEDIUM | DX | No TypeScript path aliases |
| 14 | LOW | Security | No `.gitignore` / `.env.example` |
| 15 | LOW | Architecture | PDF.js worker config inside a hook instead of `main.tsx` |
| 16 | LOW | Architecture | Inline styles — hover states via DOM mutation, no CSS modules |
| 17 | LOW | Performance | OPFS stat called per-book during every sync |
| 18 | LOW | DX | No `engines` field in `package.json` |

---

## Recommended order of attack

1. **Fix the queue bug** (#3) — it is silently corrupting Drive for any user who goes offline. One afternoon of work.
2. **Token refresh** (#2) — users will hit this after an hour every session. Add `scheduleRefresh` in `auth.ts` + a 401 interceptor in `drive.ts`.
3. **Error Boundary** (#4) — 30 minutes, prevents any future bug from showing a blank screen.
4. **Offline book list** (#5) — persist to IDB, load on startup. One day of work.
5. **Tests for `mergeSidecars`** (#6) — do this before touching the sidecar merge logic ever again.
6. **localStorage → sessionStorage** (#1) — 5 minutes, meaningful security improvement.
7. **Remove `@react-oauth/google`** (#7) — 2 minutes.
8. Everything else can be addressed as part of normal feature work.
