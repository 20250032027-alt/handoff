// Reading public ("anyone with the link") Google Drive folders with an API key,
// and saving picked files either into a folder or into a single .zip.

import { downloadZip } from 'client-zip'
import { safePath } from './files'

export const DRIVE_KEY: string = import.meta.env.VITE_GOOGLE_API_KEY || ''
const API = 'https://www.googleapis.com/drive/v3/files'
const FOLDER = 'application/vnd.google-apps.folder'

export interface DriveItem {
  id: string
  name: string
  mimeType: string
  size: number
  thumb: string
  duration: number // ms, videos only
  width: number
  height: number
  modified: string
  resourceKey: string
  isFolder: boolean
  isVideo: boolean
  isImage: boolean
  isGoogleDoc: boolean
  path: string // where it sits relative to the folder you pasted, e.g. "Day 2/A-cam"
}

export interface ParsedLink {
  id: string
  resourceKey: string
  kind: 'folder' | 'file'
}

export function parseDriveLink(input: string): ParsedLink | null {
  const s = input.trim()
  if (!s) return null
  let url: URL | null = null
  try {
    url = new URL(s.startsWith('http') ? s : 'https://' + s)
  } catch {
    url = null
  }
  if (!url || !/(^|\.)google\.com$/.test(url.hostname)) {
    // A bare id pasted on its own.
    return /^[\w-]{20,}$/.test(s) ? { id: s, resourceKey: '', kind: 'folder' } : null
  }
  const rk = url.searchParams.get('resourcekey') || ''
  const folder = url.pathname.match(/\/folders\/([\w-]+)/)
  if (folder) return { id: folder[1], resourceKey: rk, kind: 'folder' }
  const file = url.pathname.match(/\/file\/d\/([\w-]+)/) || url.pathname.match(/\/d\/([\w-]+)/)
  if (file) return { id: file[1], resourceKey: rk, kind: 'file' }
  const qid = url.searchParams.get('id')
  if (qid) return { id: qid, resourceKey: rk, kind: url.pathname.includes('folder') ? 'folder' : 'file' }
  return null
}

export class DriveError extends Error {
  constructor(
    message: string,
    readonly reason: string,
  ) {
    super(message)
  }
}

function keysHeader(pairs: { id: string; resourceKey: string }[]): HeadersInit {
  const v = pairs.filter((p) => p.resourceKey).map((p) => `${p.id}/${p.resourceKey}`)
  return v.length ? { 'X-Goog-Drive-Resource-Keys': v.join(',') } : {}
}

async function api(url: string, headers: HeadersInit = {}) {
  const res = await fetch(url, { headers })
  if (!res.ok) throw await toError(res)
  return res.json()
}

async function toError(res: Response): Promise<DriveError> {
  let reason = ''
  let msg = ''
  try {
    const j = await res.json()
    reason = j?.error?.errors?.[0]?.reason || j?.error?.status || ''
    msg = j?.error?.message || ''
  } catch {
    /* not json */
  }
  if (res.status === 404 || reason === 'notFound')
    return new DriveError("Couldn't find that. Make sure it's shared as \"Anyone with the link\".", 'notFound')
  if (reason === 'downloadQuotaExceeded')
    return new DriveError('Google is limiting downloads of this file right now because it has been downloaded a lot. Try again in a few hours.', reason)
  if (reason === 'keyInvalid' || reason === 'API_KEY_INVALID' || reason === 'accessNotConfigured' || reason === 'PERMISSION_DENIED')
    return new DriveError('The Google API key for this site is missing or not set up right.', 'key')
  if (res.status === 403) return new DriveError("That isn't public. The owner needs to share it as \"Anyone with the link\".", 'forbidden')
  return new DriveError(msg || `Google Drive said ${res.status}.`, reason || String(res.status))
}

const FIELDS = 'id,name,mimeType,size,thumbnailLink,videoMediaMetadata(durationMillis,width,height),imageMediaMetadata(width,height),modifiedTime,resourceKey'

function toItem(f: Record<string, any>, path: string): DriveItem {
  const mime: string = f.mimeType || ''
  return {
    id: f.id,
    name: f.name,
    mimeType: mime,
    size: Number(f.size || 0),
    // Ask for a bigger thumbnail than the tiny default.
    thumb: f.thumbnailLink ? String(f.thumbnailLink).replace(/=s\d+$/, '=s480') : '',
    duration: Number(f.videoMediaMetadata?.durationMillis || 0),
    width: Number(f.videoMediaMetadata?.width || f.imageMediaMetadata?.width || 0),
    height: Number(f.videoMediaMetadata?.height || f.imageMediaMetadata?.height || 0),
    modified: f.modifiedTime || '',
    resourceKey: f.resourceKey || '',
    isFolder: mime === FOLDER,
    isVideo: mime.startsWith('video/') || /\.(mp4|mov|mxf|mts|m2ts|avi|mkv|braw|r3d|crm|insv|lrv)$/i.test(f.name || ''),
    isImage: mime.startsWith('image/'),
    isGoogleDoc: mime.startsWith('application/vnd.google-apps.') && mime !== FOLDER,
    path,
  }
}

export async function getMeta(link: ParsedLink): Promise<DriveItem> {
  const f = await api(`${API}/${link.id}?fields=${FIELDS}&supportsAllDrives=true&key=${DRIVE_KEY}`, keysHeader([link]))
  return toItem(f, '')
}

