import type { BookEntry, Sidecar } from '../types'
import { cacheSidecar, enqueueWrite, clearQueueEntry } from './db'
import { upsertJSON, ensureLibraryFolder } from './drive'
import { syncLibrary as doSyncLibrary, pushPendingWrites } from './sync'

class SyncManager {
  private _folderId: string | null = null
  private _syncLock = false

  setFolderId(id: string) {
    this._folderId = id
  }

  private async getFolderId(accessToken: string): Promise<string> {
    if (!this._folderId) {
      this._folderId = await ensureLibraryFolder(accessToken)
    }
    return this._folderId
  }

  async commitSidecar(
    accessToken: string,
    bookId: string,
    sidecar: Sidecar,
    sidecarDriveId?: string,
  ): Promise<string> {
    // IDB write first — always durable regardless of network
    await cacheSidecar(bookId, sidecar)

    if (!navigator.onLine || !accessToken) {
      await enqueueWrite(bookId, sidecar)
      return sidecarDriveId ?? 'queued'
    }

    try {
      const folderId = await this.getFolderId(accessToken)
      const newId = await upsertJSON(accessToken, folderId, `${bookId}.rdsy.json`, sidecar, sidecarDriveId)
      await clearQueueEntry(bookId)
      return newId
    } catch {
      // Drive push failed — enqueue for retry when back online
      await enqueueWrite(bookId, sidecar)
      return sidecarDriveId ?? 'queued'
    }
  }

  async syncLibrary(accessToken: string): Promise<BookEntry[]> {
    if (this._syncLock || !accessToken) return []
    this._syncLock = true
    try {
      return await doSyncLibrary(accessToken)
    } finally {
      this._syncLock = false
    }
  }

  async flushQueue(accessToken: string): Promise<void> {
    if (!navigator.onLine || !accessToken) return
    try {
      const folderId = await this.getFolderId(accessToken)
      await pushPendingWrites(accessToken, folderId)
    } catch { /* non-fatal */ }
  }
}

export const syncManager = new SyncManager()
