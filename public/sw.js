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

// Watch links: the <video> element asks for byte ranges, and the page fetches
// them from the editor's computer over the peer connection.
const MAX_RANGE = 2 * 1024 * 1024

async function streamRange(e, fileId) {
  let client = e.clientId ? await self.clients.get(e.clientId) : null
  if (!client) {
    const all = await self.clients.matchAll({ type: 'window' })
    client = all.find((c) => c.url.includes('/w/')) || all[0]
  }
  if (!client) return new Response('No page', { status: 503 })
  const range = e.request.headers.get('range') || 'bytes=0-'
  const m = /bytes=(\d*)-(\d*)/.exec(range)
  const start = m && m[1] ? Number(m[1]) : 0
  const askedEnd = m && m[2] ? Number(m[2]) + 1 : Infinity
  const end = Math.min(askedEnd, start + MAX_RANGE)
  const ch = new MessageChannel()
  const reply = await new Promise((resolve) => {
    ch.port1.onmessage = (m) => resolve(m.data)
    client.postMessage({ type: 'handoff-range', fileId, start, end }, [ch.port2])
    setTimeout(() => resolve({ error: 'timeout' }), 30000)
  })
  if (reply.error) return new Response(reply.error, { status: 504 })
  return new Response(reply.buf, {
    status: 206,
    headers: {
      'Content-Type': reply.type || 'video/mp4',
      'Content-Length': String(reply.end - reply.start),
      'Content-Range': `bytes ${reply.start}-${reply.end - 1}/${reply.size}`,
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-store',
    },
  })
}

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url)
  if (url.pathname.startsWith('/__handoff_stream/')) {
    e.respondWith(streamRange(e, url.pathname.split('/').pop()))
    return
  }
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
