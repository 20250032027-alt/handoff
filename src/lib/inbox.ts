// Editor side. Owns the editor's permanent peer id, the destination folder, and
// one IncomingSession per connected shooter.

import type Peer from 'peerjs'
import type { DataConnection } from 'peerjs'
import { createXXHash64, type IHasher } from 'hash-wasm'
import { makePeer } from './peer'
import { PEER_PREFIX, WRITE_BLOCK, type EditorMsg, type ManifestFile, type SenderMsg } from './protocol'
import { safePath, safeSegment } from './files'
import { SpeedMeter } from './format'
import { getJSON, setJSON } from './store'

export type SessionStatus =
  | 'connected'
  | 'asking'
  | 'receiving'
  | 'done'
  | 'declined'
  | 'cancelled'
  | 'dropped'

export interface SessionView {
  key: string
  name: string
  clientId: string
  status: SessionStatus
  label: string
  folder: string
  totalFiles: number
  totalBytes: number
  filesDone: number
  filesSkipped: number
  bytesDone: number
  current: string
  speed: number
  failed: string[]
  startedAt: number
  finishedAt: number
}

export interface HistoryItem {
  name: string
  folder: string
  files: number
  bytes: number
  failed: number
  at: number
}

type Listener = () => void

interface Batch {
  batchId: string
  label: string
  date: string
  files: ManifestFile[]
  byId: Map<number, ManifestFile>
  root: string[]
}

class IncomingSession {
  view: SessionView
  private queue: (string | ArrayBuffer)[] = []
  private qi = 0
  private pumping = false
  private batch: Batch | null = null
  private cur: {
    id: number
    writable: FileSystemWritableFileStream
    handle: FileSystemFileHandle
    dir: FileSystemDirectoryHandle
    name: string
    received: number
    parts: Uint8Array[]
    partsLen: number
  } | null = null
  private hasher: IHasher | null = null
  private meter = new SpeedMeter()
  private skippedBytes = 0

  constructor(
    private inbox: Inbox,
    readonly conn: DataConnection,
  ) {
    const meta = (conn.metadata || {}) as { name?: string; clientId?: string }
    this.view = {
      key: conn.connectionId,
      name: meta.name || 'Someone',
      clientId: meta.clientId || '',
      status: 'connected',
      label: '',
      folder: '',
      totalFiles: 0,
      totalBytes: 0,
      filesDone: 0,
      filesSkipped: 0,
      bytesDone: 0,
      current: '',
      speed: 0,
      failed: [],
      startedAt: 0,
      finishedAt: 0,
    }
    conn.on('data', (d) => {
      this.queue.push(d as string | ArrayBuffer)
      if (!this.pumping) void this.pump()
    })
    conn.on('close', () => this.onClose())
    conn.on('error', () => this.onClose())
  }

  send(msg: EditorMsg) {
    if (this.conn.open) this.conn.send(JSON.stringify(msg))
  }

  sayHello() {
    this.send({ t: 'hello', name: this.inbox.editorName, ready: !!this.inbox.dir })
  }

  private async pump() {
    this.pumping = true
    try {
      while (this.qi < this.queue.length) {
        const msg = this.queue[this.qi]
        this.queue[this.qi++] = '' // drop reference so memory can be freed
        if (this.qi > 4096) {
          this.queue = this.queue.slice(this.qi)
          this.qi = 0
        }
        if (typeof msg === 'string') await this.onControl(JSON.parse(msg) as SenderMsg)
        else await this.onBytes(msg)
      }
    } catch (err) {
      console.error(err)
      this.send({ t: 'error', message: String((err as Error)?.message || err) })
      await this.abortCurrent()
    } finally {
      this.pumping = false
    }
  }

  private async onControl(msg: SenderMsg) {
    switch (msg.t) {
      case 'hi':
        this.view.name = msg.name || this.view.name
        this.view.clientId = msg.clientId || this.view.clientId
        this.sayHello()
        this.changed()
        return
      case 'manifest':
        return this.onManifest(msg)
      case 'file':
        return this.openFile(msg.id)
      case 'end':
        return this.closeFile(msg.id, msg.hash)
      case 'finished':
        this.view.status = 'done'
        this.view.current = ''
        this.view.finishedAt = Date.now()
        this.inbox.addHistory({
          name: this.view.name,
          folder: this.view.folder,
          files: this.view.filesDone + this.view.filesSkipped,
          bytes: this.view.totalBytes,
          failed: this.view.failed.length,
          at: Date.now(),
        })
        this.changed()
        this.inbox.notify(`${this.view.name} finished sending`, `${this.view.filesDone + this.view.filesSkipped} files are in ${this.view.folder}`)
        return
      case 'cancel':
        await this.abortCurrent()
        this.view.status = 'cancelled'
        this.changed()
        return
    }
  }

