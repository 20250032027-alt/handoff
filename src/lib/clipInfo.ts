// Looks inside a video file to explain playback trouble, and makes a smooth
// 1080p copy for clips that are too heavy to play in a browser.

import type { StreamTargetChunk } from 'mediabunny'

export interface ClipInfo {
  label: string // e.g. "HEVC 10-bit · 3840×2160 · 23.98 fps"
  canDecode: boolean
  heavy: boolean // likely to stutter in a browser
  why: string
}

function describeCodec(codec: string | null, param: string | null) {
  const p = (param || '').toLowerCase()
  if (codec === 'avc') {
    const profile = parseInt(p.split('.')[1]?.slice(0, 2) || '0', 16)
    if (profile === 0x7a) return { name: 'H.264 10-bit 4:2:2', heavyCodec: true }
    if (profile === 0x6e) return { name: 'H.264 10-bit', heavyCodec: true }
    if (profile === 0xf4) return { name: 'H.264 4:4:4', heavyCodec: true }
    return { name: 'H.264', heavyCodec: false }
  }
  if (codec === 'hevc') {
    const prof = p.split('.')[1] || ''
    if (prof.endsWith('4')) return { name: 'HEVC 4:2:2', heavyCodec: true }
    if (prof.endsWith('2')) return { name: 'HEVC 10-bit', heavyCodec: false }
    return { name: 'HEVC', heavyCodec: false }
  }
  if (codec) return { name: codec.toUpperCase(), heavyCodec: codec === 'prores' }
  return { name: '', heavyCodec: true }
}

export async function probe(file: File): Promise<ClipInfo | null> {
  try {
    const { Input, BlobSource, ALL_FORMATS } = await import('mediabunny')
    const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS })
    const track = await input.getPrimaryVideoTrack()
    if (!track) return null
    const [param, canDecode, stats] = await Promise.all([
      track.getCodecParameterString().catch(() => null),
      track.canDecode().catch(() => false),
      track.computePacketStats(60).catch(() => null),
    ])
    const { name, heavyCodec } = describeCodec(track.codec, param)
    const w = track.displayWidth
    const h = track.displayHeight
    const fps = stats?.averagePacketRate || 0
    const big = w * h >= 3840 * 2160
    const fast = fps > 31
    const heavy = !canDecode || heavyCodec || (big && fast)
    const why = !canDecode
      ? `${name ? name + ' is' : 'This is'} a camera format browsers can't play, often 10-bit or 4:2:2 footage. Open it in VLC or your editing app instead.`
      : heavyCodec
        ? `${name} is a pro camera format that browsers can only play in software, which is slow.`
        : big && fast
          ? `4K at ${Math.round(fps)} fps is a lot of data to play in a browser.`
          : ''
    return {
      label: [name || 'Pro camera format', w && h ? `${w}×${h}` : '', fps ? `${fps.toFixed(fps % 1 ? 2 : 0)} fps` : ''].filter(Boolean).join(' · '),
      canDecode,
      heavy,
      why,
    }
  } catch {
    return null
  }
}

function hashKey(s: string) {
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0
  return h.toString(36)
}

async function smoothDir() {
  return (await navigator.storage.getDirectory()).getDirectoryHandle('viewer-smooth', { create: true })
}

export async function smoothCopy(key: string): Promise<File | null> {
  try {
    const f = await (await (await smoothDir()).getFileHandle(hashKey(key) + '.mp4')).getFile()
    return f.size > 0 ? f : null
  } catch {
    return null
  }
}

// Makes an easy-to-play 1080p H.264 copy, keeping the frame rate.
export async function makeSmoothCopy(key: string, file: File, onProgress: (p: number) => void, signal: AbortSignal): Promise<File> {
  const { Input, BlobSource, ALL_FORMATS, Output, Mp4OutputFormat, StreamTarget, Conversion, canEncodeAudio } = await import('mediabunny')
  const dir = await smoothDir()
  const name = hashKey(key) + '.mp4'
  const fh = await dir.getFileHandle(name, { create: true })
  const w = await fh.createWritable()
  try {
    const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS })
    const output = new Output({
      format: new Mp4OutputFormat({ fastStart: false }),
      target: new StreamTarget(
        new WritableStream<StreamTargetChunk>({ write: (c) => w.write({ type: 'write', position: c.position, data: c.data }) }),
        { chunked: true, chunkSize: 4 * 1024 * 1024 },
      ),
    })
    const audioCodec = (await canEncodeAudio('aac').catch(() => false)) ? 'aac' : 'opus'
    const conversion = await Conversion.init({
      input,
      output,
      video: { height: 1080, codec: 'avc', bitrate: 12_000_000, fit: 'contain' },
      audio: { codec: audioCodec, bitrate: 192_000 },
    })
    if (!conversion.isValid) throw new Error("This clip's format can't be converted in a browser.")
    signal.addEventListener('abort', () => void conversion.cancel())
    conversion.onProgress = onProgress
    await conversion.execute()
    await w.close()
    return await fh.getFile()
  } catch (e) {
    await w.abort().catch(() => {})
    await dir.removeEntry(name).catch(() => {})
    throw e
  }
}
