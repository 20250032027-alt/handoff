import { useEffect, useMemo, useRef, useState } from 'react'
import { DownloadSimple, FilmStrip, Image as ImageIcon, Play, Warning, X } from '@phosphor-icons/react'
import { Watcher, type WatchView } from '../lib/watch'
import type { LibItem } from '../lib/protocol'
import { canStreamDownload } from '../lib/download'
import { bytes, plural } from '../lib/format'
import { Bar, Button, Pill, Shell, useTitle } from '../components/ui'

export default function Watch({ editorId, keyParam, editorName }: { editorId: string; keyParam: string; editorName: string }) {
  const w = useMemo(() => new Watcher(editorId, keyParam, editorName), [editorId, keyParam, editorName])
  const [v, setV] = useState<WatchView>(w.snapshot())
  const [open, setOpen] = useState<LibItem | null>(null)
  useEffect(() => {
    const off = w.subscribe(() => setV(w.snapshot()))
    w.start()
    ;(window as unknown as { __watch: Watcher }).__watch = w
    return () => {
      off()
      w.destroy()
    }
  }, [w])

  const name = v.editorName || 'your editor'
  useTitle(`${name}'s footage · Handoff`)

  const groups = useMemo(() => {
    const m = new Map<string, { shooter: string; batch: string; items: LibItem[] }>()
    for (const it of v.items || []) {
      const k = it.shooter + '\u0000' + it.batch
      if (!m.has(k)) m.set(k, { shooter: it.shooter, batch: it.batch, items: [] })
      m.get(k)!.items.push(it)
    }
    return Array.from(m.values())
  }, [v.items])

  const pill =
    v.status === 'ok' ? (
      <Pill tone="ok">{name}'s computer is on</Pill>
    ) : v.status === 'connecting' ? (
      <Pill>Connecting</Pill>
    ) : (
      <Pill tone="warn">Can't watch right now</Pill>
    )

  return (
    <Shell right={pill}>
      <section className="rise max-w-3xl">
        <h1 className="text-3xl md:text-[40px] font-semibold tracking-tight leading-[1.1]">Footage on {name}'s computer</h1>
        <p className="mt-4 text-ink-2 leading-relaxed max-w-[62ch]">
          Everything the team sends to {name} shows up here. Tap a clip to watch it, or save a copy to your device.
        </p>
        <p className="mt-3 text-sm text-muted leading-relaxed max-w-[62ch]">
          This isn't cloud storage. You're watching straight off {name}'s computer, so it only works while that computer is on
          and Handoff is open there.
        </p>
      </section>

      <section className="mt-12">
        <StatusPanel v={v} name={name} />

        {v.status === 'ok' && v.live.length > 0 && (
          <ul className="mb-8 flex flex-col gap-2">
            {v.live.map((l) => (
              <li key={l.name + l.label} className="flex items-center gap-3 rounded-lg border border-line bg-card px-4 py-3 text-sm">
                <span className="size-2 rounded-full bg-tally tally-pulse shrink-0" />
                <span>
                  <span className="font-medium">{l.name}</span> is sending{l.label ? ` "${l.label}"` : ''} right now,{' '}
                  <span className="tabular-nums">{l.filesDone} of {plural(l.totalFiles, 'file')}</span> in. New clips show up here as each one
                  lands.
                </span>
              </li>
            ))}
          </ul>
        )}

        {v.status === 'ok' && v.items && v.items.length === 0 && v.live.length === 0 && (
          <div className="rounded-xl border border-dashed border-ink/15 py-16 px-6 text-center">
            <p className="text-ink font-medium">Nothing here yet.</p>
            <p className="mt-2 text-sm text-muted max-w-[44ch] mx-auto">
              Footage shows up here once someone sends it to {name} with Handoff. If you just sent yours, give it a few seconds
              after it finishes.
            </p>
          </div>
        )}

        {v.status === 'ok' && v.items === null && <p className="text-sm text-muted">Loading the list...</p>}

        {v.status === 'ok' &&
          groups.map((g, gi) => (
            <div key={g.shooter + g.batch} className="mb-12">
              <div className="flex items-baseline gap-3 border-b border-line pb-3">
                <h2 className="font-semibold tracking-tight">{g.shooter}</h2>
                <span className="text-ink-2 truncate">{g.batch}</span>
                <span className="ml-auto text-sm text-muted tabular-nums shrink-0">{plural(g.items.length, 'clip')}</span>
              </div>
              <div className="mt-6 grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-x-4 gap-y-7">
                {g.items.map((it, i) => (
                  <Tile key={it.path} w={w} it={it} i={gi * 4 + i} onOpen={() => setOpen(it)} />
                ))}
              </div>
            </div>
          ))}
      </section>

      {open && <Player w={w} it={open} close={() => setOpen(null)} />}
    </Shell>
  )
}

