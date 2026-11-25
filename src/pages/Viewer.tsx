import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ArrowClockwise, CaretDown, CaretUp, FilmStrip, FolderSimple, Image as ImageIcon, MagnifyingGlass, Play, Star, X } from '@phosphor-icons/react'
import { pauseThumbs, peekThumb, scanFileList, scanHandle, thumbFor, type LocalItem, type Thumb } from '../lib/localLib'
import { makeSmoothCopy, probe, smoothCopy, type ClipInfo } from '../lib/clipInfo'
import { getJSON, idbGet, idbSet, setJSON } from '../lib/store'
import { bytes, dateRange, longDate, plural, shortDate, summary } from '../lib/format'
import { Button, Shell, useTitle } from '../components/ui'

const canPick = typeof window !== 'undefined' && 'showDirectoryPicker' in window
// Recording date from inside the file once it's been read, otherwise the file's own date.
const when = (it: LocalItem) => peekThumb(it.key)?.taken || it.modified
type Filter = 'all' | 'video' | 'photo' | 'starred'
type Sort = 'name' | 'newest' | 'oldest' | 'largest'

export default function Viewer() {
  const [handle, setHandle] = useState<FileSystemDirectoryHandle | null>(null)
  const [needsPermission, setNeedsPermission] = useState(false)
  const [handoffDir, setHandoffDir] = useState<FileSystemDirectoryHandle | null>(null)
  const [folderName, setFolderName] = useState('')
  const [items, setItems] = useState<LocalItem[] | null>(null)
  const [scanning, setScanning] = useState(false)
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<Filter>('all')
  const [sort, setSort] = useState<Sort>(() => (getJSON<{ sort?: Sort }>('viewer', {}).sort as Sort) || 'name')
  const [stars, setStars] = useState<Set<string>>(() => new Set(getJSON<string[]>('stars', [])))
  const [open, setOpen] = useState<number | null>(null)
  const fallbackInput = useRef<HTMLInputElement>(null)
  // Bumped (at most a few times a second) as recording dates come in, so totals and sorting catch up.
  const [datesSeen, setDatesSeen] = useState(0)
  const bumpPending = useRef(false)
  const onThumb = useCallback(() => {
    if (bumpPending.current) return
    bumpPending.current = true
    setTimeout(() => {
      bumpPending.current = false
      setDatesSeen((n) => n + 1)
    }, 400)
  }, [])

  useTitle(folderName ? `${folderName} · Viewer · Handoff` : 'Viewer · Handoff')

  const load = useCallback(async (h: FileSystemDirectoryHandle) => {
    setScanning(true)
    setFolderName(h.name)
    try {
      setItems(await scanHandle(h))
    } finally {
      setScanning(false)
    }
  }, [])

  // Reopen the folder from last time, and offer the Handoff folder if there is one.
  useEffect(() => {
    if (!canPick) return
    ;(async () => {
      const last = await idbGet<FileSystemDirectoryHandle>('viewer-dir').catch(() => undefined)
      const inbox = await idbGet<FileSystemDirectoryHandle>('dir').catch(() => undefined)
      if (inbox) setHandoffDir(inbox)
      if (!last) return
      setHandle(last)
      setFolderName(last.name)
      if ((await last.queryPermission({ mode: 'read' })) === 'granted') void load(last)
      else setNeedsPermission(true)
    })()
  }, [load])

  const use = async (h: FileSystemDirectoryHandle) => {
    if ((await h.queryPermission({ mode: 'read' })) !== 'granted' && (await h.requestPermission({ mode: 'read' })) !== 'granted') return
    await idbSet('viewer-dir', h)
    setHandle(h)
    setNeedsPermission(false)
    setOpen(null)
    void load(h)
  }

  const pick = async () => {
    if (!canPick) return fallbackInput.current?.click()
    try {
      await use(await window.showDirectoryPicker({ id: 'handoff-viewer', mode: 'read' }))
    } catch {
      /* closed the picker */
    }
  }

  const toggleStar = (it: LocalItem) => {
    const k = it.path + ':' + it.size
    const next = new Set(stars)
    next.has(k) ? next.delete(k) : next.add(k)
    setStars(next)
    setJSON('stars', Array.from(next))
  }
  const isStarred = (it: LocalItem) => stars.has(it.path + ':' + it.size)

  const visible = useMemo(() => {
    if (!items) return []
    const q = query.trim().toLowerCase()
    const list = items.filter(
      (it) =>
        (filter === 'all' || (filter === 'starred' ? stars.has(it.path + ':' + it.size) : it.kind === filter)) &&
        (!q || it.path.toLowerCase().includes(q)),
    )
    const byName = (a: LocalItem, b: LocalItem) => a.path.localeCompare(b.path, undefined, { numeric: true })
    list.sort(
      sort === 'newest'
        ? (a, b) => when(b) - when(a)
        : sort === 'oldest'
          ? (a, b) => when(a) - when(b)
          : sort === 'largest'
            ? (a, b) => b.size - a.size
            : byName,
    )
    return list
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, query, filter, sort, stars, sort === 'name' ? 0 : datesSeen])

  // Group by subfolder when sorting by name; one flat grid otherwise.
  const groups = useMemo(() => {
    if (sort !== 'name') return [{ dir: '', items: visible }]
    const m = new Map<string, LocalItem[]>()
    for (const it of visible) {
      if (!m.has(it.dir)) m.set(it.dir, [])
      m.get(it.dir)!.push(it)
    }
    return Array.from(m, ([dir, items]) => ({ dir, items }))
  }, [visible, sort])

  const totals = useMemo(() => {
    if (!items?.length) return { text: 'No videos or photos', range: '' }
    let min = Infinity
    let max = 0
    for (const i of items) {
      min = Math.min(min, when(i))
      max = Math.max(max, when(i))
    }
    return { text: summary(items), range: dateRange(min, max) }
  }, [items, datesSeen])

  const fallback = (
    <input
      ref={fallbackInput}
      type="file"
      className="hidden"
      // @ts-expect-error non-standard but widely supported
      webkitdirectory=""
      multiple
      onChange={(e) => {
        const fl = e.target.files
        if (!fl?.length) return
        setFolderName((fl[0].webkitRelativePath || '').split('/')[0] || 'Folder')
        setItems(scanFileList(fl))
        setOpen(null)
        e.target.value = ''
      }}
    />
  )

  // Nothing open yet
  if (!items) {
    return (
      <Shell nav="viewer">
        {fallback}
        <div className="max-w-2xl rise">
          <h1 className="text-3xl md:text-[40px] font-semibold tracking-tight leading-[1.1]">Watch a folder of footage.</h1>
          <p className="mt-4 text-ink-2 leading-relaxed max-w-[58ch]">
            Pick a folder on this computer and every clip in it shows up here with thumbnails. Click one and it plays right away at
            full quality, straight off your drive. Nothing is uploaded or copied.
          </p>
          <div className="mt-8 flex flex-wrap items-center gap-3">
            {needsPermission && handle ? (
              <>
                <Button size="lg" onClick={() => use(handle)}>
                  <FolderSimple size={18} weight="bold" /> Open "{handle.name}" again
                </Button>
                <Button size="lg" kind="secondary" onClick={pick}>
                  Pick a different folder
                </Button>
              </>
            ) : (
              <Button size="lg" onClick={pick} disabled={scanning}>
                <FolderSimple size={18} weight="bold" /> {scanning ? `Reading ${folderName}...` : 'Choose a folder'}
              </Button>
            )}
            {handoffDir && !needsPermission && !scanning && (
              <Button size="lg" kind="secondary" onClick={() => use(handoffDir)}>
                Open my Handoff folder
              </Button>
            )}
          </div>
          <p className="mt-4 text-sm text-muted">
            {canPick
              ? 'Your browser will ask to let Handoff view the folder. It only reads, it never changes or deletes anything.'
              : 'This browser asks for the folder each visit. Chrome, Edge and Opera remember it.'}
          </p>
        </div>
      </Shell>
    )
  }

  const flat = visible
  const current = open !== null ? flat[open] : null

  return (
    <Shell nav="viewer">
      {fallback}
      <section className="rise">
        <div className="flex flex-wrap items-end gap-x-6 gap-y-3">
          <div className="min-w-0">
            <span className="text-xs uppercase tracking-[0.08em] text-muted">Viewing</span>
            <h1 className="mt-1 text-2xl md:text-3xl font-semibold tracking-tight truncate">{folderName}</h1>
            <p className="mt-1 text-sm text-muted tabular-nums">
              {totals.text}
              {totals.range ? `, ${totals.range}` : ''}
            </p>
          </div>
          <div className="ml-auto flex items-center gap-2">
            {handle && canPick && (
              <Button kind="ghost" size="sm" onClick={() => load(handle)} disabled={scanning} aria-label="Look for new files">
                <ArrowClockwise size={14} weight="bold" /> {scanning ? 'Reading...' : 'Refresh'}
              </Button>
            )}
            <Button kind="secondary" size="sm" onClick={pick}>
              <FolderSimple size={14} weight="bold" /> Change folder
            </Button>
          </div>
        </div>

        <div className="mt-6 flex flex-wrap items-center gap-3 border-b border-line pb-4">
          <label className="relative flex-1 min-w-[200px] max-w-sm">
            <MagnifyingGlass size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              aria-label="Search by name"
              placeholder="Search"
              className="h-9 w-full rounded-md border border-line bg-card pl-9 pr-3 text-sm outline-none focus:border-ink/40"
            />
          </label>
          <div className="flex rounded-md border border-line p-0.5 text-sm">
            {(['all', 'video', 'photo', 'starred'] as Filter[]).map((f) => (
              <button
                key={f}
                onClick={() => setFilter(f)}
                className={`h-8 rounded-[5px] px-3 ${filter === f ? 'bg-ink text-paper font-medium' : 'text-ink-2 hover:bg-ink/[0.05]'}`}
              >
                {f === 'all' ? 'All' : f === 'video' ? 'Videos' : f === 'photo' ? 'Photos' : 'Starred'}
              </button>
            ))}
          </div>
          <select
            value={sort}
            aria-label="Sort"
            onChange={(e) => {
              setSort(e.target.value as Sort)
              setJSON('viewer', { sort: e.target.value })
            }}
            className="h-9 rounded-md border border-line bg-card px-2 text-sm"
          >
            <option value="name">By folder and name</option>
            <option value="newest">Newest first</option>
            <option value="oldest">Oldest first</option>
            <option value="largest">Largest first</option>
          </select>
        </div>
      </section>

      {visible.length === 0 ? (
        <div className="py-20 text-center">
          <p className="text-ink-2">
            {items.length === 0
              ? 'No videos or photos in this folder.'
              : filter === 'starred'
                ? 'Nothing starred yet. Hover a clip and click the star, or press S while watching.'
                : 'Nothing matches that.'}
          </p>
        </div>
      ) : (
        groups.map((g, gi) => (
          <section key={g.dir || '_top'} className="mt-8">
            {groups.length > 1 && (
              <div className="flex items-baseline gap-3 pb-3">
                <h2 className="font-medium tracking-tight truncate">{g.dir || folderName}</h2>
                <span className="text-sm text-muted tabular-nums">
                  {summary(g.items)}
                  {(() => {
                    const ts = g.items.map(when)
                    const r = dateRange(Math.min(...ts), Math.max(...ts))
                    return r ? `, ${r}` : ''
                  })()}
                </span>
              </div>
            )}
            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-x-4 gap-y-6">
              {g.items.map((it, i) => (
                <Tile
                  key={it.key}
                  it={it}
                  i={gi * 4 + i}
                  starred={isStarred(it)}
                  onThumb={onThumb}
                  star={() => toggleStar(it)}
                  play={() => setOpen(flat.indexOf(it))}
                />
              ))}
            </div>
          </section>
        ))
      )}

      {current && (
        <Player
          it={current}
          index={open!}
          count={flat.length}
          starred={isStarred(current)}
          star={() => toggleStar(current)}
          go={(d) => setOpen((o) => (o === null ? o : Math.max(0, Math.min(flat.length - 1, o + d))))}
          close={() => setOpen(null)}
        />
      )}
    </Shell>
  )
}

