// Where the app keeps its things. The state (what state.json holds on the PC) and the API key live in IndexedDB;
// pictures are files in the app's own folder on the phone (served to the page straight from disk), or IndexedDB
// blobs in a browser preview. Thumbnails (webp) are made in the background, one at a time.
import { native, Filesystem, Capacitor, toBase64, fromBase64 } from './platform.js';

const DB_NAME = 'nai-style-lab';
const THUMB_BOX = [440, 760];

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const store of ['kv', 'images', 'thumbs']) if (!db.objectStoreNames.contains(store)) db.createObjectStore(store);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx(db, store, mode, fn) {
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const s = t.objectStore(store);
    let result;
    const req = fn(s);
    if (req) req.onsuccess = () => { result = req.result; };
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('저장소 작업이 취소되었습니다.'));
  });
}

async function makeThumb(blob) {
  const bitmap = await createImageBitmap(blob);
  const scale = Math.min(1, THUMB_BOX[0] / bitmap.width, THUMB_BOX[1] / bitmap.height);
  const w = Math.max(1, Math.round(bitmap.width * scale)), h = Math.max(1, Math.round(bitmap.height * scale));
  let out;
  if (typeof OffscreenCanvas !== 'undefined') {
    const canvas = new OffscreenCanvas(w, h);
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bitmap, 0, 0, w, h);
    out = await canvas.convertToBlob({ type: 'image/webp', quality: 0.84 });
  } else {
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bitmap, 0, 0, w, h);
    out = await new Promise((r) => canvas.toBlob(r, 'image/webp', 0.84));
  }
  bitmap.close?.();
  return out;
}

const stem = (name) => name.replace(/\.[^.]+$/, '');

// ---------------------------------------------------------------- images: phone files
class NativeImages {
  async init() {
    await Filesystem.mkdir({ path: 'images', directory: 'DATA', recursive: true }).catch(() => {});
    await Filesystem.mkdir({ path: 'thumbs', directory: 'DATA', recursive: true }).catch(() => {});
    this.base = (await Filesystem.getUri({ path: '', directory: 'DATA' })).uri.replace(/\/$/, '');
    this.names = new Set(await this.readdir('images'));
    this.thumbs = new Set((await this.readdir('thumbs')).map(stem));
    this.queue = [];
    this.working = false;
  }

  async readdir(path) {
    try {
      const { files } = await Filesystem.readdir({ path, directory: 'DATA' });
      return files.map((f) => (typeof f === 'string' ? f : f.name)).filter((n) => !n.startsWith('.'));
    } catch {
      return [];
    }
  }

  src(path) { return Capacitor.convertFileSrc(`${this.base}/${path}`); }
  url(name) { return name ? this.src(`images/${encodeURIComponent(name)}`) : null; }
  thumbUrl(name) {
    if (!name) return null;
    if (this.thumbs.has(stem(name))) return this.src(`thumbs/${encodeURIComponent(stem(name))}.webp`);
    this.queueThumb(name);
    return this.url(name);
  }
  has(name) { return this.names.has(name); }
  list() { return [...this.names]; }

  async put(name, bytes, { thumb = true } = {}) {
    await Filesystem.writeFile({ path: `images/${name}`, data: toBase64(bytes), directory: 'DATA', recursive: true });
    this.names.add(name);
    if (thumb) this.queueThumb(name, new Blob([bytes], { type: 'image/png' }));
  }

  async read(name) {
    const res = await fetch(this.url(name));
    if (res.ok) return new Uint8Array(await res.arrayBuffer());
    const { data } = await Filesystem.readFile({ path: `images/${name}`, directory: 'DATA' });
    return typeof data === 'string' ? fromBase64(data) : new Uint8Array(await data.arrayBuffer());
  }

  async remove(name) {
    if (!name) return;
    this.names.delete(name);
    this.thumbs.delete(stem(name));
    await Filesystem.deleteFile({ path: `images/${name}`, directory: 'DATA' }).catch(() => {});
    await Filesystem.deleteFile({ path: `thumbs/${stem(name)}.webp`, directory: 'DATA' }).catch(() => {});
  }

  async clear() {
    await Filesystem.rmdir({ path: 'images', directory: 'DATA', recursive: true }).catch(() => {});
    await Filesystem.rmdir({ path: 'thumbs', directory: 'DATA', recursive: true }).catch(() => {});
    this.names.clear();
    this.thumbs.clear();
    this.queue = [];
    await this.init();
  }

  async clearThumbs() {
    await Filesystem.rmdir({ path: 'thumbs', directory: 'DATA', recursive: true }).catch(() => {});
    await Filesystem.mkdir({ path: 'thumbs', directory: 'DATA', recursive: true }).catch(() => {});
    this.thumbs.clear();
  }

  queueThumb(name, blob = null) {
    if (this.thumbs.has(stem(name)) || this.queue.some((q) => q.name === name)) return;
    this.queue.push({ name, blob });
    this.pump();
  }

