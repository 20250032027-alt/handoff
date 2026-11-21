// Editor side of watch links: lists what's in the Handoff folder, makes
// thumbnails, and serves byte ranges to teammates' browsers.

import type { DataConnection } from 'peerjs'
import { CHUNK, PHOTO_EXT, VIDEO_EXT, type LibItem, type LibraryMsg, type LiveSend, type ViewerMsg } from './protocol'

const thumbCache = new Map<string, { jpeg: string; duration: number }>()
let thumbQueue: Promise<unknown> = Promise.resolve()

export async function scanFolder(dir: FileSystemDirectoryHandle): Promise<LibItem[]> {
  const out: LibItem[] = []
  async function walk(d: FileSystemDirectoryHandle, parts: string[]) {
    for await (const [name, h] of d.entries()) {
      if (out.length >= 5000) return
      if (name.startsWith('.') || name.endsWith('.crswap')) continue
      if (h.kind === 'directory') {
        await walk(h as FileSystemDirectoryHandle, [...parts, name])
      } else {
        const kind = VIDEO_EXT.test(name) ? 'video' : PHOTO_EXT.test(name) ? 'photo' : null
        if (!kind || parts.length < 1) continue
        const f = await (h as FileSystemFileHandle).getFile()
        out.push({
          path: [...parts, name].join('/'),
          name,
          size: f.size,
          modified: f.lastModified,
          kind,
          shooter: parts[0],
          batch: parts[1] || '',
        })
      }
    }
  }
  await walk(dir, [])
  out.sort((a, b) => b.batch.localeCompare(a.batch) || a.shooter.localeCompare(b.shooter) || a.path.localeCompare(b.path, undefined, { numeric: true }))
  return out
}

async function fileAt(dir: FileSystemDirectoryHandle, path: string): Promise<File> {
  const parts = path.split('/').filter((p) => p && p !== '.' && p !== '..')
  const name = parts.pop()!
  let d = dir
  for (const p of parts) d = await d.getDirectoryHandle(p)
  return (await d.getFileHandle(name)).getFile()
}

function thumbOf(file: File, kind: 'video' | 'photo'): Promise<{ jpeg: string; duration: number }> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file)
    let v: HTMLVideoElement | null = null
    const done = (jpeg: string, duration = 0) => {
      if (v) {
        v.onerror = null
        v.removeAttribute('src')
        v.load()
      }
      URL.revokeObjectURL(url)
      resolve({ jpeg, duration })
    }
    const draw = (el: HTMLVideoElement | HTMLImageElement, w: number, h: number, duration = 0) => {
      try {
        const scale = 360 / Math.max(1, w)
        const c = document.createElement('canvas')
        c.width = 360
        c.height = Math.round(h * scale) || 202
        c.getContext('2d')!.drawImage(el, 0, 0, c.width, c.height)
        done(c.toDataURL('image/jpeg', 0.72), duration)
      } catch {
        done('', duration)
      }
    }
    const timer = setTimeout(() => done(''), 10000)
    if (kind === 'photo') {
      const img = new Image()
      img.onload = () => {
        clearTimeout(timer)
        draw(img, img.naturalWidth, img.naturalHeight)
      }
      img.onerror = () => {
        clearTimeout(timer)
        done('')
      }
      img.src = url
      return
    }
    v = document.createElement('video')
    v.muted = true
    v.preload = 'metadata'
    v.onloadedmetadata = () => {
      v!.currentTime = Math.min(1, (v.duration || 2) * 0.1)
    }
    v.onseeked = () => {
      clearTimeout(timer)
      draw(v!, v!.videoWidth, v!.videoHeight, v!.duration)
    }
    v.onerror = () => {
      clearTimeout(timer)
      done('')
    }
    v.src = url
  })
}

export class ViewerSession {
  constructor(
    private conn: DataConnection,
    private ctx: {
      dir: () => FileSystemDirectoryHandle | null
      live: () => LiveSend[]
    },
  ) {
    conn.on('data', (d) => {
      if (typeof d !== 'string') return
      void this.onMsg(JSON.parse(d) as ViewerMsg)
    })
  }

  send(m: LibraryMsg) {
    if (this.conn.open) this.conn.send(JSON.stringify(m))
  }

  close() {
    this.conn.close()
  }

  private async onMsg(m: ViewerMsg) {
    const dir = this.ctx.dir()
    if (!dir) return this.send({ t: 'v-err', rid: m.rid, message: 'no folder' })
    try {
      if (m.t === 'v-list') {
        this.send({ t: 'v-list', rid: m.rid, items: await scanFolder(dir), live: this.ctx.live() })
      } else if (m.t === 'v-thumb') {
        const file = await fileAt(dir, m.path)
        const key = `${m.path}:${file.size}:${file.lastModified}`
        let t = thumbCache.get(key)
        if (!t) {
          // One at a time, so a big grid doesn't decode 40 videos at once.
          const job = thumbQueue.then(() => thumbOf(file, VIDEO_EXT.test(m.path) ? 'video' : 'photo'))
          thumbQueue = job.catch(() => {})
          t = await job
          thumbCache.set(key, t)
        }
        this.send({ t: 'v-thumb', rid: m.rid, jpeg: t.jpeg, duration: t.duration })
      } else if (m.t === 'v-read') {
        const file = await fileAt(dir, m.path)
        const start = Math.max(0, Math.min(m.start, file.size))
        const end = Math.max(start, Math.min(m.end, file.size))
        this.send({ t: 'v-read', rid: m.rid, size: file.size, start, end })
        const buf = new Uint8Array(await file.slice(start, end).arrayBuffer())
        const dc = this.conn.dataChannel
        for (let o = 0; o < buf.byteLength; o += CHUNK - 4) {
          while (dc.bufferedAmount > 4 * 1024 * 1024) await new Promise((r) => setTimeout(r, 20))
          const piece = buf.subarray(o, Math.min(o + CHUNK - 4, buf.byteLength))
          const msg = new Uint8Array(piece.byteLength + 4)
          new DataView(msg.buffer).setUint32(0, m.rid, true)
          msg.set(piece, 4)
          dc.send(msg.buffer)
        }
        this.send({ t: 'v-end', rid: m.rid })
      }
    } catch (e) {
      this.send({ t: 'v-err', rid: m.rid, message: String((e as Error)?.message || e) })
    }
  }
}
