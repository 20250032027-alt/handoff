import Editor from './pages/Editor'
import Sender from './pages/Sender'
import Drive from './pages/Drive'
import Watch from './pages/Watch'
import Viewer from './pages/Viewer'

function route(): { page: 'editor' } | { page: 'drive' } | { page: 'viewer' } | { page: 'watch'; id: string; key: string; name: string } | { page: 'sender'; id: string; name: string } {
  const url = new URL(window.location.href)
  const w = url.pathname.match(/^\/w\/([a-z0-9]+)\/?$/i)
  if (w) return { page: 'watch', id: w[1].toLowerCase(), key: url.searchParams.get('k') || '', name: url.searchParams.get('n') || '' }
  const m = url.pathname.match(/^\/d\/([a-z0-9]+)\/?$/i)
  const id = m?.[1] || url.searchParams.get('to')
  if (id) return { page: 'sender', id: id.toLowerCase(), name: url.searchParams.get('n') || '' }
  if (/^\/drive\/?$/.test(url.pathname)) return { page: 'drive' }
  if (/^\/view\/?$/.test(url.pathname)) return { page: 'viewer' }
  return { page: 'editor' }
}

export default function App() {
  const r = route()
  if (r.page === 'sender') return <Sender editorId={r.id} editorName={r.name} />
  if (r.page === 'drive') return <Drive />
  if (r.page === 'viewer') return <Viewer />
  if (r.page === 'watch') return <Watch editorId={r.id} keyParam={r.key} editorName={r.name} />
  return <Editor />
}