  private async onManifest(msg: Extract<SenderMsg, { t: 'manifest' }>) {
    if (!this.inbox.dir) {
      this.sayHello()
      return
    }
    const sub = safeSegment(`${msg.date}${msg.label ? ' ' + msg.label : ''}`)
    const root = [safeSegment(this.view.name), sub]
    this.batch = {
      batchId: msg.batchId,
      label: msg.label,
      date: msg.date,
      files: msg.files,
      byId: new Map(msg.files.map((f) => [f.id, f])),
      root,
    }
    this.view.label = msg.label
    this.view.folder = [this.inbox.dir.name, ...root].join(' / ')
    this.view.totalFiles = msg.files.length
    this.view.totalBytes = msg.files.reduce((a, f) => a + f.size, 0)
    if (this.inbox.isApproved(this.view.clientId, msg.batchId)) {
      await this.accept(false)
    } else {
      this.view.status = 'asking'
      this.changed()
      this.inbox.notify(`${this.view.name} wants to send footage`, 'Open Handoff to accept it.')
    }
  }

  async accept(always: boolean) {
    if (!this.batch || !this.inbox.dir) return
    this.inbox.approve(this.view.clientId, this.batch.batchId, always ? this.view.name : null)
    // Anything already on disk at the same size is skipped. This is what makes
    // resuming after a dropped connection work.
    const skip: number[] = []
    this.skippedBytes = 0
    for (const f of this.batch.files) {
      const existing = await this.existingSize(f.path)
      if (existing === f.size) {
        skip.push(f.id)
        this.skippedBytes += f.size
      }
    }
    this.view.filesSkipped = skip.length
    this.view.filesDone = 0
    this.view.bytesDone = this.skippedBytes
    this.view.failed = []
    this.view.status = 'receiving'
    this.view.startedAt = Date.now()
    this.meter.reset()
    this.send({ t: 'plan', skip })
    this.changed()
  }

  decline() {
    this.view.status = 'declined'
    this.send({ t: 'declined' })
    this.changed()
  }

  private async dirFor(parts: string[], create: boolean): Promise<FileSystemDirectoryHandle> {
    let d = this.inbox.dir!
    for (const p of [...this.batch!.root, ...parts]) d = await d.getDirectoryHandle(p, { create })
    return d
  }

  private async existingSize(path: string): Promise<number> {
    try {
      const parts = safePath(path)
      const name = parts.pop()!
      const d = await this.dirFor(parts, false)
      const fh = await d.getFileHandle(name)
      return (await fh.getFile()).size
    } catch {
      return -1
    }
  }

  private async openFile(id: number) {
    const f = this.batch?.byId.get(id)
    if (!f) throw new Error('Unknown file ' + id)
    await this.abortCurrent()
    const parts = safePath(f.path)
    const name = parts.pop() || 'file'
    const dir = await this.dirFor(parts, true)
    const handle = await dir.getFileHandle(name, { create: true })
    const writable = await handle.createWritable({ keepExistingData: false })
    if (!this.hasher) this.hasher = await createXXHash64()
    this.hasher.init()
    this.cur = { id, writable, handle, dir, name, received: 0, parts: [], partsLen: 0 }
    this.view.current = f.path
    this.changed()
  }

  private async onBytes(buf: ArrayBuffer) {
    const c = this.cur
    if (!c) return
    const u8 = new Uint8Array(buf)
    this.hasher!.update(u8)
    c.parts.push(u8)
    c.partsLen += u8.byteLength
    c.received += u8.byteLength
    this.view.bytesDone += u8.byteLength
    if (c.partsLen >= WRITE_BLOCK) await this.flush()
  }

  private async flush() {
    const c = this.cur
    if (!c || c.partsLen === 0) return
    const block = new Uint8Array(c.partsLen)
    let o = 0
    for (const p of c.parts) {
      block.set(p, o)
      o += p.byteLength
    }
    c.parts = []
    c.partsLen = 0
    await c.writable.write(block)
    this.send({ t: 'ack', id: c.id, bytes: c.received })
    this.meter.add(this.view.bytesDone)
    this.view.speed = this.meter.rate
    this.changed()
  }

  private async closeFile(id: number, hash: string) {
    const c = this.cur
    if (!c || c.id !== id) return
    await this.flush()
    await c.writable.close()
    this.cur = null
    const ok = this.hasher!.digest('hex') === hash
    const path = this.batch?.byId.get(id)?.path || c.name
    if (ok) {
      this.view.filesDone++
      this.view.failed = this.view.failed.filter((p) => p !== path)
    } else {
      if (!this.view.failed.includes(path)) this.view.failed.push(path)
      try {
        await c.dir.removeEntry(c.name)
      } catch {
        /* ignore */
      }
      this.view.bytesDone -= c.received
    }
    this.send({ t: 'done', id, ok })
    this.changed()
  }

