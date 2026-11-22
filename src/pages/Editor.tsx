import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { AppWindow, Bell, Check, Copy, Eye, FolderSimple, PencilSimple, Warning, X } from '@phosphor-icons/react'
import { Inbox, type SessionView } from '../lib/inbox'
import { getLocal, idbGet, idbSet, setLocal, stableId } from '../lib/store'
import { canStreamDownload, prepareDownloads } from '../lib/download'
import { bytes, duration, plural, speed } from '../lib/format'
import { Bar, Button, Field, Pill, Shell, Stat, inputClass, useLeaveWarning, useTitle, useWakeLock } from '../components/ui'

const canReceive = typeof window !== 'undefined' && 'showDirectoryPicker' in window
const params = new URLSearchParams(window.location.search)
const testMode = params.has('opfs')
// Browsers without folder access (Firefox, Safari) get each delivery as one streamed .zip in Downloads.
const zipMode = params.has('zipmode') || (!canReceive && !testMode)

function useInbox(): Inbox {
  const inbox = useMemo(() => new Inbox(stableId('inbox-id', 8)), [])
  useEffect(() => {
    inbox.start()
    ;(window as unknown as { __inbox: Inbox }).__inbox = inbox
    return () => inbox.destroy()
  }, [inbox])
  return inbox
}

function useSnapshot(inbox: Inbox) {
  const [, force] = useState(0)
  useEffect(() => {
    const off = inbox.subscribe(() => force((n) => n + 1))
    return () => {
      off()
    }
  }, [inbox])
  return inbox.snapshot()
}

type FolderState = { handle: FileSystemDirectoryHandle | null; needsPermission: boolean; loaded: boolean }

