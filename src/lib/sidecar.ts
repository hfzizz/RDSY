import type { Sidecar, ReadingSession } from '../types';
import { makeSidecar } from '../types';
import { getCachedSidecar, cacheSidecar, enqueueWrite } from './db';
import { downloadJSON, upsertJSON } from './drive';

/**
 * Load a sidecar for a book.
 * Strategy: try Drive first (if sidecarDriveId provided), fall back to local
 * cache, fall back to a fresh default sidecar.
 */
export async function loadSidecar(
  accessToken: string,
  bookId: string,
  sidecarDriveId: string | undefined
): Promise<Sidecar> {
  const cached = await getCachedSidecar(bookId);

  if (sidecarDriveId) {
    try {
      const remote = await downloadJSON<Sidecar>(accessToken, sidecarDriveId);
      const merged = cached ? mergeSidecars(cached, remote) : remote;
      await cacheSidecar(bookId, merged);
      return merged;
    } catch (err) {
      console.warn('[sidecar] Failed to download from Drive, falling back to cache:', err);
    }
  }

  if (cached) {
    return cached;
  }

  return makeSidecar(bookId);
}

/**
 * Merge two sidecars into one, applying the RDSY conflict-resolution rules:
 *  - progress: last-write-wins by updatedAt
 *  - bookmarks/highlights: additive merge by id, tombstones preserved
 *  - stats.sessions: concatenate + deduplicate by device+startedAt
 *  - version: always 1
 */
export function mergeSidecars(local: Sidecar, remote: Sidecar): Sidecar {
  // --- progress: last-write-wins ---
  const progress =
    local.progress.updatedAt >= remote.progress.updatedAt
      ? local.progress
      : remote.progress;

  // --- bookmarks: additive merge by id ---
  const bookmarks = mergeAnnotations(local.bookmarks, remote.bookmarks);

  // --- highlights: additive merge by id ---
  const highlights = mergeAnnotations(local.highlights, remote.highlights);

  // --- sessions: concatenate + deduplicate by device+startedAt ---
  const sessionKey = (s: ReadingSession) => `${s.device}::${s.startedAt}`;
  const sessionMap = new Map<string, ReadingSession>();
  for (const session of [...local.stats.sessions, ...remote.stats.sessions]) {
    sessionMap.set(sessionKey(session), session);
  }
  const sessions = Array.from(sessionMap.values());

  return {
    version: 1,
    bookId: local.bookId,
    progress,
    bookmarks,
    highlights,
    stats: { sessions },
  };
}

/**
 * Generic merge for Bookmark[] or Highlight[].
 * Rules:
 *  - Merge by id across local and remote.
 *  - If id exists in both: keep whichever has later createdAt, but if either
 *    side marks deleted=true the tombstone always wins.
 *  - Items that only appear on one side are kept as-is (including tombstones).
 */
function mergeAnnotations<T extends { id: string; createdAt: string; deleted?: boolean }>(
  local: T[],
  remote: T[]
): T[] {
  const map = new Map<string, T>();

  // Index local items first
  for (const item of local) {
    map.set(item.id, item);
  }

  // Merge remote items
  for (const remoteItem of remote) {
    const localItem = map.get(remoteItem.id);
    if (!localItem) {
      // Only in remote — take it
      map.set(remoteItem.id, remoteItem);
    } else {
      // Exists in both — resolve conflict
      const deletedWins = localItem.deleted || remoteItem.deleted;
      if (deletedWins) {
        // Tombstone wins: use whichever is deleted (or the remote one if both are)
        const winner = localItem.deleted ? localItem : remoteItem;
        map.set(remoteItem.id, { ...winner, deleted: true });
      } else {
        // Neither deleted: keep later createdAt
        const winner =
          localItem.createdAt >= remoteItem.createdAt ? localItem : remoteItem;
        map.set(remoteItem.id, winner);
      }
    }
  }

  return Array.from(map.values());
}

/**
 * Save a sidecar to Google Drive, or enqueue for later if offline.
 * Returns the sidecar file Drive ID, or 'queued' if deferred.
 */
export async function saveSidecar(
  accessToken: string,
  folderId: string,
  sidecar: Sidecar,
  existingId?: string
): Promise<string> {
  if (!navigator.onLine) {
    await enqueueWrite(sidecar.bookId, sidecar);
    return existingId ?? 'queued';
  }

  const fileName = `${sidecar.bookId}.rdsy.json`;
  const driveId = await upsertJSON(accessToken, folderId, fileName, sidecar, existingId);

  // Update local cache with the just-saved version
  await cacheSidecar(sidecar.bookId, sidecar);

  return driveId;
}
