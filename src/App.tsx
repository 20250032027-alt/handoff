import Editor from './pages/Editor'
import Sender from './pages/Sender'
import Drive from './pages/Drive'

function route(): { page: 'editor' } | { page: 'drive' } | { page: 'sender'; id: string; name: string } {
  const url = new URL(window.location.href)
  const m = url.pathname.match(/^\/d\/([a-z0-9]+)\/?$/i)
  const id = m?.[1] || url.searchParams.get('to')
  if (id) return { page: 'sender', id: id.toLowerCase(), name: url.searchParams.get('n') || '' }
  if (/^\/drive\/?$/.test(url.pathname)) return { page: 'drive' }
  return { page: 'editor' }
}

export default function App() {
  const r = route()
  if (r.page === 'sender') return <Sender editorId={r.id} editorName={r.name} />
  if (r.page === 'drive') return <Drive />
  return <Editor />
}
