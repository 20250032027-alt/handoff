// Shooter side. Connects to the editor's permanent id, sends a manifest, then
// streams each file in order. Reconnects and resumes on its own.

import type Peer from 'peerjs'
import type { DataConnection } from 'peerjs'
import { createXXHash64, type IHasher } from 'hash-wasm'
import { makePeer } from './peer'
import {
  CHANNEL_HIGH_WATER,
  CHANNEL_LOW_WATER,
  CHUNK,
  MAX_IN_FLIGHT,
  PEER_PREFIX,
  READ_BLOCK,
  type EditorMsg,
  type ManifestFile,
  type SenderMsg,
} from './protocol'
import type { PickedFile } from './files'
import { SpeedMeter, today } from './format'
import { randomId } from './store'

export type OutStatus =
  | 'connecting'
  | 'offline' // editor's tab isn't open
  | 'unreachable' // couldn't open a direct connection
  | 'no-folder' // editor is online but hasn't picked a folder
  | 'ready'
  | 'asking'
  | 'sending'
  | 'reconnecting'
  | 'done'
  | 'declined'

export interface FileState {
  path: string
  size: number
  state: 'waiting' | 'sending' | 'done' | 'skipped' | 'failed'
}

export interface OutView {
  status: OutStatus
  editorName: string
  files: FileState[]
  totalBytes: number
  bytesDone: number
  current: number
  speed: number
  error: string
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export class Outbox {
  view: OutView
  private peer: Peer | null = null
  private conn: DataConnection | null = null
  private picked: PickedFile[] = []
  private manifest: ManifestFile[] = []
  private batchId = ''
  private label = ''
  private date = today()
  private gen = 0 // bumps on every new connection, so old loops stop
  private acked = 0
  private ackWaiter: (() => void) | null = null
  private doneWaiter: ((ok: boolean) => void) | null = null
  private hasher: IHasher | null = null
  private meter = new SpeedMeter()
  private listeners = new Set<() => void>()
  private emitScheduled = false
  private destroyed = false
  private wantSend = false
  private retryTimer: ReturnType<typeof setTimeout> | null = null

  constructor(
    private editorId: string,
    private myName: () => string,
    private clientId: string,
    editorName: string,
  ) {
    this.view = {
      status: 'connecting',
      editorName,
      files: [],
      totalBytes: 0,
      bytesDone: 0,
      current: -1,
      speed: 0,
      error: '',
    }
  }

  start() {
    const peer = makePeer()
    this.peer = peer
    peer.on('open', () => this.connect())
    peer.on('error', (err: Error & { type?: string }) => {
      if (this.destroyed) return
      if (err.type === 'peer-unavailable') {
        this.set({ status: this.isMidTransfer() ? 'reconnecting' : 'offline' })
        this.retry(4000)
      } else if (err.type === 'network' || err.type === 'server-error' || err.type === 'socket-error' || err.type === 'disconnected') {
        this.set({ status: this.isMidTransfer() ? 'reconnecting' : 'connecting' })
        setTimeout(() => {
          if (!this.destroyed && peer.disconnected && !peer.destroyed) peer.reconnect()
        }, 3000)
      } else {
        this.set({ error: err.message })
        this.retry(5000)
      }
    })
    peer.on('disconnected', () => {
      if (this.destroyed) return
      setTimeout(() => !this.destroyed && !peer.destroyed && peer.reconnect(), 2000)
    })
  }

  destroy() {
    this.destroyed = true
    this.gen++
    this.peer?.destroy()
  }

  private isMidTransfer() {
    return this.wantSend && this.view.status !== 'done' && this.view.status !== 'declined'
  }

  private retry(ms: number) {
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      if (!this.destroyed && this.peer?.open) this.connect()
    }, ms)
  }

  private connect() {
    if (this.destroyed || !this.peer) return
    if (this.conn?.open) return
    this.conn?.close()
    const gen = ++this.gen
    const conn = this.peer.connect(PEER_PREFIX + this.editorId, {
      reliable: true,
      serialization: 'raw',
      metadata: { name: this.myName(), clientId: this.clientId },
    })
    this.conn = conn
    let opened = false
    // If ICE can't find a route the connection just never opens. Give it a while.
    const timeout = setTimeout(() => {
      if (!opened && gen === this.gen) {
        conn.close()
        this.set({ status: 'unreachable' })
        this.retry(6000)
      }
    }, 20000)
    conn.on('open', () => {
      opened = true
      clearTimeout(timeout)
      if (gen !== this.gen) return
      conn.dataChannel.bufferedAmountLowThreshold = CHANNEL_LOW_WATER
      this.send({ t: 'hi', name: this.myName(), clientId: this.clientId })
    })
    conn.on('data', (d) => {
      if (gen !== this.gen || typeof d !== 'string') return
      this.onMessage(JSON.parse(d) as EditorMsg)
    })
    const lost = () => {
      clearTimeout(timeout)
      if (gen !== this.gen || this.destroyed) return
      this.gen++ // stops the send loop
      this.ackWaiter?.()
      this.doneWaiter?.(false)
      if (this.view.status === 'done' || this.view.status === 'declined') return
      this.set({ status: this.isMidTransfer() ? 'reconnecting' : 'connecting', speed: 0 })
      this.retry(2500)
    }
    conn.on('close', lost)
    conn.on('error', lost)
  }

  private send(msg: SenderMsg) {
    if (this.conn?.open) this.conn.send(JSON.stringify(msg))
  }

  private onMessage(msg: EditorMsg) {
    switch (msg.t) {
      case 'hello':
        this.view.editorName = msg.name || this.view.editorName
        if (!msg.ready) {
          this.set({ status: 'no-folder' })
        } else if (this.wantSend && this.view.status !== 'done') {
          this.sendManifest()
        } else if (this.view.status !== 'done') {
          this.set({ status: 'ready' })
        }
        return
      case 'plan':
        void this.run(new Set(msg.skip), this.gen)
        return
      case 'declined':
        this.wantSend = false
        this.set({ status: 'declined' })
        return
      case 'ack':
        this.acked = msg.bytes
        this.ackWaiter?.()
        return
      case 'done':
        this.doneWaiter?.(msg.ok)
        return
      case 'error':
        this.set({ error: msg.message })
        return
    }
  }

  setFiles(picked: PickedFile[]) {
    this.picked = picked
    this.manifest = picked.map((p, id) => ({ id, path: p.path, size: p.file.size, lastModified: p.file.lastModified }))
    this.view.files = picked.map((p) => ({ path: p.path, size: p.file.size, state: 'waiting' }))
    this.view.totalBytes = picked.reduce((a, p) => a + p.file.size, 0)
    this.view.bytesDone = 0
    this.view.current = -1
    this.emit()
  }

  begin(label: string) {
    this.label = label.trim()
    this.batchId = randomId(12)
    this.date = today()
    this.wantSend = true
    this.sendManifest()
  }

  cancel() {
    this.send({ t: 'cancel' })
    this.wantSend = false
    this.gen++
    this.ackWaiter?.()
    this.doneWaiter?.(false)
    this.conn?.close()
    this.view.files = []
    this.picked = []
    this.set({ status: 'connecting', current: -1, bytesDone: 0, totalBytes: 0, speed: 0 })
    this.retry(500)
  }

  reset() {
    this.wantSend = false
    this.picked = []
    this.manifest = []
    this.view.files = []
    this.set({ status: this.conn?.open ? 'ready' : 'connecting', current: -1, bytesDone: 0, totalBytes: 0, speed: 0, error: '' })
  }

  private sendManifest() {
    if (!this.conn?.open) return
    this.set({ status: 'asking' })
    this.send({ t: 'manifest', batchId: this.batchId, label: this.label, date: this.date, files: this.manifest })
  }

  private waitAck(): Promise<void> {
    return new Promise((r) => (this.ackWaiter = r))
  }

  private waitChannel(dc: RTCDataChannel): Promise<void> {
    return new Promise((r) => {
      const done = () => {
        dc.removeEventListener('bufferedamountlow', done)
        r()
      }
      dc.addEventListener('bufferedamountlow', done)
      setTimeout(done, 1000) // safety net in case the event is missed
    })
  }

  private async run(skip: Set<number>, gen: number) {
    if (!this.hasher) this.hasher = await createXXHash64()
    const files = this.view.files
    let base = 0
    for (let i = 0; i < files.length; i++) {
      if (skip.has(i)) {
        files[i].state = 'skipped'
        base += files[i].size
      } else if (files[i].state !== 'failed') {
        files[i].state = 'waiting'
      }
    }
    this.meter.reset()
    this.set({ status: 'sending', bytesDone: base })

    for (let i = 0; i < files.length; i++) {
      if (gen !== this.gen) return
      if (files[i].state === 'skipped' || files[i].state === 'done') continue
      let ok = false
      for (let attempt = 0; attempt < 3 && !ok; attempt++) {
        if (gen !== this.gen) return
        files[i].state = 'sending'
        this.set({ current: i })
        ok = await this.sendFile(i, gen, base)
      }
      if (gen !== this.gen) return
      files[i].state = ok ? 'done' : 'failed'
      base += files[i].size
      this.set({ bytesDone: base })
    }
    if (gen !== this.gen) return
    this.send({ t: 'finished' })
    this.wantSend = false
    this.set({ status: 'done', current: -1, speed: 0 })
  }

  private async sendFile(i: number, gen: number, base: number): Promise<boolean> {
    const conn = this.conn!
    const dc = conn.dataChannel
    const { file } = this.picked[i]
    const chunk = CHUNK
    const h = this.hasher!
    h.init()
    this.acked = 0
    let sent = 0
    const donePromise = new Promise<boolean>((r) => (this.doneWaiter = r))
    this.send({ t: 'file', id: i })
    let lastUi = 0
    for (let off = 0; off < file.size; off += READ_BLOCK) {
      const block = new Uint8Array(await file.slice(off, Math.min(off + READ_BLOCK, file.size)).arrayBuffer())
      if (gen !== this.gen) return false
      h.update(block)
      for (let o = 0; o < block.byteLength; o += chunk) {
        while (dc.bufferedAmount > CHANNEL_HIGH_WATER) {
          await this.waitChannel(dc)
          if (gen !== this.gen) return false
        }
        while (sent - this.acked > MAX_IN_FLIGHT) {
          await this.waitAck()
          if (gen !== this.gen) return false
        }
        const piece = block.slice(o, Math.min(o + chunk, block.byteLength))
        try {
          dc.send(piece.buffer)
        } catch {
          return false
        }
        sent += piece.byteLength
      }
      const now = performance.now()
      if (now - lastUi > 200) {
        lastUi = now
        this.meter.add(base + sent)
        this.view.bytesDone = base + this.acked
        this.view.speed = this.meter.rate
        this.emit()
      }
    }
    this.send({ t: 'end', id: i, hash: h.digest('hex') })
    const ok = await donePromise
    this.doneWaiter = null
    return ok
  }

  private set(p: Partial<OutView>) {
    Object.assign(this.view, p)
    this.emit()
  }

  subscribe(fn: () => void) {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  emit() {
    if (this.emitScheduled) return
    this.emitScheduled = true
    setTimeout(() => {
      this.emitScheduled = false
      for (const l of this.listeners) l()
    }, 120)
  }

  snapshot(): OutView {
    return { ...this.view, files: this.view.files.map((f) => ({ ...f })) }
  }
}
