import { useEffect, useRef, type ButtonHTMLAttributes, type ReactNode } from 'react'

export function Shell({ right, nav, children }: { right?: ReactNode; nav?: 'receive' | 'drive'; children: ReactNode }) {
  return (
    <div className="min-h-[100dvh] flex flex-col">
      <header className="w-full border-b border-line bg-paper/80 backdrop-blur sticky top-0 z-10">
        <div className="max-w-5xl mx-auto px-5 md:px-8 h-14 flex items-center justify-between gap-4">
          <a href="/" className="flex items-center gap-2.5 text-ink">
            <img
              src="/logo.svg"
              alt=""
              width={28}
              height={28}
              className="size-7 rounded-[7px] shadow-[0_1px_2px_rgba(28,27,25,0.25),0_6px_14px_-6px_rgba(28,27,25,0.45)]"
            />
            <span className="font-semibold tracking-tight">Handoff</span>
          </a>
          {nav && (
            <nav className="flex items-center gap-1 text-sm mr-auto ml-4 md:ml-8">
              <a href="/" className={`rounded-md px-3 h-8 inline-flex items-center ${nav === 'receive' ? 'bg-ink/[0.06] text-ink font-medium' : 'text-muted hover:text-ink'}`}>
                Receive
              </a>
              <a href="/drive" className={`rounded-md px-3 h-8 inline-flex items-center ${nav === 'drive' ? 'bg-ink/[0.06] text-ink font-medium' : 'text-muted hover:text-ink'}`}>
                From Drive
              </a>
            </nav>
          )}
          <div className="min-w-0 hidden sm:block">{right}</div>
        </div>
      </header>
      <main className="flex-1 w-full max-w-5xl mx-auto px-5 md:px-8 py-10 md:py-16">{children}</main>
      <footer className="border-t border-line">
        <div className="max-w-5xl mx-auto px-5 md:px-8 py-6 text-sm text-muted flex flex-col md:flex-row gap-2 md:justify-between">
          <span>Files go straight from one browser to the other. Nothing is stored in between.</span>
          <span>Free, open source, no account.</span>
        </div>
      </footer>
    </div>
  )
}

type Tone = 'neutral' | 'live' | 'ok' | 'warn'

const toneClass: Record<Tone, string> = {
  neutral: 'bg-card text-ink-2 border-line',
  live: 'bg-tally-soft text-tally border-transparent',
  ok: 'bg-ok-soft text-ok border-transparent',
  warn: 'bg-warn-soft text-warn border-transparent',
}

const dotClass: Record<Tone, string> = {
  neutral: 'bg-muted',
  live: 'bg-tally',
  ok: 'bg-ok',
  warn: 'bg-warn',
}

export function Pill({ tone = 'neutral', pulse, children }: { tone?: Tone; pulse?: boolean; children: ReactNode }) {
  return (
    <span className={`inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs font-medium whitespace-nowrap ${toneClass[tone]}`}>
      <span className={`size-1.5 rounded-full ${dotClass[tone]} ${pulse ? 'tally-pulse' : ''}`} />
      {children}
    </span>
  )
}

type BtnKind = 'primary' | 'secondary' | 'ghost' | 'danger'

const btnClass: Record<BtnKind, string> = {
  primary: 'bg-ink text-paper hover:bg-ink-2 disabled:bg-ink/30',
  secondary: 'bg-card text-ink border border-line hover:border-ink/25 disabled:text-muted',
  ghost: 'text-ink-2 hover:bg-ink/5 disabled:text-muted',
  danger: 'bg-card text-tally border border-line hover:border-tally/40',
}

export function Button({
  kind = 'primary',
  size = 'md',
  className = '',
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { kind?: BtnKind; size?: 'sm' | 'md' | 'lg' }) {
  const sz = size === 'lg' ? 'h-12 px-6 text-[15px]' : size === 'sm' ? 'h-8 px-3 text-sm' : 'h-10 px-4 text-sm'
  return (
    <button
      {...rest}
      className={`inline-flex items-center justify-center gap-2 rounded-md font-medium transition-[background-color,border-color,transform] duration-150 active:scale-[0.98] disabled:cursor-not-allowed disabled:active:scale-100 ${sz} ${btnClass[kind]} ${className}`}
    />
  )
}

export function Bar({ value, live }: { value: number; live?: boolean }) {
  const pct = Math.max(0, Math.min(1, value || 0))
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-ink/[0.07]">
      <div
        className={`h-full origin-left rounded-full bg-ink transition-transform duration-300 ease-out ${live ? 'bar-live' : ''}`}
        style={{ transform: `scaleX(${pct})` }}
      />
    </div>
  )
}

export function Field({ label, help, children }: { label: string; help?: string; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-2">
      <span className="text-sm font-medium text-ink">{label}</span>
      {children}
      {help && <span className="text-sm text-muted">{help}</span>}
    </label>
  )
}

export const inputClass =
  'h-11 w-full rounded-md border border-line bg-card px-3.5 text-[15px] text-ink placeholder:text-muted/70 outline-none transition-colors focus:border-ink/40'

export function Stat({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs uppercase tracking-[0.08em] text-muted">{label}</span>
      <span className="num text-lg text-ink">{value}</span>
    </div>
  )
}

// Keep the screen (and so the machine) awake while something is moving.
export function useWakeLock(active: boolean) {
  const lock = useRef<WakeLockSentinel | null>(null)
  useEffect(() => {
    if (!active || !('wakeLock' in navigator)) return
    let cancelled = false
    const grab = async () => {
      try {
        const l = await navigator.wakeLock.request('screen')
        if (cancelled) l.release()
        else lock.current = l
      } catch {
        /* not allowed right now */
      }
    }
    grab()
    const onVis = () => document.visibilityState === 'visible' && grab()
    document.addEventListener('visibilitychange', onVis)
    return () => {
      cancelled = true
      document.removeEventListener('visibilitychange', onVis)
      lock.current?.release().catch(() => {})
      lock.current = null
    }
  }, [active])
}

export function useLeaveWarning(active: boolean) {
  useEffect(() => {
    if (!active) return
    const h = (e: BeforeUnloadEvent) => {
      e.preventDefault()
      e.returnValue = ''
    }
    window.addEventListener('beforeunload', h)
    return () => window.removeEventListener('beforeunload', h)
  }, [active])
}

export function useTitle(title: string) {
  useEffect(() => {
    document.title = title
  }, [title])
}
