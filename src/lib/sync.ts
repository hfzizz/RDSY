import type { BookEntry, DriveFile } from '../types';
import { SIDECAR_SUFFIX } from '../types';
import { ensureLibraryFolder, listPDFs, listSidecars, upsertJSON } from './drive';
import { getPinnedIds, dequeueWrites, clearQueueEntry } from './db'
import { hasCachedPDF } from './opfs';
import { loadSidecar } from './sidecar';

/**
 * Pull the full library from Drive: list PDFs, match with sidecars,
 * load/merge each sidecar, and return enriched BookEntry[].
 * Pinned status is applied from IndexedDB.
 */
export async function syncLibrary(accessToken: string): Promise<BookEntry[]> {
  const folderId = await ensureLibraryFolder(accessToken);

  // Fetch PDFs and sidecars in parallel
  const [pdfs, sidecars, pinnedIds] = await Promise.all([
    listPDFs(accessToken, folderId),
    listSidecars(accessToken, folderId),
    getPinnedIds(),
  ]);

  // Index sidecars by bookId: sidecar filename is "<pdf-driveId>.rdsy.json"
  const sidecarByBookId = new Map<string, DriveFile>();
  for (const sc of sidecars) {
    if (sc.name.endsWith(SIDECAR_SUFFIX)) {
      const bookId = sc.name.slice(0, -SIDECAR_SUFFIX.length);
      sidecarByBookId.set(bookId, sc);
    }
  }

  // Build BookEntry for each PDF
  const entries = await Promise.all(
    pdfs.map(async (pdf): Promise<BookEntry> => {
      const matchedSidecar = sidecarByBookId.get(pdf.id);

      // Load (and merge) the sidecar; caching is handled inside loadSidecar when Drive data is merged
      const sidecar = await loadSidecar(accessToken, pdf.id, matchedSidecar?.id);

      const cachedLocally = await hasCachedPDF(pdf.id);

      return {
        driveId: pdf.id,
        sidecarDriveId: matchedSidecar?.id,
        name: pdf.name,
        pinnedOffline: pinnedIds.has(pdf.id),
        sidecar,
        cachedLocally,
      };
    })
  );

  // Sort alphabetically by name
  entries.sort((a, b) => a.name.localeCompare(b.name));

  return entries;
}

/**
 * Push all enqueued offline writes to Drive when back online.
 */
export async function pushPendingWrites(
  accessToken: string,
  folderId: string
): Promise<void> {
  const pending = await dequeueWrites();

  if (pending.length === 0) return;

  // Ensure we have the folder ID (caller should pass one, but we accept it as param)
  for (const { driveId, sidecar } of pending) {
    try {
      const fileName = `${sidecar.bookId}.rdsy.json`;
      await upsertJSON(accessToken, folderId, fileName, sidecar);
      await clearQueueEntry(driveId);
    } catch (err) {
      console.error('[sync] Failed to push pending write for', driveId, err);
      // Continue with remaining entries
    }
  }
}
