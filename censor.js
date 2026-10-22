// 검열 사본: find nipples / genitals in anime pictures and cover them with a
// white blur, entirely inside the browser.
//
// Model: deepghs/anime_censor_detection (Hugging Face, MIT on its model card;
// trained with Ultralytics YOLOv8). It is NOT shipped with the extension: the
// browser downloads it once on first use and keeps it in Cache Storage.
// Runtime: onnxruntime-web (MIT), bundled under vendor/ort.
// Pre/post-processing follows deepghs/imgutils (MIT): stretch-resize to the
// model size, RGB/255 CHW, YOLOv8 [4+classes, boxes] output, NMS IoU 0.7.
(function initCensor(root) {
  "use strict";

  const MODEL = {
    repo: "deepghs/anime_censor_detection",
    name: "censor_detect_v1.0_s",
    sizeMB: 45,
    license: "MIT (모델 카드 표기) · Ultralytics YOLOv8로 학습",
    labelsFallback: ["nipple_f", "penis", "pussy"],
    thresholdFallback: 0.3,
  };
  const LABEL_KO = { nipple_f: "유두", penis: "음경", pussy: "음부" };
  const CACHE_NAME = "nai-autosaver-models-v1";
  const base = () => `https://huggingface.co/${MODEL.repo}/resolve/main/${MODEL.name}`;

  let session = null;
  let sessionPromise = null;
  let labels = MODEL.labelsFallback;
  let threshold = MODEL.thresholdFallback;
  let inputSize = 640;

  async function cachedFetch(url, { onProgress } = {}) {
    const cache = await caches.open(CACHE_NAME);
    const hit = await cache.match(url);
    if (hit) return hit;
    const res = await fetch(url, { mode: "cors", credentials: "omit" });
    if (!res.ok) throw new Error(`내려받기 실패 (${res.status})`);
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

  async function removeModel() {
    session = null;
    sessionPromise = null;
    await caches.delete(CACHE_NAME);
  }

  function loadModel({ onProgress } = {}) {
    if (session) return Promise.resolve(session);
    if (sessionPromise) return sessionPromise;
    sessionPromise = (async () => {
      const ort = root.ort;
      if (!ort) throw new Error("검열 엔진을 불러오지 못했어요.");
      ort.env.wasm.numThreads = 1;
      try {
        ort.env.wasm.wasmPaths = chrome.runtime.getURL("vendor/ort/");
      } catch (error) {
        ort.env.wasm.wasmPaths = "vendor/ort/";
      }
      try {
        const lab = await (await cachedFetch(`${base()}/labels.json`)).json();
        if (Array.isArray(lab) && lab.length) labels = lab.map(String);
      } catch (error) {
        void error;
      }
      try {
        const th = await (await cachedFetch(`${base()}/threshold.json`)).json();
        const value = Number(th?.threshold ?? th);
        if (value > 0 && value < 1) threshold = value;
      } catch (error) {
        void error;
      }
      const model = await (await cachedFetch(`${base()}/model.onnx`, { onProgress })).arrayBuffer();
      session = await ort.InferenceSession.create(model, { executionProviders: ["wasm"], graphOptimizationLevel: "all" });
      const meta = session.inputMetadata?.[0];
      const dims = meta?.shape || meta?.dimensions;
      if (Array.isArray(dims) && typeof dims[2] === "number" && dims[2] > 0) inputSize = dims[2];
      return session;
    })().catch((error) => {
      sessionPromise = null;
      throw error;
    });
    return sessionPromise;
  }

  // ------------------------------------------------------------ inference ---
  function nms(boxes, iou = 0.7) {
    const sorted = boxes.slice().sort((a, b) => b.score - a.score);
    const keep = [];
    const area = (b) => Math.max(0, b.x1 - b.x0 + 1) * Math.max(0, b.y1 - b.y0 + 1);
    for (const b of sorted) {
      let ok = true;
      for (const k of keep) {
        const w = Math.max(0, Math.min(b.x1, k.x1) - Math.max(b.x0, k.x0) + 1);
        const h = Math.max(0, Math.min(b.y1, k.y1) - Math.max(b.y0, k.y0) + 1);
        const inter = w * h;
        if (inter / (area(b) + area(k) - inter) > iou) {
          ok = false;
          break;
        }
      }
      if (ok) keep.push(b);
    }
    return keep;
  }

  // output: Float32Array laid out [4 + classes, count] (YOLOv8, batch removed).
  function postprocess(output, dims, { classes, conf, iou = 0.7, scaleX, scaleY, width, height, labelNames }) {
    const rows = dims[dims.length - 2];
    const count = dims[dims.length - 1];
    if (rows !== 4 + classes) throw new Error(`모델 출력 모양이 달라요 (${dims.join("×")})`);
    const out = [];
    for (let i = 0; i < count; i += 1) {
      let best = -1;
      let score = 0;
      for (let c = 0; c < classes; c += 1) {
        const s = output[(4 + c) * count + i];
        if (s > score) {
          score = s;
          best = c;
        }
      }
      if (score <= conf) continue;
      const cx = output[i];
      const cy = output[count + i];
      const w = output[2 * count + i];
      const h = output[3 * count + i];
      out.push({ x0: cx - w / 2, y0: cy - h / 2, x1: cx + w / 2, y1: cy + h / 2, score, cls: best });
    }
    const clamp = (v, max) => Math.round(Math.min(max, Math.max(0, v)));
    return nms(out, iou).map((b) => ({
      x0: clamp(b.x0 * scaleX, width),
      y0: clamp(b.y0 * scaleY, height),
      x1: clamp(b.x1 * scaleX, width),
      y1: clamp(b.y1 * scaleY, height),
      score: b.score,
      label: labelNames[b.cls] || String(b.cls),
    }));
  }

  async function detect(bitmap, { conf = null } = {}) {
    const s = await loadModel();
    const ort = root.ort;
    const size = inputSize;
    const canvas = new OffscreenCanvas(size, size);
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(bitmap, 0, 0, size, size);
    const { data } = ctx.getImageData(0, 0, size, size);
    const plane = size * size;
    const input = new Float32Array(3 * plane);
    for (let p = 0, i = 0; p < plane; p += 1, i += 4) {
      input[p] = data[i] / 255;
      input[plane + p] = data[i + 1] / 255;
      input[2 * plane + p] = data[i + 2] / 255;
    }
    const feeds = { [s.inputNames[0]]: new ort.Tensor("float32", input, [1, 3, size, size]) };
    const result = await s.run(feeds);
    const tensor = result[s.outputNames[0]];
    return postprocess(tensor.data, tensor.dims, {
      classes: labels.length,
      conf: conf ?? threshold,
      scaleX: bitmap.width / size,
      scaleY: bitmap.height / size,
      width: bitmap.width,
      height: bitmap.height,
      labelNames: labels,
    });
  }

  // ------------------------------------------------------------ rendering ---
  // Soft white glow, shaped like what it hides (the look of hand-made "white
  // light" censoring): a solid white core with feathered edges and a faint
  // halo, over a blur of the picture. Detected boxes become shapes:
  //   nipples           -> a small circle
  //   genitals          -> an ellipse along the object's direction
  // Hand-painted strokes ({ kind: "stroke", points, r }) render the same way;
  // eraser strokes ({ kind: "erase", points, r }) cut back what came before.

  // Dominant direction inside a box from the image's edge structure
  // (structure tensor). Returns { angle, coherence } with angle along edges.
  function edgeDirection(bitmap, b) {
    const w = Math.max(1, b.x1 - b.x0);
    const h = Math.max(1, b.y1 - b.y0);
    const k = Math.min(1, 96 / Math.max(w, h));
    const W = Math.max(8, Math.round(w * k));
    const H = Math.max(8, Math.round(h * k));
    const c = new OffscreenCanvas(W, H);
    const g = c.getContext("2d", { willReadFrequently: true });
    g.drawImage(bitmap, b.x0, b.y0, w, h, 0, 0, W, H);
    const d = g.getImageData(0, 0, W, H).data;
    const lum = new Float32Array(W * H);
    for (let i = 0, p = 0; p < lum.length; i += 4, p += 1) lum[p] = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    let jxx = 0;
    let jyy = 0;
    let jxy = 0;
    const sx = W / 2.2;
    const sy = H / 2.2;
    for (let y = 1; y < H - 1; y += 1) {
      for (let x = 1; x < W - 1; x += 1) {
        const at = (xx, yy) => lum[yy * W + xx];
        const gx = at(x + 1, y - 1) + 2 * at(x + 1, y) + at(x + 1, y + 1) - at(x - 1, y - 1) - 2 * at(x - 1, y) - at(x - 1, y + 1);
        const gy = at(x - 1, y + 1) + 2 * at(x, y + 1) + at(x + 1, y + 1) - at(x - 1, y - 1) - 2 * at(x, y - 1) - at(x + 1, y - 1);
        const wgt = Math.exp(-(((x - W / 2) / sx) ** 2 + ((y - H / 2) / sy) ** 2));
        jxx += wgt * gx * gx;
        jyy += wgt * gy * gy;
        jxy += wgt * gx * gy;
      }
    }
    const trace = jxx + jyy;
    if (trace <= 1e-6) return { angle: w >= h ? 0 : Math.PI / 2, coherence: 0 };
    const coherence = Math.sqrt((jxx - jyy) ** 2 + 4 * jxy * jxy) / trace;
    const gradient = 0.5 * Math.atan2(2 * jxy, jxx - jyy);
    return { angle: gradient + Math.PI / 2, coherence };
  }

  // Box -> { cx, cy, rx, ry, angle } in picture pixels.
  function shapeFor(bitmap, b) {
    const w = Math.max(2, b.x1 - b.x0);
    const h = Math.max(2, b.y1 - b.y0);
    const cx = (b.x0 + b.x1) / 2;
    const cy = (b.y0 + b.y1) / 2;
    if (b.label === "nipple_f") {
      const r = ((w + h) / 4) * 0.92;
      return { cx, cy, rx: r, ry: r, angle: 0 };
    }
    let angle = w >= h ? 0 : Math.PI / 2;
    try {
      const dir = edgeDirection(bitmap, b);
      if (dir.coherence >= 0.15) angle = dir.angle;
    } catch (error) {
      void error;
    }
    // A rod of length L and thickness t at `angle` fills a w×h box:
    //   w = L|cos| + t|sin|,  h = L|sin| + t|cos|
    const c = Math.abs(Math.cos(angle));
    const s = Math.abs(Math.sin(angle));
    const det = c * c - s * s;
    let L;
    let t;
    if (Math.abs(det) > 0.25) {
      L = (c * w - s * h) / det;
      t = (c * h - s * w) / det;
    } else {
      L = Math.hypot(w, h) * 0.85;
      t = Math.min(w, h) * 0.45;
    }
    if (!(L > 0) || !(t > 0) || t > L) {
      // The box isn't a tight fit for a rod at this angle: take the chord
      // through the centre along the direction, and a moderate thickness.
      L = Math.min(c > 0.01 ? w / c : Infinity, s > 0.01 ? h / s : Infinity);
      t = Math.min(w, h) * 0.55;
    }
    L = Math.min(Math.hypot(w, h), Math.max(L, Math.max(w, h) * 0.6));
    t = Math.min(L * 0.75, Math.max(t, L * 0.24));
    const minor = b.label === "pussy" ? Math.max(t, L * 0.36) : t;
    return { cx, cy, rx: (L / 2) * 1.06, ry: (minor / 2) * 1.15, angle };
  }

  function traceMark(g, m, grow) {
    g.beginPath();
    if (m.kind === "stroke" || m.kind === "erase") {
      const pts = m.points || [];
      if (!pts.length) return false;
      g.lineCap = "round";
      g.lineJoin = "round";
      g.lineWidth = (m.r + grow) * 2;
      g.moveTo(pts[0].x, pts[0].y);
      if (pts.length === 1) g.lineTo(pts[0].x + 0.01, pts[0].y);
      for (let i = 1; i < pts.length; i += 1) g.lineTo(pts[i].x, pts[i].y);
      g.stroke();
      return true;
    }
    // A capsule (rounded bar) along the shape's direction — round when rx = ry.
    const sh = m.shape;
    const half = Math.max(0, sh.rx - sh.ry);
    const dx = Math.cos(sh.angle) * half;
    const dy = Math.sin(sh.angle) * half;
    g.lineCap = "round";
    g.lineWidth = Math.max(2, (sh.ry + grow) * 2);
    g.moveTo(sh.cx - dx, sh.cy - dy);
    g.lineTo(sh.cx + dx + 0.01, sh.cy + dy);
    g.stroke();
    return true;
  }

  function featherOf(m) {
    if (m.kind === "erase") return Math.max(2, m.r * 0.25);
    const r = m.kind === "stroke" ? m.r : Math.min(m.shape.rx, m.shape.ry);
    return Math.max(3, r * 0.32);
  }

  // size: overall scale for detected shapes (1 = as found); each mark can
  // also carry its own `scale`. Painted strokes keep the brush size.
  function render(bitmap, marks, { strength = 0.7, size = 1 } = {}) {
    const W = bitmap.width;
    const H = bitmap.height;
    const canvas = new OffscreenCanvas(W, H);
    const ctx = canvas.getContext("2d");
    ctx.drawImage(bitmap, 0, 0);
    const list = marks.filter(Boolean).map((m) => {
      if (m.kind === "stroke" || m.kind === "erase") return m;
      if (!m.shape) m.shape = shapeFor(bitmap, m);
      const k = Math.max(0.2, (m.scale || 1) * (size || 1));
      return { ...m, shape: { ...m.shape, rx: m.shape.rx * k, ry: m.shape.ry * k } };
    });
    if (!list.some((m) => m.kind !== "erase")) return canvas;
    // soft mask (core + feathered edge)
    const mask = new OffscreenCanvas(W, H);
    const mg = mask.getContext("2d");
    mg.fillStyle = "#fff";
    mg.strokeStyle = "#fff";
    let maxFeather = 3;
    // In order, so an eraser stroke removes what came before it and later
    // painting covers it again.
    for (const m of list) {
      const f = featherOf(m);
      const erase = m.kind === "erase";
      if (!erase) maxFeather = Math.max(maxFeather, f);
      mg.globalCompositeOperation = erase ? "destination-out" : "source-over";
      mg.filter = `blur(${f.toFixed(1)}px)`;
      traceMark(mg, m, erase ? 0 : f * 0.8);
    }
    mg.globalCompositeOperation = "source-over";
    mg.filter = "none";
    const masked = (source, filter = "none") => {
      const layer = new OffscreenCanvas(W, H);
      const lg = layer.getContext("2d");
      lg.filter = filter;
      if (source) lg.drawImage(source, 0, 0);
      else {
        lg.fillStyle = "#fff";
        lg.fillRect(0, 0, W, H);
      }
      lg.filter = "none";
      lg.globalCompositeOperation = "destination-in";
      lg.drawImage(mask, 0, 0);
      return layer;
    };
    // 1. the picture blurred under the glow, so the edge melts instead of cutting
    ctx.drawImage(masked(bitmap, `blur(${Math.round(maxFeather * 0.9)}px)`), 0, 0);
    // 2. solid white core
    const white = masked(null);
    ctx.globalAlpha = 0.72 + 0.28 * strength;
    ctx.drawImage(white, 0, 0);
    // 3. faint halo
    ctx.globalAlpha = 0.18 + 0.22 * strength;
    ctx.filter = `blur(${Math.round(maxFeather * 1.2)}px)`;
    ctx.drawImage(white, 0, 0);
    ctx.filter = "none";
    ctx.globalAlpha = 1;
    return canvas;
  }

  // Censored bytes with every piece of metadata removed (format: "png" | "webp",
  // WebP is lossless like NovelAI's own).
  async function censoredBytes(bitmap, boxes, options = {}) {
    const canvas = render(bitmap, boxes, options);
    const webp = options.format === "webp";
    const blob = await canvas.convertToBlob(webp ? { type: "image/webp", quality: 1 } : { type: "image/png" });
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const cleaned = await root.NAIMeta.strip(bytes);
    return cleaned.bytes || bytes;
  }

  const api = {
    MODEL, LABEL_KO, loadModel, isDownloaded, removeModel, detect, render, censoredBytes, postprocess, nms, shapeFor, edgeDirection,
    info: () => ({ labels, threshold, inputSize, loaded: Boolean(session) }),
  };
  root.Censor = api;
  if (typeof module === "object" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