export default function Editor() {
  const inbox = useInbox()
  const sessions = useSnapshot(inbox)
  const [name, setName] = useState(getLocal('editor-name') || '')
  const [editingName, setEditingName] = useState(!getLocal('editor-name'))
  const [folder, setFolder] = useState<FolderState>({ handle: null, needsPermission: false, loaded: false })
  const [copied, setCopied] = useState(false)
  const [notif, setNotif] = useState(typeof Notification !== 'undefined' ? Notification.permission : 'denied')
  const online = useSyncExternalStore(
    (cb) => {
      window.addEventListener('online', cb)
      window.addEventListener('offline', cb)
      return () => {
        window.removeEventListener('online', cb)
        window.removeEventListener('offline', cb)
      }
    },
    () => navigator.onLine,
  )

  // Bring back the folder picked last time. Browsers ask again for permission
  // after a restart, which needs a click, so we show a button for that.
  useEffect(() => {
    ;(async () => {
      if (testMode) {
        const h = await navigator.storage.getDirectory()
        setFolder({ handle: h, needsPermission: false, loaded: true })
        return
      }
      if (!canReceive) return setFolder((f) => ({ ...f, loaded: true }))
      try {
        const h = await idbGet<FileSystemDirectoryHandle>('dir')
        if (!h) return setFolder({ handle: null, needsPermission: false, loaded: true })
        const p = await h.queryPermission({ mode: 'readwrite' })
        setFolder({ handle: h, needsPermission: p !== 'granted', loaded: true })
      } catch {
        setFolder({ handle: null, needsPermission: false, loaded: true })
      }
    })()
  }, [])

  useEffect(() => {
    inbox.setDir(folder.handle && !folder.needsPermission ? folder.handle : null)
  }, [inbox, folder])

  useEffect(() => {
    inbox.setName(name.trim())
  }, [inbox, name])

  useEffect(() => {
    if (!zipMode) return
    inbox.setMode('zip')
    void prepareDownloads()
  }, [inbox])

  // Holding a Web Lock tells Chrome not to freeze or discard this tab while it sits in the background.
  useEffect(() => {
    let release: () => void = () => {}
    navigator.locks?.request('handoff-inbox', () => new Promise<void>((r) => (release = r))).catch(() => {})
    if (!zipMode) navigator.serviceWorker?.register('/sw.js').catch(() => {})
    return () => release()
  }, [])

  const [installEvt, setInstallEvt] = useState<(Event & { prompt: () => Promise<void> }) | null>(null)
  useEffect(() => {
    const h = (e: Event) => {
      e.preventDefault()
      setInstallEvt(e as Event & { prompt: () => Promise<void> })
    }
    window.addEventListener('beforeinstallprompt', h)
    return () => window.removeEventListener('beforeinstallprompt', h)
  }, [])

  const pickFolder = async () => {
    try {
      const h = await window.showDirectoryPicker({ id: 'handoff', mode: 'readwrite' })
      await idbSet('dir', h)
      setFolder({ handle: h, needsPermission: false, loaded: true })
    } catch {
      /* closed the picker */
    }
  }

  const regrant = async () => {
    if (!folder.handle) return
    const p = await folder.handle.requestPermission({ mode: 'readwrite' })
    if (p === 'granted') setFolder({ ...folder, needsPermission: false })
  }

  const saveName = () => {
    const n = name.trim()
    if (!n) return
    setLocal('editor-name', n)
    setEditingName(false)
  }

  const link = `${window.location.origin}/d/${inbox.id}${name.trim() ? `?n=${encodeURIComponent(name.trim())}` : ''}`
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(link)
      setCopied(true)
      setTimeout(() => setCopied(false), 1800)
    } catch {
      /* ignore */
    }
  }

  const receiving = sessions.filter((s) => s.status === 'receiving')
  const busy = receiving.length > 0
  useWakeLock(busy)
  useLeaveWarning(busy)
  const totalPct = busy
    ? receiving.reduce((a, s) => a + s.bytesDone, 0) / Math.max(1, receiving.reduce((a, s) => a + s.totalBytes, 0))
    : 0
  const asking = sessions.filter((s) => s.status === 'asking').length
  useTitle(busy ? `${Math.floor(totalPct * 100)}% receiving · Handoff` : asking ? `(${asking}) Handoff` : 'Handoff')

  const ready = !!name.trim() && !editingName && (zipMode || (!!folder.handle && !folder.needsPermission))

  const status = !online ? (
    <Pill tone="warn">No internet</Pill>
  ) : inbox.status === 'online' ? (
    ready ? (
      <Pill tone={busy ? 'live' : 'ok'} pulse={busy}>
        {busy
          ? receiving.length === 1
            ? `Receiving from ${receiving[0].name}`
            : `Receiving from ${receiving.length} shooters`
          : 'Ready to receive'}
      </Pill>
    ) : (
      <Pill>Setting up</Pill>
    )
  ) : inbox.status === 'taken' ? (
    <Pill tone="warn">Open in another tab</Pill>
  ) : (
    <Pill>Connecting</Pill>
  )

  if (zipMode && !canStreamDownload()) return <Unsupported />

  if (inbox.status === 'taken') {
    return (
      <Shell right={status} nav="receive">
        <div className="max-w-xl rise">
          <h1 className="text-3xl md:text-4xl font-semibold tracking-tight leading-tight">Handoff is already open in another tab.</h1>
          <p className="mt-4 text-ink-2 leading-relaxed">
            Your link can only be live in one place at a time. Close the other tab, then reload this one.
          </p>
          <Button className="mt-8" onClick={() => window.location.reload()}>
            Reload
          </Button>
        </div>
      </Shell>
    )
  }

  if (!ready) {
    return (
      <Shell right={status} nav="receive">
        <div className="grid gap-12 md:grid-cols-[1.1fr_1fr] md:gap-16">
          <div className="rise">
            <h1 className="text-3xl md:text-[44px] font-semibold tracking-tight leading-[1.08]">
              Get footage from your shooters, straight onto your drive.
            </h1>
            <p className="mt-5 text-ink-2 leading-relaxed max-w-[52ch]">
              {zipMode
                ? 'You get a link. Shooters open it, drop their card in, and the footage downloads straight to this computer while they watch it happen.'
                : 'Pick a folder on this computer and you get a link. Shooters open it, drop their card in, and the files land in that folder while they watch it happen.'}{' '}
              Nothing goes up to a cloud first, so there's no storage to fill up and nothing to delete the next day.
            </p>
            <ul className="mt-8 flex flex-col gap-3 text-sm text-ink-2">
              <li className="flex gap-3">
                <span className="num text-muted w-5">01</span>One link for everyone. It stays the same, so pin it in the group chat.
              </li>
              <li className="flex gap-3">
                <span className="num text-muted w-5">02</span>
                {zipMode ? 'Each delivery is named after the shooter and the date.' : 'Each shooter gets their own folder, sorted by date.'}
              </li>
              <li className="flex gap-3">
                <span className="num text-muted w-5">03</span>Every file is checked against the original when it arrives.
              </li>
            </ul>
          </div>

          <div className="rise flex flex-col gap-8 rounded-xl border border-line bg-card p-6 md:p-8" style={{ ['--i' as string]: 1 }}>
            <Field label="Your name" help="Shooters see this when they open your link.">
              <input
                className={inputClass}
                value={name}
                autoFocus={editingName}
               
                onChange={(e) => {
                  setName(e.target.value)
                  setEditingName(true)
                }}
                onBlur={saveName}
                onKeyDown={(e) => e.key === 'Enter' && saveName()}
              />
            </Field>

            {zipMode ? (
              <div className="flex flex-col gap-2">
                <span className="text-sm font-medium">Where footage goes</span>
                <div className="flex items-center gap-2 rounded-md border border-line px-3.5 h-11 text-ink-2">
                  <FolderSimple size={18} weight="bold" className="shrink-0" />
                  Downloads, one .zip per delivery
                </div>
                <span className="text-sm text-muted">
                  This browser can't save into a folder you pick. Open Handoff in Chrome or Edge to get files unzipped and
                  sorted into folders, and to skip anything you already have.
                </span>
              </div>
            ) : (
            <div className="flex flex-col gap-2">
              <span className="text-sm font-medium">Where should footage go?</span>
              {folder.handle && folder.needsPermission ? (
                <>
                  <Button kind="secondary" className="justify-start" onClick={regrant}>
                    <FolderSimple size={18} weight="bold" />
                    Allow access to "{folder.handle.name}" again
                  </Button>
                  <button className="self-start text-sm text-muted underline underline-offset-4 hover:text-ink" onClick={pickFolder}>
                    Or pick a different folder
                  </button>
                </>
              ) : folder.handle ? (
                <div className="flex items-center justify-between gap-3 rounded-md border border-line px-3.5 h-11">
                  <span className="flex items-center gap-2 min-w-0">
                    <FolderSimple size={18} weight="bold" className="shrink-0" />
                    <span className="truncate">{folder.handle.name}</span>
                  </span>
                  <button className="text-sm text-muted hover:text-ink" onClick={pickFolder}>
                    Change
                  </button>
                </div>
              ) : (
                <Button kind="secondary" className="justify-start" onClick={pickFolder}>
                  <FolderSimple size={18} weight="bold" />
                  Choose a folder
                </Button>
              )}
              <span className="text-sm text-muted">
                An external drive works well. Your browser will ask if Handoff can save files there. Say yes.
              </span>
            </div>
            )}

            <Button
              size="lg"
              disabled={!name.trim() || (!zipMode && (!folder.handle || folder.needsPermission))}
              onClick={saveName}
            >
              Get my link
            </Button>
          </div>
        </div>
      </Shell>
    )
  }

  const active = sessions.filter((s) => s.status !== 'done' && s.status !== 'declined' && s.status !== 'cancelled')
  const finished = sessions.filter((s) => s.status === 'done' || s.status === 'declined' || s.status === 'cancelled')

  return (
    <Shell right={status} nav="receive">
      <section className="rise">
        <span className="text-xs uppercase tracking-[0.08em] text-muted">Your link</span>
        <div className="mt-3 flex flex-col md:flex-row md:items-center gap-3">
          <code className="num min-w-0 flex-1 truncate rounded-md border border-line bg-card px-4 h-12 flex items-center text-[15px]">
            {link.replace(/^https?:\/\//, '')}
          </code>
          <Button size="lg" onClick={copy} className="md:w-36">
            {copied ? <Check size={18} weight="bold" /> : <Copy size={18} weight="bold" />}
            {copied ? 'Copied' : 'Copy link'}
          </Button>
        </div>
        <p className="mt-3 text-sm text-muted max-w-[70ch]">
          Send this to anyone shooting for you. Keep this tab open while they send. If it closes, their transfer pauses and
          picks up again when you come back.
        </p>
        <div className="mt-6 flex flex-wrap items-center gap-x-6 gap-y-3 text-sm">
          {zipMode ? (
            <span className="flex items-center gap-2 text-ink-2">
              <FolderSimple size={16} weight="bold" />
              Saving to <span className="font-medium text-ink">Downloads</span>, one .zip per delivery
            </span>
          ) : (
            <span className="flex items-center gap-2 text-ink-2">
              <FolderSimple size={16} weight="bold" />
              Saving to <span className="font-medium text-ink">{folder.handle!.name}</span>
              <button className="text-muted underline underline-offset-4 hover:text-ink" onClick={pickFolder}>
                change
              </button>
            </span>
          )}
          <span className="flex items-center gap-2 text-ink-2">
            <PencilSimple size={16} weight="bold" />
            Shown as <span className="font-medium text-ink">{name}</span>
            <button className="text-muted underline underline-offset-4 hover:text-ink" onClick={() => setEditingName(true)}>
              edit
            </button>
          </span>
          {installEvt && (
            <button
              className="flex items-center gap-2 text-muted hover:text-ink"
              onClick={async () => {
                await installEvt.prompt()
                setInstallEvt(null)
              }}
            >
              <AppWindow size={16} weight="bold" />
              Install as an app
            </button>
          )}
          {notif !== 'granted' && notif !== 'denied' && (
            <button
              className="flex items-center gap-2 text-muted hover:text-ink"
              onClick={async () => setNotif(await Notification.requestPermission())}
            >
              <Bell size={16} weight="bold" />
              Tell me when something arrives
            </button>
          )}
        </div>
      </section>

      <WatchSection inbox={inbox} name={name} />

      <details className="mt-6 max-w-[70ch] text-sm group">
        <summary className="cursor-pointer text-muted hover:text-ink select-none">How to keep Handoff on all the time</summary>
        <ol className="mt-3 flex flex-col gap-2 text-ink-2 leading-relaxed list-decimal pl-5">
          <li>
            Install it as an app with the <span className="font-medium">Install as an app</span> button above (or the install icon in
            the address bar). It gets its own window, so it won't get lost or closed with your other tabs.
          </li>
          <li>
            Make it open when you log in. In Chrome or Edge, go to <span className="num">chrome://apps</span> (Edge:{' '}
            <span className="num">edge://apps</span>), right-click Handoff, and turn on <span className="font-medium">Start app when you sign in</span>.
          </li>
          <li>
            Stop the computer from sleeping while it's plugged in. Windows: Settings, System, Power, set sleep to Never. Mac: System
            Settings, Battery or Energy, turn on "Prevent automatic sleeping".
          </li>
          <li>
            When Chrome asks to let Handoff edit your folder, pick <span className="font-medium">Allow on every visit</span> so it doesn't ask
            again after a restart.
          </li>
        </ol>
      </details>

      <section className="mt-14">
        <div className="flex items-baseline justify-between border-b border-line pb-3">
          <h2 className="font-semibold tracking-tight">Incoming</h2>
          {busy && (
            <span className="num text-sm text-muted">
              {speed(receiving.reduce((a, s) => a + s.speed, 0))}
            </span>
          )}
        </div>
        {active.length === 0 ? (
          <div className="py-14 text-center">
            <p className="text-ink-2">Nobody's sending right now.</p>
            <p className="mt-1 text-sm text-muted">When someone opens your link, they'll show up here.</p>
          </div>
        ) : (
          <ul className="divide-y divide-line">
            {active.map((s, i) => (
              <SessionRow key={s.key} s={s} i={i} inbox={inbox} />
            ))}
          </ul>
        )}
      </section>

      {(finished.length > 0 || inbox.history.length > 0) && (
        <section className="mt-14">
          <h2 className="font-semibold tracking-tight border-b border-line pb-3">Received</h2>
          <ul className="divide-y divide-line">
            {finished.map((s) => (
              <li key={s.key} className="py-4 flex flex-col md:flex-row md:items-center gap-2 md:gap-6">
                <span className="font-medium md:w-44 truncate">{s.name}</span>
                <span className="flex-1 text-sm text-ink-2 min-w-0 truncate">
                  {s.status === 'done'
                    ? `${plural(s.filesDone + s.filesSkipped, 'file')}, ${bytes(s.totalBytes)} in ${s.folder}`
                    : s.status === 'declined'
                      ? 'You declined this one.'
                      : 'They cancelled before it finished.'}
                </span>
                {s.status === 'done' &&
                  (s.failed.length ? (
                    <Pill tone="warn">{plural(s.failed.length, 'file')} missing</Pill>
                  ) : (
                    <Pill tone="ok">All checked</Pill>
                  ))}
                <button className="text-muted hover:text-ink self-start md:self-auto" onClick={() => inbox.dismiss(s.key)} aria-label="Clear">
                  <X size={16} weight="bold" />
                </button>
              </li>
            ))}
            {inbox.history
              .filter((h) => !finished.some((s) => s.status === 'done' && s.finishedAt && Math.abs(s.finishedAt - h.at) < 2000))
              .slice(0, 12)
              .map((h) => (
                <li key={h.at} className="py-4 flex flex-col md:flex-row md:items-center gap-1 md:gap-6 text-sm">
                  <span className="font-medium md:w-44 truncate text-ink-2">{h.name}</span>
                  <span className="flex-1 text-muted truncate">
                    {plural(h.files, 'file')}, {bytes(h.bytes)} in {h.folder}
                  </span>
                  <span className="num text-muted">{new Date(h.at).toLocaleDateString()}</span>
                </li>
              ))}
          </ul>
        </section>
      )}

      {inbox.trustedNames.length > 0 && (
        <section className="mt-14 text-sm">
          <h2 className="font-semibold tracking-tight border-b border-line pb-3 text-base">Accepted automatically</h2>
          <ul className="mt-3 flex flex-wrap gap-2">
            {inbox.trustedNames.map((t) => (
              <li key={t.id} className="flex items-center gap-2 rounded-full border border-line bg-card pl-3 pr-2 h-8">
                {t.name}
                <button className="text-muted hover:text-tally" onClick={() => inbox.forget(t.id)} aria-label={`Stop auto-accepting ${t.name}`}>
                  <X size={14} weight="bold" />
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </Shell>
  )
}

function WatchSection({ inbox, name }: { inbox: Inbox; name: string }) {
  const [copied, setCopied] = useState(false)
  const link = `${window.location.origin}/w/${inbox.id}?k=${inbox.watchKey}${name.trim() ? `&n=${encodeURIComponent(name.trim())}` : ''}`
  const viewers = inbox.viewers.size
  if (inbox.mode === 'zip') {
    return (
      <section className="mt-12 rounded-xl border border-line bg-card p-6 max-w-3xl">
        <p className="font-medium flex items-center gap-2">
          <Eye size={18} weight="bold" /> Let the team watch
        </p>
        <p className="mt-2 text-sm text-muted leading-relaxed">
          Teammates can watch everything you've received from a link, but only when Handoff saves into a folder. Open Handoff in
          Chrome, Edge or Opera to turn this on.
        </p>
      </section>
    )
  }
  return (
    <section className="mt-12 rounded-xl border border-line bg-card p-6 max-w-3xl">
      <div className="flex items-start gap-4">
        <div className="flex-1">
          <p className="font-medium flex items-center gap-2">
            <Eye size={18} weight="bold" /> Let the team watch
          </p>
          <p className="mt-1.5 text-sm text-muted leading-relaxed">
            Teammates get their own link to watch and save everything in your Handoff folder, straight from this computer. It
            works while this tab is open.
          </p>
        </div>
        <button
          role="switch"
          aria-checked={inbox.watchOn}
          onClick={() => inbox.setWatch(!inbox.watchOn)}
          className={`relative mt-0.5 h-6 w-11 shrink-0 rounded-full transition-colors ${inbox.watchOn ? 'bg-ink' : 'bg-ink/15'}`}
        >
          <span className={`absolute top-0.5 left-0.5 size-5 rounded-full bg-paper shadow transition-transform ${inbox.watchOn ? 'translate-x-5' : ''}`} />
        </button>
      </div>
      {inbox.watchOn && (
        <div className="mt-5 flex flex-col gap-3">
          <div className="flex flex-col sm:flex-row gap-3">
            <code className="num min-w-0 flex-1 truncate rounded-md border border-line bg-paper px-3.5 h-10 flex items-center text-sm">
              {link.replace(/^https?:\/\//, '')}
            </code>
            <Button
              kind="secondary"
              onClick={async () => {
                await navigator.clipboard.writeText(link).catch(() => {})
                setCopied(true)
                setTimeout(() => setCopied(false), 1800)
              }}
            >
              {copied ? <Check size={16} weight="bold" /> : <Copy size={16} weight="bold" />}
              {copied ? 'Copied' : 'Copy watch link'}
            </Button>
          </div>
          <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-sm">
            <span className="text-ink-2">
              {viewers ? `${plural(viewers, 'person')} watching now`.replace('persons', 'people') : 'Nobody watching right now'}
            </span>
            <button
              className="text-muted underline underline-offset-4 hover:text-ink"
              onClick={() => confirm('Make a new watch link? The old one stops working right away.') && inbox.newWatchKey()}
            >
              Make a new link
            </button>
          </div>
          <p className="text-xs text-muted">This is a different link from your send link. Anyone who has it can watch and save your footage.</p>
        </div>
      )}
    </section>
  )
}

function SessionRow({ s, i, inbox }: { s: SessionView; i: number; inbox: Inbox }) {
  const [always, setAlways] = useState(false)
  const pct = s.totalBytes ? s.bytesDone / s.totalBytes : 0
  const left = s.speed > 0 ? (s.totalBytes - s.bytesDone) / s.speed : NaN
  const fileCount = s.filesDone + s.filesSkipped

  return (
    <li className="py-6 rise" style={{ ['--i' as string]: i }}>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <span className="font-medium text-lg tracking-tight">{s.name}</span>
        {s.label && <span className="text-ink-2">{s.label}</span>}
        <span className="ml-auto">
          {s.status === 'receiving' ? (
            <Pill tone="live" pulse>
              Receiving
            </Pill>
          ) : s.status === 'asking' ? (
            <Pill tone="warn">Waiting for you</Pill>
          ) : s.status === 'dropped' ? (
            <Pill tone="warn">Connection dropped</Pill>
          ) : (
            <Pill>Picking files</Pill>
          )}
        </span>
      </div>

      {s.status === 'connected' && <p className="mt-2 text-sm text-muted">They've opened your link and are choosing what to send.</p>}

      {s.status === 'dropped' && (
        <p className="mt-2 text-sm text-muted">
          Lost the connection to {s.name}. If they keep their tab open it reconnects by itself and skips files you already have.
        </p>
      )}

      {s.status === 'asking' && (
        <div className="mt-4 rounded-lg border border-line bg-card p-5">
          <p className="text-ink">
            {s.name} wants to send <span className="tabular-nums">{plural(s.totalFiles, 'file')}</span>,{' '}
            <span className="tabular-nums">{bytes(s.totalBytes)}</span>.
          </p>
          <p className="mt-1 text-sm text-muted truncate">They'll go into {s.folder}</p>
          <div className="mt-5 flex flex-wrap items-center gap-3">
            <Button onClick={() => inbox.session(s.key)?.accept(always)}>Accept</Button>
            <Button kind="secondary" onClick={() => inbox.session(s.key)?.decline()}>
              Decline
            </Button>
            <label className="ml-1 flex items-center gap-2 text-sm text-ink-2 cursor-pointer select-none">
              <input type="checkbox" className="size-4 accent-[#1c1b19]" checked={always} onChange={(e) => setAlways(e.target.checked)} />
              Always accept from {s.name}
            </label>
          </div>
        </div>
      )}

      {s.status === 'receiving' && (
        <div className="mt-5">
          <Bar value={pct} live />
          <div className="mt-5 grid grid-cols-2 md:grid-cols-4 gap-5">
            <Stat label="Done" value={`${Math.floor(pct * 100)}%`} />
            <Stat label="Received" value={`${bytes(s.bytesDone)} / ${bytes(s.totalBytes)}`} />
            <Stat label="Speed" value={speed(s.speed)} />
            <Stat label="Time left" value={duration(left)} />
          </div>
          <p className="mt-5 text-sm text-muted flex items-center gap-2 min-w-0">
            <span className="num shrink-0">
              {fileCount}/{s.totalFiles}
            </span>
            <span className="num truncate text-ink-2">{s.current}</span>
          </p>
          {s.route !== 'unknown' && (
            <p className="mt-1 text-sm text-muted">
              {s.route === 'local'
                ? 'Direct over your network.'
                : `Over the internet, so it's limited by ${s.name}'s upload speed. If you're on the same Wi-Fi, check they aren't on mobile data or a VPN.`}
            </p>
          )}
          {s.filesSkipped > 0 && (
            <p className="mt-1 text-sm text-muted">Skipped {plural(s.filesSkipped, 'file')} you already had.</p>
          )}
          {s.failed.length > 0 && (
            <p className="mt-2 text-sm text-warn flex items-center gap-2">
              <Warning size={16} weight="bold" /> {plural(s.failed.length, 'file')} didn't match and will be retried.
            </p>
          )}
        </div>
      )}
    </li>
  )
}

function Unsupported() {
  return (
    <Shell nav="receive">
      <div className="max-w-xl rise">
        <h1 className="text-3xl md:text-4xl font-semibold tracking-tight leading-tight">This browser can't receive footage.</h1>
        <p className="mt-4 text-ink-2 leading-relaxed">
          Try Chrome, Edge or Firefox on a computer. Sending works in any browser.
        </p>
        <p className="mt-4 text-ink-2 leading-relaxed">
          If someone sent you a link to send them footage, open that link instead.
        </p>
      </div>
    </Shell>
  )
}
