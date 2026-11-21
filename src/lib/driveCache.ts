// Preloading Drive clips for instant previews. By default it keeps small
// proxies (720p, 480p...) made right here in the browser, so the full-size
// original never has to sit on disk. A space cap keeps the total in check: when
// it fills up, the clips you looked at least recently get removed first.

import type { StreamTargetChunk } from 'mediabunny'
import type { DriveItem } from './drive'
import { getJSON, idbGet, idbSet, setJSON } from './store'

export type Quality = '360' | '480' | '720' | '1080' | 'original'

export const QUALITIES: { id: Quality; label: string; hint: string; bitrate: number; height: number }[] = [
  { id: '360', label: '360p', hint: 'Rough, just to see what is in a clip', bitrate: 800_000, height: 360 },
  { id: '480', label: '480p', hint: 'Fine for picking selects', bitrate: 1_500_000, height: 480 },
  { id: '720', label: '720p', hint: 'Clean on a laptop screen', bitrate: 4_000_000, height: 720 },
  { id: '1080', label: '1080p', hint: 'Sharp enough to judge focus', bitrate: 8_000_000, height: 1080 },
  { id: 'original', label: 'Original', hint: 'Exact file, biggest by far', bitrate: 0, height: 0 },
]

export const CAPS_GB = [2, 5, 10, 20, 50]

export type CacheState = {
  status: 'queued' | 'loading' | 'ready' | 'error'
  progress: number // 0..1
  quality?: Quality
  error?: string
}

type Entry = { stored: number; quality: Quality; name: string; used: number; source: number }
type Settings = { quality: Quality; capGB: number; where: 'browser' | 'folder' }
type Fetcher = (item: DriveItem, signal: AbortSignal, range?: [number, number]) => Promise<Response>

const PARALLEL_ORIGINAL = 2
// Short clips spend most of their time waiting on the network, so a few at once keeps things moving.
const PARALLEL_PROXY = 3
const FILE_PREFIX = 'proxy-'

export function canPreload() {
  return typeof navigator !== 'undefined' && !!navigator.storage?.getDirectory && typeof FileSystemFileHandle !== 'undefined' && 'createWritable' in FileSystemFileHandle.prototype
}

export function canPickProxyFolder() {
  return typeof window !== 'undefined' && 'showDirectoryPicker' in window
}

class DriveCache {
  states = new Map<string, CacheState>()
  settings: Settings = { quality: '720', capGB: 10, where: 'browser', ...getJSON<Partial<Settings>>('preload-settings', {}) }
  folder: FileSystemDirectoryHandle | null = null
  folderNeedsPermission = false
  private queue: DriveItem[] = []
  private running = 0
  private ctl = new AbortController()
  private listeners = new Set<() => void>()
  private manifest: Record<string, Entry> = getJSON('drive-cache-v2', {})
  private fetcher: Fetcher | null = null
  error = ''
  clipsDoneInBatch = 0
  clipsInBatch = 0
  batchStarted = 0
  doneInBatch = 0 // source bytes finished in the current batch
  totalInBatch = 0
  private live = new Map<string, number>() // source bytes in progress, per clip

  constructor() {
    for (const [id, m] of Object.entries(this.manifest)) this.states.set(id, { status: 'ready', progress: 1, quality: m.quality })
    if (this.settings.where === 'folder') void this.restoreFolder()
    void this.dropOldVersion()
  }

  // The first version kept full originals under a different list. Clean those up.
  private async dropOldVersion() {
    const old = getJSON<Record<string, unknown>>('drive-cache', {})
    if (!Object.keys(old).length) return
    try {
      const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('drive-cache', { create: true })
      for (const id of Object.keys(old)) await dir.removeEntry(id).catch(() => {})
    } catch {
      /* ignore */
    }
    setJSON('drive-cache', {})
  }

  setFetcher(f: Fetcher) {
    this.fetcher = f
  }

  // Settings

  setQuality(q: Quality) {
    this.settings.quality = q
    this.saveSettings()
  }