  private async abortCurrent() {
    const c = this.cur
    if (!c) return
    this.cur = null
    this.view.bytesDone -= c.received
    try {
      await c.writable.abort()
    } catch {
      /* ignore */
    }
  }

  private async onClose() {
    await this.abortCurrent()
    if (this.view.status === 'receiving' || this.view.status === 'asking' || this.view.status === 'connected') {
      this.view.status = 'dropped'
    }
    this.view.speed = 0
    this.changed()
  }

  private changed() {
    this.inbox.emit()
  }
}

export class Inbox {
  peer: Peer | null = null
  dir: FileSystemDirectoryHandle | null = null
  editorName = ''
  status: 'starting' | 'online' | 'reconnecting' | 'taken' | 'error' = 'starting'
  error = ''
  sessions = new Map<string, IncomingSession>()
  history: HistoryItem[] = getJSON('history', [])
  private trusted: Record<string, string> = getJSON('trusted', {})
  private approvedBatches = new Set<string>()
  private listeners = new Set<Listener>()
  private emitScheduled = false
  private destroyed = false

  constructor(readonly id: string) {}

  start() {
    const peer = makePeer(PEER_PREFIX + this.id)
    this.peer = peer
    peer.on('open', () => {
      this.status = 'online'
      this.emit()
    })
    peer.on('connection', (conn) => {
      const s = new IncomingSession(this, conn)
      conn.on('open', () => {
        // A reconnect from the same shooter replaces their old, dropped row.
        for (const [k, old] of this.sessions) {
          if (old.view.clientId && old.view.clientId === s.view.clientId && old.view.status !== 'done') {
            this.sessions.delete(k)
          }
        }
        this.sessions.set(s.view.key, s)
        this.emit()
      })
    })
    peer.on('disconnected', () => {
      if (this.destroyed) return
      this.status = 'reconnecting'
      this.emit()
      setTimeout(() => !this.destroyed && !peer.destroyed && peer.reconnect(), 2000)
    })
    peer.on('error', (err: Error & { type?: string }) => {
      if (err.type === 'unavailable-id') {
        this.status = 'taken'
      } else if (err.type === 'network' || err.type === 'server-error' || err.type === 'socket-error') {
        this.status = 'reconnecting'
        setTimeout(() => {
          if (!this.destroyed && peer.disconnected && !peer.destroyed) peer.reconnect()
        }, 4000)
      } else if (err.type !== 'peer-unavailable') {
        this.status = 'error'
        this.error = err.message
      }
      this.emit()
    })
  }

  destroy() {
    this.destroyed = true
    this.peer?.destroy()
  }

  setDir(dir: FileSystemDirectoryHandle | null) {
    this.dir = dir
    for (const s of this.sessions.values()) s.sayHello()
    this.emit()
  }

  setName(name: string) {
    this.editorName = name
    for (const s of this.sessions.values()) s.sayHello()
  }

  session(key: string) {
    return this.sessions.get(key)
  }

  dismiss(key: string) {
    this.sessions.delete(key)
    this.emit()
  }

  isApproved(clientId: string, batchId: string) {
    return this.approvedBatches.has(batchId) || (!!clientId && clientId in this.trusted)
  }

  approve(clientId: string, batchId: string, rememberAs: string | null) {
    this.approvedBatches.add(batchId)
    if (rememberAs && clientId) {
      this.trusted[clientId] = rememberAs
      setJSON('trusted', this.trusted)
    }
  }

  get trustedNames() {
    return Object.entries(this.trusted).map(([id, name]) => ({ id, name }))
  }

  forget(clientId: string) {
    delete this.trusted[clientId]
    setJSON('trusted', this.trusted)
    this.emit()
  }

  addHistory(item: HistoryItem) {
    this.history = [item, ...this.history].slice(0, 50)
    setJSON('history', this.history)
  }

  notify(title: string, body: string) {
    try {
      if (document.hidden && 'Notification' in window && Notification.permission === 'granted') {
        new Notification(title, { body, icon: '/favicon.svg' })
      }
    } catch {
      /* ignore */
    }
  }

  subscribe(fn: Listener) {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  // Coalesce updates so a fast transfer doesn't re-render hundreds of times a second.
  emit() {
    if (this.emitScheduled) return
    this.emitScheduled = true
    setTimeout(() => {
      this.emitScheduled = false
      for (const l of this.listeners) l()
    }, 150)
  }

  snapshot(): SessionView[] {
    return Array.from(this.sessions.values()).map((s) => ({ ...s.view, failed: [...s.view.failed] }))
  }
}
