// Reads the list of file names inside a .zip without unpacking it. Only the
// small table of contents at the end of the file is read, so even a 200 GB zip
// is quick. Handles large (ZIP64) archives.

export async function zipFileNames(file: File): Promise<string[]> {
  const tailSize = Math.min(file.size, 65557 + 20)
  const tail = new DataView(await file.slice(file.size - tailSize).arrayBuffer())
  let eocd = -1
  for (let i = tail.byteLength - 22; i >= 0; i--) {
    if (tail.getUint32(i, true) === 0x06054b50) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new Error("That doesn't look like a zip file.")
  let count = tail.getUint16(eocd + 10, true)
  let cdSize = tail.getUint32(eocd + 12, true)
  let cdOffset = tail.getUint32(eocd + 16, true)
  if (cdOffset === 0xffffffff || cdSize === 0xffffffff || count === 0xffff) {
    // ZIP64: a locator right before the normal end record points at the real one.
    const loc = eocd - 20
    if (loc < 0 || tail.getUint32(loc, true) !== 0x07064b50) throw new Error("Couldn't read this zip's file list.")
    const recOffset = Number(tail.getBigUint64(loc + 8, true))
    const rec = new DataView(await file.slice(recOffset, recOffset + 56).arrayBuffer())
    if (rec.getUint32(0, true) !== 0x06064b50) throw new Error("Couldn't read this zip's file list.")
    count = Number(rec.getBigUint64(32, true))
    cdSize = Number(rec.getBigUint64(40, true))
    cdOffset = Number(rec.getBigUint64(48, true))
  }
  const cd = new DataView(await file.slice(cdOffset, cdOffset + cdSize).arrayBuffer())
  const utf8 = new TextDecoder()
  const names: string[] = []
  let p = 0
  for (let n = 0; n < count && p + 46 <= cd.byteLength; n++) {
    if (cd.getUint32(p, true) !== 0x02014b50) break
    const nameLen = cd.getUint16(p + 28, true)
    const extraLen = cd.getUint16(p + 30, true)
    const commentLen = cd.getUint16(p + 32, true)
    const name = utf8.decode(new Uint8Array(cd.buffer, cd.byteOffset + p + 46, nameLen))
    if (!name.endsWith('/')) names.push(name.split('/').pop()!)
    p += 46 + nameLen + extraLen + commentLen
  }
  return names
}

// Every file name inside a folder picked with the folder picker or a folder input.
export async function folderFileNames(dir: FileSystemDirectoryHandle): Promise<string[]> {
  const out: string[] = []
  async function walk(d: FileSystemDirectoryHandle) {
    for await (const [name, h] of d.entries()) {
      if (h.kind === 'directory') await walk(h as FileSystemDirectoryHandle)
      else if (!name.startsWith('.')) out.push(name)
    }
  }
  await walk(dir)
  return out
}