  setCap(gb: number) {
    this.settings.capGB = gb
    this.saveSettings()
    void this.evict()
  }

  async useFolder() {
    const h = await window.showDirectoryPicker({ id: 'handoff-proxies', mode: 'readwrite' })
    await idbSet('proxy-dir', h)
    await this.clearFiles()
    this.folder = h
    this.folderNeedsPermission = false
    this.settings.where = 'folder'
    this.saveSettings()
  }

  async useBrowser() {
    await this.clearFiles()
    this.folder = null
    this.settings.where = 'browser'
    this.saveSettings()
  }

  async regrantFolder() {
    if (!this.folder) return
    if ((await this.folder.requestPermission({ mode: 'readwrite' })) === 'granted') {
      this.folderNeedsPermission = false
      this.emit()
    }
  }

  private async restoreFolder() {
    try {
      const h = await idbGet<FileSystemDirectoryHandle>('proxy-dir')
      if (!h) return
      this.folder = h
      this.folderNeedsPermission = (await h.queryPermission({ mode: 'readwrite' })) !== 'granted'
      this.emit()
    } catch {
      /* ignore */
    }
  }

  private saveSettings() {
    setJSON('preload-settings', this.settings)
    this.emit()
  }

  private async dir(): Promise<FileSystemDirectoryHandle> {
    if (this.settings.where === 'folder') {
      if (!this.folder || this.folderNeedsPermission) throw new Error('Handoff needs access to your preload folder again.')
      return this.folder
    }
    const root = await navigator.storage.getDirectory()
    return root.getDirectoryHandle('drive-cache', { create: true })
  }

  // Reading

  isReady(id: string) {
    return this.states.get(id)?.status === 'ready'
  }

  qualityOf(id: string): Quality | undefined {
    return this.manifest[id]?.quality
  }

  // Any preloaded copy, for previews.
  async file(item: DriveItem): Promise<File | null> {
    const m = this.manifest[item.id]
    if (!m) return null
    try {
      const f = await (await (await this.dir()).getFileHandle(FILE_PREFIX + item.id + (m.quality === 'original' ? '' : '.mp4'))).getFile()
      m.used = Date.now()
      setJSON('drive-cache-v2', this.manifest)
      return f
    } catch {
      this.forget(item.id)
      return null
    }
  }

  // Only a full-quality copy counts when saving.
  async original(item: DriveItem): Promise<File | null> {
    if (this.manifest[item.id]?.quality !== 'original') return null
    const f = await this.file(item)
    return f && f.size === item.size ? f : null
  }

  get usedBytes() {
    return Object.values(this.manifest).reduce((a, m) => a + m.stored, 0)
  }

  get readyCount() {
    return Object.keys(this.manifest).length
  }

  private preparing = false

  get busy() {
    return this.preparing || this.running > 0 || this.queue.length > 0
  }

  get pendingCount() {
    return this.queue.length + this.running
  }

  get batchProgress() {
    let live = 0
    for (const v of this.live.values()) live += v
    return this.totalInBatch ? Math.min(1, (this.doneInBatch + live) / this.totalInBatch) : 0
  }

  // Seconds left in the current batch, based on how fast it's gone so far.
  get secondsLeft() {
    const p = this.batchProgress
    const elapsed = (performance.now() - this.batchStarted) / 1000
    if (p < 0.02 || elapsed < 5) return NaN
    return (elapsed / p) * (1 - p)
  }

  // Move a clip to the front of the line, e.g. when you open it.
  prioritize(item: DriveItem) {
    if (this.isReady(item.id) || this.states.get(item.id)?.status === 'loading') return
    const i = this.queue.findIndex((q) => q.id === item.id)
    if (i > 0) {
      this.queue.splice(i, 1)
      this.queue.unshift(item)
      this.emit()
    }
  }

  // Work queue

