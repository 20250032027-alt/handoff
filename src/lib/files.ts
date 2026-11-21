// Collecting files on the sender side, and making paths safe on the editor side.

export interface PickedFile {
  file: File
  path: string
}

const JUNK_NAMES = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini', '.localized'])
const JUNK_DIRS = new Set([
  '.Spotlight-V100',
  '.Trashes',
  '.fseventsd',
  '.TemporaryItems',
  'System Volume Information',
  '$RECYCLE.BIN',
])

export function isJunk(path: string): boolean {
  const parts = path.split('/')
  const name = parts[parts.length - 1]
  if (JUNK_NAMES.has(name) || name.startsWith('._')) return true
  return parts.slice(0, -1).some((p) => JUNK_DIRS.has(p))
}

function readAllEntries(reader: FileSystemDirectoryReader): Promise<FileSystemEntry[]> {
  return new Promise((resolve, reject) => {
    const all: FileSystemEntry[] = []
    const next = () =>
      reader.readEntries((batch) => {
        if (batch.length === 0) resolve(all)
        else {
          all.push(...batch)
          next()
        }
      }, reject)
    next()
  })
}

function entryFile(entry: FileSystemFileEntry): Promise<File> {
  return new Promise((resolve, reject) => entry.file(resolve, reject))
}

async function walk(entry: FileSystemEntry, out: PickedFile[]) {
  if (entry.isFile) {
    const file = await entryFile(entry as FileSystemFileEntry)
    out.push({ file, path: entry.fullPath.replace(/^\/+/, '') })
  } else if (entry.isDirectory) {
    const children = await readAllEntries((entry as FileSystemDirectoryEntry).createReader())
    for (const c of children) await walk(c, out)
  }
}

export async function filesFromDrop(dt: DataTransfer): Promise<PickedFile[]> {
  const out: PickedFile[] = []
  const entries: FileSystemEntry[] = []
  for (const item of Array.from(dt.items)) {
    const e = item.webkitGetAsEntry?.()
    if (e) entries.push(e)
  }
  if (entries.length) {
    for (const e of entries) await walk(e, out)
  } else {
    for (const f of Array.from(dt.files)) out.push({ file: f, path: f.name })
  }
  return out
}

export function filesFromInput(list: FileList): PickedFile[] {
  return Array.from(list).map((f) => ({ file: f, path: f.webkitRelativePath || f.name }))
}

export function splitJunk(files: PickedFile[]): { keep: PickedFile[]; junk: number } {
  const keep: PickedFile[] = []
  let junk = 0
  for (const f of files) (isJunk(f.path) ? junk++ : keep.push(f))
  keep.sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true }))
  return { keep, junk }
}

// The editor is usually on Windows, so names must be valid there too.
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i

export function safeSegment(s: string): string {
  let out = s.replace(/[<>:"|?*\\\u0000-\u001f]/g, '_').replace(/[. ]+$/, '').trim()
  if (!out || out === '.' || out === '..') out = '_'
  if (RESERVED.test(out)) out = '_' + out
  if (out.length > 150) out = out.slice(0, 150)
  return out
}

export function safePath(p: string): string[] {
  return p
    .split(/[\\/]+/)
    .filter((s) => s && s !== '.' && s !== '..')
    .map(safeSegment)
}
