import { openDB } from 'idb';
import type { IDBPDatabase } from 'idb';
import type { Sidecar } from '../types';

const DB_NAME = 'rdsy-db';
const DB_VERSION = 1;

type RdsyDB = {
  pdfBlobs: {
    key: string;
    value: Blob;
  };
  sidecars: {
    key: string;
    value: Sidecar;
  };
  meta: {
    key: string;
    value: any;
  };
};

let dbPromise: Promise<IDBPDatabase<RdsyDB>> | null = null;

function getDB(): Promise<IDBPDatabase<RdsyDB>> {
  if (!dbPromise) {
    dbPromise = openDB<RdsyDB>(DB_NAME, DB_VERSION, {
      upgrade(db) {
        if (!db.objectStoreNames.contains('pdfBlobs')) {
          db.createObjectStore('pdfBlobs');
        }
        if (!db.objectStoreNames.contains('sidecars')) {
          db.createObjectStore('sidecars');
        }
        if (!db.objectStoreNames.contains('meta')) {
          db.createObjectStore('meta');
        }
      },
    });
  }
  return dbPromise;
}

export async function initDB(): Promise<void> {
  await getDB();
}

export async function getCachedPDF(driveId: string): Promise<Blob | undefined> {
  const db = await getDB();
  return db.get('pdfBlobs', driveId);
}

export async function cachePDF(driveId: string, blob: Blob): Promise<void> {
  const db = await getDB();
  await db.put('pdfBlobs', blob, driveId);
}

export async function removeCachedPDF(driveId: string): Promise<void> {
  const db = await getDB();
  await db.delete('pdfBlobs', driveId);
}

export async function hasCachedPDF(driveId: string): Promise<boolean> {
  const db = await getDB();
  const val = await db.getKey('pdfBlobs', driveId);
  return val !== undefined;
}

export async function getCachedSidecar(driveId: string): Promise<Sidecar | undefined> {
  const db = await getDB();
  return db.get('sidecars', driveId);
}

export async function cacheSidecar(driveId: string, sidecar: Sidecar): Promise<void> {
  const db = await getDB();
  await db.put('sidecars', sidecar, driveId);
}

export async function getPinnedIds(): Promise<Set<string>> {
  const db = await getDB();
  const pinned = await db.get('meta', 'pinned');
  if (!pinned) return new Set<string>();
  if (pinned instanceof Set) return pinned;
  // Stored as array for IDB serialization compatibility
  return new Set<string>(pinned as string[]);
}

export async function setPinned(driveId: string, pinned: boolean): Promise<void> {
  const db = await getDB();
  const current = await getPinnedIds();
  if (pinned) {
    current.add(driveId);
  } else {
    current.delete(driveId);
  }
  // Store as array since IDB cannot serialize Set directly
  await db.put('meta', Array.from(current), 'pinned');
}

export async function enqueueWrite(driveId: string, sidecar: Sidecar): Promise<void> {
  const db = await getDB();
  const queue: Array<{ driveId: string; sidecar: Sidecar }> =
    (await db.get('meta', 'writeQueue')) ?? [];
  const idx = queue.findIndex((entry) => entry.driveId === driveId);
  if (idx !== -1) {
    queue[idx] = { driveId, sidecar };
  } else {
    queue.push({ driveId, sidecar });
  }
  await db.put('meta', queue, 'writeQueue');
}

export async function dequeueWrites(): Promise<Array<{ driveId: string; sidecar: Sidecar }>> {
  const db = await getDB();
  return (await db.get('meta', 'writeQueue')) ?? [];
}

export async function clearQueueEntry(driveId: string): Promise<void> {
  const db = await getDB();
  const queue: Array<{ driveId: string; sidecar: Sidecar }> =
    (await db.get('meta', 'writeQueue')) ?? [];
  const updated = queue.filter((entry) => entry.driveId !== driveId);
  await db.put('meta', updated, 'writeQueue');
}
