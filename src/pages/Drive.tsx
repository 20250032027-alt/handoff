import { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowRight, CaretRight, Check, FileText, FilmStrip, FolderSimple, Image as ImageIcon, Play, Warning, X } from '@phosphor-icons/react'
import {
  DRIVE_KEY,
  DriveError,
  getMeta,
  listFolder,
  parseDriveLink,
  previewUrl,
  saveAsZip,
  saveToFolder,
  type DriveItem,
  type SaveProgress,
} from '../lib/drive'
import { SpeedMeter, bytes, duration, plural, speed } from '../lib/format'
import { Bar, Button, Pill, Shell, inputClass, useLeaveWarning, useTitle, useWakeLock } from '../components/ui'

const canSave = typeof window !== 'undefined' && 'showDirectoryPicker' in window

interface Crumb {
  id: string
  resourceKey: string
  name: string
  path: string
}

type Job = {
  mode: 'folder' | 'zip'
  target: string
  total: number
  totalFiles: number
  p: SaveProgress
  speed: number
  finished: boolean
  error: string
}

export default function Drive() {
  const [link, setLink] = useState(() => new URLSearchParams(window.location.search).get('link') || '')
  const [crumbs, setCrumbs] = useState<Crumb[]>([])
  const [items, setItems] = useState<DriveItem[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [videosOnly, setVideosOnly] = useState(false)
  const [picked, setPicked] = useState<Map<string, DriveItem>>(new Map())
  const [preview, setPreview] = useState<DriveItem | null>(null)
  const [job, setJob] = useState<Job | null>(null)
  const [busyFolder, setBusyFolder] = useState('')
  const abort = useRef<AbortController | null>(null)

  const running = !!job && !job.finished
  useWakeLock(running)
  useLeaveWarning(running)
  useTitle(running && job ? `${Math.floor((job.p.bytes / Math.max(1, job.total)) * 100)}% saving · Dailies` : 'From Drive · Dailies')

  const open = async (e?: React.FormEvent) => {
    e?.preventDefault()
    setError('')
    const parsed = parseDriveLink(link)
    if (!parsed) return setError("That doesn't look like a Google Drive link.")
    setLoading(true)
    setPicked(new Map())
    try {
      const meta = await getMeta(parsed)
      if (meta.isFolder) {
        const root = { id: meta.id, resourceKey: meta.resourceKey || parsed.resourceKey, name: meta.name, path: '' }
        setCrumbs([root])
        setItems(await listFolder(root, ''))
      } else {
        setCrumbs([{ id: meta.id, resourceKey: '', name: meta.name, path: '' }])
        setItems([meta])
        setPicked(new Map([[meta.id, meta]]))
      }
      const url = new URL(window.location.href)
      url.searchParams.set('link', link.trim())
      history.replaceState(null, '', url)
    } catch (err) {
      setItems(null)
      setError(err instanceof DriveError ? err.message : 'Couldn\'t reach Google Drive. Check your connection and try again.')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (link && DRIVE_KEY) void open()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const enter = async (f: DriveItem) => {
    const here = crumbs[crumbs.length - 1]
    const c = { id: f.id, resourceKey: f.resourceKey, name: f.name, path: [here.path, f.name].filter(Boolean).join('/') }
    setLoading(true)
    try {
      setItems(await listFolder(c, c.path))
      setCrumbs([...crumbs, c])
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setLoading(false)
    }
  }

  const goTo = async (i: number) => {
    const c = crumbs[i]
    setLoading(true)
    try {
      setItems(await listFolder(c, c.path))
      setCrumbs(crumbs.slice(0, i + 1))
    } finally {
      setLoading(false)
    }
  }

  const downloadable = (f: DriveItem) => !f.isFolder && !f.isGoogleDoc
  const visible = useMemo(
    () => (items || []).filter((f) => !videosOnly || f.isFolder || f.isVideo),
    [items, videosOnly],
  )
  const folders = visible.filter((f) => f.isFolder)
  const files = visible.filter((f) => !f.isFolder)
  const allHerePicked = files.filter(downloadable).length > 0 && files.filter(downloadable).every((f) => picked.has(f.id))

  const toggle = (f: DriveItem) => {
    if (!downloadable(f) || running) return
    const next = new Map(picked)
    if (next.has(f.id)) next.delete(f.id)
    else next.set(f.id, f)
    setPicked(next)
  }

  const toggleAllHere = () => {
    const next = new Map(picked)
    for (const f of files.filter(downloadable)) allHerePicked ? next.delete(f.id) : next.set(f.id, f)
    setPicked(next)
  }

  // Pick everything inside a folder, including its subfolders.
  const pickFolder = async (f: DriveItem) => {
    const here = crumbs[crumbs.length - 1]
    setBusyFolder(f.id)
    try {
      const next = new Map(picked)
      const walk = async (id: string, rk: string, path: string) => {
        for (const it of await listFolder({ id, resourceKey: rk }, path)) {
          if (it.isFolder) await walk(it.id, it.resourceKey, [path, it.name].join('/'))
          else if (downloadable(it) && (!videosOnly || it.isVideo)) next.set(it.id, it)
        }
      }
      await walk(f.id, f.resourceKey, [here.path, f.name].filter(Boolean).join('/'))
      setPicked(next)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusyFolder('')
    }
  }

  const selection = Array.from(picked.values())
  const selBytes = selection.reduce((a, f) => a + f.size, 0)

  const run = async (mode: 'folder' | 'zip') => {
    const list = [...selection].sort((a, b) => (a.path + '/' + a.name).localeCompare(b.path + '/' + b.name, undefined, { numeric: true }))
    let target = ''
    let dir: FileSystemDirectoryHandle | null = null
    let file: FileSystemFileHandle | null = null
    try {
      if (mode === 'folder') {
        dir = await window.showDirectoryPicker({ id: 'dailies-drive', mode: 'readwrite' })
        target = dir.name
      } else {
        const base = (crumbs[0]?.name || 'drive-footage').replace(/[\\/:*?"<>|]/g, '_')
        file = await window.showSaveFilePicker({
          id: 'dailies-zip',
          suggestedName: `${base}.zip`,
          types: [{ description: 'Zip archive', accept: { 'application/zip': ['.zip'] } }],
        })
        target = file.name
      }
    } catch {
      return // closed the picker
    }
    const ctl = new AbortController()
    abort.current = ctl
    const meter = new SpeedMeter()
    const fresh: Job = {
      mode,
      target,
      total: selBytes,
      totalFiles: list.length,
      p: { bytes: 0, current: '', done: 0, failed: [], skipped: 0 },
      speed: 0,
      finished: false,
      error: '',
    }
    setJob(fresh)
    let last = 0
    const onProgress = (p: SaveProgress) => {
      const now = performance.now()
      if (now - last < 150 && p.current) return
      last = now
      meter.add(p.bytes)
      setJob((j) => (j ? { ...j, p, speed: meter.rate } : j))
    }
    try {
      const p = mode === 'folder' ? await saveToFolder(list, dir!, ctl.signal, onProgress) : await saveAsZip(list, file!, ctl.signal, onProgress)
      setJob((j) => (j ? { ...j, p, finished: true, speed: 0, error: ctl.signal.aborted ? 'Stopped.' : '' } : j))
    } catch (err) {
      setJob((j) => (j ? { ...j, finished: true, speed: 0, error: (err as Error).message } : j))
    }
  }

  if (!DRIVE_KEY) {
    return (
      <Shell nav="drive">
        <div className="max-w-xl rise">
          <h1 className="text-3xl md:text-4xl font-semibold tracking-tight leading-tight">Drive import isn't switched on yet.</h1>
          <p className="mt-4 text-ink-2 leading-relaxed">
            Whoever runs this site needs to add a free Google API key. It takes about five minutes, and the steps are in the README
            under "Turning on Drive import".
          </p>
        </div>
      </Shell>
    )
  }

  return (
    <Shell nav="drive">
      <section className="rise max-w-3xl">
        <h1 className="text-3xl md:text-[40px] font-semibold tracking-tight leading-[1.1]">Get footage out of a Drive link.</h1>
        <p className="mt-4 text-ink-2 leading-relaxed max-w-[62ch]">
          Paste a shared folder. Play clips right here, tick the ones you want, and save them in one go, either straight into a
          folder or as a single zip. No splitting into 2 GB zip parts, and no "can't scan for viruses" pop-up on every big file.
        </p>
        <form onSubmit={open} className="mt-8 flex flex-col sm:flex-row gap-3">
          <input
            className={inputClass + ' sm:flex-1 h-12'}
            value={link}
            onChange={(e) => setLink(e.target.value)}
            placeholder="https://drive.google.com/drive/folders/..."
            spellCheck={false}
          />
          <Button size="lg" type="submit" disabled={loading || !link.trim()}>
            {loading && !items ? 'Opening...' : 'Open'}
            <ArrowRight size={18} weight="bold" />
          </Button>
        </form>
        {error && (
          <p className="mt-3 text-sm text-tally flex items-start gap-2">
            <Warning size={16} weight="bold" className="mt-0.5 shrink-0" />
            {error}
          </p>
        )}
        {!items && !error && (
          <p className="mt-3 text-sm text-muted">The folder has to be shared as "Anyone with the link". You don't need to sign in.</p>
        )}
        {!canSave && (
          <p className="mt-3 text-sm text-warn">You can browse and preview here, but saving needs Chrome or Edge on a computer.</p>
        )}
      </section>

      {items && (
        <section className="mt-12 pb-28">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-3 border-b border-line pb-3">
            <nav className="flex flex-wrap items-center gap-1 text-sm min-w-0">
              {crumbs.map((c, i) => (
                <span key={c.id} className="flex items-center gap-1 min-w-0">
                  {i > 0 && <CaretRight size={12} weight="bold" className="text-muted" />}
                  <button
                    className={`truncate max-w-[220px] ${i === crumbs.length - 1 ? 'font-semibold text-ink' : 'text-muted hover:text-ink'}`}
                    onClick={() => i < crumbs.length - 1 && goTo(i)}
                  >
                    {c.name}
                  </button>
                </span>
              ))}
            </nav>
            <div className="ml-auto flex items-center gap-4 text-sm">
              <label className="flex items-center gap-2 text-ink-2 cursor-pointer select-none">
                <input type="checkbox" className="size-4 accent-[#1c1b19]" checked={videosOnly} onChange={(e) => setVideosOnly(e.target.checked)} />
                Videos only
              </label>
              {files.some(downloadable) && (
                <button className="text-ink-2 hover:text-ink" onClick={toggleAllHere} disabled={running}>
                  {allHerePicked ? 'Unselect all here' : 'Select all here'}
                </button>
              )}
            </div>
          </div>

          {loading && <div className="py-10 text-sm text-muted">Loading...</div>}

          {!loading && visible.length === 0 && (
            <div className="py-14 text-center text-ink-2">
              {videosOnly ? 'No videos in this folder.' : 'This folder is empty.'}
            </div>
          )}

          {!loading && folders.length > 0 && (
            <ul className="divide-y divide-line">
              {folders.map((f) => (
                <li key={f.id} className="flex items-center gap-3 py-3">
                  <button className="flex flex-1 items-center gap-3 min-w-0 text-left hover:text-ink" onClick={() => enter(f)}>
                    <FolderSimple size={20} weight="fill" className="text-muted shrink-0" />
                    <span className="truncate font-medium">{f.name}</span>
                  </button>
                  <Button kind="ghost" size="sm" onClick={() => pickFolder(f)} disabled={!!busyFolder || running}>
                    {busyFolder === f.id ? 'Adding...' : 'Select everything inside'}
                  </Button>
                </li>
              ))}
            </ul>
          )}

          {!loading && files.length > 0 && (
            <div className="mt-6 grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-x-4 gap-y-7">
              {files.map((f, i) => (
                <Tile key={f.id} f={f} i={i} on={picked.has(f.id)} can={downloadable(f)} toggle={() => toggle(f)} play={() => setPreview(f)} />
              ))}
            </div>
          )}
        </section>
      )}

      {(selection.length > 0 || job) && (
        <div className="fixed inset-x-0 bottom-0 z-20 border-t border-line bg-paper/95 backdrop-blur">
          <div className="max-w-5xl mx-auto px-5 md:px-8 py-4">
            {job ? <JobBar job={job} stop={() => abort.current?.abort()} close={() => setJob(null)} /> : (
              <div className="flex flex-col sm:flex-row sm:items-center gap-3">
                <div className="flex-1 min-w-0">
                  <p className="font-medium">
                    <span className="tabular-nums">{plural(selection.length, 'file')}</span> selected,{' '}
                    <span className="tabular-nums">{bytes(selBytes)}</span>
                  </p>
                  <button className="text-sm text-muted hover:text-ink" onClick={() => setPicked(new Map())}>
                    Clear selection
                  </button>
                </div>
                <div className="flex gap-3">
                  <Button kind="secondary" size="lg" disabled={!canSave} onClick={() => run('zip')}>
                    One .zip
                  </Button>
                  <Button size="lg" disabled={!canSave} onClick={() => run('folder')}>
                    <FolderSimple size={18} weight="bold" /> Save to a folder
                  </Button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {preview && <Preview f={preview} close={() => setPreview(null)} on={picked.has(preview.id)} toggle={() => toggle(preview)} />}
    </Shell>
  )
}

function Tile({ f, i, on, can, toggle, play }: { f: DriveItem; i: number; on: boolean; can: boolean; toggle: () => void; play: () => void }) {
  const [broken, setBroken] = useState(false)
  const Icon = f.isVideo ? FilmStrip : f.isImage ? ImageIcon : FileText
  return (
    <div className="rise group" style={{ ['--i' as string]: Math.min(i, 12) }}>
      <div
        className={`relative aspect-video overflow-hidden rounded-lg border bg-ink/[0.04] transition-colors ${on ? 'border-ink ring-1 ring-ink' : 'border-line'}`}
      >
        {f.thumb && !broken ? (
          <img src={f.thumb} alt="" loading="lazy" referrerPolicy="no-referrer" onError={() => setBroken(true)} className="size-full object-cover" />
        ) : (
          <div className="size-full flex items-center justify-center text-muted">
            <Icon size={28} />
          </div>
        )}
        {(f.isVideo || f.isImage) && (
          <button
            onClick={play}
            className="absolute inset-0 flex items-center justify-center bg-ink/0 opacity-0 transition-[opacity,background-color] group-hover:opacity-100 group-hover:bg-ink/25 focus-visible:opacity-100"
            aria-label={`Preview ${f.name}`}
          >
            <span className="flex size-11 items-center justify-center rounded-full bg-paper/95 text-ink">
              <Play size={18} weight="fill" />
            </span>
          </button>
        )}
        {can && (
          <button
            onClick={toggle}
            aria-label={on ? 'Unselect' : 'Select'}
            className={`absolute left-2 top-2 flex size-6 items-center justify-center rounded-md border transition-colors ${
              on ? 'bg-ink border-ink text-paper' : 'bg-paper/90 border-ink/20 text-transparent hover:border-ink/50'
            }`}
          >
            <Check size={14} weight="bold" />
          </button>
        )}
        {f.duration > 0 && (
          <span className="num absolute right-2 bottom-2 rounded bg-ink/80 px-1.5 py-0.5 text-[11px] text-paper">{clock(f.duration)}</span>
        )}
      </div>
      <button onClick={can ? toggle : undefined} className="mt-2.5 block w-full text-left">
        <span className="block truncate text-sm font-medium">{f.name}</span>
        <span className="num block text-xs text-muted mt-0.5">
          {f.isGoogleDoc ? 'Google file, skip' : [bytes(f.size), f.height ? `${f.height}p` : ''].filter(Boolean).join(' · ')}
        </span>
      </button>
    </div>
  )
}

function clock(ms: number) {
  const s = Math.round(ms / 1000)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const ss = String(s % 60).padStart(2, '0')
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`
}

function Preview({ f, close, on, toggle }: { f: DriveItem; close: () => void; on: boolean; toggle: () => void }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && close()
    window.addEventListener('keydown', k)
    return () => window.removeEventListener('keydown', k)
  }, [close])
  return (
    <div className="fixed inset-0 z-30 flex items-center justify-center bg-ink/70 p-4 md:p-10" onClick={close}>
      <div className="w-full max-w-5xl rounded-xl bg-paper overflow-hidden" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-4 px-5 h-14 border-b border-line">
          <span className="truncate font-medium flex-1">{f.name}</span>
          <span className="num text-sm text-muted hidden sm:inline">{bytes(f.size)}</span>
          <Button size="sm" kind={on ? 'primary' : 'secondary'} onClick={toggle}>
            {on ? <Check size={14} weight="bold" /> : null}
            {on ? 'Selected' : 'Select'}
          </Button>
          <button onClick={close} className="text-muted hover:text-ink" aria-label="Close">
            <X size={18} weight="bold" />
          </button>
        </div>
        <div className="aspect-video bg-ink">
          <iframe src={previewUrl(f)} className="size-full" allow="autoplay; fullscreen" allowFullScreen title={f.name} />
        </div>
        <p className="px-5 py-3 text-xs text-muted">
          Preview plays Google's streaming copy, which can look softer than the original. What you save is the original file.
        </p>
      </div>
    </div>
  )
}

function JobBar({ job, stop, close }: { job: Job; stop: () => void; close: () => void }) {
  const pct = job.p.bytes / Math.max(1, job.total)
  const left = job.speed > 0 ? (job.total - job.p.bytes) / job.speed : NaN
  if (job.finished) {
    const ok = job.p.done + job.p.skipped
    return (
      <div className="flex flex-col sm:flex-row sm:items-center gap-3">
        <div className="flex-1 min-w-0">
          {job.error && job.error !== 'Stopped.' ? (
            <p className="font-medium text-tally flex items-center gap-2">
              <Warning size={16} weight="bold" /> Something went wrong: {job.error}
            </p>
          ) : (
            <p className="font-medium flex items-center gap-2">
              {job.error ? null : <Check size={16} weight="bold" className="text-ok" />}
              {job.error ? 'Stopped. ' : ''}
              Saved <span className="tabular-nums">{plural(ok, 'file')}</span> {job.mode === 'zip' ? `into ${job.target}` : `to ${job.target}`}.
              {job.p.skipped > 0 && <span className="text-muted font-normal"> {job.p.skipped} were already there.</span>}
            </p>
          )}
          {job.p.failed.length > 0 && (
            <details className="mt-1 text-sm text-warn">
              <summary className="cursor-pointer">{plural(job.p.failed.length, 'file')} couldn't be saved</summary>
              <ul className="mt-2 flex flex-col gap-1 text-ink-2">
                {job.p.failed.map((f) => (
                  <li key={f.name}>
                    <span className="num">{f.name}</span>: {f.why}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
        <Button kind="secondary" onClick={close}>
          Done
        </Button>
      </div>
    )
  }
  return (
    <div>
      <div className="flex items-center gap-4">
        <Pill tone="live" pulse>
          Saving
        </Pill>
        <span className="num text-sm text-ink-2 truncate flex-1">{job.p.current}</span>
        <Button kind="ghost" size="sm" onClick={stop}>
          <X size={14} weight="bold" /> Stop
        </Button>
      </div>
      <div className="mt-3">
        <Bar value={pct} live />
      </div>
      <div className="num mt-2 flex flex-wrap gap-x-6 gap-y-1 text-sm text-muted">
        <span className="text-ink">{Math.floor(pct * 100)}%</span>
        <span>
          {bytes(job.p.bytes)} / {bytes(job.total)}
        </span>
        <span>
          {job.p.done + job.p.skipped}/{job.totalFiles} files
        </span>
        <span>{speed(job.speed)}</span>
        <span>{duration(left)} left</span>
      </div>
    </div>
  )
}
