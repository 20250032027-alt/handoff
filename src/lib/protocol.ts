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
  | { t: 'plan'; skip: number[] }
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

export const PEER_PREFIX = 'dailies-v1-'
