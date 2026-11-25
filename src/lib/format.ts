export function bytes(n: number): string {
  if (n < 1024) return `${n} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let v = n / 1024
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v >= 100 ? v.toFixed(0) : v.toFixed(1)} ${units[i]}`
}

export function speed(bps: number): string {
  if (!bps || !isFinite(bps)) return '--'
  return `${bytes(bps)}/s`
}

export function duration(seconds: number): string {
  if (!isFinite(seconds) || seconds < 0) return '--'
  const s = Math.round(seconds)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${s % 60}s`
  const h = Math.floor(m / 60)
  return `${h}h ${m % 60}m`
}

export function plural(n: number, word: string): string {
  return `${n.toLocaleString()} ${word}${n === 1 ? '' : 's'}`
}

export function today(): string {
  const d = new Date()
  const p = (x: number) => String(x).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

// Rolling speed meter over the last few seconds.
export class SpeedMeter {
  private samples: { t: number; b: number }[] = []
  add(total: number) {
    const t = performance.now()
    this.samples.push({ t, b: total })
    while (this.samples.length > 2 && t - this.samples[0].t > 5000) this.samples.shift()
  }
  get rate(): number {
    if (this.samples.length < 2) return 0
    const a = this.samples[0]
    const z = this.samples[this.samples.length - 1]
    const dt = (z.t - a.t) / 1000
    return dt > 0 ? (z.b - a.b) / dt : 0
  }
  reset() {
    this.samples = []
  }
}

const sameYear = (a: Date, b: Date) => a.getFullYear() === b.getFullYear()

export function shortDate(ms: number, withTime = false): string {
  if (!ms) return ''
  const d = new Date(ms)
  const now = new Date()
  const opts: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric', ...(sameYear(d, now) ? {} : { year: 'numeric' }) }
  const day = d.toLocaleDateString(undefined, opts)
  return withTime ? `${day}, ${d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}` : day
}

export function longDate(ms: number): string {
  if (!ms) return ''
  return new Date(ms).toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}

// "Nov 20 – Nov 22, 2026", or a single day when they match.
export function dateRange(min: number, max: number): string {
  if (!min || !max) return ''
  const a = new Date(min)
  const b = new Date(max)
  const y = { year: 'numeric' } as const
  if (a.toDateString() === b.toDateString()) return a.toLocaleDateString(undefined, { month: 'short', day: 'numeric', ...y })
  if (sameYear(a, b))
    return `${a.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} – ${b.toLocaleDateString(undefined, { month: 'short', day: 'numeric', ...y })}`
  return `${a.toLocaleDateString(undefined, { month: 'short', day: 'numeric', ...y })} – ${b.toLocaleDateString(undefined, { month: 'short', day: 'numeric', ...y })}`
}

// "214 videos, 12 photos, 186 GB"
export function summary(list: { kind?: string; isVideo?: boolean; isImage?: boolean; size: number }[]): string {
  let v = 0
  let p = 0
  let o = 0
  let size = 0
  for (const f of list) {
    size += f.size
    if (f.kind === 'video' || f.isVideo) v++
    else if (f.kind === 'photo' || f.isImage) p++
    else o++
  }
  const parts = [v ? plural(v, 'video') : '', p ? plural(p, 'photo') : '', o ? plural(o, 'other file') : ''].filter(Boolean)
  return `${parts.join(', ') || 'No files'}${size ? `, ${bytes(size)}` : ''}`
}