  async enqueue(items: DriveItem[]) {
    this.error = ''
    const q = this.settings.quality
    const todo = items.filter(
      (i) =>
        !i.isFolder &&
        !i.isGoogleDoc &&
        !(this.isReady(i.id) && this.manifest[i.id]?.quality === q) &&
        !this.queue.some((x) => x.id === i.id) &&
        this.states.get(i.id)?.status !== 'loading',
    )
    if (!todo.length) {
      this.emit()
      return
    }
    if (q !== 'original') {
      this.preparing = true
      this.emit()
      const { canEncodeVideo } = await import('mediabunny')
      const ok = await canEncodeVideo('avc').catch(() => false)
      this.preparing = false
      if (!ok) {
        this.error = "This browser can't make small copies. Update it, or switch the quality to Original."
        this.emit()
        return
      }
    }
    try {
      await navigator.storage.persist?.()
    } catch {
      /* fine */
    }
    if (this.running === 0 && this.queue.length === 0) {
      this.doneInBatch = 0
      this.totalInBatch = 0
      this.clipsDoneInBatch = 0
      this.clipsInBatch = 0
      this.batchStarted = performance.now()
      this.ctl = new AbortController()
    }
    for (const i of todo) {
      this.states.set(i.id, { status: 'queued', progress: 0 })
      this.queue.push(i)
      this.totalInBatch += i.size
      this.clipsInBatch++
    }
    this.emit()
    this.pump()
  }

  private pump() {
    const limit = this.settings.quality === 'original' ? PARALLEL_ORIGINAL : PARALLEL_PROXY
    while (this.running < limit && this.queue.length) void this.next()
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
    const quality = this.settings.quality
    const st: CacheState = { status: 'loading', progress: 0 }
    this.states.set(item.id, st)
    this.emit()
    const signal = this.ctl.signal
    const name = FILE_PREFIX + item.id + (quality === 'original' ? '' : '.mp4')
    let w: FileSystemWritableFileStream | null = null
    let dirRef: FileSystemDirectoryHandle | null = null
    let last = 0
    const tick = (p: number) => {
      st.progress = p
      this.live.set(item.id, p * item.size)
      const now = performance.now()
      if (now - last > 250) {
        last = now
        this.emit()
      }
    }
    try {
      const dir = await this.dir()
      dirRef = dir
      const fh = await dir.getFileHandle(name, { create: true })
      w = await fh.createWritable()
      if (quality === 'original') await this.copyOriginal(item, w, signal, tick)
      else await this.makeProxy(item, w, quality, signal, tick)
      await w.close()
      w = null
      const stored = (await fh.getFile()).size
      // Replace any older copy at a different quality.
      const old = this.manifest[item.id]
      if (old && old.quality !== quality) {
        try {
          await dir.removeEntry(FILE_PREFIX + item.id + (old.quality === 'original' ? '' : '.mp4'))
        } catch {
          /* ignore */
        }
      }
      this.manifest[item.id] = { stored, quality, name: item.name, used: Date.now(), source: item.size }
      setJSON('drive-cache-v2', this.manifest)
      st.status = 'ready'
      st.progress = 1
      st.quality = quality
      await this.evict(item.id)
    } catch (e) {
      try {
        await w?.abort()
      } catch {
        /* ignore */
      }
      if (!this.manifest[item.id] || this.manifest[item.id].quality !== quality) await dirRef?.removeEntry(name).catch(() => {})
      if (signal.aborted) this.states.delete(item.id)
      else {
        st.status = 'error'
        st.error = friendly(e)
      }
    } finally {
      this.live.delete(item.id)
      this.doneInBatch += item.size
      this.clipsDoneInBatch++
      this.running--
      this.emit()
      if (!signal.aborted) this.pump()
    }
  }

