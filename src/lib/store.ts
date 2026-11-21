// Small persistence helpers: localStorage for simple values, IndexedDB for the
// folder handle (handles can't go in localStorage).

export function getLocal(key: string): string | null {
  try {
    return localStorage.getItem('dailies:' + key)
  } catch {
    return null
  }
}

export function setLocal(key: string, value: string) {
  try {
    localStorage.setItem('dailies:' + key, value)
  } catch {
    /* private mode, ignore */
  }
}

export function randomId(len = 10): string {
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789'
  const bytes = crypto.getRandomValues(new Uint8Array(len))
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('')
}

export function stableId(key: string, len = 10): string {
  let v = getLocal(key)
  if (!v) {
    v = randomId(len)
    setLocal(key, v)
  }
  return v
}

export function getJSON<T>(key: string, fallback: T): T {
  const raw = getLocal(key)
  if (!raw) return fallback
  try {
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

export function setJSON(key: string, value: unknown) {
  setLocal(key, JSON.stringify(value))
}

function db(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('dailies', 1)
    req.onupgradeneeded = () => req.result.createObjectStore('kv')
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

export async function idbGet<T>(key: string): Promise<T | undefined> {
  const d = await db()
  return new Promise((resolve, reject) => {
    const req = d.transaction('kv').objectStore('kv').get(key)
    req.onsuccess = () => resolve(req.result as T | undefined)
    req.onerror = () => reject(req.error)
  })
}

export async function idbSet(key: string, value: unknown) {
  const d = await db()
  return new Promise<void>((resolve, reject) => {
    const tx = d.transaction('kv', 'readwrite')
    tx.objectStore('kv').put(value, key)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
}
