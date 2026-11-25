import { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowRight, CaretRight, Check, FileText, FilmStrip, FolderSimple, Image as ImageIcon, Lightning, Play, Warning, X } from '@phosphor-icons/react'
import { CAPS_GB, QUALITIES, canPickProxyFolder, canPreload, driveCache } from '../lib/driveCache'
import { canStreamDownload, downloadStream } from '../lib/download'
import { getLocal, setLocal } from '../lib/store'
import { folderFileNames, zipFileNames } from '../lib/zipNames'
import {
  DRIVE_KEY,
  DriveError,
  getMeta,
  listFolder,
  parseDriveLink,
  previewUrl,
  saveAsZip,
  saveToFolder,
  shotTime,
  type DriveItem,
  type SaveProgress,
} from '../lib/drive'
import { SpeedMeter, bytes, dateRange, duration, longDate, plural, shortDate, speed, summary } from '../lib/format'
import { Bar, Button, Pill, Shell, inputClass, useLeaveWarning, useTitle, useWakeLock } from '../components/ui'

const canFolder = typeof window !== 'undefined' && 'showDirectoryPicker' in window
const canZip = typeof window !== 'undefined' && (typeof window.showSaveFilePicker === 'function' || canStreamDownload())

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
  const [videosOnly, setVideosOnlyState] = useState(() => getLocal('drive-videos-only') === '1')
  const setVideosOnly = (v: boolean) => {
    setVideosOnlyState(v)
    setLocal('drive-videos-only', v ? '1' : '0')
  }
  const [picked, setPicked] = useState<Map<string, DriveItem>>(new Map())
  const [preview, setPreview] = useState<DriveItem | null>(null)
  const [job, setJob] = useState<Job | null>(null)
  const [busyFolder, setBusyFolder] = useState('')
  const abort = useRef<AbortController | null>(null)
  const [, bump] = useState(0)
  useEffect(() => driveCache.subscribe(() => bump((n) => n + 1)), [])
  // Pick an unfinished preload back up after a refresh.
  useEffect(() => {
    if (DRIVE_KEY && canPreload()) driveCache.resume()
  }, [])
  const [preloadMenu, setPreloadMenu] = useState(false)

  const running = !!job && !job.finished
  useWakeLock(running)
  useLeaveWarning(running)
  useTitle(running && job ? `${Math.floor((job.p.bytes / Math.max(1, job.total)) * 100)}% saving · Handoff` : 'From Drive · Handoff')

  const open = async (e?: React.FormEvent) => {
    e?.preventDefault()
    setError('')
    const parsed = parseDriveLink(link)
    if (!parsed) return setError("That doesn't look like a Google Drive link.")
    setLoading(true)
    setPicked(new Map())
    setOnlyIds(null)
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
  const [namePicker, setNamePicker] = useState<false | 'only' | 'except'>(false)
  const [onlyIds, setOnlyIds] = useState<Set<string> | null>(null)
  const visible = useMemo(
    () => (items || []).filter((f) => (!videosOnly || f.isFolder || f.isVideo) && (!onlyIds || f.isFolder || onlyIds.has(f.id))),
    [items, videosOnly, onlyIds],
  )
  const folders = visible.filter((f) => f.isFolder)
  const [sort, setSortState] = useState<string>(() => getLocal('drive-sort') || 'name')
  const setSort = (v: string) => {
    setSortState(v)
    setLocal('drive-sort', v)
  }
  const files = useMemo(() => {
    const list = visible.filter((f) => !f.isFolder)
    if (sort === 'newest') list.sort((a, b) => shotTime(b) - shotTime(a))
    else if (sort === 'oldest') list.sort((a, b) => shotTime(a) - shotTime(b))
    else if (sort === 'largest') list.sort((a, b) => b.size - a.size)
    return list
  }, [visible, sort])
  const here = useMemo(() => (items || []).filter((f) => !f.isFolder), [items])
  const hereTimes = here.map(shotTime).filter(Boolean)
  // Totals including every subfolder, worked out on request.
  const [deep, setDeep] = useState<{ id: string; text: string } | 'loading' | null>(null)
  const countDeep = async () => {
    const top = crumbs[crumbs.length - 1]
    setDeep('loading')
    try {
      const all: DriveItem[] = []
      let subfolders = 0
      const walk = async (id: string, rk: string, path: string) => {
        for (const it of await listFolder({ id, resourceKey: rk }, path)) {
          if (it.isFolder) {
            subfolders++
            await walk(it.id, it.resourceKey, [path, it.name].filter(Boolean).join('/'))
          } else all.push(it)
        }
      }
      await walk(top.id, top.resourceKey, top.path)
      const t = all.map(shotTime).filter(Boolean)
      setDeep({
        id: top.id,
        text: `${summary(all)} across ${plural(subfolders + 1, 'folder')}${t.length ? `, ${dateRange(Math.min(...t), Math.max(...t))}` : ''}`,
      })
    } catch (e) {
      setDeep(null)
      setError((e as Error).message)
    }
  }
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

  // Pick files by a list of names. "only" picks the ones on the list (like failed
  // downloads); "except" picks everything NOT on it (what you don't have yet).
  const selectByNames = async (text: string, deepSearch: boolean, mode: 'only' | 'except'): Promise<NameResult> => {
    const typed = new Map<string, string>()
    for (const n of text.match(/[^\s:,;"'<>|\\/]+\.[A-Za-z0-9]{2,5}\b/g) || []) if (!typed.has(n.toLowerCase())) typed.set(n.toLowerCase(), n)
    if (!typed.size) return { mode, found: 0, matched: 0, missing: [], none: true }
    const pool: DriveItem[] = (items || []).filter(downloadable)
    if (deepSearch) {
      const top = crumbs[crumbs.length - 1]
      const walk = async (id: string, rk: string, path: string) => {
        for (const it of await listFolder({ id, resourceKey: rk }, path)) {
          if (it.isFolder) await walk(it.id, it.resourceKey, [path, it.name].filter(Boolean).join('/'))
          else if (downloadable(it)) pool.push(it)
        }
      }
      for (const f of (items || []).filter((x) => x.isFolder)) await walk(f.id, f.resourceKey, [top.path, f.name].filter(Boolean).join('/'))
    }
    const next = new Map(picked)
    if (mode === 'except') {
      const left = pool.filter((f) => !typed.has(f.name.toLowerCase()))
      for (const f of left) next.set(f.id, f)
      setPicked(next)
      setOnlyIds(new Set(left.map((f) => f.id)))
      return { mode, found: left.length, matched: pool.length - left.length, missing: [], none: false, bytes: left.reduce((a, f) => a + f.size, 0) }
    }
    const byName = new Map<string, DriveItem[]>()
    for (const f of pool) byName.set(f.name.toLowerCase(), [...(byName.get(f.name.toLowerCase()) || []), f])
    let found = 0
    const missing: string[] = []
    for (const [w, original] of typed) {
      const hits = byName.get(w)
      if (!hits) missing.push(original)
      else
        for (const h of hits) {
          if (!next.has(h.id)) found++
          next.set(h.id, h)
        }
    }
    setPicked(next)
    return { mode, found, matched: found, missing, none: false }
  }

  const selection = Array.from(picked.values())
  const selBytes = selection.reduce((a, f) => a + f.size, 0)

  const run = async (mode: 'folder' | 'zip') => {
    const list = [...selection].sort((a, b) => (a.path + '/' + a.name).localeCompare(b.path + '/' + b.name, undefined, { numeric: true }))
    let target = ''
    let dir: FileSystemDirectoryHandle | null = null
    let out: WritableStream<Uint8Array> | null = null
    try {
      if (mode === 'folder') {
        dir = await window.showDirectoryPicker({ id: 'handoff-drive', mode: 'readwrite' })
        target = dir.name
      } else {
        const base = (crumbs[0]?.name || 'drive-footage').replace(/[\\/:*?"<>|]/g, '_')
        if (typeof window.showSaveFilePicker === 'function') {
          const file = await window.showSaveFilePicker({
            id: 'handoff-zip',
            suggestedName: `${base}.zip`,
            types: [{ description: 'Zip archive', accept: { 'application/zip': ['.zip'] } }],
          })
          out = await file.createWritable()
          target = file.name
        } else {
          out = await downloadStream(`${base}.zip`)
          target = `${base}.zip in Downloads`
        }
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
      const p = mode === 'folder' ? await saveToFolder(list, dir!, ctl.signal, onProgress) : await saveAsZip(list, out!, ctl.signal, onProgress)
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
        {!canFolder && canZip && (
          <p className="mt-3 text-sm text-muted">Saving into a folder needs Chrome, Edge or Opera. Saving as one .zip works in this browser.</p>
        )}
        {!canFolder && !canZip && <p className="mt-3 text-sm text-muted">You can browse and preview here. Saving needs a computer.</p>}
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
              {!running && (
                <>
                  <button className="text-ink-2 hover:text-ink" onClick={() => setNamePicker('except')}>
                    Find what's missing
                  </button>
                  <button className="text-ink-2 hover:text-ink" onClick={() => setNamePicker('only')}>
                    Select by name
                  </button>
                </>
              )}
              {canPreload() && files.some(downloadable) && (
                <div className="relative">
                  <Button kind="secondary" size="sm" onClick={() => setPreloadMenu((o) => !o)}>
                    <Lightning size={14} weight="bold" /> Preload
                  </Button>
                  {preloadMenu && (
                    <PreloadMenu
                      selected={selection}
                      here={files.filter((f) => downloadable(f) && f.isVideo)}
                      hasSubfolders={folders.length > 0}
                      everything={async () => {
                        const here = crumbs[crumbs.length - 1]
                        const out: DriveItem[] = []
                        const walk = async (id: string, rk: string, path: string) => {
                          for (const it of await listFolder({ id, resourceKey: rk }, path)) {
                            if (it.isFolder) await walk(it.id, it.resourceKey, [path, it.name].filter(Boolean).join('/'))
                            else if (downloadable(it) && it.isVideo) out.push(it)
                          }
                        }
                        await walk(here.id, here.resourceKey, here.path)
                        return out
                      }}
                      close={() => setPreloadMenu(false)}
                    />
                  )}
                </div>
              )}
            </div>
          </div>
          {onlyIds && (
            <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 rounded-lg border border-line bg-warn-soft px-4 py-2.5 text-sm text-warn">
              <span>
                Showing only the {plural(onlyIds.size, 'file')} you don't have yet, across this folder and its subfolders. They're
                selected and ready to save.
              </span>
              <button className="underline underline-offset-4" onClick={() => setOnlyIds(null)}>
                Show everything
              </button>
            </div>
          )}
          <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted">
            <span className="tabular-nums">
              <span className="text-ink-2">In this folder:</span>{' '}
              {folders.length ? `${plural(folders.length, 'folder')}, ` : ''}
              {summary(here)}
              {hereTimes.length ? `, ${dateRange(Math.min(...hereTimes), Math.max(...hereTimes))}` : ''}
            </span>
            {folders.length > 0 &&
              (deep && deep !== 'loading' && deep.id === crumbs[crumbs.length - 1]?.id ? (
                <span className="tabular-nums">
                  <span className="text-ink-2">With subfolders:</span> {deep.text}
                </span>
              ) : (
                <button className="underline underline-offset-4 hover:text-ink" onClick={countDeep} disabled={deep === 'loading'}>
                  {deep === 'loading' ? 'Counting...' : 'Count subfolders too'}
                </button>
              ))}
            <select
              value={sort}
              aria-label="Sort"
              onChange={(e) => setSort(e.target.value)}
              className="ml-auto h-8 rounded-md border border-line bg-card px-2 text-sm text-ink"
            >
              <option value="name">By name</option>
              <option value="newest">Newest first</option>
              <option value="oldest">Oldest first</option>
              <option value="largest">Largest first</option>
            </select>
          </div>
          <PreloadStrip />

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
            {job ? (
              <JobBar
                job={job}
                stop={() => abort.current?.abort()}
                close={() => setJob(null)}
                retry={(list) => {
                  setPicked(new Map(list.map((f) => [f.id, f])))
                  setJob(null)
                }}
              />
            ) : (
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
                  <Button kind="secondary" size="lg" disabled={!canZip} onClick={() => run('zip')}>
                    One .zip
                  </Button>
                  <Button size="lg" disabled={!canFolder} onClick={() => run('folder')}>
                    <FolderSimple size={18} weight="bold" /> Save to a folder
                  </Button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {namePicker && <NamePicker initialMode={namePicker} hasFolders={folders.length > 0} run={selectByNames} close={() => setNamePicker(false)} />}
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
        <CacheBadge id={f.id} />
      </div>
      <button onClick={can ? toggle : undefined} className="mt-2.5 block w-full text-left">
        <span className="block truncate text-sm font-medium">{f.name}</span>
        <span className="num block text-xs text-muted mt-0.5 truncate">
          {f.isGoogleDoc ? 'Google file, skip' : [bytes(f.size), f.height ? `${f.height}p` : '', shortDate(shotTime(f))].filter(Boolean).join(' · ')}
        </span>
      </button>
    </div>
  )
}

function CacheBadge({ id }: { id: string }) {
  const st = driveCache.states.get(id)
  if (!st) return null
  const have = driveCache.qualityOf(id)
  if ((st.status === 'queued' || st.status === 'loading') && have) {
    // Still playable at the old quality while the new copy is being made.
    const q = QUALITIES.find((x) => x.id === have)
    return (
      <>
        <span className="absolute right-2 top-2 flex items-center gap-1 rounded-full bg-paper/95 px-2 py-0.5 text-[11px] font-medium text-ok">
          <Lightning size={11} weight="fill" /> Ready, {q?.label}
        </span>
        <span className="absolute inset-x-0 bottom-0 h-1 bg-ink/20">
          <span className="block h-full origin-left bg-paper transition-transform duration-300" style={{ transform: `scaleX(${st.progress})` }} />
        </span>
      </>
    )
  }
  if (st.status === 'ready') {
    const q = QUALITIES.find((x) => x.id === st.quality)
    return (
      <span className="absolute right-2 top-2 flex items-center gap-1 rounded-full bg-paper/95 px-2 py-0.5 text-[11px] font-medium text-ok">
        <Lightning size={11} weight="fill" /> Ready{q ? `, ${q.label}` : ''}
      </span>
    )
  }
  if (st.status === 'error')
    return (
      <span className="absolute right-2 top-2 max-w-[85%] truncate rounded-full bg-paper/95 px-2 py-0.5 text-[11px] font-medium text-warn" title={st.error}>
        Uses Google's preview
      </span>
    )
  return (
    <span className="absolute inset-x-0 bottom-0 h-1 bg-ink/20">
      <span className="block h-full origin-left bg-paper transition-transform duration-300" style={{ transform: `scaleX(${st.progress})` }} />
    </span>
  )
}

// Rough size of the preview copies, from clip lengths Drive reports.
function estimate(list: DriveItem[], quality: string): number | null {
  const q = QUALITIES.find((x) => x.id === quality)!
  if (q.id === 'original') return list.reduce((a, f) => a + f.size, 0)
  let secs = 0
  let unknown = 0
  for (const f of list) f.duration ? (secs += f.duration / 1000) : unknown++
  if (unknown > list.length / 2) return null
  const perSec = (q.bitrate + 128_000) / 8
  // Never more than the original itself.
  return list.reduce((a, f) => a + (f.duration ? Math.min(f.size, (f.duration / 1000) * perSec) : 0), 0) + (unknown ? (secs / Math.max(1, list.length - unknown)) * unknown * perSec : 0)
}

function PreloadMenu({
  selected,
  here,
  hasSubfolders,
  everything,
  close,
}: {
  selected: DriveItem[]
  here: DriveItem[]
  hasSubfolders: boolean
  everything: () => Promise<DriveItem[]>
  close: () => void
}) {
  const [listing, setListing] = useState(false)
  const c = driveCache
  const q = QUALITIES.find((x) => x.id === c.settings.quality)!
  const sum = (l: DriveItem[]) => l.reduce((a, f) => a + f.size, 0)
  const option = (title: string, list: DriveItem[]) => (
    <button
      disabled={!list.length}
      onClick={() => {
        void c.enqueue(list)
        close()
      }}
      className="w-full rounded-md px-3 py-2.5 text-left hover:bg-ink/[0.05] disabled:opacity-40 disabled:hover:bg-transparent"
    >
      <span className="block text-sm font-medium text-ink">{title}</span>
      <span className="num block text-xs text-muted mt-0.5">
        {plural(list.length, 'clip')}, {bytes(sum(list))} on Drive
        {list.length > 0 && c.settings.quality !== 'original' && estimate(list, c.settings.quality) !== null
          ? `, about ${bytes(estimate(list, c.settings.quality)!)} as ${q.label}`
          : ''}
      </span>
    </button>
  )
  return (
    <>
      <div className="fixed inset-0 z-10" onClick={close} />
      <div className="absolute right-0 top-10 z-20 w-[22rem] rounded-lg border border-line bg-card shadow-[0_12px_32px_-12px_rgba(28,27,25,0.3)]">
        <div className="p-4 border-b border-line">
          <p className="text-xs uppercase tracking-[0.08em] text-muted">Quality</p>
          <div className="mt-2 grid grid-cols-5 rounded-md border border-line p-0.5 text-xs">
            {QUALITIES.map((x) => (
              <button
                key={x.id}
                onClick={() => c.setQuality(x.id)}
                className={`h-7 rounded-[5px] font-medium ${x.id === c.settings.quality ? 'bg-ink text-paper' : 'text-ink-2 hover:bg-ink/[0.05]'}`}
              >
                {x.label}
              </button>
            ))}
          </div>
          <p className="mt-2 text-xs text-muted">
            {q.hint}.{' '}
            {q.id === 'original'
              ? 'Saving from Drive also gets faster, since nothing has to download again.'
              : `Takes about ${bytes((q.bitrate / 8) * 3600 + 58e6)} of space for every hour of video.`}
          </p>

          <div className="mt-4 flex items-center justify-between gap-3">
            <span className="text-xs uppercase tracking-[0.08em] text-muted">Space limit</span>
            <select
              value={c.settings.capGB}
              onChange={(e) => c.setCap(Number(e.target.value))}
              className="h-8 rounded-md border border-line bg-card px-2 text-sm"
            >
              {CAPS_GB.map((g) => (
                <option key={g} value={g}>
                  {g} GB
                </option>
              ))}
            </select>
          </div>
          <p className="mt-1.5 text-xs text-muted">When it fills up, the clips you looked at longest ago are removed to make room.</p>

          {canPickProxyFolder() && (
            <div className="mt-4 flex items-center justify-between gap-3 text-sm">
              <span className="text-xs uppercase tracking-[0.08em] text-muted">Stored in</span>
              <span className="flex items-center gap-2 min-w-0">
                <span className="truncate text-ink-2">{c.settings.where === 'folder' && c.folder ? c.folder.name : 'This browser'}</span>
                <button
                  className="shrink-0 text-muted underline underline-offset-4 hover:text-ink"
                  onClick={async () => {
                    try {
                      if (c.settings.where === 'folder') await c.useBrowser()
                      else await c.useFolder()
                    } catch {
                      /* closed the picker */
                    }
                  }}
                >
                  {c.settings.where === 'folder' ? 'use browser' : 'pick a folder'}
                </button>
              </span>
            </div>
          )}
        </div>
        <div className="p-2">
          {option('Selected clips', selected)}
          {option('All videos in this folder', here)}
          {hasSubfolders && (
            <button
              disabled={listing}
              onClick={async () => {
                setListing(true)
                try {
                  void c.enqueue(await everything())
                } finally {
                  setListing(false)
                  close()
                }
              }}
              className="w-full rounded-md px-3 py-2.5 text-left hover:bg-ink/[0.05] disabled:opacity-60"
            >
              <span className="block text-sm font-medium text-ink">Everything, including subfolders</span>
              <span className="block text-xs text-muted mt-0.5">{listing ? 'Finding every video...' : 'Good for leaving it running on a whole event'}</span>
            </button>
          )}
        </div>
        <p className="px-4 pb-4 text-xs text-muted leading-relaxed">
          Clips you open jump to the front of the line.{' '}
          {q.id === 'original'
            ? 'Downloads each original in the background and keeps it.'
            : `Each clip is read from Drive and shrunk to ${q.label} on this computer, and only the small copy is kept.`}{' '}
          Once a clip says Ready, it plays instantly. Keep this tab open while it works.
        </p>
      </div>
    </>
  )
}

function PreloadStrip() {
  const c = driveCache
  if (!c.busy && !c.readyCount && !c.error && !c.folderNeedsPermission) return null
  const q = QUALITIES.find((x) => x.id === c.settings.quality)!
  const space = (
    <span className="num text-muted">
      {bytes(c.usedBytes)} of {c.settings.capGB} GB used
    </span>
  )
  return (
    <div className="mt-4 rounded-lg border border-line bg-card px-4 py-3 text-sm">
      {c.error && <p className="text-tally mb-2">{c.error}</p>}
      {c.folderNeedsPermission && (
        <p className="mb-2 flex flex-wrap items-center gap-2 text-ink-2">
          Handoff needs permission to use your preload folder again.
          <button className="underline underline-offset-4 hover:text-ink" onClick={() => c.regrantFolder()}>
            Allow
          </button>
        </p>
      )}
      {c.busy ? (
        <>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
            <span className="flex items-center gap-2 font-medium">
              <Lightning size={14} weight="fill" className="text-tally" />
              {q.id === 'original' ? 'Preloading originals' : `Making ${q.label} copies`}
              {c.resumed && <span className="font-normal text-muted">(picked up where it left off)</span>}
            </span>
            <span className="num text-muted">
              {c.pendingCount
                ? `${c.clipsDoneInBatch} of ${plural(c.clipsInBatch, 'clip')} ready${isFinite(c.secondsLeft) ? `, about ${duration(c.secondsLeft)} left` : ''}`
                : 'Getting ready...'}
            </span>
            {space}
            <button className="ml-auto text-muted hover:text-ink" onClick={() => c.stop()}>
              Stop
            </button>
          </div>
          <div className="mt-2.5">
            <Bar value={c.batchProgress} live />
          </div>
        </>
      ) : (
        c.readyCount > 0 && (
          <>
          {c.otherQuality.length > 0 && (
            <div className="mb-2.5 pb-2.5 border-b border-line flex flex-wrap items-center gap-x-4 gap-y-1">
              <span className="text-ink-2">
                {plural(c.otherQuality.length, 'clip')} {c.otherQuality.length === 1 ? 'is' : 'are'} at a different quality than {q.label}.
              </span>
              <button className="text-ink underline underline-offset-4" onClick={() => c.remakeAll()}>
                Remake at {q.label}
              </button>
              <span className="text-xs text-muted">
                Lower-quality copies are made from the ones already here, so going down is quick and needs no internet.
              </span>
            </div>
          )}
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
            <span className="flex items-center gap-2 text-ink-2">
              <Lightning size={14} weight="fill" className="text-ok" />
              {plural(c.readyCount, 'clip')} ready to play instantly
            </span>
            {space}
            <button
              className="ml-auto text-muted hover:text-ink"
              onClick={() => confirm('Remove all preloaded copies? Your saved files and Drive are not affected.') && c.clear()}
            >
              Clear preloaded
            </button>
          </div>
          <p className="mt-1.5 text-xs text-muted">Preloaded copies stay after you refresh or close the tab.</p>
          </>
        )
      )}
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
  const [local, setLocal] = useState('')
  const [localFailed, setLocalFailed] = useState(false)
  useEffect(() => {
    driveCache.prioritize(f)
    let url = ''
    driveCache.file(f).then((file) => {
      if (file) {
        url = URL.createObjectURL(file)
        setLocal(url)
      }
    })
    return () => {
      if (url) URL.revokeObjectURL(url)
    }
  }, [f])
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
          {local && !localFailed && f.isVideo ? (
            <video src={local} controls autoPlay playsInline className="size-full" onError={() => setLocalFailed(true)} />
          ) : local && !localFailed && f.isImage ? (
            <img src={local} alt={f.name} className="size-full object-contain" onError={() => setLocalFailed(true)} />
          ) : (
            <iframe src={previewUrl(f)} className="size-full" allow="autoplay; fullscreen" allowFullScreen title={f.name} />
          )}
        </div>
        <p className="px-5 pt-3 text-xs text-ink-2 tabular-nums">
          {[
            f.taken ? `Shot ${longDate(f.taken)}` : f.modified ? `Modified ${longDate(Date.parse(f.modified))}` : '',
            f.created ? `Put on Drive ${longDate(f.created)}` : '',
            f.width && f.height ? `${f.width}×${f.height}` : '',
          ]
            .filter(Boolean)
            .join('  ·  ')}
        </p>
        <p className="px-5 pb-3 pt-1 text-xs text-muted">
          {local && !localFailed
            ? driveCache.qualityOf(f.id) === 'original'
              ? 'Playing the preloaded original, straight from this computer.'
              : `Playing your ${QUALITIES.find((x) => x.id === driveCache.qualityOf(f.id))?.label} preview copy. Saving still gets you the original.`
            : localFailed
              ? "This clip's format can't play in a browser, so this is Google's copy. The saved file is still the original."
              : "Preview plays Google's streaming copy, which can look softer than the original. What you save is the original file."}
        </p>
      </div>
    </div>
  )
}

type NameResult = { mode: 'only' | 'except'; found: number; matched: number; missing: string[]; none: boolean; bytes?: number }

function NamePicker({
  initialMode,
  hasFolders,
  run,
  close,
}: {
  initialMode: 'only' | 'except'
  hasFolders: boolean
  run: (text: string, deep: boolean, mode: 'only' | 'except') => Promise<NameResult>
  close: () => void
}) {
  const [text, setText] = useState('')
  const [mode, setMode] = useState<'only' | 'except'>(initialMode)
  const [deep, setDeep] = useState(true)
  const [busy, setBusy] = useState(false)
  const [loadedFrom, setLoadedFrom] = useState('')
  const [loadErr, setLoadErr] = useState('')
  const [result, setResult] = useState<NameResult | null>(null)
  const folderInput = useRef<HTMLInputElement>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && close()
    window.addEventListener('keydown', k)
    return () => window.removeEventListener('keydown', k)
  }, [close])

  const fill = (names: string[], from: string, nextMode?: 'only' | 'except') => {
    setText(names.join('\n'))
    setLoadedFrom(`${plural(names.length, 'name')} from ${from}`)
    setResult(null)
    setLoadErr('')
    if (nextMode) setMode(nextMode)
  }

  const fromFolder = async () => {
    if ('showDirectoryPicker' in window) {
      try {
        const dir = await window.showDirectoryPicker({ id: 'handoff-compare', mode: 'read' })
        fill(await folderFileNames(dir), dir.name, 'except')
      } catch {
        /* closed the picker */
      }
    } else folderInput.current?.click()
  }

  const fromFile = async (f: File) => {
    try {
      if (/\.zip$/i.test(f.name)) fill(await zipFileNames(f), f.name, 'except')
      else fill((await f.text()).split(/\r?\n/).filter((l) => l.trim()), f.name)
    } catch (e) {
      setLoadErr((e as Error).message)
    }
  }

  return (
    <div className="fixed inset-0 z-30 flex items-center justify-center bg-ink/60 p-4" onClick={close}>
      <input
        ref={folderInput}
        type="file"
        className="hidden"
        // @ts-expect-error non-standard but widely supported
        webkitdirectory=""
        multiple
        onChange={(e) => {
          const fl = e.target.files
          if (fl?.length) fill(Array.from(fl, (f) => f.name).filter((n) => !n.startsWith('.')), (fl[0].webkitRelativePath || '').split('/')[0] || 'that folder', 'except')
          e.target.value = ''
        }}
      />
      <input
        ref={fileInput}
        type="file"
        accept=".zip,.txt,text/plain,application/zip"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0]
          if (f) void fromFile(f)
          e.target.value = ''
        }}
      />
      <div className="w-full max-w-lg rounded-xl bg-paper p-6 shadow-xl max-h-[92vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-lg font-semibold tracking-tight">{initialMode === 'except' ? "Find what's missing" : 'Select by name'}</h2>
            <p className="mt-1 text-sm text-muted leading-relaxed">
              {initialMode === 'except'
                ? 'Point Handoff at the folder or zip you already downloaded. It selects every file here that is not in it yet.'
                : 'Paste file names, or load them from a folder, zip or .txt list.'}
            </p>
          </div>
          <button onClick={close} className="text-muted hover:text-ink" aria-label="Close">
            <X size={18} weight="bold" />
          </button>
        </div>

        <div className="mt-4 flex flex-wrap gap-2">
          <Button kind="secondary" size="sm" onClick={fromFolder}>
            <FolderSimple size={14} weight="bold" /> Load names from a folder
          </Button>
          <Button kind="secondary" size="sm" onClick={() => fileInput.current?.click()}>
            Load from a .zip or .txt
          </Button>
        </div>
        {loadedFrom && <p className="mt-2 text-xs text-ok">Loaded {loadedFrom}.</p>}
        {loadErr && <p className="mt-2 text-xs text-tally">{loadErr}</p>}

        <label className="mt-3 block">
          <span className="sr-only">File names</span>
          <textarea
            value={text}
            onChange={(e) => {
              setText(e.target.value)
              setLoadedFrom('')
              setResult(null)
            }}
            rows={7}
            className="num w-full rounded-md border border-line bg-card p-3 text-sm outline-none focus:border-ink/40"
          />
        </label>

        <div className="mt-3 flex flex-col gap-2 text-sm">
          <label className="flex items-start gap-2.5 cursor-pointer">
            <input type="radio" name="mode" className="mt-1 accent-[#1c1b19]" checked={mode === 'only'} onChange={() => (setMode('only'), setResult(null))} />
            <span>
              <span className="font-medium text-ink">Select the files on this list</span>
              <span className="block text-muted">For retrying failed downloads.</span>
            </span>
          </label>
          <label className="flex items-start gap-2.5 cursor-pointer">
            <input type="radio" name="mode" className="mt-1 accent-[#1c1b19]" checked={mode === 'except'} onChange={() => (setMode('except'), setResult(null))} />
            <span>
              <span className="font-medium text-ink">Select everything that's NOT on this list</span>
              <span className="block text-muted">For finding what you haven't downloaded yet. Only those files will show.</span>
            </span>
          </label>
        </div>

        {hasFolders && (
          <label className="mt-3 flex items-center gap-2 text-sm text-ink-2 cursor-pointer select-none">
            <input type="checkbox" className="size-4 accent-[#1c1b19]" checked={deep} onChange={(e) => setDeep(e.target.checked)} />
            Look inside subfolders too
          </label>
        )}

        {result && (
          <div className="mt-4 text-sm">
            {result.none ? (
              <p className="text-warn">No file names found in that text. Names need their extension, like .MOV or .MP4.</p>
            ) : result.mode === 'except' ? (
              <p className="text-ink">
                {result.found === 0
                  ? `You already have all ${plural(result.matched, 'file')}. Nothing is missing.`
                  : `${plural(result.found, 'file')} (${bytes(result.bytes || 0)}) ${result.found === 1 ? "isn't" : "aren't"} on your list, so ${result.found === 1 ? "it's" : "they're"} selected. ${result.matched} you already have ${result.matched === 1 ? 'was' : 'were'} left out.`}
              </p>
            ) : (
              <>
                <p className="text-ink">
                  Selected {plural(result.found, 'file')}.
                  {result.missing.length === 0 ? ' Every name matched.' : ''}
                </p>
                {result.missing.length > 0 && (
                  <p className="mt-1 text-muted">
                    Couldn't find {plural(result.missing.length, 'name')} here:{' '}
                    <span className="num">{result.missing.slice(0, 8).join(', ')}{result.missing.length > 8 ? ', ...' : ''}</span>
                  </p>
                )}
              </>
            )}
          </div>
        )}
        <div className="mt-5 flex justify-end gap-3">
          {result && !result.none ? (
            <Button onClick={close}>Done</Button>
          ) : (
            <>
              <Button kind="secondary" onClick={close}>
                Cancel
              </Button>
              <Button
                disabled={!text.trim() || busy}
                onClick={async () => {
                  setBusy(true)
                  try {
                    setResult(await run(text, hasFolders && deep, mode))
                  } finally {
                    setBusy(false)
                  }
                }}
              >
                {busy ? 'Looking...' : mode === 'except' ? 'Find what is missing' : 'Select matches'}
              </Button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

function namesText(list: { name: string }[]) {
  return list.map((f) => f.name).join('\n')
}

function saveTextFile(name: string, text: string) {
  const a = document.createElement('a')
  a.href = URL.createObjectURL(new Blob([text], { type: 'text/plain' }))
  a.download = name
  a.click()
  setTimeout(() => URL.revokeObjectURL(a.href), 2000)
}

function JobBar({ job, stop, close, retry }: { job: Job; stop: () => void; close: () => void; retry: (items: DriveItem[]) => void }) {
  const [copied, setCopied] = useState(false)
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
            <div className="mt-2">
              <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
                <span className="text-warn font-medium">{plural(job.p.failed.length, 'file')} couldn't be saved</span>
                <button className="text-ink underline underline-offset-4" onClick={() => retry(job.p.failed.map((f) => f.item))}>
                  Select these to try again
                </button>
                <button
                  className="text-ink-2 underline underline-offset-4 hover:text-ink"
                  onClick={async () => {
                    await navigator.clipboard.writeText(namesText(job.p.failed)).catch(() => {})
                    setCopied(true)
                    setTimeout(() => setCopied(false), 1800)
                  }}
                >
                  {copied ? 'Copied' : 'Copy names'}
                </button>
                <button
                  className="text-ink-2 underline underline-offset-4 hover:text-ink"
                  onClick={() => saveTextFile('failed-files.txt', namesText(job.p.failed))}
                >
                  Save list as .txt
                </button>
              </div>
              {(() => {
                const reasons = Array.from(new Set(job.p.failed.map((f) => f.why)))
                return reasons.length === 1 ? <p className="mt-1 text-sm text-muted">Reason: {reasons[0]}</p> : null
              })()}
              <details className="mt-1 text-sm">
                <summary className="cursor-pointer text-muted hover:text-ink">Show the list</summary>
                <ul className="mt-2 max-h-48 overflow-y-auto flex flex-col gap-1 text-ink-2 pr-2">
                  {job.p.failed.map((f) => (
                    <li key={f.item.id} className="truncate">
                      <span className="num">{f.name}</span>
                      <span className="text-muted">: {f.why}</span>
                    </li>
                  ))}
                </ul>
              </details>
            </div>
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
        {job.p.failed.length > 0 && <span className="text-warn">{job.p.failed.length} failed so far</span>}
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
