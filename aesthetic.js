// 미적 점수: how good a picture looks to an anime aesthetic model, 0–100.
//
// Model: deepghs/anime_aesthetic (Hugging Face, OpenRAIL on its model card),
// trained on danbooru scores (HakuBooru). It is NOT shipped with the
// extension: the browser downloads it once on first use and keeps it in Cache
// Storage. It runs in aesthetic-worker.js with onnxruntime-web (MIT).
// Score = Σ p(label) × rank, worst 0 … masterpiece 6, as in deepghs/imgutils
// (MIT) anime_dbaesthetic; shown as 0–100.
(function initAesthetic(root) {
  "use strict";

  const MODEL = {
    repo: "deepghs/anime_aesthetic",
    name: "caformer_s36_v0_ls0.2",
    sizeMB: 150,
    license: "OpenRAIL (모델 카드 표기) · danbooru 점수로 학습",
  };
  const RANK = { worst: 0, low: 1, normal: 2, good: 3, great: 4, best: 5, masterpiece: 6 };
  const CACHE_NAME = "nai-autosaver-models-v1";
  const SCORES_KEY = `aesScores:${MODEL.name}`;
  const base = () => `https://huggingface.co/${MODEL.repo}/resolve/main/${MODEL.name}`;

  const scores = new Map(); // picture id → 0–100
  let loaded = false;
  let worker = null;
  let ready = null; // Promise of the worker being ready
  let labels = null;
  const queue = []; // ids, front first
  const queued = new Set();
  const blobs = new Map(); // id → () => Blob
  let busy = false;
  let saveTimer = null;
  const listeners = new Set();
  const status = { phase: "off", progress: 0, error: "", threads: 1, done: 0, fingerprints: null };

  // ---- 그림 지문 (fingerprints): one Float32Array per picture, in their own
  // IndexedDB (they are big next to everything else).
  const FP_DB = "nai-autosaver-fp";
  const FP_STORE = `fp:${MODEL.name}`;
  let fpDb = null;
  const fpIds = new Set();
  let fpSupported = null; // null = not known yet (before the model ran)
  function openFp() {
    if (fpDb) return fpDb;
    fpDb = new Promise((resolve, reject) => {
      const req = indexedDB.open(FP_DB, 1);
      req.onupgradeneeded = () => { if (!req.result.objectStoreNames.contains(FP_STORE)) req.result.createObjectStore(FP_STORE); };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return fpDb;
  }
  const fpTx = async (mode, run) => {
    const db = await openFp();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(FP_STORE, mode);
      const out = run(tx.objectStore(FP_STORE));
      tx.oncomplete = () => resolve(out && "result" in out ? out.result : out);
      tx.onerror = () => reject(tx.error);
    });
  };
  async function loadFpIds() {
    try {
      const keys = await fpTx("readonly", (st) => st.getAllKeys());
      for (const k of keys || []) fpIds.add(String(k));
    } catch (error) {
      void error;
    }
  }
  async function fingerprints(ids) {
    const out = new Map();
    const want = ids.filter((id) => fpIds.has(id));
    for (let i = 0; i < want.length; i += 500) {
      const part = want.slice(i, i + 500);
      const got = await fpTx("readonly", (st) => part.map((id) => st.get(id)));
      part.forEach((id, j) => { const v = got[j]?.result; if (v) out.set(id, new Float32Array(v)); });
    }
    return out;
  }

  // ---- 내 점수: the user's own taste, learned from their 셀렉 (taste.js).
  const TASTE_KEY = `tasteModel:${MODEL.name}`;
  let taste = null; // { model, personal, generic, groups, pictures, better, at }
  let useTaste = false;
  const personal = new Map(); // id → 0–100
  async function loadTaste() {
    try {
      const saved = await root.LibDB.getKv(TASTE_KEY);
      if (saved?.model?.theta) {
        taste = saved;
        useTaste = saved.use !== false && Boolean(saved.better);
        await scorePersonalAll();
      }
    } catch (error) {
      void error;
    }
  }
  async function scorePersonalAll() {
    personal.clear();
    if (!taste) return;
    const ids = [...fpIds].filter((id) => scores.has(id));
    const fps = await fingerprints(ids);
    for (const [id, x] of fps) personal.set(id, root.Taste.apply(taste.model, x, scores.get(id)));
  }
  const tasteOn = () => Boolean(useTaste && taste && fpSupported !== false);
  function personalOne(id, x) {
    if (taste && x && scores.has(id)) personal.set(id, root.Taste.apply(taste.model, x, scores.get(id)));
  }

  function emit(event) {
    for (const fn of listeners) {
      try {
        fn(event);
      } catch (error) {
        void error;
      }
    }
  }
  function setPhase(phase, extra = {}) {
    Object.assign(status, { phase, ...extra });
    emit({ type: "status", status: { ...status, queued: queue.length } });
  }

  async function cachedFetch(url, { onProgress, optional = false } = {}) {
    const cache = await caches.open(CACHE_NAME);
    const hit = await cache.match(url);
    if (hit) return hit;
    const res = await fetch(url, { mode: "cors", credentials: "omit" });
    if (!res.ok) {
      if (optional && res.status === 404) {
        await cache.put(url, new Response("null", { headers: { "content-type": "application/json" } })); // remember "not there"
        return null;
      }
      throw new Error(`내려받기 실패 (${res.status})`);
    }
    let body = res;
    if (onProgress && res.body) {
      const total = Number(res.headers.get("content-length")) || MODEL.sizeMB * 1048576;
      const reader = res.body.getReader();
      const chunks = [];
      let got = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        got += value.length;
        onProgress(Math.min(1, got / total));
      }
      body = new Response(new Blob(chunks), { headers: { "content-type": res.headers.get("content-type") || "application/octet-stream" } });
    }
    await cache.put(url, body.clone());
    return body;
  }
  async function isDownloaded() {
    try {
      const cache = await caches.open(CACHE_NAME);
      return Boolean(await cache.match(`${base()}/model.onnx`));
    } catch (error) {
      return false;
    }
  }

  async function loadScores() {
    if (loaded) return;
    loaded = true;
    await loadFpIds();
    try {
      const saved = await root.LibDB.getKv(SCORES_KEY);
      if (saved && typeof saved === "object") for (const [id, s] of Object.entries(saved)) if (typeof s === "number") scores.set(id, s);
    } catch (error) {
      void error;
    }
    await loadTaste();
  }
  function saveScores() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => { void root.LibDB.setKv(SCORES_KEY, Object.fromEntries(scores)).catch(() => {}); }, 1500);
  }

  // Downloads (first time) and starts the model in its worker.
  function start({ onProgress } = {}) {
    if (ready) return ready;
    ready = (async () => {
      await loadScores();
      setPhase(await isDownloaded() ? "loading" : "downloading", { progress: 0, error: "" });
      const meta = await (await cachedFetch(`${base()}/meta.json`)).json();
      labels = Array.isArray(meta?.labels) ? meta.labels.map(String) : null;
      if (!labels || !labels.every((l) => l in RANK)) throw new Error("모델 정보(meta.json)를 읽지 못했어요.");
      let preprocess = null;
      try {
        const res = await cachedFetch(`${base()}/preprocess.json`, { optional: true });
        preprocess = res ? await res.json() : null;
      } catch (error) {
        preprocess = null;
      }
      const model = await (await cachedFetch(`${base()}/model.onnx`, {
        onProgress: (p) => { setPhase("downloading", { progress: p }); onProgress?.(p); },
      })).arrayBuffer();
      setPhase("loading");
      worker = new Worker(chrome.runtime.getURL("aesthetic-worker.js"));
      const threads = root.crossOriginIsolated ? Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 2) - 1)) : 1;
      const info = await new Promise((resolve, reject) => {
        worker.onmessage = ({ data }) => {
          if (data.type === "ready") resolve(data);
          else if (data.type === "init-error") reject(new Error(data.error));
        };
        worker.onerror = (e) => reject(new Error(e.message || "점수 엔진을 시작하지 못했어요."));
        worker.postMessage({ type: "init", model, wasmBase: chrome.runtime.getURL("vendor/ort/"), threads, preprocess, fallbackSize: /_448/.test(MODEL.name) ? 448 : 384 }, [model]);
      });
      worker.onmessage = null;
      fpSupported = Boolean(info.embName);
      setPhase("ready", { threads: info.threads, fingerprints: fpSupported });
      void pump();
      return true;
    })().catch((error) => {
      ready = null;
      try { worker?.terminate(); } catch (e) { void e; }
      worker = null;
      setPhase("error", { error: String(error?.message || error) });
      throw error;
    });
    return ready;
  }
  function stop() {
    try { worker?.terminate(); } catch (e) { void e; }
    worker = null;
    ready = null;
    queue.length = 0;
    queued.clear();
    blobs.clear();
    busy = false;
    setPhase("off");
  }
  async function removeModel() {
    stop();
    try {
      const cache = await caches.open(CACHE_NAME);
      for (const file of ["model.onnx", "meta.json", "preprocess.json"]) await cache.delete(`${base()}/${file}`);
    } catch (error) {
      void error;
    }
  }

  function runOne(id, blob) {
    return new Promise((resolve, reject) => {
      worker.onmessage = ({ data }) => {
        if (data.id !== id) return;
        if (data.type === "score") resolve(data);
        else reject(new Error(data.error));
      };
      worker.postMessage({ type: "score", id, blob });
    });
  }
  function toScore(probs) {
    let s = 0;
    labels.forEach((label, i) => { s += (probs[i] || 0) * RANK[label]; });
    return Math.round((s / 6) * 1000) / 10;
  }
  async function pump() {
    if (busy || !worker || status.phase !== "ready") return;
    busy = true;
    try {
      while (queue.length && worker) {
        const id = queue.shift();
        queued.delete(id);
        const get = blobs.get(id);
        blobs.delete(id);
        if (!needs(id) || !get) continue;
        let blob = null;
        try {
          blob = await get();
        } catch (error) {
          blob = null;
        }
        if (!blob) continue;
        try {
          const out = await runOne(id, blob);
          const s = toScore(out.probs);
          scores.set(id, s);
          if (out.emb) {
            fpIds.add(id);
            void fpTx("readwrite", (st) => st.put(out.emb.buffer, id)).catch(() => fpIds.delete(id));
            personalOne(id, out.emb);
          } else if (fpSupported) {
            fpSupported = false; // the model stopped giving fingerprints
          }
          status.done += 1;
          saveScores();
          emit({ type: "score", id, score: s, queued: queue.length });
        } catch (error) {
          void error; // one unreadable picture: skip it
        }
      }
    } finally {
      busy = false;
      emit({ type: "idle", queued: queue.length });
    }
  }
  // Done with a picture: it has a score, and its fingerprint when the model gives one.
  const needs = (id) => !scores.has(id) || (fpSupported !== false && !fpIds.has(id));
  // Ask for scores. items: [{ id, blob: () => Blob }]. front: before the rest.
  function want(items, { front = false } = {}) {
    const fresh = [];
    for (const it of items) {
      if (!it || !needs(it.id)) continue;
      blobs.set(it.id, it.blob);
      if (queued.has(it.id)) {
        if (front) {
          const at = queue.indexOf(it.id);
          if (at >= 0) queue.splice(at, 1);
          fresh.push(it.id);
        }
        continue;
      }
      queued.add(it.id);
      fresh.push(it.id);
    }
    if (!fresh.length) return;
    if (front) queue.unshift(...fresh);
    else queue.push(...fresh);
    void pump();
  }

  root.Aesthetic = {
    MODEL,
    start,
    stop,
    removeModel,
    isDownloaded,
    loadScores,
    want,
    score: (id) => (scores.has(id) ? scores.get(id) : null),
    has: (id) => scores.has(id),
    // the score that orders a 칸: 내 점수 when it is in use, else the general one
    rank: (id) => (tasteOn() ? (personal.has(id) ? personal.get(id) : null) : (scores.has(id) ? scores.get(id) : null)),
    hasRank: (id) => (tasteOn() ? personal.has(id) : scores.has(id)),
    personal: (id) => (personal.has(id) ? personal.get(id) : null),
    needs,
    hasFingerprint: (id) => fpIds.has(id),
    fingerprintsSupported: () => fpSupported,
    fingerprints,
    taste: () => taste,
    usingTaste: () => tasteOn(),
    async setUseTaste(on) {
      useTaste = Boolean(on) && Boolean(taste);
      if (taste) { taste.use = useTaste; await root.LibDB.setKv(TASTE_KEY, taste); }
      emit({ type: "taste" });
    },
    async setTaste(result) {
      taste = { ...result, at: Date.now(), use: Boolean(result.better) };
      useTaste = taste.use;
      await root.LibDB.setKv(TASTE_KEY, taste);
      await scorePersonalAll();
      emit({ type: "taste" });
    },
    async clearTaste() {
      taste = null;
      useTaste = false;
      personal.clear();
      await root.LibDB.delKv(TASTE_KEY).catch(() => {});
      emit({ type: "taste" });
    },
    forget: (id) => { scores.delete(id); saveScores(); },
    pending: () => queue.length,
    status: () => ({ ...status, queued: queue.length }),
    on: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
  };
})(typeof self !== "undefined" ? self : globalThis);
