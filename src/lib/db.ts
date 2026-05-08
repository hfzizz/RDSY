import Dexie, { type Table } from 'dexie'
import type { Sidecar } from '../types'

type WriteQueueEntry = { driveId: string; sidecar: Sidecar }

class RdsyDatabase extends Dexie {
  sidecars!: Table<Sidecar, string>
  meta!: Table<any, string>

  constructor() {
    super('rdsy-db')
    // Version 1: mirrors the original idb schema exactly — existing data is preserved
    this.version(1).stores({
      pdfBlobs: '',
      sidecars: '',
      meta: '',
    })
    // Version 2: drop pdfBlobs (PDFs now live in OPFS), sidecars and meta unchanged
    this.version(2).stores({
      pdfBlobs: null,
      sidecars: '',
      meta: '',
    })
  }
}

const db = new RdsyDatabase()

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
