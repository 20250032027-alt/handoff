// Streams a download straight to the browser's Downloads folder without
// holding it in memory. Used when the browser can't write into a picked folder
// (Firefox, Safari). The page sends chunks over a MessagePort, and this worker
// hands them to the browser as a normal file download.

const pending = new Map()

self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()))

self.addEventListener('message', (e) => {
  const d = e.data
  if (d && d.type === 'register') {
    pending.set(d.id, { port: e.ports[0], filename: d.filename })
    e.ports[0].postMessage({ type: 'registered' })
  }
})

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url)
  if (!url.pathname.startsWith('/__handoff_dl/')) return
  const id = url.pathname.split('/').pop()
  if (id === 'ping') {
    e.respondWith(new Response('ok'))
    return
  }
  const job = pending.get(id)
  if (!job) return
  pending.delete(id)
  const { port, filename } = job
  const stream = new ReadableStream(
    {
      start(ctl) {
        port.onmessage = (m) => {
          const v = m.data
          if (v === 'end') ctl.close()
          else if (v && v.type === 'abort') ctl.error(new Error('aborted'))
          else ctl.enqueue(new Uint8Array(v))
        }
      },
      pull() {
        port.postMessage({ type: 'pull' })
      },
      cancel() {
        port.postMessage({ type: 'cancel' })
      },
    },
    new CountQueuingStrategy({ highWaterMark: 16 }),
  )
  const encoded = encodeURIComponent(filename).replace(/['()]/g, escape)
  e.respondWith(
    new Response(stream, {
      headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Disposition': `attachment; filename*=UTF-8''${encoded}`,
        'Content-Security-Policy': "default-src 'none'",
        'X-Content-Type-Options': 'nosniff',
      },
    }),
  )
})
