// Tiny IndexedDB key/value store, used for binary blobs that are too big for
// localStorage (template images, saved setups, local photos). Keys are
// strings; values can be any structured-cloneable object, including Blobs.

const DB_NAME = 'photoboot';
const DB_VERSION = 1;
const STORE = 'blobs';

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    req.onsuccess = () => {
      const db = req.result;
      // Let other pages upgrade / open the DB instead of waiting on us.
      db.onversionchange = () => closeDb();
      resolve(db);
    };
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function closeDb() {
  const pending = dbPromise;
  dbPromise = null;
  pending?.then((db) => db.close()).catch(() => {});
}

// A page kept in the back/forward cache with an open connection can stall
// the next page's open (seen when leaving settings right after first load),
// so close on the way out; the next call reopens.
if (typeof addEventListener === 'function') addEventListener('pagehide', closeDb);

async function tx<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE, mode);
    // run() returns an IDBRequest; a missing key resolves to undefined.
    const request = run(transaction.objectStore(STORE));
    transaction.oncomplete = () => resolve(request.result);
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}

export const kv = {
  get<T = unknown>(key: string): Promise<T | undefined> {
    return tx('readonly', (store) => store.get(key));
  },
  async set(key: string, value: unknown): Promise<void> {
    await tx('readwrite', (store) => store.put(value, key));
  },
  async delete(key: string): Promise<void> {
    await tx('readwrite', (store) => store.delete(key));
  },
  async keys(): Promise<string[]> {
    const keys = await tx('readonly', (store) => store.getAllKeys());
    return keys.filter((k): k is string => typeof k === 'string');
  },
};
