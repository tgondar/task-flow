// Keeps the one thing this page needs to remember between visits: the handle to
// the task-flow home folder the user picked (File System Access API). IndexedDB
// is the only place a handle can be kept - it is not serializable to localStorage
// - and it lives in this page's own origin, so nobody else's page can read it.
window.TFV = window.TFV || {};
(function () {

const DB_NAME = "task-flow-viewer";
const STORE = "handles";
const KEY = "root";

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function withStore(mode, fn) {
  const db = await openDb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const result = fn(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(result);
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

async function saveRootHandle(handle) {
  await withStore("readwrite", (store) => store.put(handle, KEY));
}

async function loadRootHandle() {
  try {
    return await withStore("readonly", (store) => {
      const request = store.get(KEY);
      return new Promise((resolve) => {
        request.onsuccess = () => resolve(request.result ?? null);
        request.onerror = () => resolve(null);
      });
    });
  } catch {
    return null;
  }
}

async function clearRootHandle() {
  await withStore("readwrite", (store) => store.delete(KEY));
}

/** True once the handle can actually be read without asking again - Chromium
 *  remembers the grant across restarts for a handle kept in IndexedDB, but it is
 *  still a query, never assumed. */
async function hasReadPermission(handle) {
  return (await handle.queryPermission({ mode: "readwrite" })) === "granted";
}

/** Must run from a user gesture (a click): the permission prompt is a native
 *  dialog the browser will not show otherwise. */
async function requestPermission(handle) {
  return (await handle.requestPermission({ mode: "readwrite" })) === "granted";
}

Object.assign(window.TFV, { saveRootHandle, loadRootHandle, clearRootHandle, hasReadPermission, requestPermission });
})();
