import { create } from 'zustand'
import type { AuthState, BookEntry, SyncStatus, Sidecar } from '../types'
import { loadStoredAuth, saveAuth } from '../lib/auth'

interface StoreState {
  auth: AuthState
  books: BookEntry[]
  syncStatus: SyncStatus
  folderId: string | null
  setAuth: (auth: AuthState) => void
  setBooks: (books: BookEntry[]) => void
  setSyncStatus: (status: SyncStatus) => void
  setFolderId: (id: string | null) => void
  updateSidecar: (bookId: string, sidecar: Sidecar, sidecarDriveId?: string) => void
}

export const useStore = create<StoreState>()((set) => ({
  auth: loadStoredAuth(),
  books: [],
  syncStatus: 'idle',
  folderId: null,
  setAuth: (auth) => {
    saveAuth(auth)
    set({ auth })
  },
  setBooks: (books) => set({ books }),
  setSyncStatus: (syncStatus) => set({ syncStatus }),
  setFolderId: (folderId) => set({ folderId }),
  updateSidecar: (bookId, sidecar, sidecarDriveId) => set((state) => {
    const idx = state.books.findIndex((b) => b.driveId === bookId)
    if (idx === -1) return state
    const next = state.books.slice()
    next[idx] = { ...next[idx], sidecar, ...(sidecarDriveId ? { sidecarDriveId } : {}) }
    return { books: next }
  }),
}))
