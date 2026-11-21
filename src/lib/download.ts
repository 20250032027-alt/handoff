// A WritableStream that ends up as a file in the user's Downloads folder,
// streamed through public/sw.js so nothing big sits in memory.

let ready: Promise<ServiceWorkerRegistration> | null = null

export function canStreamDownload() {
  return typeof navigator !== 'undefined' && 'serviceWorker' in navigator && window.isSecureContext
}

export function prepareDownloads() {
  if (!ready && canStreamDownload()) {
    ready = navigator.serviceWorker.register('/sw.js').then(async (reg) => {
      await navigator.serviceWorker.ready
      // The first load isn't controlled by the worker yet. Wait for it to claim the page.
      if (!navigator.serviceWorker.controller) {
        await new Promise<void>((r) => {
          navigator.serviceWorker.addEventListener('controllerchange', () => r(), { once: true })
          setTimeout(r, 3000)
        })
      }
      return reg
    })
  }
  return ready
}

export async function downloadStream(filename: string): Promise<WritableStream<Uint8Array>> {
  const reg = await prepareDownloads()
  const worker = navigator.serviceWorker.controller || reg?.active
  if (!worker) throw new Error('Downloads aren\'t available in this browser window. Try reloading the page.')
  const id = Math.random().toString(36).slice(2) + Date.now().toString(36)
  const ch = new MessageChannel()
  let credits = 0
  let waiter: (() => void) | null = null
  let cancelled = false
  await new Promise<void>((resolve) => {
    ch.port1.onmessage = (m) => {
      const t = m.data?.type
      if (t === 'registered') resolve()
      else if (t === 'pull') {
        credits++
        waiter?.()
      } else if (t === 'cancel') {
        cancelled = true
        waiter?.()
      }
    }
    worker.postMessage({ type: 'register', id, filename }, [ch.port2])
  })

  // Kick off the actual download with a hidden iframe.
  const frame = document.createElement('iframe')
  frame.hidden = true
  frame.src = `/__handoff_dl/${id}`
  document.body.appendChild(frame)

  // Some browsers stop an idle service worker after a while. Poke it now and then.
  const ping = setInterval(() => fetch('/__handoff_dl/ping').catch(() => {}), 10000)
  const cleanup = () => {
    clearInterval(ping)
    setTimeout(() => frame.remove(), 1000)
  }

  return new WritableStream<Uint8Array>({
    async write(chunk) {
      while (credits <= 0 && !cancelled) await new Promise<void>((r) => (waiter = r))
      if (cancelled) throw new Error('The download was cancelled in the browser.')
      credits--
      const copy = chunk.slice() // own copy, since the buffer gets handed over to the worker
      ch.port1.postMessage(copy.buffer, [copy.buffer as ArrayBuffer])
    },
    close() {
      ch.port1.postMessage('end')
      cleanup()
    },
    abort() {
      ch.port1.postMessage({ type: 'abort' })
      cleanup()
    },
  })
}
