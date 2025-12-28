const DB_NAME = "muse";
const STORE_NAME = "kv";
const DB_VERSION = 1;

const openDb = () =>
  new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onerror = () => reject(request.error);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };
    request.onsuccess = () => resolve(request.result);
  });

const withStore = async <T>(mode: IDBTransactionMode, action: (store: IDBObjectStore) => IDBRequest<T>) => {
  const db = await openDb();
  return new Promise<T>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, mode);
    const store = tx.objectStore(STORE_NAME);
    const request = action(store);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
    tx.oncomplete = () => db.close();
    tx.onerror = () => reject(tx.error);
  });
};

export const idbGet = async <T>(key: string): Promise<T | null> => {
  try {
    return await withStore<T | null>("readonly", (store) => store.get(key));
  } catch {
    return null;
  }
};

export const idbSet = async (key: string, value: unknown): Promise<boolean> => {
  try {
    await withStore("readwrite", (store) => store.put(value, key));
    return true;
  } catch {
    return false;
  }
};

