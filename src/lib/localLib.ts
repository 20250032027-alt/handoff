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
const SLOTS = 3

async function slot<T>(fn: () => Promise<T>): Promise<T> {
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
    mem.set(it.key, stored)
    return stored
  }
  const t = await slot(() => thumbOf(it.file, it.kind))
  mem.set(it.key, t)
  if (t.jpeg || t.duration) void idbSet('vthumb:' + it.key, t).catch(() => {})
  return t
}

export function peekThumb(key: string) {
  return mem.get(key)
}
