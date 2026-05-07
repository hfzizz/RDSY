export const RDSY_FOLDER_NAME = 'RDSY-Library';
export const DEVICE_ID_KEY = 'rdsy_device_id';
export const SIDECAR_SUFFIX = '.rdsy.json';

export interface BookProgress {
  page: number;
  scrollPct: number;
  updatedAt: string;
  updatedBy: string;
}

export interface Bookmark {
  id: string;
  page: number;
  label: string;
  createdAt: string;
  deleted?: boolean;
}

export interface HighlightRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Highlight {
  id: string;
  page: number;
  rects: HighlightRect[];
  text: string;
  note?: string;
  color: 'yellow' | 'green' | 'blue' | 'pink';
  createdAt: string;
  deleted?: boolean;
}

export interface ReadingSession {
  device: string;
  startedAt: string;
  endedAt: string;
  pagesRead: number;
}

export interface BookStats {
  sessions: ReadingSession[];
}

export interface Sidecar {
  version: number;
  bookId: string;
  progress: BookProgress;
  bookmarks: Bookmark[];
  highlights: Highlight[];
  stats: BookStats;
}

export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  size?: string;
  modifiedTime?: string;
}

export interface BookEntry {
  driveId: string;
  sidecarDriveId?: string;
  name: string;
  pinnedOffline: boolean;
  sidecar?: Sidecar;
  cachedLocally?: boolean;
}

export type SyncStatus = 'idle' | 'syncing' | 'error' | 'offline';

export type AuthState =
  | { status: 'unauthenticated' }
  | { status: 'authenticated'; accessToken: string; expiresAt: number };

export function makeDeviceId(): string {
  const platform = /iPhone|iPad/i.test(navigator.userAgent) ? 'ios' : 'win';
  return `${platform}-${Math.random().toString(36).slice(2, 8)}`;
}

export function getDeviceId(): string {
  let id = localStorage.getItem(DEVICE_ID_KEY);
  if (!id) {
    id = makeDeviceId();
    localStorage.setItem(DEVICE_ID_KEY, id);
  }
  return id;
}

export function makeSidecar(bookId: string): Sidecar {
  return {
    version: 1,
    bookId,
    progress: { page: 1, scrollPct: 0, updatedAt: new Date().toISOString(), updatedBy: getDeviceId() },
    bookmarks: [],
    highlights: [],
    stats: { sessions: [] },
  };
}