function Tile({
  it,
  i,
  starred,
  star,
  play,
  onThumb,
}: {
  it: LocalItem
  i: number
  starred: boolean
  star: () => void
  play: () => void
  onThumb: () => void
}) {
  const ref = useRef<HTMLButtonElement>(null)
  const [t, setT] = useState<Thumb | undefined>(() => peekThumb(it.key))
  useEffect(() => {
    if (t) return
    const el = ref.current
    if (!el) return
    let cancelled = false
    const io = new IntersectionObserver(
      (entries) => {
        if (!entries.some((e) => e.isIntersecting)) return
        io.disconnect()
        thumbFor(it).then((x) => {
          if (cancelled) return
          setT(x)
          onThumb()
        })
      },
      { rootMargin: '400px' },
    )
    io.observe(el)
    return () => {
      cancelled = true
      io.disconnect()
    }
  }, [it, t, onThumb])
  const Icon = it.kind === 'video' ? FilmStrip : ImageIcon
  return (
    <div className="group" style={{ ['--i' as string]: Math.min(i, 12) }}>
      <div className="relative">
        <button
          ref={ref}
          onClick={play}
          className="relative block w-full aspect-video overflow-hidden rounded-lg border border-line bg-ink/[0.04]"
          aria-label={`Play ${it.name}`}
        >
          {t?.jpeg ? (
            <img src={t.jpeg} alt="" className="size-full object-cover" />
          ) : (
            <span className={`size-full flex items-center justify-center text-muted ${t ? '' : 'animate-pulse'}`}>
              <Icon size={26} />
            </span>
          )}
          {it.kind === 'video' && (
            <span className="absolute inset-0 flex items-center justify-center bg-ink/0 opacity-0 transition-[opacity,background-color] group-hover:opacity-100 group-hover:bg-ink/25">
              <span className="flex size-11 items-center justify-center rounded-full bg-paper/95 text-ink">
                <Play size={18} weight="fill" />
              </span>
            </span>
          )}
          {t && t.duration > 0 && (
            <span className="num absolute right-2 bottom-2 rounded bg-ink/80 px-1.5 py-0.5 text-[11px] text-paper">{clock(t.duration)}</span>
          )}
        </button>
        <button
          onClick={star}
          aria-label={starred ? 'Unstar' : 'Star'}
          className={`absolute left-2 top-2 flex size-7 items-center justify-center rounded-md bg-paper/90 transition-opacity ${
            starred ? 'opacity-100 text-tally' : 'opacity-0 group-hover:opacity-100 text-ink-2 hover:text-ink'
          }`}
        >
          <Star size={15} weight={starred ? 'fill' : 'bold'} />
        </button>
      </div>
      <p className="mt-2 truncate text-sm font-medium">{it.name}</p>
      <p className="num text-xs text-muted mt-0.5 truncate">
        {[bytes(it.size), t?.height ? `${t.height}p` : '', shortDate(t?.taken || it.modified, true)].filter(Boolean).join(' · ')}
      </p>
    </div>
  )
}

