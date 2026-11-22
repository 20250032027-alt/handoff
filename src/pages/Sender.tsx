import { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowRight, Check, FolderSimple, Files, Warning, X } from '@phosphor-icons/react'
import { Outbox, type OutView } from '../lib/outbox'
import { filesFromDrop, filesFromInput, splitJunk, type PickedFile } from '../lib/files'
import { PHOTO_EXT } from '../lib/protocol'
import { getLocal, setLocal, stableId } from '../lib/store'
import { bytes, duration, plural, speed } from '../lib/format'
import { Bar, Button, Field, Pill, Shell, Stat, inputClass, useLeaveWarning, useTitle, useWakeLock } from '../components/ui'

const isPhone = typeof window !== 'undefined' && window.matchMedia('(pointer: coarse)').matches && !/Macintosh|Windows/.test(navigator.userAgent)

export default function Sender({ editorId, editorName }: { editorId: string; editorName: string }) {
  const [name, setName] = useState(getLocal('sender-name') || '')
  const nameRef = useRef(name)
  nameRef.current = name
  const [label, setLabel] = useState('')
  const [junk, setJunk] = useState(0)
  const [reading, setReading] = useState(false)
  const [dragging, setDragging] = useState(false)
  const folderInput = useRef<HTMLInputElement>(null)
  const filesInput = useRef<HTMLInputElement>(null)

  const out = useMemo(
    () => new Outbox(editorId, () => nameRef.current.trim() || 'A shooter', stableId('client-id', 12), editorName),
    [editorId, editorName],
  )
  const [v, setV] = useState<OutView>(out.snapshot())
  useEffect(() => {
    const unsub = out.subscribe(() => setV(out.snapshot()))
    out.start()
    ;(window as unknown as { __outbox: Outbox }).__outbox = out
    return () => {
      unsub()
      out.destroy()
    }
  }, [out])

  const editor = v.editorName || 'your editor'
  const sending = v.status === 'sending' || (v.status === 'reconnecting' && v.files.length > 0) || v.status === 'asking'
  const moving = v.status === 'sending'
  useWakeLock(sending)
  useLeaveWarning(sending)
  const pct = v.totalBytes ? v.bytesDone / v.totalBytes : 0
  useTitle(moving ? `${Math.floor(pct * 100)}% to ${editor} · Handoff` : v.status === 'done' ? `Sent · Handoff` : `Send to ${editor} · Handoff`)

  // Everything picked so far. Picking again adds to it instead of starting over.
  const [picked, setPicked] = useState<PickedFile[]>([])
  const update = (next: PickedFile[]) => {
    setPicked(next)
    out.setFiles(next)
  }
  const take = (incoming: PickedFile[]) => {
    const { keep, junk: j } = splitJunk(incoming)
    setJunk((n) => n + j)
    const seen = new Set(picked.map((p) => p.path + ':' + p.file.size))
    const fresh = keep.filter((p) => !seen.has(p.path + ':' + p.file.size))
    update([...picked, ...fresh].sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true })))
  }
  const removeAt = (i: number) => update(picked.filter((_, k) => k !== i))
  const clearAll = () => {
    setJunk(0)
    update([])
  }
  const photoCount = picked.filter((p) => PHOTO_EXT.test(p.path)).length
  const otherCount = picked.length - photoCount

  const onDrop = async (e: React.DragEvent) => {
    e.preventDefault()
    setDragging(false)
    if (sending) return
    setReading(true)
    try {
      take(await filesFromDrop(e.dataTransfer))
    } finally {
      setReading(false)
    }
  }

  const start = () => {
    const n = name.trim()
    if (n) setLocal('sender-name', n)
    out.begin(label)
  }

  const statusPill = (() => {
    switch (v.status) {
      case 'connecting':
        return <Pill>Connecting</Pill>
      case 'offline':
        return <Pill tone="warn">{editor} is offline</Pill>
      case 'unreachable':
        return <Pill tone="warn">Can't reach {editor}</Pill>
      case 'no-folder':
        return <Pill tone="warn">{editor} is setting up</Pill>
      case 'ready':
        return <Pill tone="ok">{editor} is online</Pill>
      case 'asking':
        return <Pill tone="warn">Waiting for {editor}</Pill>
      case 'sending':
        return (
          <Pill tone="live" pulse>
            Sending
          </Pill>
        )
      case 'reconnecting':
        return <Pill tone="warn">Reconnecting</Pill>
      case 'done':
        return <Pill tone="ok">Sent</Pill>
      case 'declined':
        return <Pill tone="warn">Declined</Pill>
    }
  })()

  const statusNote: Partial<Record<OutView['status'], string>> = {
    connecting: 'Connecting to your editor...',
    offline: `${editor} doesn't have Handoff open right now. Leave this tab open and it connects the moment they do.`,
    unreachable: `Can't get a direct line to ${editor}'s computer. Some office and hotel networks block this. It keeps trying, but a different Wi-Fi or a phone hotspot usually fixes it.`,
    'no-folder': `${editor} is online but hasn't picked where to save yet.`,
    reconnecting: 'Lost the connection. Reconnecting now, and it picks up where it left off.',
  }

  const counts = v.files.reduce(
    (a, f) => {
      a[f.state]++
      return a
    },
    { waiting: 0, sending: 0, done: 0, skipped: 0, failed: 0 },
  )
  const left = v.speed > 0 ? (v.totalBytes - v.bytesDone) / v.speed : NaN
  const hasFiles = v.files.length > 0
  const canSend = hasFiles && v.status === 'ready' && !!name.trim()

  // Finished
  if (v.status === 'done') {
    const good = counts.done + counts.skipped
    return (
      <Shell right={statusPill}>
        <div className="max-w-2xl rise">
          <span className="flex size-11 items-center justify-center rounded-full bg-ok-soft text-ok">
            <Check size={22} weight="bold" />
          </span>
          <h1 className="mt-6 text-3xl md:text-4xl font-semibold tracking-tight leading-tight">
            {counts.failed ? `Most of it made it to ${editor}.` : `All of it made it to ${editor}.`}
          </h1>
          <p className="mt-4 text-ink-2 leading-relaxed">
            <span className="tabular-nums">{plural(good, 'file')}</span>, <span className="tabular-nums">{bytes(v.totalBytes)}</span>. Each one was
            checked against what's on your card, and they match. You can eject the card now.
          </p>
          {counts.failed > 0 && (
            <div className="mt-6 rounded-lg border border-line bg-card p-5">
              <p className="flex items-center gap-2 text-warn font-medium">
                <Warning size={18} weight="bold" />
                {plural(counts.failed, 'file')} didn't go through after three tries
              </p>
              <ul className="mt-3 num text-sm text-ink-2 flex flex-col gap-1">
                {v.files
                  .filter((f) => f.state === 'failed')
                  .map((f) => (
                    <li key={f.path} className="truncate">
                      {f.path}
                    </li>
                  ))}
              </ul>
              <p className="mt-3 text-sm text-muted">Send the card again. Everything that already arrived gets skipped.</p>
            </div>
          )}
          <Button
            className="mt-8"
            size="lg"
            onClick={() => {
              setPicked([])
              setJunk(0)
              out.reset()
            }}
          >
            Send another card
          </Button>
        </div>
      </Shell>
    )
  }

  if (v.status === 'declined') {
    return (
      <Shell right={statusPill}>
        <div className="max-w-xl rise">
          <h1 className="text-3xl md:text-4xl font-semibold tracking-tight leading-tight">{editor} declined this one.</h1>
          <p className="mt-4 text-ink-2 leading-relaxed">Nothing was sent. If that seems wrong, message them and try again.</p>
          <Button
            className="mt-8"
            onClick={() => {
              setPicked([])
              setJunk(0)
              out.reset()
            }}
          >
            Start over
          </Button>
        </div>
      </Shell>
    )
  }

  // Sending
  if (sending) {
    return (
      <Shell right={statusPill}>
        <div className="rise">
          <span className="text-xs uppercase tracking-[0.08em] text-muted">Sending to {editor}</span>
          <div className="mt-3 flex items-end justify-between gap-6">
            <span className="num text-6xl md:text-7xl tracking-tighter leading-none">{Math.floor(pct * 100)}%</span>
            <Button kind="ghost" size="sm" onClick={() => {
                if (!confirm('Stop sending? Files that already arrived stay with your editor.')) return
                setPicked([])
                setJunk(0)
                out.cancel()
              }}>
              <X size={16} weight="bold" /> Stop
            </Button>
          </div>
          <div className="mt-6">
            <Bar value={pct} live={moving} />
          </div>
          <div className="mt-6 grid grid-cols-2 md:grid-cols-4 gap-5">
            <Stat label="Sent" value={`${bytes(v.bytesDone)} / ${bytes(v.totalBytes)}`} />
            <Stat label="Files" value={`${counts.done + counts.skipped} / ${v.files.length}`} />
            <Stat label="Speed" value={moving ? speed(v.speed) : '--'} />
            <Stat label="Time left" value={moving ? duration(left) : '--'} />
          </div>

          {moving && v.route !== 'unknown' && (
            <p className="mt-5 text-sm text-ink-2 flex items-start gap-2">
              <span className={`mt-1.5 size-2 shrink-0 rounded-full ${v.route === 'local' ? 'bg-ok' : 'bg-warn'}`} />
              {v.route === 'local'
                ? 'Going straight across your Wi-Fi. This is as fast as your network allows.'
                : `Going out over the internet, so the speed is capped by this device's upload speed. If you're near ${editor}, put both devices on the same Wi-Fi (not mobile data) and turn off any VPN. It can be much faster.`}
            </p>
          )}

          {v.hidden && (
            <div className="mt-5 flex items-start gap-3 rounded-lg border border-line bg-warn-soft px-4 py-3 text-sm text-warn">
              <Warning size={16} weight="bold" className="mt-0.5 shrink-0" />
              <span className="flex-1">
                This page left the screen for a while. Phones slow down or pause pages in the background, so keep Handoff open
                and on screen until it finishes.
              </span>
              <button className="shrink-0 underline underline-offset-4" onClick={() => out.dismissHidden()}>
                Got it
              </button>
            </div>
          )}

          <div className="mt-8 rounded-lg border border-line bg-card px-5 py-4 text-sm text-ink-2 leading-relaxed">
            {v.status === 'asking'
              ? `Waiting for ${editor} to accept. They'll see your name and how much you're sending.`
              : statusNote[v.status] || 'Keep this tab open and your laptop plugged in. If the connection drops, it picks up where it left off.'}
          </div>

          <FileList files={v.files} current={v.current} />
        </div>
      </Shell>
    )
  }

  // Picking
  return (
    <Shell right={statusPill}>
      <div className="grid gap-10 md:grid-cols-[1fr_1.15fr] md:gap-16">
        <div className="rise">
          <h1 className="text-3xl md:text-[44px] font-semibold tracking-tight leading-[1.08]">Send footage to {editor}.</h1>
          <p className="mt-5 text-ink-2 leading-relaxed max-w-[46ch]">
            {isPhone ? 'Your clips go straight to their drive.' : 'Drop your card in and it goes straight to their drive.'} No upload limit, no waiting for a cloud, and every file gets
            checked when it lands.
          </p>
          {statusNote[v.status] && <p className="mt-5 text-sm text-muted leading-relaxed max-w-[46ch]">{statusNote[v.status]}</p>}

          <div className="mt-10 flex flex-col gap-6 max-w-sm">
            <Field label="Your name" help={`So ${editor} knows who it's from.`}>
              <input className={inputClass} value={name} onChange={(e) => setName(e.target.value)} />
            </Field>
            <Field label="What's on it?" help="Optional. Becomes the folder name, next to today's date.">
              <input className={inputClass} value={label} onChange={(e) => setLabel(e.target.value)} />
            </Field>
          </div>
        </div>

        <div className="rise flex flex-col" style={{ ['--i' as string]: 1 }}>
          <input
            ref={folderInput}
            type="file"
            className="hidden"
            // @ts-expect-error non-standard but supported everywhere that matters
            webkitdirectory=""
            multiple
            onChange={(e) => {
              if (e.target.files) take(filesFromInput(e.target.files))
              e.target.value = ''
            }}
          />
          <input
            ref={filesInput}
            type="file"
            className="hidden"
            multiple
            onChange={(e) => {
              if (e.target.files) take(filesFromInput(e.target.files))
              e.target.value = ''
            }}
          />

          {!hasFiles ? (
            <div
              onDragOver={(e) => {
                e.preventDefault()
                setDragging(true)
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={onDrop}
              className={`flex min-h-[340px] flex-1 flex-col items-center justify-center rounded-xl border-2 border-dashed px-8 py-12 text-center transition-colors ${
                dragging ? 'border-ink bg-card' : 'border-ink/15 bg-card/60'
              }`}
            >
              <span className="flex size-12 items-center justify-center rounded-full bg-paper border border-line">
                <FolderSimple size={22} weight="bold" />
              </span>
              {isPhone ? (
                <>
                  <p className="mt-5 text-lg font-medium tracking-tight">Pick your clips</p>
                  <p className="mt-2 text-sm text-muted max-w-[34ch]">
                    Tap Choose files, then Browse, and open your SD card. Pick from there instead of Photos, since Photos can shrink videos.
                  </p>
                  <div className="mt-7">
                    <Button onClick={() => filesInput.current?.click()}>
                      <Files size={16} weight="bold" /> Choose files
                    </Button>
                  </div>
                </>
              ) : (
                <>
                  <p className="mt-5 text-lg font-medium tracking-tight">{reading ? 'Reading the card...' : 'Drop your card here'}</p>
                  <p className="mt-2 text-sm text-muted max-w-[34ch]">
                    Drag the SD card, or any folder, from Finder or Explorer onto this box.
                  </p>
                  <div className="mt-7 flex flex-wrap justify-center gap-3">
                    <Button kind="secondary" onClick={() => folderInput.current?.click()}>
                      <FolderSimple size={16} weight="bold" /> Choose folder
                    </Button>
                    <Button kind="ghost" onClick={() => filesInput.current?.click()}>
                      <Files size={16} weight="bold" /> Choose files
                    </Button>
                  </div>
                  <p className="mt-5 text-xs text-muted max-w-[38ch]">
                    With Choose folder, the files inside look grayed out. That's normal: click the folder itself, then Upload.
                    Nothing actually goes online, the button is just named that.
                  </p>
                </>
              )}
            </div>
          ) : (
            <div
              className={`flex flex-col rounded-xl border bg-card p-6 transition-colors ${dragging ? 'border-ink' : 'border-line'}`}
              onDragOver={(e) => {
                e.preventDefault()
                setDragging(true)
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={onDrop}
            >
              <div className="flex items-start justify-between gap-4">
                <div>
                  <p className="text-lg font-medium tracking-tight">
                    <span className="tabular-nums">{plural(v.files.length, 'file')}</span>, <span className="tabular-nums">{bytes(v.totalBytes)}</span>
                  </p>
                  {junk > 0 && (
                    <p className="mt-1 text-sm text-muted">Left out {plural(junk, 'hidden system file')} your editor won't need.</p>
                  )}
                </div>
                <button className="text-sm text-muted hover:text-ink whitespace-nowrap" onClick={clearAll}>
                  Clear all
                </button>
              </div>
              <div className="mt-4 flex flex-wrap items-center gap-2">
                <Button kind="secondary" size="sm" onClick={() => filesInput.current?.click()}>
                  <Files size={14} weight="bold" /> Add files
                </Button>
                {!isPhone && (
                  <Button kind="secondary" size="sm" onClick={() => folderInput.current?.click()}>
                    <FolderSimple size={14} weight="bold" /> Add folder
                  </Button>
                )}
                {photoCount > 0 && otherCount > 0 && (
                  <Button kind="ghost" size="sm" onClick={() => update(picked.filter((p) => !PHOTO_EXT.test(p.path)))}>
                    Remove {plural(photoCount, 'photo')}
                  </Button>
                )}
              </div>
              <p className="mt-2 text-xs text-muted">Adding more keeps what's already here. Tap the x on a file to take it out.</p>
              <FileList files={v.files} current={-1} compact onRemove={removeAt} />
              <Button size="lg" className="mt-6" disabled={!canSend} onClick={start}>
                Send to {editor} <ArrowRight size={18} weight="bold" />
              </Button>
              {!canSend && (
                <p className="mt-3 text-sm text-muted">
                  {!name.trim() ? 'Add your name first.' : v.status !== 'ready' ? `You can send once ${editor} is online and ready.` : ''}
                </p>
              )}
            </div>
          )}
        </div>
      </div>
    </Shell>
  )
}

function FileList({
  files,
  current,
  compact,
  onRemove,
}: {
  files: OutView['files']
  current: number
  compact?: boolean
  onRemove?: (i: number) => void
}) {
  const ref = useRef<HTMLUListElement>(null)
  useEffect(() => {
    if (current < 0) return
    const el = ref.current?.children[current] as HTMLElement | undefined
    el?.scrollIntoView({ block: 'nearest' })
  }, [current])
  const shown = files.slice(0, 2000)
  return (
    <ul ref={ref} className={`mt-6 overflow-y-auto divide-y divide-line border-y border-line ${compact ? 'max-h-64' : 'max-h-[420px]'}`}>
      {shown.map((f, i) => (
        <li key={f.path + i} className="flex items-center gap-4 py-2.5 text-sm">
          <span className="w-4 shrink-0 flex justify-center">
            {f.state === 'done' || f.state === 'skipped' ? (
              <Check size={14} weight="bold" className="text-ok" />
            ) : f.state === 'sending' ? (
              <span className="size-2 rounded-full bg-tally tally-pulse" />
            ) : f.state === 'failed' ? (
              <Warning size={14} weight="bold" className="text-warn" />
            ) : (
              <span className="size-1.5 rounded-full bg-ink/20" />
            )}
          </span>
          <span className={`num flex-1 truncate ${f.state === 'waiting' ? 'text-ink-2' : 'text-ink'}`}>{f.path}</span>
          {f.state === 'skipped' && <span className="text-xs text-muted">already there</span>}
          <span className="num text-muted shrink-0">{bytes(f.size)}</span>
          {onRemove && (
            <button
              onClick={() => onRemove(i)}
              className="shrink-0 -mr-1 flex size-7 items-center justify-center rounded-md text-muted hover:bg-ink/[0.06] hover:text-tally"
              aria-label={`Remove ${f.path}`}
            >
              <X size={14} weight="bold" />
            </button>
          )}
        </li>
      ))}
      {files.length > shown.length && (
        <li className="py-2.5 text-sm text-muted">and {plural(files.length - shown.length, 'more file')}</li>
      )}
    </ul>
  )
}