function StatusPanel({ v, name }: { v: WatchView; name: string }) {
  const box = (title: string, body: string, tone: 'muted' | 'warn' = 'muted') => (
    <div className="mb-10 rounded-xl border border-line bg-card p-6 md:p-8 max-w-3xl">
      <p className={`font-medium flex items-center gap-2 ${tone === 'warn' ? 'text-warn' : 'text-ink'}`}>
        {tone === 'warn' && <Warning size={18} weight="bold" />}
        {title}
      </p>
      <p className="mt-2 text-sm text-ink-2 leading-relaxed">{body}</p>
    </div>
  )
  switch (v.status) {
    case 'connecting':
      return box(`Connecting to ${name}'s computer...`, 'This usually takes a few seconds.')
    case 'offline':
      return box(
        `${name}'s computer is off, or Handoff isn't open on it.`,
        `Footage stays on ${name}'s computer instead of a server, so you can only watch while it's on. Leave this page open and it loads by itself as soon as ${name} is back.`,
        'warn',
      )
    case 'unreachable':
      return box(
        `Can't get a direct line to ${name}'s computer.`,
        "Some school, office and hotel networks block this kind of connection. It keeps trying. Switching to a different Wi-Fi or a phone hotspot usually fixes it.",
        'warn',
      )
    case 'off':
      return box(`${name} has turned watching off.`, `Ask ${name} to switch on "Let the team watch" in Handoff.`, 'warn')
    case 'badkey':
      return box('This watch link is old.', `${name} made a new one, and this one stopped working. Ask for the new link.`, 'warn')
    case 'zip':
      return box(
        `${name}'s browser can't share footage.`,
        `${name} is using a browser that saves footage as zip files, and those can't be watched here. If ${name} opens Handoff in Chrome, Edge or Opera instead, this page starts working.`,
        'warn',
      )
    case 'nofolder':
      return box(`${name} hasn't picked a footage folder yet.`, "Once that's set, everything in it shows up here.", 'warn')
    default:
      return null
  }
}

function Tile({ w, it, i, onOpen }: { w: Watcher; it: LibItem; i: number; onOpen: () => void }) {
  const ref = useRef<HTMLButtonElement>(null)
  const [thumb, setThumb] = useState<{ jpeg: string; duration: number } | null>(null)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    let cancelled = false
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) {
        io.disconnect()
        w.thumb(it.path)
          .then((t) => !cancelled && setThumb(t))
          .catch(() => !cancelled && setThumb({ jpeg: '', duration: 0 }))
      }
    })
    io.observe(el)
    return () => {
      cancelled = true
      io.disconnect()
    }
  }, [w, it.path])
  const Icon = it.kind === 'video' ? FilmStrip : ImageIcon
  return (
    <div className="rise group" style={{ ['--i' as string]: Math.min(i, 12) }}>
      <button ref={ref} onClick={onOpen} className="relative block w-full aspect-video overflow-hidden rounded-lg border border-line bg-ink/[0.04]" aria-label={`Open ${it.name}`}>
        {thumb?.jpeg ? (
          <img src={thumb.jpeg} alt="" className="size-full object-cover" />
        ) : (
          <span className={`size-full flex items-center justify-center text-muted ${thumb ? '' : 'animate-pulse'}`}>
            <Icon size={28} />
          </span>
        )}
        <span className="absolute inset-0 flex items-center justify-center bg-ink/0 opacity-0 transition-[opacity,background-color] group-hover:opacity-100 group-hover:bg-ink/25">
          <span className="flex size-11 items-center justify-center rounded-full bg-paper/95 text-ink">
            <Play size={18} weight="fill" />
          </span>
        </span>
        {thumb && thumb.duration > 0 && (
          <span className="num absolute right-2 bottom-2 rounded bg-ink/80 px-1.5 py-0.5 text-[11px] text-paper">{clock(thumb.duration)}</span>
        )}
      </button>
      <p className="mt-2.5 truncate text-sm font-medium">{it.name}</p>
      <p className="num text-xs text-muted mt-0.5">{bytes(it.size)}</p>
    </div>
  )
}