export async function listFolder(folder: { id: string; resourceKey: string }, path: string): Promise<DriveItem[]> {
  const out: DriveItem[] = []
  let pageToken = ''
  do {
    const q = encodeURIComponent(`'${folder.id}' in parents and trashed = false`)
    const url =
      `${API}?q=${q}&fields=nextPageToken,files(${FIELDS})&pageSize=1000&orderBy=folder,name_natural` +
      `&supportsAllDrives=true&includeItemsFromAllDrives=true&key=${DRIVE_KEY}${pageToken ? `&pageToken=${pageToken}` : ''}`
    const j = await api(url, keysHeader([folder]))
    for (const f of j.files || []) out.push(toItem(f, path))
    pageToken = j.nextPageToken || ''
  } while (pageToken)
  return out
}

function mediaUrl(item: DriveItem) {
  return `${API}/${item.id}?alt=media&supportsAllDrives=true&acknowledgeAbuse=true&key=${DRIVE_KEY}`
}

export function previewUrl(item: DriveItem) {
  return `https://drive.google.com/file/d/${item.id}/preview${item.resourceKey ? `?resourcekey=${item.resourceKey}` : ''}`
}

async function openMedia(item: DriveItem, signal: AbortSignal): Promise<Response> {
  let res = await fetch(mediaUrl(item), { headers: keysHeader([item]), signal })
  // acknowledgeAbuse is only allowed for some files. Retry without it if Google refuses.
  if (res.status === 400 || res.status === 403) {
    const plain = mediaUrl(item).replace('&acknowledgeAbuse=true', '')
    const again = await fetch(plain, { headers: keysHeader([item]), signal })
    if (again.ok) res = again
    else throw await toError(again)
  }
  if (!res.ok || !res.body) throw await toError(res)
  return res
}

// Counts bytes as they stream past so the page can show progress.
function counted(body: ReadableStream<Uint8Array>, onBytes: (n: number) => void) {
  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, ctl) {
        onBytes(chunk.byteLength)
        ctl.enqueue(chunk)
      },
    }),
  )
}

export interface SaveProgress {
  bytes: number
  current: string
  done: number
  failed: { name: string; why: string }[]
  skipped: number
}

export async function saveToFolder(
  items: DriveItem[],
  dir: FileSystemDirectoryHandle,
  signal: AbortSignal,
  onProgress: (p: SaveProgress) => void,
) {
  const p: SaveProgress = { bytes: 0, current: '', done: 0, failed: [], skipped: 0 }
  for (const item of items) {
    if (signal.aborted) break
    const rel = [...safePath(item.path), ...safePath(item.name)]
    const name = rel.pop()!
    p.current = [...rel, name].join('/')
    onProgress({ ...p })
    let d = dir
    for (const part of rel) d = await d.getDirectoryHandle(part, { create: true })
    try {
      const existing = await (await d.getFileHandle(name)).getFile()
      if (existing.size === item.size) {
        p.skipped++
        p.bytes += item.size
        onProgress({ ...p })
        continue
      }
    } catch {
      /* not there yet */
    }
    let w: FileSystemWritableFileStream | null = null
    let got = 0
    try {
      const res = await openMedia(item, signal)
      const fh = await d.getFileHandle(name, { create: true })
      w = await fh.createWritable()
      await counted(res.body!, (n) => {
        got += n
        p.bytes += n
        onProgress({ ...p })
      }).pipeTo(w, { signal })
      w = null // pipeTo closes it
      p.done++
    } catch (e) {
      p.bytes -= got
      try {
        await w?.abort()
      } catch {
        /* ignore */
      }
      if (signal.aborted) break
      p.failed.push({ name: item.name, why: (e as Error).message })
    }
    onProgress({ ...p })
  }
  p.current = ''
  onProgress({ ...p })
  return p
}

export async function saveAsZip(
  items: DriveItem[],
  file: FileSystemFileHandle,
  signal: AbortSignal,
  onProgress: (p: SaveProgress) => void,
) {
  const p: SaveProgress = { bytes: 0, current: '', done: 0, failed: [], skipped: 0 }
  async function* entries() {
    for (const item of items) {
      if (signal.aborted) return
      p.current = [item.path, item.name].filter(Boolean).join('/')
      onProgress({ ...p })
      try {
        const res = await openMedia(item, signal)
        yield {
          name: [...safePath(item.path), ...safePath(item.name)].join('/'),
          lastModified: item.modified ? new Date(item.modified) : new Date(),
          size: item.size,
          input: counted(res.body!, (n) => {
            p.bytes += n
            onProgress({ ...p })
          }),
        }
        p.done++
      } catch (e) {
        if (signal.aborted) return
        p.failed.push({ name: item.name, why: (e as Error).message })
        onProgress({ ...p })
      }
    }
  }
  // Videos are already compressed, so the zip just stores them. That keeps it fast.
  const zip = downloadZip(entries())
  const w = await file.createWritable()
  try {
    await zip.body!.pipeTo(w, { signal })
  } catch (e) {
    try {
      await w.abort()
    } catch {
      /* ignore */
    }
    if (!signal.aborted) throw e
  }
  p.current = ''
  onProgress({ ...p })
  return p
}
