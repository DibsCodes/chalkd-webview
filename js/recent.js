/**
 * Recently opened boards, kept in this browser's IndexedDB. Each entry holds
 * a copy of the file (so it reopens without asking), a thumbnail, and, where
 * the browser supports it, a file handle so the latest version can be read
 * from disk instead.
 */

const DB_NAME = 'chalkd-viewer';
const STORE = 'recent';
export const MAX_RECENT = 12;

let dbPromise = null;

function openDb() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const store = req.result.createObjectStore(STORE, { keyPath: 'id' });
        store.createIndex('openedAt', 'openedAt');
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    }).catch((err) => {
      dbPromise = null;
      throw err;
    });
  }
  return dbPromise;
}

function request(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function store(mode) {
  const db = await openDb();
  return db.transaction(STORE, mode).objectStore(STORE);
}

/** Newest first. Returns [] if browser storage is unavailable. */
export async function listRecent() {
  try {
    const all = await request((await store('readonly')).getAll());
    return all.sort((a, b) => b.openedAt - a.openedAt);
  } catch {
    return [];
  }
}

export async function getRecent(id) {
  return request((await store('readonly')).get(id));
}

export async function removeRecent(id) {
  await request((await store('readwrite')).delete(id));
}

export async function clearRecent() {
  await request((await store('readwrite')).clear());
}

/**
 * Remember a board that was just opened. Replaces an older entry for the
 * same file, and drops the oldest entries past MAX_RECENT. Returns the id,
 * or null if nothing could be saved.
 */
export async function addRecent({ id, name, file, handle, thumb, title }) {
  try {
    const existing = await listRecent();
    const same = await findSame(existing, { id, name, file, handle });
    const entry = {
      id: same?.id ?? id ?? crypto.randomUUID(),
      name,
      title,
      size: file.size,
      lastModified: file.lastModified,
      openedAt: Date.now(),
      file,
      thumb: thumb ?? null,
      handle: handle ?? same?.handle ?? null,
    };
    try {
      await request((await store('readwrite')).put(entry));
    } catch (err) {
      // Probably out of storage space: keep the entry without the copy.
      if (err?.name !== 'QuotaExceededError') throw err;
      await request(
        (await store('readwrite')).put({ ...entry, file: null, thumb: null }),
      );
    }
    const rest = existing.filter((e) => e.id !== entry.id);
    for (const old of rest.slice(MAX_RECENT - 1)) await removeRecent(old.id);
    return entry.id;
  } catch (err) {
    console.warn('Could not remember this board:', err);
    return null;
  }
}

/** An existing entry that is the same file as this one, if any. */
async function findSame(entries, { id, name, file, handle }) {
  if (id) {
    const byId = entries.find((e) => e.id === id);
    if (byId) return byId;
  }
  for (const e of entries) {
    if (e.name !== name) continue;
    if (handle && e.handle) {
      try {
        if (await handle.isSameEntry(e.handle)) return e;
      } catch {
        // Not comparable; fall through.
      }
      continue;
    }
    if (e.size === file.size && e.lastModified === file.lastModified) return e;
  }
  return null;
}

/**
 * The newest version of a recent board: read fresh from disk through its
 * file handle when allowed, otherwise the copy saved in the browser.
 * Must be called from a click so the browser can ask for permission.
 */
export async function loadRecentFile(entry) {
  if (entry.handle) {
    try {
      let perm = await entry.handle.queryPermission({ mode: 'read' });
      if (perm === 'prompt')
        perm = await entry.handle.requestPermission({ mode: 'read' });
      if (perm === 'granted') {
        return { file: await entry.handle.getFile(), fromDisk: true };
      }
    } catch {
      // Moved, deleted, or permission refused: use the saved copy.
    }
  }
  if (entry.file) return { file: entry.file, fromDisk: false };
  return null;
}
