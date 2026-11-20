// A tiny key-value store for this browser: IndexedDB when it works, memory otherwise.
// Private mode, blocked storage or jsdom fall back to memory, so the app still works for the
// session (a reload then means a new device key, which the server handles).

const DB = 'pingme'
const STORE = 'kv'

type Backend = { get(key: string): Promise<unknown>; set(key: string, value: unknown): Promise<void>; del(key: string): Promise<void> }

const memory = new Map<string, unknown>()
const memoryBackend: Backend = {
  get: async (key) => memory.get(key),
  set: async (key, value) => {
    memory.set(key, value)
  },
  del: async (key) => {
    memory.delete(key)
  },
}

function request<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result)
    r.onerror = () => reject(r.error)
  })
}

function idbBackend(idb: IDBFactory): Backend {
  let db: Promise<IDBDatabase> | null = null
  const open = () => {
    db ??= new Promise<IDBDatabase>((resolve, reject) => {
      const r = idb.open(DB, 1)
      r.onupgradeneeded = () => r.result.createObjectStore(STORE)
      r.onsuccess = () => resolve(r.result)
      r.onerror = () => reject(r.error)
      r.onblocked = () => reject(new Error('blocked'))
    })
    return db
  }
  return {
    get: async (key) => request((await open()).transaction(STORE, 'readonly').objectStore(STORE).get(key)),
    set: async (key, value) => {
      const tx = (await open()).transaction(STORE, 'readwrite')
      tx.objectStore(STORE).put(value, key)
      await new Promise<void>((resolve, reject) => {
        tx.oncomplete = () => resolve()
        tx.onerror = () => reject(tx.error)
        tx.onabort = () => reject(tx.error)
      })
    },
    del: async (key) => {
      const tx = (await open()).transaction(STORE, 'readwrite')
      tx.objectStore(STORE).delete(key)
      await new Promise<void>((resolve, reject) => {
        tx.oncomplete = () => resolve()
        tx.onerror = () => reject(tx.error)
        tx.onabort = () => reject(tx.error)
      })
    },
  }
}

let backend: Backend | null = null

function pick(): Backend {
  if (backend) return backend
  try {
    backend = typeof indexedDB !== 'undefined' && indexedDB ? idbBackend(indexedDB) : memoryBackend
  } catch {
    backend = memoryBackend
  }
  return backend
}

// The first failure moves everything to memory for the rest of the session.
async function run<T>(op: (b: Backend) => Promise<T>): Promise<T> {
  const b = pick()
  if (b === memoryBackend) return op(memoryBackend)
  try {
    return await op(b)
  } catch {
    backend = memoryBackend
    return op(memoryBackend)
  }
}

export function vaultGet(key: string): Promise<unknown> {
  return run((b) => b.get(key))
}

export function vaultSet(key: string, value: unknown): Promise<void> {
  return run((b) => b.set(key, value))
}

export function vaultDelete(key: string): Promise<void> {
  return run((b) => b.del(key))
}

/** True once storage fell back to memory (or never had IndexedDB). For tests and diagnostics. */
export function vaultInMemory() {
  return pick() === memoryBackend
}

/** Tests only: forget the memory copy and pick the backend again. */
export function resetVault() {
  memory.clear()
  backend = null
}
