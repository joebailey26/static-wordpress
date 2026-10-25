import type { Checkpoint } from './editor.ts'

const database = new Promise<IDBDatabase>((resolve, reject) => {
  const request = indexedDB.open(`${__STATIC_WORDPRESS_CONFIG__.id}-cms-recovery`, 1)
  request.onupgradeneeded = () => request.result.createObjectStore('checkpoints')
  request.onsuccess = () => resolve(request.result)
  request.onerror = () => reject(request.error)
})

// The unsynced checkpoint kept on this device.
export async function recovery(action: 'get'): Promise<Checkpoint | undefined>
export async function recovery(action: 'put', value: Checkpoint): Promise<unknown>
export async function recovery(action: 'delete'): Promise<unknown>
export async function recovery(action: 'get' | 'put' | 'delete', value?: Checkpoint): Promise<unknown> {
  const db = await database

  return new Promise((resolve, reject) => {
    const transaction = db.transaction('checkpoints', action === 'get' ? 'readonly' : 'readwrite')
    const store = transaction.objectStore('checkpoints')
    const request = action === 'get' ? store.get('pending') : action === 'put' ? store.put(value, 'pending') : store.delete('pending')
    transaction.oncomplete = () => resolve(request.result)
    transaction.onerror = () => reject(transaction.error)
    transaction.onabort = () => reject(transaction.error || new Error('Local recovery storage failed'))
  })
}