function clock(sec: number) {
  const s = Math.round(sec)
  const m = Math.floor(s / 60)
  return `${m}:${String(s % 60).padStart(2, '0')}`
}

function Player({ w, it, close }: { w: Watcher; it: LibItem; close: () => void }) {
  const [failed, setFailed] = useState(false)
  const [photo, setPhoto] = useState('')
  const [saving, setSaving] = useState<number | null>(null)
  const [saveErr, setSaveErr] = useState('')
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && close()
    window.addEventListener('keydown', k)
    return () => window.removeEventListener('keydown', k)
  }, [close])

  useEffect(() => {
    if (it.kind !== 'photo') return
    let url = ''
    w.read(it.path, 0, it.size)
      .then((r) => {
        url = URL.createObjectURL(new Blob([r.buf as BlobPart]))
        setPhoto(url)
      })
      .catch(() => setFailed(true))
    return () => {
      if (url) URL.revokeObjectURL(url)
    }
  }, [w, it])

  const save = async () => {
    setSaveErr('')
    setSaving(0)
    try {
      await w.save(it, setSaving)
      setSaved(true)
    } catch (e) {
      setSaveErr((e as Error).message)
    } finally {
      setSaving(null)
    }
  }

  return (
    <div className="fixed inset-0 z-30 flex items-center justify-center bg-ink/75 p-3 md:p-10" onClick={close}>
      <div className="w-full max-w-5xl rounded-xl bg-paper overflow-hidden" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-3 px-4 md:px-5 h-14 border-b border-line">
          <span className="truncate font-medium flex-1">{it.name}</span>
          <span className="num text-sm text-muted hidden sm:inline">{bytes(it.size)}</span>
          {canStreamDownload() && (
            <Button size="sm" kind="secondary" onClick={save} disabled={saving !== null}>
              <DownloadSimple size={14} weight="bold" />
              {saving !== null ? 'Saving...' : saved ? 'Saved' : 'Save'}
            </Button>
          )}
          <button onClick={close} className="text-muted hover:text-ink" aria-label="Close">
            <X size={18} weight="bold" />
          </button>
        </div>
        {saving !== null && (
          <div className="px-5 py-2 border-b border-line">
            <Bar value={saving / Math.max(1, it.size)} live />
          </div>
        )}
        <div className="aspect-video bg-ink flex items-center justify-center">
          {failed ? (
            <div className="max-w-md px-6 text-center text-paper/90">
              <p className="font-medium">This clip can't play in a browser.</p>
              <p className="mt-2 text-sm text-paper/60 leading-relaxed">
                That's normal for some camera formats, like 10-bit or RAW footage. It's not broken. Save it and open it in your
                editing app or VLC instead.
              </p>
            </div>
          ) : it.kind === 'photo' ? (
            photo ? <img src={photo} alt={it.name} className="max-h-full max-w-full object-contain" /> : <span className="text-paper/60 text-sm">Loading...</span>
          ) : (
            <video
              key={it.path}
              src={w.streamUrl(it)}
              controls
              autoPlay
              playsInline
              className="size-full"
              onError={() => setFailed(true)}
            />
          )}
        </div>
        <p className="px-5 py-3 text-xs text-muted">
          {saveErr
            ? `Couldn't save: ${saveErr}`
            : saved
              ? 'Saved to your Downloads folder.'
              : 'Playing straight from the original file, so it can take a moment to start on slower connections.'}
        </p>
      </div>
    </div>
  )
}
