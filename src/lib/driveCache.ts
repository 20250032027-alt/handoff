// Preloading Drive originals into the browser's own storage (OPFS), so they play
// instantly and save without downloading again. Survives reloads.

import type { DriveItem } from './drive'
import { getJSON, setJSON } from './store'

export type CacheState = { status: 'queued' | 'loading' | 'ready' | 'error'; got: number; size: number; error?: string }

type Fetcher = (item: DriveItem, signal: AbortSignal) => Promise<Response>

const PARALLEL = 2

export function canPreload() {
  return (
    typeof navigator !== 'undefined' &&
    !!navigator.storage?.getDirectory &&
    typeof FileSystemFileHandle !== 'undefined' &&
    'createWritable' in FileSystemFileHandle.prototype
  )
}

class DriveCache {
  states = new Map<string, CacheState>()
  private queue: DriveItem[] = []
  private running = 0
  private ctl = new AbortController()
  private listeners = new Set<() => void>()
  private manifest: Record<string, { size: number; name: string }> = getJSON('drive-cache', {})
  private fetcher: Fetcher | null = null
  error = ''
  bytesDone = 0 // for the current batch
  bytesTotal = 0

  constructor() {
    for (const [id, m] of Object.entries(this.manifest)) this.states.set(id, { status: 'ready', got: m.size, size: m.size })
  }

  setFetcher(f: Fetcher) {
    this.fetcher = f
  }

  private async dir() {
    const root = await navigator.storage.getDirectory()
    return root.getDirectoryHandle('drive-cache', { create: true })
  }

  isReady(id: string) {
    return this.states.get(id)?.status === 'ready'
  }

  async file(item: DriveItem): Promise<File | null> {
    if (!this.isReady(item.id)) return null
    try {
      const f = await (await (await this.dir()).getFileHandle(item.id)).getFile()
      if (f.size === item.size) return f
    } catch {
      /* gone */
    }
    this.forget(item.id)
    return null
  }

  get usedBytes() {
    return Object.values(this.manifest).reduce((a, m) => a + m.size, 0)
  }

  get readyCount() {
    return Object.keys(this.manifest).length
  }

  get busy() {
    return this.running > 0 || this.queue.length > 0
  }

  get pendingCount() {
    return this.queue.length + this.running
  }

  async enqueue(items: DriveItem[]) {
    this.error = ''
    const todo = items.filter((i) => !i.isFolder && !i.isGoogleDoc && !this.isReady(i.id) && !this.queue.some((q) => q.id === i.id) && this.states.get(i.id)?.status !== 'loading')
    if (!todo.length) return
    const need = todo.reduce((a, i) => a + i.size, 0)
    try {
      await navigator.storage.persist?.()
      const est = await navigator.storage.estimate()
      const free = (est.quota || 0) - (est.usage || 0)
      if (est.quota && need > free) {
        this.error = `That's more than this browser can store right now. It has room for about ${Math.floor(free / 1e9)} GB.`
        this.emit()
        return
      }
    } catch {
      /* estimate not available, try anyway */
    }
    if (!this.busy) {
      this.bytesDone = 0
      this.bytesTotal = 0
      this.ctl = new AbortController()
    }
    for (const i of todo) {
      this.states.set(i.id, { status: 'queued', got: 0, size: i.size })
      this.queue.push(i)
      this.bytesTotal += i.size
    }
    this.emit()
    while (this.running < PARALLEL && this.queue.length) void this.next()
  }

  stop() {
    this.ctl.abort()
    for (const q of this.queue) this.states.delete(q.id)
    this.queue = []
    this.emit()
  }

  private async next() {
    const item = this.queue.shift()
    if (!item) return
    this.running++
    const st: CacheState = { status: 'loading', got: 0, size: item.size }
    this.states.set(item.id, st)
    this.emit()
    const signal = this.ctl.signal
    let w: FileSystemWritableFileStream | null = null
    try {
      const res = await this.fetcher!(item, signal)
      const fh = await (await this.dir()).getFileHandle(item.id, { create: true })
      w = await fh.createWritable()
      const reader = res.body!.getReader()
      let last = 0
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        await w.write(value)
        st.got += value.byteLength
        this.bytesDone += value.byteLength
        const now = performance.now()
        if (now - last > 250) {
          last = now
          this.emit()
        }
      }
      await w.close()
      w = null
      if (st.got !== item.size && item.size > 0) throw new Error('The download ended early.')
      st.status = 'ready'
      this.manifest[item.id] = { size: item.size, name: item.name }
      setJSON('drive-cache', this.manifest)
    } catch (e) {
      try {
        await w?.abort()
      } catch {
        /* ignore */
      }
      this.bytesDone -= st.got
      if (signal.aborted) this.states.delete(item.id)
      else {
        st.status = 'error'
        st.error = (e as Error).message
      }
    } finally {
      this.running--
      this.emit()
      if (!signal.aborted && this.queue.length) void this.next()
    }
  }

  private forget(id: string) {
    delete this.manifest[id]
    setJSON('drive-cache', this.manifest)
    this.states.delete(id)
    this.emit()
  }

  async clear() {
    this.stop()
    try {
      const root = await navigator.storage.getDirectory()
      await root.removeEntry('drive-cache', { recursive: true })
    } catch {
      /* nothing there */
    }
    this.manifest = {}
    setJSON('drive-cache', this.manifest)
    this.states.clear()
    this.emit()
  }

  subscribe(fn: () => void) {
    this.listeners.add(fn)
    return () => {
      this.listeners.delete(fn)
    }
  }

  emit() {
    for (const l of this.listeners) l()
  }
}

export const driveCache = new DriveCache()
