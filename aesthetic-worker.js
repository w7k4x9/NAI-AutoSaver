// 미적 점수 worker: runs the aesthetic model off the page's main thread, so
// 셀렉 keeps responding while pictures are being scored.
// Pre-processing follows deepghs/imgutils (MIT): the model's preprocess.json
// when it has one, otherwise a stretch-resize to the model size, RGB / 255,
// CHW, (x - 0.5) / 0.5.
/* global ort */
"use strict";
importScripts("vendor/ort/ort.wasm.min.js");

let session = null;
let inputName = "input";
let outputName = "output";
let size = 384;
let stages = null;

function shape(meta) {
  const dims = meta?.shape || meta?.dimensions;
  return Array.isArray(dims) ? dims : null;
}

async function init({ model, wasmBase, threads, preprocess, fallbackSize }) {
  ort.env.wasm.wasmPaths = wasmBase;
  ort.env.wasm.numThreads = Math.max(1, threads | 0);
  session = await ort.InferenceSession.create(model, { executionProviders: ["wasm"], graphOptimizationLevel: "all" });
  inputName = session.inputNames[0];
  outputName = session.outputNames.includes("output") ? "output" : session.outputNames[0];
  const dims = shape(session.inputMetadata?.[0]);
  size = dims && typeof dims[2] === "number" && dims[2] > 0 ? dims[2] : fallbackSize || 384;
  stages = Array.isArray(preprocess?.stages) ? preprocess.stages : null;
  return { size, threads: ort.env.wasm.numThreads };
}

// A picture as an OffscreenCanvas on white (transparent parts count as white).
function toCanvas(src, w, h, sx = 0, sy = 0, sw = src.width, sh = src.height) {
  const c = new OffscreenCanvas(Math.max(1, Math.round(w)), Math.max(1, Math.round(h)));
  const g = c.getContext("2d", { willReadFrequently: true });
  g.fillStyle = "#fff";
  g.fillRect(0, 0, c.width, c.height);
  g.imageSmoothingEnabled = true;
  g.imageSmoothingQuality = "high";
  g.drawImage(src, sx, sy, sw, sh, 0, 0, c.width, c.height);
  return c;
}
const pair = (v) => (Array.isArray(v) ? (v.length === 1 ? [v[0], v[0]] : [v[0], v[1]]) : [v, v]);

// The few torchvision-like steps deepghs models use. Unknown step → null
// (then the default stretch-resize is used).
function runStages(bitmap) {
  let img = toCanvas(bitmap, bitmap.width, bitmap.height);
  let mean = null;
  let std = null;
  let tensor = false;
  for (const st of stages) {
    const type = st.type;
    if (type === "convert_rgb") continue;
    if (type === "resize") {
      if (typeof st.size === "number") {
        // shorter side → size, aspect kept (max_size caps the longer side)
        let s = st.size / Math.min(img.width, img.height);
        if (st.max_size && Math.max(img.width, img.height) * s > st.max_size) s = st.max_size / Math.max(img.width, img.height);
        img = toCanvas(img, img.width * s, img.height * s);
      } else {
        const [h, w] = pair(st.size);
        img = toCanvas(img, w, h);
      }
    } else if (type === "center_crop") {
      const [h, w] = pair(st.size);
      img = toCanvas(img, w, h, Math.round((img.width - w) / 2), Math.round((img.height - h) / 2), w, h);
    } else if (type === "to_tensor" || type === "maybe_to_tensor") {
      tensor = true;
    } else if (type === "normalize") {
      mean = pair3(st.mean);
      std = pair3(st.std);
    } else {
      return null;
    }
  }
  if (!tensor || img.width !== size || img.height !== size) return null;
  return encode(img, mean || [0, 0, 0], std || [1, 1, 1]);
}
function pair3(v) {
  if (Array.isArray(v)) return v.length >= 3 ? v.slice(0, 3).map(Number) : [Number(v[0]), Number(v[0]), Number(v[0])];
  return [Number(v), Number(v), Number(v)];
}
function encode(canvas, mean, std) {
  const { data } = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height);
  const n = canvas.width * canvas.height;
  const out = new Float32Array(3 * n);
  for (let i = 0; i < n; i += 1) {
    out[i] = (data[i * 4] / 255 - mean[0]) / std[0];
    out[n + i] = (data[i * 4 + 1] / 255 - mean[1]) / std[1];
    out[2 * n + i] = (data[i * 4 + 2] / 255 - mean[2]) / std[2];
  }
  return out;
}

async function score(blob) {
  const bitmap = await createImageBitmap(blob);
  try {
    const input = (stages && runStages(bitmap)) || encode(toCanvas(bitmap, size, size), [0.5, 0.5, 0.5], [0.5, 0.5, 0.5]);
    const result = await session.run({ [inputName]: new ort.Tensor("float32", input, [1, 3, size, size]) });
    return Array.from(result[outputName].data);
  } finally {
    bitmap.close();
  }
}

self.onmessage = async ({ data }) => {
  try {
    if (data.type === "init") {
      self.postMessage({ type: "ready", ...(await init(data)) });
    } else if (data.type === "score") {
      self.postMessage({ type: "score", id: data.id, probs: await score(data.blob) });
    }
  } catch (error) {
    self.postMessage({ type: data.type === "init" ? "init-error" : "score-error", id: data.id, error: String(error?.message || error) });
  }
};
