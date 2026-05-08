export const RDSY_FOLDER_NAME = 'RDSY-Library'
export const SIDECAR_SUFFIX = '.rdsy.json'

export interface BookProgress {
  page: number
  scrollPct: number
  updatedAt: string
  updatedBy: string
}

export interface DriveFile {
  id: string
  name: string
  mimeType: string
  size?: string
  modifiedTime?: string
}

export interface BookEntry {
  driveId: string
  sidecarDriveId?: string
  name: string
  pinnedOffline: boolean
  sidecar?: import('./sidecar').Sidecar
  cachedLocally?: boolean
}
