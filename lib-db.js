// 보관함 storage: one IndexedDB shared by the background worker (indexes every
// saved picture) and the library page. Pictures themselves stay in the user's
// Downloads folder; here we keep the metadata, a small thumbnail and the path.
(function initLibDb(root) {
  "use strict";

  const DB_NAME = "naiAutoSaverLibrary";
  const DB_VERSION = 1;
  let dbPromise = null;

  function open() {
    if (!dbPromise) {
      dbPromise = new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains("images")) {
            const store = db.createObjectStore("images", { keyPath: "id" });
            store.createIndex("savedAt", "savedAt");
          }
          if (!db.objectStoreNames.contains("kv")) {
            db.createObjectStore("kv");
          }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    }
    return dbPromise;
  }

  function tx(storeName, mode, fn) {
    return open().then((db) => new Promise((resolve, reject) => {
      const t = db.transaction(storeName, mode);
      const store = t.objectStore(storeName);
      let result;
      Promise.resolve(fn(store)).then((value) => { result = value; }, reject);
      t.oncomplete = () => resolve(result);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    }));
  }
  const req = (r) => new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });

  // --- helpers shared by the worker and the page -----------------------------
  function stripCounter(name) {
    return String(name || "").replace(/\s*\(\d+\)$/, "");
  }
  // Same rule as the save folders: the text before the first "_" is the character.
  function characterOf(name) {
    const base = stripCounter(name).trim();
    const i = base.indexOf("_");
    return i > 0 ? base.slice(0, i).trim() : "";
  }
  function dateKey(ms) {
    const d = new Date(ms);
    const pad = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }
  function searchText(meta, name) {
    const parts = [name, meta?.prompt, ...(meta?.characters || []).map((c) => c.prompt)];
    return parts.filter(Boolean).join(" \n ").toLowerCase();
  }
  function negativeText(meta) {
    return [meta?.negative, ...(meta?.characters || []).map((c) => c.negative)].filter(Boolean).join(" \n ").toLowerCase();
  }

  // Fits inside box×box, keeping the picture's shape.
  async function makeThumb(blob, box = 480) {
    const probe = await createImageBitmap(blob);
    const k = Math.min(1, box / Math.max(probe.width, probe.height));
    const size = { resizeWidth: Math.max(1, Math.round(probe.width * k)), resizeHeight: Math.max(1, Math.round(probe.height * k)), resizeQuality: "high" };
    probe.close?.();
    const bitmap = await createImageBitmap(blob, size);
    try {
      const canvas = typeof OffscreenCanvas !== "undefined"
        ? new OffscreenCanvas(bitmap.width, bitmap.height)
        : Object.assign(document.createElement("canvas"), { width: bitmap.width, height: bitmap.height });
      canvas.getContext("2d").drawImage(bitmap, 0, 0);
      if (canvas.convertToBlob) {
        return await canvas.convertToBlob({ type: "image/webp", quality: 0.9 });
      }
      return await new Promise((resolve) => canvas.toBlob(resolve, "image/webp", 0.9));
    } finally {
      bitmap.close?.();
    }
  }

  // Builds the stored record for one picture.
  async function buildEntry({ path, bytes, meta = null, savedAt = Date.now(), downloadId = null, source = "saved", thumb = null }) {
    const name = String(path.split("/").pop() || "").replace(/\.(png|webp)$/i, "");
    const info = meta || await root.NAIMeta.readFast(bytes);
    const format = root.NAIMeta.isWebp(bytes) ? "webp" : "png";
    const blob = new Blob([bytes], { type: `image/${format}` });
    let thumbnail = thumb;
    let size = { w: info.imageWidth || info.width || null, h: info.imageHeight || info.height || null };
    if (!thumbnail) {
      try {
        thumbnail = await makeThumb(blob);
      } catch (error) {
        thumbnail = null;
      }
    }
    const { textKeys, ...cleanMeta } = info;
    void textKeys;
    return {
      id: path,
      path,
      name,
      char: characterOf(name),
      date: dateKey(savedAt),
      savedAt,
      downloadId,
      source,
      hasMeta: Boolean(info.found),
      meta: cleanMeta,
      w: size.w,
      h: size.h,
      bytes: bytes.length,
      format,
      thumb: thumbnail,
      search: searchText(info, name),
      negSearch: negativeText(info),
    };
  }

  const api = {
    open,
    put: (entry) => tx("images", "readwrite", (s) => req(s.put(entry))),
    get: (id) => tx("images", "readonly", (s) => req(s.get(id))),
    remove: (id) => tx("images", "readwrite", (s) => req(s.delete(id))),
    all: () => tx("images", "readonly", (s) => req(s.getAll())),
    keys: () => tx("images", "readonly", (s) => req(s.getAllKeys())),
    count: () => tx("images", "readonly", (s) => req(s.count())),
    getKv: (key) => tx("kv", "readonly", (s) => req(s.get(key))),
    setKv: (key, value) => tx("kv", "readwrite", (s) => req(s.put(value, key))),
    delKv: (key) => tx("kv", "readwrite", (s) => req(s.delete(key))),
    buildEntry,
    makeThumb,
    characterOf,
    stripCounter,
    dateKey,
    searchText,
  };
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }
  root.LibDB = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