  async pump() {
    if (this.working) return;
    this.working = true;
    try {
      while (this.queue.length) {
        const { name, blob } = this.queue.shift();
        if (!this.names.has(name) || this.thumbs.has(stem(name))) continue;
        try {
          const source = blob || new Blob([await this.read(name)], { type: 'image/png' });
          const webp = await makeThumb(source);
          const bytes = new Uint8Array(await webp.arrayBuffer());
          await Filesystem.writeFile({ path: `thumbs/${stem(name)}.webp`, data: toBase64(bytes), directory: 'DATA', recursive: true });
          this.thumbs.add(stem(name));
        } catch { /* the full picture keeps standing in */ }
      }
    } finally {
      this.working = false;
    }
  }
}

// ---------------------------------------------------------------- images: browser blobs
class WebImages {
  constructor(db) { this.db = db; }

  async init() {
    this.blobs = new Map();
    this.thumbBlobs = new Map();
    this.urls = new Map();
    const load = async (store, map) => {
      const keys = await tx(this.db, store, 'readonly', (s) => s.getAllKeys());
      const values = await tx(this.db, store, 'readonly', (s) => s.getAll());
      (keys || []).forEach((k, i) => map.set(k, values[i]));
    };
    await load('images', this.blobs);
    await load('thumbs', this.thumbBlobs);
    this.queue = [];
    this.working = false;
  }

  objectUrl(key, blob) {
    if (!blob) return null;
    if (!this.urls.has(key)) this.urls.set(key, URL.createObjectURL(blob));
    return this.urls.get(key);
  }

  url(name) { return name ? this.objectUrl(`i:${name}`, this.blobs.get(name)) : null; }
  thumbUrl(name) {
    if (!name) return null;
    const thumb = this.thumbBlobs.get(name);
    if (thumb) return this.objectUrl(`t:${name}`, thumb);
    this.queueThumb(name);
    return this.url(name);
  }
  has(name) { return this.blobs.has(name); }
  list() { return [...this.blobs.keys()]; }

  async put(name, bytes, { thumb = true } = {}) {
    const blob = new Blob([bytes], { type: 'image/png' });
    await tx(this.db, 'images', 'readwrite', (s) => s.put(blob, name));
    this.blobs.set(name, blob);
    if (thumb) this.queueThumb(name);
  }

  async read(name) {
    const blob = this.blobs.get(name);
    if (!blob) throw new Error('그림 파일을 찾을 수 없습니다.');
    return new Uint8Array(await blob.arrayBuffer());
  }

  drop(name) {
    for (const key of [`i:${name}`, `t:${name}`]) {
      if (this.urls.has(key)) URL.revokeObjectURL(this.urls.get(key));
      this.urls.delete(key);
    }
  }

  async remove(name) {
    if (!name) return;
    this.drop(name);
    this.blobs.delete(name);
    this.thumbBlobs.delete(name);
    await tx(this.db, 'images', 'readwrite', (s) => s.delete(name)).catch(() => {});
    await tx(this.db, 'thumbs', 'readwrite', (s) => s.delete(name)).catch(() => {});
  }

  async clear() {
    for (const name of this.blobs.keys()) this.drop(name);
    await tx(this.db, 'images', 'readwrite', (s) => s.clear());
    await tx(this.db, 'thumbs', 'readwrite', (s) => s.clear());
    this.blobs.clear();
    this.thumbBlobs.clear();
    this.queue = [];
  }

  async clearThumbs() {
    for (const name of this.thumbBlobs.keys()) this.drop(name);
    await tx(this.db, 'thumbs', 'readwrite', (s) => s.clear());
    this.thumbBlobs.clear();
  }

  queueThumb(name) {
    if (this.thumbBlobs.has(name) || this.queue.includes(name)) return;
    this.queue.push(name);
    this.pump();
  }

  async pump() {
    if (this.working) return;
    this.working = true;
    try {
      while (this.queue.length) {
        const name = this.queue.shift();
        const blob = this.blobs.get(name);
        if (!blob || this.thumbBlobs.has(name)) continue;
        try {
          const webp = await makeThumb(blob);
          await tx(this.db, 'thumbs', 'readwrite', (s) => s.put(webp, name));
          this.thumbBlobs.set(name, webp);
        } catch { /* the full picture keeps standing in */ }
      }
    } finally {
      this.working = false;
    }
  }
}

// ---------------------------------------------------------------- the store
export async function openStorage() {
  const db = await openDb();
  const images = native ? new NativeImages() : new WebImages(db);
  await images.init();
  return {
    native,
    images,
    get: (key) => tx(db, 'kv', 'readonly', (s) => s.get(key)),
    set: (key, value) => tx(db, 'kv', 'readwrite', (s) => s.put(value, key)),
    del: (key) => tx(db, 'kv', 'readwrite', (s) => s.delete(key)),
  };
}
