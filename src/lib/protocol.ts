// Messages sent over the data channel. Control messages are JSON strings,
// file bytes are raw ArrayBuffers sent between a 'file' and an 'end' message.

export interface ManifestFile {
  id: number
  path: string // relative path, forward slashes, e.g. "DCIM/100MSDCF/C0001.MP4"
  size: number
  lastModified: number
}

export type SenderMsg =
  | { t: 'hi'; name: string; clientId: string }
  | { t: 'manifest'; batchId: string; label: string; date: string; files: ManifestFile[] }
  | { t: 'file'; id: number }
  | { t: 'end'; id: number; hash: string }
  | { t: 'cancel' }
  | { t: 'finished' }

export type EditorMsg =
  | { t: 'hello'; name: string; ready: boolean }
  | { t: 'plan'; skip: number[]; noRetry?: boolean }
  | { t: 'declined' }
  | { t: 'ack'; id: number; bytes: number }
  | { t: 'done'; id: number; ok: boolean }
  | { t: 'error'; message: string }

export const CHUNK = 64 * 1024 // data channel message size, safe across Chrome/Safari/Firefox
export const READ_BLOCK = 4 * 1024 * 1024 // how much the sender reads from disk at once
export const WRITE_BLOCK = 4 * 1024 * 1024 // how much the receiver buffers before a disk write
export const MAX_IN_FLIGHT = 64 * 1024 * 1024 // unacknowledged bytes allowed before the sender waits
export const CHANNEL_HIGH_WATER = 4 * 1024 * 1024
export const CHANNEL_LOW_WATER = 1024 * 1024

export const PEER_PREFIX = 'handoff-v1-'

// Watch links: a teammate's browser asks the editor's browser for the list of
// footage, thumbnails, and byte ranges of files. Binary replies start with a
// 4-byte little-endian request id.

export interface LibItem {
  path: string // relative to the editor's Handoff folder
  name: string
  size: number
  modified: number
  kind: 'video' | 'photo'
  shooter: string
  batch: string
}

export interface LiveSend {
  name: string
  label: string
  filesDone: number
  totalFiles: number
}

export type ViewerMsg =
  | { t: 'v-list'; rid: number }
  | { t: 'v-thumb'; rid: number; path: string }
  | { t: 'v-read'; rid: number; path: string; start: number; end: number }

export type LibraryMsg =
  | { t: 'v-hello'; name: string; status: 'ok' | 'zip' | 'off' | 'badkey' | 'nofolder' }
  | { t: 'v-list'; rid: number; items: LibItem[]; live: LiveSend[] }
  | { t: 'v-thumb'; rid: number; jpeg: string; duration: number }
  | { t: 'v-read'; rid: number; size: number; start: number; end: number }
  | { t: 'v-end'; rid: number }
  | { t: 'v-err'; rid: number; message: string }

export const VIDEO_EXT = /\.(mp4|mov|m4v|mxf|mts|m2ts|avi|mkv|webm|insv|lrv|crm)$/i
export const PHOTO_EXT = /\.(jpe?g|png|heic|heif|webp)$/i
