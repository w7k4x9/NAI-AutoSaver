// Finds the "pre-logits" of a classifier ONNX model — the picture's feature
// vector right before the classification head — and adds it as an extra
// output, so one run gives both the class scores and a picture fingerprint.
//
// Only the bits of the ONNX protobuf needed for that are read; the model
// itself (weights and all) is copied untouched. Fields used (onnx.proto):
//   ModelProto.graph = 7
//   GraphProto.node = 1, initializer = 5, output = 12
//   NodeProto.input = 1, output = 2, op_type = 4, attribute = 5
//   AttributeProto.name = 1, ints = 8 · TensorProto.name = 8
//   ValueInfoProto.name = 1, type = 2 · TypeProto.tensor_type = 1 · elem_type = 1
(function initOnnxTap(root) {
  "use strict";

  function readVarint(buf, pos) {
    let result = 0;
    let shift = 0;
    let b;
    do {
      b = buf[pos++];
      result += (b & 0x7f) * 2 ** shift;
      shift += 7;
    } while (b & 0x80);
    return [result, pos];
  }
  // [{ field, wire, start (value start), end, value? }] for one message.
  function fields(buf, start, end) {
    const out = [];
    let pos = start;
    while (pos < end) {
      const tagStart = pos;
      let tag;
      [tag, pos] = readVarint(buf, pos);
      const field = Math.floor(tag / 8);
      const wire = tag & 7;
      if (wire === 0) {
        let v;
        [v, pos] = readVarint(buf, pos);
        out.push({ field, wire, tagStart, start: pos, end: pos, value: v });
      } else if (wire === 2) {
        let len;
        [len, pos] = readVarint(buf, pos);
        out.push({ field, wire, tagStart, start: pos, end: pos + len });
        pos += len;
      } else if (wire === 1) {
        out.push({ field, wire, tagStart, start: pos, end: pos + 8 });
        pos += 8;
      } else if (wire === 5) {
        out.push({ field, wire, tagStart, start: pos, end: pos + 4 });
        pos += 4;
      } else {
        throw new Error(`ONNX 파일을 읽지 못했어요 (wire ${wire}).`);
      }
    }
    return out;
  }
  const text = (buf, f) => new TextDecoder().decode(buf.subarray(f.start, f.end));
  function signed(v) {
    return v >= 2 ** 63 ? v - 2 ** 64 : v > 2 ** 53 ? v - 2 ** 64 : v;
  }

  function readGraph(buf) {
    const top = fields(buf, 0, buf.length);
    const g = top.find((f) => f.field === 7 && f.wire === 2);
    if (!g) throw new Error("ONNX 그래프가 없어요.");
    const nodes = [];
    const inits = new Set();
    const smallInts = new Map(); // name → int64 values of small constant tensors (opset 18 "axes" inputs)
    const outputs = [];
    for (const f of fields(buf, g.start, g.end)) {
      if (f.field === 1 && f.wire === 2) {
        const node = { inputs: [], outputs: [], op: "", axes: null };
        for (const nf of fields(buf, f.start, f.end)) {
          if (nf.field === 1 && nf.wire === 2) node.inputs.push(text(buf, nf));
          else if (nf.field === 2 && nf.wire === 2) node.outputs.push(text(buf, nf));
          else if (nf.field === 4 && nf.wire === 2) node.op = text(buf, nf);
          else if (nf.field === 5 && nf.wire === 2) {
            let name = "";
            const ints = [];
            for (const af of fields(buf, nf.start, nf.end)) {
              if (af.field === 1 && af.wire === 2) name = text(buf, af);
              else if (af.field === 8 && af.wire === 0) ints.push(signed(af.value));
              else if (af.field === 8 && af.wire === 2) {
                let p = af.start;
                while (p < af.end) {
                  let v;
                  [v, p] = readVarint(buf, p);
                  ints.push(signed(v));
                }
              }
            }
            if (name === "axes") node.axes = ints;
            if (name === "value") {
              const tf = fields(buf, nf.start, nf.end).find((af) => af.field === 5 && af.wire === 2);
              if (tf) node.valueInts = readTensor(buf, tf).ints;
            }
          }
        }
        nodes.push(node);
      } else if (f.field === 5 && f.wire === 2) {
        const t = readTensor(buf, f);
        if (t.name) {
          inits.add(t.name);
          if (t.ints) smallInts.set(t.name, t.ints);
        }
      } else if (f.field === 12 && f.wire === 2) {
        const nameField = fields(buf, f.start, f.end).find((vf) => vf.field === 1 && vf.wire === 2);
        if (nameField) outputs.push(text(buf, nameField));
      }
    }
    for (const n of nodes) {
      if (n.op === "Constant" && n.valueInts) for (const o of n.outputs) smallInts.set(o, n.valueInts);
    }
    // opset 18+: ReduceMean takes its axes as an input
    for (const n of nodes) if (!n.axes && n.inputs[1] && smallInts.has(n.inputs[1])) n.axes = smallInts.get(n.inputs[1]);
    return { top, graph: g, nodes, inits, outputs };
  }
  // A TensorProto's name, and its values when it is a small INT64 tensor.
  function readTensor(buf, f) {
    let name = "";
    let type = 0;
    let raw = null;
    const ints = [];
    let size = 0;
    for (const tf of fields(buf, f.start, f.end)) {
      if (tf.field === 8 && tf.wire === 2) name = text(buf, tf);
      else if (tf.field === 2 && tf.wire === 0) type = tf.value;
      else if (tf.field === 9 && tf.wire === 2) raw = tf;
      else if (tf.field === 7 && tf.wire === 2) {
        let p = tf.start;
        while (p < tf.end) {
          let v;
          [v, p] = readVarint(buf, p);
          ints.push(signed(v));
        }
      } else if (tf.field === 7 && tf.wire === 0) ints.push(signed(tf.value));
      size = Math.max(size, raw ? raw.end - raw.start : 0);
    }
    if (type !== 7) return { name, ints: null }; // not INT64
    if (raw && raw.end - raw.start <= 128) {
      const view = new DataView(buf.buffer, buf.byteOffset + raw.start, raw.end - raw.start);
      for (let i = 0; i + 8 <= view.byteLength; i += 8) ints.push(Number(view.getBigInt64(i, true)));
    }
    return { name, ints: ints.length && ints.length <= 16 ? ints : null };
  }

  const POOL_OPS = new Set(["GlobalAveragePool", "GlobalMaxPool", "AveragePool", "MaxPool"]);
  const CONV_OPS = new Set(["Conv", "ConvTranspose"]);
  // Walks back from the class output through the head: the input of the
  // first linear layer (MatMul / Gemm) after the global pooling.
  function findPreLogits(info, outputName) {
    const producer = new Map();
    const constants = new Set(info.inits);
    for (const n of info.nodes) {
      for (const o of n.outputs) producer.set(o, n);
      if (n.op === "Constant") n.outputs.forEach((o) => constants.add(o));
    }
    const dataInput = (n) => n.inputs.find((i) => i && !constants.has(i));
    let t = outputName || info.outputs[0];
    const linears = [];
    let pooled = false;
    for (let step = 0; step < 80 && t; step += 1) {
      const n = producer.get(t);
      if (!n) break;
      if (n.op === "MatMul" || n.op === "Gemm") linears.push(dataInput(n));
      if (POOL_OPS.has(n.op) || CONV_OPS.has(n.op)) {
        pooled = true;
        break;
      }
      // a mean over two or more axes = global pooling (a LayerNorm averages one)
      if ((n.op === "ReduceMean" || n.op === "ReduceSum") && n.axes && n.axes.length >= 2) {
        pooled = true;
        break;
      }
      t = dataInput(n);
    }
    if (!linears.length) return null;
    // Walked into the pooling: the earliest linear layer of the head. Not
    // found (unusual head): the input of the last layer before the classes'
    // own layer, when there are two, as in an MLP head.
    if (pooled) return linears[linears.length - 1];
    return linears.length >= 2 ? linears[1] : null;
  }

  function varint(n) {
    const out = [];
    let v = n;
    while (v >= 0x80) {
      out.push((v % 0x80) | 0x80);
      v = Math.floor(v / 0x80);
    }
    out.push(v);
    return out;
  }
  function lenField(field, bytes) {
    return Uint8Array.from([...varint(field * 8 + 2), ...varint(bytes.length), ...bytes]);
  }
  function concat(parts) {
    const total = parts.reduce((s, p) => s + p.length, 0);
    const out = new Uint8Array(total);
    let at = 0;
    for (const p of parts) {
      out.set(p, at);
      at += p.length;
    }
    return out;
  }
  // A float tensor output named `name` (no shape: the runtime works it out).
  function valueInfo(name) {
    const tensor = Uint8Array.from([0x08, 0x01]); // TypeProto.Tensor { elem_type = FLOAT }
    const type = lenField(1, tensor); // TypeProto { tensor_type }
    return concat([lenField(1, new TextEncoder().encode(name)), lenField(2, type)]);
  }

  // → { model: Uint8Array, name } with the fingerprint added as an output, or
  // { model, name: null } when it could not be found (model unchanged).
  function tapPreLogits(input, { outputName = "output" } = {}) {
    const buf = input instanceof Uint8Array ? input : new Uint8Array(input);
    const info = readGraph(buf);
    if (info.outputs.includes("embedding")) return { model: buf, name: "embedding" };
    const name = findPreLogits(info, info.outputs.includes(outputName) ? outputName : info.outputs[0]);
    if (!name) return { model: buf, name: null };
    if (info.outputs.includes(name)) return { model: buf, name };
    const g = info.graph;
    const extra = lenField(12, valueInfo(name));
    const graphBody = concat([buf.subarray(g.start, g.end), extra]);
    const graphField = concat([Uint8Array.from(varint(7 * 8 + 2)), Uint8Array.from(varint(graphBody.length)), graphBody]);
    return { model: concat([buf.subarray(0, g.tagStart), graphField, buf.subarray(g.end)]), name };
  }

  const api = { tapPreLogits, findPreLogits, readGraph };
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.OnnxTap = api;
})(typeof self !== "undefined" ? self : globalThis);
