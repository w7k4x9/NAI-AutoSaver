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
  const status = { phase: "off", progress: 0, error: "", threads: 1, done: 0 };

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
    try {
      const saved = await root.LibDB.getKv(SCORES_KEY);
      if (saved && typeof saved === "object") for (const [id, s] of Object.entries(saved)) if (typeof s === "number") scores.set(id, s);
    } catch (error) {
      void error;
    }
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
      setPhase("ready", { threads: info.threads });
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
        if (data.type === "score") resolve(data.probs);
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
        if (scores.has(id) || !get) continue;
        let blob = null;
        try {
          blob = await get();
        } catch (error) {
          blob = null;
        }
        if (!blob) continue;
        try {
          const s = toScore(await runOne(id, blob));
          scores.set(id, s);
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
  // Ask for scores. items: [{ id, blob: () => Blob }]. front: before the rest.
  function want(items, { front = false } = {}) {
    const fresh = [];
    for (const it of items) {
      if (!it || scores.has(it.id)) continue;
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
    forget: (id) => { scores.delete(id); saveScores(); },
    pending: () => queue.length,
    status: () => ({ ...status, queued: queue.length }),
    on: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
  };
})(typeof self !== "undefined" ? self : globalThis);