  private async copyOriginal(item: DriveItem, w: FileSystemWritableFileStream, signal: AbortSignal, tick: (p: number) => void) {
    const res = await this.fetcher!(item, signal)
    const reader = res.body!.getReader()
    let got = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      await w.write(value)
      got += value.byteLength
      tick(item.size ? got / item.size : 1)
    }
    if (item.size && got !== item.size) throw new Error('The download ended early.')
  }

  private async makeProxy(item: DriveItem, w: FileSystemWritableFileStream, quality: Quality, signal: AbortSignal, tick: (p: number) => void) {
    const q = QUALITIES.find((x) => x.id === quality)!
    // Loaded only when needed, since it's a big chunk of code.
    const { ALL_FORMATS, BlobSource, Conversion, CustomSource, Input, Mp4OutputFormat, Output, StreamTarget, canEncodeAudio } = await import('mediabunny')
    // Read the clip from Drive in pieces as the converter needs them. If a full-size
    // copy is already preloaded, read that instead.
    const local = await this.original(item)
    const source = local
      ? new BlobSource(local)
      : new CustomSource({
          getSize: () => item.size,
          read: async (start, end) => {
            const res = await this.fetcher!(item, signal, [start, end])
            if (res.status !== 206) {
              await res.body?.cancel()
              throw new Error("Google didn't allow reading this clip in pieces.")
            }
            return new Uint8Array(await res.arrayBuffer())
          },
          maxCacheSize: 32 * 1024 * 1024,
          prefetchProfile: 'network',
        })
    const input = new Input({ source, formats: ALL_FORMATS })
    const writable = new WritableStream<StreamTargetChunk>({
      write: (chunk) => w.write({ type: 'write', position: chunk.position, data: chunk.data }),
    })
    const output = new Output({ format: new Mp4OutputFormat({ fastStart: false }), target: new StreamTarget(writable, { chunked: true, chunkSize: 4 * 1024 * 1024 }) })
    const audioCodec = (await canEncodeAudio('aac').catch(() => false)) ? 'aac' : 'opus'
    const conversion = await Conversion.init({
      input,
      output,
      video: { height: q.height, codec: 'avc', bitrate: q.bitrate, fit: 'contain' },
      audio: { codec: audioCodec, bitrate: 128_000, numberOfChannels: 2 },
    })
    const videoLost = conversion.discardedTracks.find((d) => d.track.type === 'video')
    if (!conversion.isValid || videoLost) {
      input.dispose?.()
      throw new Error("This clip's format can't be shrunk in a browser. Its preview uses Google's copy.")
    }
    const onAbort = () => void conversion.cancel()
    signal.addEventListener('abort', onAbort)
    conversion.onProgress = (p) => tick(p)
    try {
      await conversion.execute()
    } finally {
      signal.removeEventListener('abort', onAbort)
      input.dispose?.()
    }
  }

  // Keeps total storage under the cap by removing the least recently viewed clips.
  private async evict(keep?: string) {
    const cap = this.settings.capGB * 1e9
    const entries = Object.entries(this.manifest).sort((a, b) => a[1].used - b[1].used)
    let used = this.usedBytes
    let dir: FileSystemDirectoryHandle | null = null
    try {
      dir = await this.dir()
    } catch {
      return
    }
    for (const [id, m] of entries) {
      if (used <= cap) break
      if (id === keep && entries.length > 1) continue
      try {
        await dir.removeEntry(FILE_PREFIX + id + (m.quality === 'original' ? '' : '.mp4'))
      } catch {
        /* already gone */
      }
      used -= m.stored
      delete this.manifest[id]
      this.states.delete(id)
    }
    setJSON('drive-cache-v2', this.manifest)
    this.emit()
  }

  private forget(id: string) {
    delete this.manifest[id]
    setJSON('drive-cache-v2', this.manifest)
    this.states.delete(id)
    this.emit()
  }

  private async clearFiles() {
    this.stop()
    try {
      const dir = await this.dir()
      for (const id of Object.keys(this.manifest)) {
        const m = this.manifest[id]
        await dir.removeEntry(FILE_PREFIX + id + (m.quality === 'original' ? '' : '.mp4')).catch(() => {})
      }
    } catch {
      /* folder not reachable */
    }
    this.manifest = {}
    setJSON('drive-cache-v2', this.manifest)
    this.states.clear()
  }

  async clear() {
    await this.clearFiles()
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

function friendly(e: unknown) {
  const m = String((e as Error)?.message || e)
  if (/quota|QuotaExceeded/i.test(m)) return 'Not enough space left for this clip.'
  return m
}

export const driveCache = new DriveCache()
