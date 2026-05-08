import { useEffect } from 'react'
import type { Sidecar } from '../types'
import { loadSidecar } from '../lib/sidecar'

export function useCrossDeviceSync(
  bookId: string | undefined,
  accessToken: string,
  authStatus: string,
  sidecarDriveId: string | undefined,
  hasLoadedRef: React.MutableRefObject<boolean>,
  setSidecar: React.Dispatch<React.SetStateAction<Sidecar | null>>,
  setCurrentPage: (page: number) => void,
) {
  useEffect(() => {
    if (authStatus !== 'authenticated' || !bookId) return

    const pollRemote = async () => {
      if (!hasLoadedRef.current || !navigator.onLine) return
      try {
        const remote = await loadSidecar(accessToken, bookId, sidecarDriveId)
        setSidecar(prev => {
          if (!prev || remote.progress.updatedAt <= prev.progress.updatedAt) return prev
          if (remote.progress.page !== prev.progress.page) setCurrentPage(remote.progress.page)
          return remote
        })
      } catch { /* non-fatal */ }
    }

    const id = setInterval(pollRemote, 60_000)
    const onVisible = () => { if (!document.hidden) pollRemote() }
    document.addEventListener('visibilitychange', onVisible)
    return () => { clearInterval(id); document.removeEventListener('visibilitychange', onVisible) }
  }, [authStatus, bookId]) // eslint-disable-line react-hooks/exhaustive-deps
}
