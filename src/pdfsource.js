/**
 * Getting hold of the official map PDF.
 *
 * The layout data is tied to one exact file, so the bytes matter.  We look for
 * a copy shipped with the site first, fall back to one the user supplies, and
 * cache whatever we end up with in IndexedDB so the drop step happens once.
 */

const DB_NAME = 'comiket-planner';
const STORE = 'maps';

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbGet(key) {
  try {
    const db = await openDB();
    return await new Promise((resolve, reject) => {
      const req = db.transaction(STORE).objectStore(STORE).get(key);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  } catch {
    return null;
  }
}

async function idbPut(key, value) {
  try {
    const db = await openDB();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(value, key);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    /* caching is a convenience, never a requirement */
  }
}

export async function sha256(bytes) {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)]
    .map(b => b.toString(16).padStart(2, '0')).join('');
}

const isPdf = bytes =>
  bytes.length > 4 && bytes[0] === 0x25 && bytes[1] === 0x50 &&
  bytes[2] === 0x44 && bytes[3] === 0x46;    // "%PDF"

/**
 * Resolve the map bytes for an event.
 * @param {{event: string, source: string, sha256?: string}} meta layout header
 * @param {() => Promise<ArrayBuffer>} askUser called only when nothing is cached
 * @returns {Promise<{bytes: Uint8Array, verified: boolean}>}
 */
export async function loadMap(meta, askUser) {
  const key = meta.event;

  const cached = await idbGet(key);
  if (cached && isPdf(new Uint8Array(cached))) {
    return finish(new Uint8Array(cached), meta, false);
  }

  try {
    const res = await fetch(`maps/${meta.source}`, { cache: 'force-cache' });
    if (res.ok) {
      const bytes = new Uint8Array(await res.arrayBuffer());
      if (isPdf(bytes)) {
        await idbPut(key, bytes.buffer);
        return finish(bytes, meta, true);
      }
    }
  } catch {
    /* not shipped with the site; fall through to asking */
  }

  const supplied = new Uint8Array(await askUser());
  if (!isPdf(supplied)) throw new Error('not-pdf');
  await idbPut(key, supplied.buffer);
  return finish(supplied, meta, true);
}

async function finish(bytes, meta, fresh) {
  let verified = true;
  if (meta.sha256 && fresh) {
    verified = (await sha256(bytes)) === meta.sha256;
  }
  return { bytes, verified };
}

export async function forgetMap(event) {
  try {
    const db = await openDB();
    db.transaction(STORE, 'readwrite').objectStore(STORE).delete(event);
  } catch {
    /* nothing cached */
  }
}