function clock(sec: number) {
  const s = Math.round(sec)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const ss = String(s % 60).padStart(2, '0')
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`
}

const SPEEDS = [0.5, 1, 1.5, 2]

function Player({
  it,
  index,
  count,
  starred,
  star,
  go,
  close,
}: {
  it: LocalItem
  index: number
  count: number
  starred: boolean
  star: () => void
  go: (d: number) => void
  close: () => void
}) {
  const [url, setUrl] = useState('')
  const [failed, setFailed] = useState(false)
  const [rate, setRate] = useState(1)
  const [autoNext, setAutoNext] = useState(() => getJSON<{ autoNext?: boolean }>('viewer-player', {}).autoNext || false)
  const video = useRef<HTMLVideoElement>(null)
  const [info, setInfo] = useState<Thumb | undefined>(() => peekThumb(it.key))
  const [clip, setClip] = useState<ClipInfo | null>(null)
  const [smooth, setSmooth] = useState<File | null>(null)
  const [useSmooth, setUseSmooth] = useState(false)
  const [making, setMaking] = useState<number | null>(null)
  const [makeErr, setMakeErr] = useState('')
  const [stutter, setStutter] = useState(false)
  const makeCtl = useRef<AbortController | null>(null)

  // Thumbnails wait while something is playing, so they don't fight over the decoder.
  useEffect(() => {
    pauseThumbs(true)
    return () => pauseThumbs(false)
  }, [])

  // Look inside the file, and check for a smooth copy made earlier.
  useEffect(() => {
    let alive = true
    setClip(null)
    setSmooth(null)
    setUseSmooth(false)
    setStutter(false)
    setMakeErr('')
    setMaking(null)
    makeCtl.current?.abort()
    if (it.kind !== 'video') return
    probe(it.file).then((c) => alive && setClip(c))
    smoothCopy(it.key).then((f) => {
      if (alive && f) {
        setSmooth(f)
        setUseSmooth(true)
      }
    })
    return () => {
      alive = false
    }
  }, [it])

  const src = useSmooth && smooth ? smooth : it.file
  useEffect(() => {
    const u = URL.createObjectURL(src)
    setUrl(u)
    setFailed(false)
    setInfo(peekThumb(it.key))
    return () => URL.revokeObjectURL(u)
  }, [src, it.key])

  // Watch for dropped frames, and recover from a stall by reloading at the same spot.
  useEffect(() => {
    if (it.kind !== 'video' || useSmooth) return
    let lastDropped = 0
    let lastTotal = 0
    let bad = 0
    const iv = setInterval(() => {
      const v = video.current
      if (!v || v.paused || v.playbackRate > 1) return
      const q = v.getVideoPlaybackQuality?.()
      if (!q) return
      const d = q.droppedVideoFrames - lastDropped
      const t = q.totalVideoFrames - lastTotal
      lastDropped = q.droppedVideoFrames
      lastTotal = q.totalVideoFrames
      if (t > 10 && d / t > 0.08) bad++
      else bad = Math.max(0, bad - 1)
      if (bad >= 2) setStutter(true)
    }, 1500)
    return () => clearInterval(iv)
  }, [it, url, useSmooth])

  const stallTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const retried = useRef(false)
  useEffect(() => {
    retried.current = false
  }, [url])
  const onWaiting = () => {
    if (stallTimer.current) clearTimeout(stallTimer.current)
    stallTimer.current = setTimeout(() => {
      const v = video.current
      if (!v || retried.current || v.readyState >= 3) return
      retried.current = true
      const at = v.currentTime
      v.load()
      v.currentTime = at
      void v.play().catch(() => {})
      setStutter(true)
    }, 5000)
  }
  const onPlaying = () => {
    if (stallTimer.current) clearTimeout(stallTimer.current)
  }

  const makeSmooth = async () => {
    setMakeErr('')
    setMaking(0)
    const ctl = new AbortController()
    makeCtl.current = ctl
    try {
      const f = await makeSmoothCopy(it.key, it.file, (p) => setMaking(p), ctl.signal)
      if (ctl.signal.aborted) return
      setSmooth(f)
      setUseSmooth(true)
      setStutter(false)
    } catch (e) {
      if (!ctl.signal.aborted) setMakeErr((e as Error).message)
    } finally {
      setMaking(null)
    }
  }
  useEffect(() => () => makeCtl.current?.abort(), [])

  const showHelp = it.kind === 'video' && !useSmooth && (stutter || failed || clip?.heavy)

  useEffect(() => {
    if (video.current) video.current.playbackRate = rate
  }, [rate, url])

  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.tagName === 'INPUT') return
      const v = video.current
      if (e.key === 'Escape') close()
      else if (e.key === 'ArrowDown') {
        e.preventDefault()
        go(1)
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        go(-1)
      } else if (e.key.toLowerCase() === 's') star()
      else if (!v) return
      else if (e.key === ' ') {
        e.preventDefault()
        v.paused ? void v.play() : v.pause()
      } else if (e.key === 'ArrowRight') {
        e.preventDefault()
        v.currentTime = Math.min(v.duration || 0, v.currentTime + 5)
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault()
        v.currentTime = Math.max(0, v.currentTime - 5)
      } else if (e.key === '.') {
        v.pause()
        v.currentTime += 1 / 30
      } else if (e.key === ',') {
        v.pause()
        v.currentTime = Math.max(0, v.currentTime - 1 / 30)
      }
    }
    window.addEventListener('keydown', k)
    return () => window.removeEventListener('keydown', k)
  }, [close, go, star])

  return (
    <div className="fixed inset-0 z-30 flex flex-col bg-[#0f0f0e]">
      <div className="flex items-center gap-4 px-4 md:px-6 h-14 text-paper/90 shrink-0">
        <span className="num text-xs text-paper/50 tabular-nums">
          {index + 1} / {count}
        </span>
        <span className="truncate font-medium flex-1">{it.path}</span>
        <button onClick={star} className={`flex items-center gap-1.5 text-sm ${starred ? 'text-tally' : 'text-paper/70 hover:text-paper'}`}>
          <Star size={16} weight={starred ? 'fill' : 'bold'} /> {starred ? 'Starred' : 'Star'}
        </button>
        <button onClick={close} className="text-paper/70 hover:text-paper" aria-label="Close">
          <X size={20} weight="bold" />
        </button>
      </div>

      <div className="relative flex-1 min-h-0 flex items-center justify-center">
        {failed ? (
          <div className="max-w-md px-6 text-center text-paper/90">
            <p className="font-medium">This clip can't play in a browser as it is.</p>
            <p className="mt-2 text-sm text-paper/60 leading-relaxed">
              {clip && clip.canDecode
                ? 'A smooth copy should fix it. Use the button below.'
                : 'Some camera formats, like 10-bit or RAW, need an editing app or VLC. The file itself is fine.'}
            </p>
          </div>
        ) : it.kind === 'photo' ? (
          url && <img src={url} alt={it.name} className="max-h-full max-w-full object-contain" />
        ) : (
          url && (
            <video
              ref={video}
              key={url}
              src={url}
              controls
              autoPlay
              playsInline
              className="max-h-full max-w-full"
              preload="auto"
              onError={() => setFailed(true)}
              onWaiting={onWaiting}
              onPlaying={onPlaying}
              onLoadedMetadata={(e) => {
                const v = e.currentTarget
                v.playbackRate = rate
                setInfo((old) => ({ jpeg: old?.jpeg || '', duration: v.duration, width: v.videoWidth, height: v.videoHeight }))
              }}
              onEnded={() => autoNext && index < count - 1 && go(1)}
            />
          )
        )}
        <button
          onClick={() => go(-1)}
          disabled={index === 0}
          className="absolute left-3 top-1/2 -translate-y-1/2 flex size-10 items-center justify-center rounded-full bg-paper/10 text-paper hover:bg-paper/20 disabled:opacity-20"
          aria-label="Previous clip"
        >
          <CaretUp size={18} weight="bold" className="-rotate-90" />
        </button>
        <button
          onClick={() => go(1)}
          disabled={index === count - 1}
          className="absolute right-3 top-1/2 -translate-y-1/2 flex size-10 items-center justify-center rounded-full bg-paper/10 text-paper hover:bg-paper/20 disabled:opacity-20"
          aria-label="Next clip"
        >
          <CaretDown size={18} weight="bold" className="-rotate-90" />
        </button>
      </div>

      {showHelp && (
        <div className="shrink-0 flex flex-wrap items-center gap-x-4 gap-y-2 px-4 md:px-6 py-3 text-sm bg-paper/[0.06] text-paper/85 border-t border-paper/10">
          <span className="flex-1 min-w-[260px] leading-relaxed">
            {clip && !clip.canDecode
              ? "This clip can't play in a browser."
              : failed
                ? "This clip won't play directly."
                : stutter
                  ? 'This clip is stuttering.'
                  : 'This clip may stutter.'}{' '}
            {clip?.why || 'It is heavy for this computer to play in a browser.'}{' '}
            {clip?.canDecode !== false && 'A smooth 1080p copy plays without hiccups. It keeps the frame rate, and the original is not touched.'}
          </span>
          {clip?.canDecode !== false &&
            (making !== null ? (
              <span className="flex items-center gap-3">
                <span className="num tabular-nums">Making smooth copy {Math.floor(making * 100)}%</span>
                <button className="text-paper/60 hover:text-paper underline underline-offset-4" onClick={() => makeCtl.current?.abort()}>
                  Cancel
                </button>
              </span>
            ) : (
              <button onClick={makeSmooth} className="h-8 rounded-md bg-paper px-3 text-sm font-medium text-ink hover:bg-paper/90">
                Play a smooth copy
              </button>
            ))}
          {makeErr && <span className="w-full text-tally">{makeErr}</span>}
        </div>
      )}
      <div className="shrink-0 flex flex-wrap items-center gap-x-6 gap-y-2 px-4 md:px-6 py-3 text-sm text-paper/70 border-t border-paper/10">
        <span className="num tabular-nums">
          {[
            clip?.label || (info?.width && info?.height ? `${info.width}×${info.height}` : ''),
            info?.duration ? clock(info.duration) : '',
            bytes(it.size),
            peekThumb(it.key)?.taken ? `Recorded ${longDate(peekThumb(it.key)!.taken!)}` : `Modified ${longDate(it.modified)}`,
          ]
            .filter(Boolean)
            .join('  ·  ')}
        </span>
        {smooth && (
          <span className="flex items-center rounded-md border border-paper/15 p-0.5 text-xs">
            <button
              onClick={() => setUseSmooth(false)}
              className={`h-6 rounded px-2 ${!useSmooth ? 'bg-paper text-ink' : 'text-paper/70 hover:bg-paper/10'}`}
            >
              Original
            </button>
            <button
              onClick={() => setUseSmooth(true)}
              className={`h-6 rounded px-2 ${useSmooth ? 'bg-paper text-ink' : 'text-paper/70 hover:bg-paper/10'}`}
            >
              Smooth copy
            </button>
          </span>
        )}
        {it.kind === 'video' && (
          <>
            <span className="flex items-center gap-1">
              {SPEEDS.map((s) => (
                <button
                  key={s}
                  onClick={() => setRate(s)}
                  className={`num h-7 rounded px-2 text-xs ${rate === s ? 'bg-paper text-ink' : 'text-paper/70 hover:bg-paper/10'}`}
                >
                  {s}x
                </button>
              ))}
            </span>
            <label className="flex items-center gap-2 cursor-pointer select-none">
              <input
                type="checkbox"
                className="size-4"
                checked={autoNext}
                onChange={(e) => {
                  setAutoNext(e.target.checked)
                  setJSON('viewer-player', { autoNext: e.target.checked })
                }}
              />
              Play next automatically
            </label>
          </>
        )}
        <span className="ml-auto hidden lg:inline text-xs text-paper/40">
          Space play/pause · ← → skip 5s · , . step a frame · ↑ ↓ previous/next clip · S star · Esc close
        </span>
      </div>
    </div>
  )
}
