const PDFS_DIR = 'pdfs'

async function getPdfsDir(): Promise<FileSystemDirectoryHandle> {
  const root = await navigator.storage.getDirectory()
  return root.getDirectoryHandle(PDFS_DIR, { create: true })
}

export async function cachePDF(driveId: string, blob: Blob): Promise<void> {
  const dir = await getPdfsDir()
  const file = await dir.getFileHandle(`${driveId}.pdf`, { create: true })
  const writable = await file.createWritable()
  await writable.write(blob)
  await writable.close()
}

export async function getCachedPDF(driveId: string): Promise<Blob | undefined> {
  try {
    const dir = await getPdfsDir()
    const fileHandle = await dir.getFileHandle(`${driveId}.pdf`)
    return await fileHandle.getFile()
  } catch {
    return undefined
  }
}

export async function hasCachedPDF(driveId: string): Promise<boolean> {
  try {
    const dir = await getPdfsDir()
    await dir.getFileHandle(`${driveId}.pdf`)
    return true
  } catch {
    return false
  }
}

export async function removeCachedPDF(driveId: string): Promise<void> {
  try {
    const dir = await getPdfsDir()
    await dir.removeEntry(`${driveId}.pdf`)
  } catch { /* already gone — treat as success */ }
}
