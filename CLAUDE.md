# RDSY — Claude Notes

## Critical: sidecar must never be null after PDF load

`sidecar` state being `null` silently breaks page saving. In `Reader.tsx`, `saveProgress` and the unmount cleanup both guard on `if (sidecar)` — if sidecar is null, every page turn is silently dropped and progress is never persisted.

**Rule:** Always use `loadSidecar(...)` (from `src/lib/sidecar.ts`) to set sidecar state after load. It always returns a real `Sidecar` object (merges Drive + IDB, falls back to `makeSidecar`). Never set sidecar to `null` after the PDF finishes loading, and never use `getCachedSidecar` alone as the source of truth for the initial page — it can return `undefined` for new books that haven't been read yet.

**Correct pattern for parallel load (fast + correct):**
```typescript
const [pdf, freshSidecar] = await Promise.all([
  pdfjsLib.getDocument({ url: blobUrl }).promise,
  loadSidecar(accessToken, bookId!, book?.sidecarDriveId),
])
// freshSidecar is always a real Sidecar — never null
setSidecar(freshSidecar)
```

**Wrong pattern (caused the "goes to page 1" bug):**
```typescript
// getCachedSidecar can return undefined → sidecar stays null → saves silently skipped
const cachedSidecar = await getCachedSidecar(bookId!)
setSidecar(cachedSidecar ?? book?.sidecar ?? null)  // DON'T DO THIS
loadSidecar(...).then(...) // background update too late
```

## Critical: React StrictMode fakes an unmount on every mount

In development, `<StrictMode>` immediately unmounts and remounts every component. The unmount cleanup in `Reader.tsx` fires **before `loadPDF` has finished**, so `currentPageAtUnmount.current = 1` (the initial `useState` value). This caused `savePageLocal(bookId, 1)` to write page 1 with a fresh timestamp, which then beat the real IDB/Drive data in the tiebreaker on the subsequent load.

**Rule:** The unmount cleanup must check `hasLoadedRef.current` before calling `savePageLocal` or `commitSidecar`. Set `hasLoadedRef.current = true` only after `loadPDF` fully completes (right before `setLoading(false)`).

```typescript
// In loadPDF, after all state is ready:
hasLoadedRef.current = true
setLoading(false)

// In unmount cleanup:
if (!hasLoadedRef.current) return  // Strict Mode fake unmount — nothing to save
```

**Also:** `makeSidecar` must use `new Date(0).toISOString()` (epoch) as the default `updatedAt`, not `new Date().toISOString()`. A fresh timestamp on the fallback sidecar would beat localStorage snapshots written at unmount time, restoring page 1 when IDB is empty due to the async write race.
