// The Viewer: reading a folder on this computer and caching thumbnails so
// reopening it is instant.

import { PHOTO_EXT, VIDEO_EXT } from './protocol'
import { thumbOf } from './library'
import { idbGet, idbSet } from './store'

export interface LocalItem {
  key: string // path + size + modified, stable across visits
  path: string // relative to the picked folder
  name: string
  dir: string // subfolder it sits in ('' for the top)
  kind: 'video' | 'photo'
  size: number
  modified: number
  file: File
}

export interface Thumb {
  jpeg: string
  duration: number
  width: number
  height: number
  taken?: number // when it was recorded, from inside the file (0 if the file doesn't say)
}

// The recording date the camera wrote into the file, which survives copying.
async function readTaken(it: LocalItem): Promise<number> {
  try {
    if (it.kind === 'photo') {
      const head = new Uint8Array(await it.file.slice(0, 128 * 1024).arrayBuffer())
      const text = new TextDecoder('latin1').decode(head)
      const m = /(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})/.exec(text)
      return m ? new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime() : 0
    }
    const { Input, BlobSource, ALL_FORMATS } = await import('mediabunny')
    const input = new Input({ source: new BlobSource(it.file), formats: ALL_FORMATS })
    const tags = await input.getMetadataTags()
    const d = tags.date || tags.creationTime
    const t = d ? d.getTime() : 0
    // Some cameras write 1904 or 1970 when their clock was never set.
    return t > Date.UTC(1995, 0, 1) ? t : 0
  } catch {
    return 0
  }
}

export async function scanHandle(root: FileSystemDirectoryHandle): Promise<LocalItem[]> {
  const out: LocalItem[] = []
  async function walk(d: FileSystemDirectoryHandle, parts: string[]) {
    for await (const [name, h] of d.entries()) {
      if (out.length >= 20000) return
      if (name.startsWith('.') || name.startsWith('$')) continue
      if (h.kind === 'directory') await walk(h as FileSystemDirectoryHandle, [...parts, name])
      else {
        const kind = VIDEO_EXT.test(name) ? 'video' : PHOTO_EXT.test(name) ? 'photo' : null
        if (!kind || name.startsWith('._')) continue
        const file = await (h as FileSystemFileHandle).getFile()
        out.push(item(file, [...parts, name].join('/'), kind))
      }
    }
  }
  await walk(root, [])
  return out
}

export function scanFileList(list: FileList): LocalItem[] {
  const out: LocalItem[] = []
  for (const f of Array.from(list)) {
    const path = (f.webkitRelativePath || f.name).split('/').slice(1).join('/') || f.name
    const kind = VIDEO_EXT.test(f.name) ? 'video' : PHOTO_EXT.test(f.name) ? 'photo' : null
    if (!kind || f.name.startsWith('._') || path.split('/').some((p) => p.startsWith('.'))) continue
    out.push(item(f, path, kind))
  }
  return out
}

function item(file: File, path: string, kind: 'video' | 'photo'): LocalItem {
  const parts = path.split('/')
  return {
    key: `${path}:${file.size}:${file.lastModified}`,
    path,
    name: parts[parts.length - 1],
    dir: parts.slice(0, -1).join('/'),
    kind,
    size: file.size,
    modified: file.lastModified,
    file,
  }
}

// Thumbnails: memory first, then IndexedDB, then make one. A few at a time.
const mem = new Map<string, Thumb>()
let active = 0
const waiting: (() => void)[] = []
const SLOTS = 2
// While a clip is playing, thumbnails wait, so they don't steal the video decoder.
let paused = false
const resumeWaiters: (() => void)[] = []
export function pauseThumbs(p: boolean) {
  paused = p
  if (!p) while (resumeWaiters.length) resumeWaiters.shift()!()
}

async function slot<T>(fn: () => Promise<T>): Promise<T> {
  while (paused) await new Promise<void>((r) => resumeWaiters.push(r))
  if (active >= SLOTS) await new Promise<void>((r) => waiting.push(r))
  active++
  try {
    return await fn()
  } finally {
    active--
    waiting.shift()?.()
  }
}

export async function thumbFor(it: LocalItem): Promise<Thumb> {
  const hit = mem.get(it.key)
  if (hit) return hit
  const stored = await idbGet<Thumb>('vthumb:' + it.key).catch(() => undefined)
  if (stored) {
    if (stored.taken === undefined) {
      stored.taken = await readTaken(it)
      void idbSet('vthumb:' + it.key, stored).catch(() => {})
    }
    mem.set(it.key, stored)
    return stored
  }
  const t: Thumb = await slot(async () => ({ ...(await thumbOf(it.file, it.kind)), taken: await readTaken(it) }))
  mem.set(it.key, t)
  if (t.jpeg || t.duration) void idbSet('vthumb:' + it.key, t).catch(() => {})
  return t
}

export function peekThumb(key: string) {
  return mem.get(key)
}
