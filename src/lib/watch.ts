// Teammate side of watch links. Connects to the editor's computer, lists the
// footage there, and streams it into a normal <video> player via the service worker.

import type Peer from 'peerjs'
import type { DataConnection } from 'peerjs'
import { makePeer } from './peer'
import { PEER_PREFIX, type LibItem, type LibraryMsg, type LiveSend, type ViewerMsg } from './protocol'
import { downloadStream, prepareDownloads } from './download'

export type WatchStatus = 'connecting' | 'offline' | 'unreachable' | 'ok' | 'off' | 'badkey' | 'zip' | 'nofolder'

export interface WatchView {
  status: WatchStatus
  editorName: string
  items: LibItem[] | null
  live: LiveSend[]
}

type Pending = {
  resolve: (v: any) => void
  reject: (e: Error) => void
  header?: { size: number; start: number; end: number }
  parts: Uint8Array[]
}

const TYPES: Record<string, string> = { mov: 'video/mp4', mp4: 'video/mp4', m4v: 'video/mp4', webm: 'video/webm', mkv: 'video/webm', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' }

export class Watcher {
  view: WatchView
  private peer: Peer | null = null
  private conn: DataConnection | null = null
  private rid = 1
  private pending = new Map<number, Pending>()
  private listeners = new Set<() => void>()
  private destroyed = false
  private poll: ReturnType<typeof setInterval> | null = null
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private files = new Map<string, LibItem>()

  constructor(
    private editorId: string,
    private key: string,
    editorName: string,
  ) {
    this.view = { status: 'connecting', editorName, items: null, live: [] }
  }

  start() {
    void prepareDownloads()
    navigator.serviceWorker?.addEventListener('message', this.onWorkerMessage)
    const peer = makePeer()
    this.peer = peer
    peer.on('open', () => this.connect())
    peer.on('error', (err: Error & { type?: string }) => {
      if (this.destroyed) return
      if (err.type === 'peer-unavailable') this.set({ status: 'offline' })
      this.retry(err.type === 'peer-unavailable' ? 5000 : 4000)
    })
    peer.on('disconnected', () => !this.destroyed && setTimeout(() => !peer.destroyed && peer.reconnect(), 2000))
    this.poll = setInterval(() => {
      if (this.view.status === 'ok') void this.refresh()
    }, 15000)
  }

  destroy() {
    this.destroyed = true
    if (this.poll) clearInterval(this.poll)
    navigator.serviceWorker?.removeEventListener('message', this.onWorkerMessage)
    this.peer?.destroy()
  }

  private retry(ms: number) {
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.retryTimer = setTimeout(() => !this.destroyed && this.peer?.open && this.connect(), ms)
  }

  private connect() {
    if (this.conn?.open) return
    this.conn?.close()
    const conn = this.peer!.connect(PEER_PREFIX + this.editorId, { reliable: true, serialization: 'raw', metadata: { role: 'viewer', key: this.key } })
    this.conn = conn
    let opened = false
    const t = setTimeout(() => {
      if (!opened) {
        conn.close()
        this.set({ status: 'unreachable' })
        this.retry(6000)
      }
    }, 20000)
    conn.on('open', () => {
      opened = true
      clearTimeout(t)
    })
    conn.on('data', (d) => this.onData(d as string | ArrayBuffer))
    const lost = () => {
      clearTimeout(t)
      if (this.conn !== conn || this.destroyed) return
      for (const p of this.pending.values()) p.reject(new Error('Lost the connection'))
      this.pending.clear()
      if (this.view.status === 'ok' || this.view.status === 'connecting') this.set({ status: 'connecting' })
      this.retry(3000)
    }
    conn.on('close', lost)
    conn.on('error', lost)
  }

  private onData(d: string | ArrayBuffer) {
    if (typeof d !== 'string') {
      const rid = new DataView(d).getUint32(0, true)
      this.pending.get(rid)?.parts.push(new Uint8Array(d, 4))
      return
    }
    const m = JSON.parse(d) as LibraryMsg
    if (m.t === 'v-hello') {
      this.view.editorName = m.name || this.view.editorName
      this.set({ status: m.status === 'ok' ? 'ok' : m.status })
      if (m.status === 'ok') void this.refresh()
      return
    }
    const p = this.pending.get(m.rid)
    if (!p) return
    if (m.t === 'v-err') {
      this.pending.delete(m.rid)
      p.reject(new Error(m.message))
    } else if (m.t === 'v-read') {
      p.header = { size: m.size, start: m.start, end: m.end }
    } else if (m.t === 'v-end') {
      this.pending.delete(m.rid)
      const total = p.parts.reduce((a, x) => a + x.byteLength, 0)
      const buf = new Uint8Array(total)
      let o = 0
      for (const x of p.parts) {
        buf.set(x, o)
        o += x.byteLength
      }
      p.resolve({ ...p.header!, buf })
    } else {
      this.pending.delete(m.rid)
      p.resolve(m)
    }
  }

  private ask<T>(m: Omit<ViewerMsg, 'rid'>): Promise<T> {
    if (!this.conn?.open) return Promise.reject(new Error('Not connected'))
    const rid = this.rid++
    return new Promise<T>((resolve, reject) => {
      this.pending.set(rid, { resolve, reject, parts: [] })
      this.conn!.send(JSON.stringify({ ...m, rid }))
    })
  }

  async refresh() {
    try {
      const r = await this.ask<{ items: LibItem[]; live: LiveSend[] }>({ t: 'v-list' })
      for (const it of r.items) this.files.set(it.path, it)
      this.set({ items: r.items, live: r.live })
    } catch {
      /* will retry on the next poll */
    }
  }

  thumb(path: string) {
    return this.ask<{ jpeg: string; duration: number }>({ t: 'v-thumb', path } as Omit<ViewerMsg, 'rid'>)
  }

  read(path: string, start: number, end: number) {
    return this.ask<{ size: number; start: number; end: number; buf: Uint8Array }>({ t: 'v-read', path, start, end } as Omit<ViewerMsg, 'rid'>)
  }

  // The URL a <video> element can play from.
  streamUrl(item: LibItem) {
    const id = encodeURIComponent(btoa(unescape(encodeURIComponent(item.path))).replace(/=+$/, ''))
    return `/__handoff_stream/${id}`
  }

  private onWorkerMessage = async (e: MessageEvent) => {
    const d = e.data
    if (!d || d.type !== 'handoff-range') return
    const port = e.ports[0]
    try {
      const raw = decodeURIComponent(d.fileId)
      const path = decodeURIComponent(escape(atob(raw + '='.repeat((4 - (raw.length % 4)) % 4))))
      const r = await this.read(path, d.start, d.end)
      const ext = path.split('.').pop()?.toLowerCase() || ''
      const buf = r.buf.buffer.slice(r.buf.byteOffset, r.buf.byteOffset + r.buf.byteLength)
      port.postMessage({ ...r, buf, type: TYPES[ext] || 'application/octet-stream' }, [buf])
    } catch (err) {
      port.postMessage({ error: String((err as Error).message || err) })
    }
  }

  async save(item: LibItem, onProgress: (bytes: number) => void) {
    const out = (await downloadStream(item.name)).getWriter()
    const STEP = 4 * 1024 * 1024
    let off = 0
    try {
      while (off < item.size) {
        const r = await this.read(item.path, off, Math.min(item.size, off + STEP))
        if (r.buf.byteLength === 0) throw new Error('Got an empty piece')
        await out.write(r.buf)
        off += r.buf.byteLength
        onProgress(off)
      }
      await out.close()
    } catch (e) {
      await out.abort().catch(() => {})
      throw e
    }
  }

  private set(p: Partial<WatchView>) {
    Object.assign(this.view, p)
    for (const l of this.listeners) l()
  }

  subscribe(fn: () => void) {
    this.listeners.add(fn)
    return () => {
      this.listeners.delete(fn)
    }
  }

  snapshot(): WatchView {
    return { ...this.view }
  }
}
