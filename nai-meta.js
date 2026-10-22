// NovelAI image metadata: read it, show it, and strip it.
//
// NovelAI hides the generation settings in two places of every PNG:
//   1. text chunks (tEXt / iTXt): "Description" (prompt), "Comment" (JSON with
//      prompt, negative, seed, steps, sampler, characters …), "Source" (model) …
//   2. the lowest bit of every alpha value ("stealth" data): the magic text
//      "stealth_pngcomp" followed by gzipped JSON, read column by column.
// Stripping must remove both, otherwise the prompt can still be recovered.
//
// Pure JS + Compression Streams, so it runs the same in the extension pages,
// the content script and Node (tests).
(function initNaiMeta(root) {
  "use strict";

  const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];
  // Chunks that only describe how to draw the picture. Everything else
  // (tEXt, iTXt, zTXt, eXIf, tIME, caBX/C2PA, private chunks …) is dropped.
  const KEEP_CHUNKS = new Set(["IHDR", "PLTE", "IDAT", "IEND", "tRNS", "gAMA", "cHRM", "sRGB", "iCCP", "sBIT", "pHYs", "bKGD"]);
  const STEALTH_MAGIC = { "stealth_pngcomp": true, "stealth_pnginfo": false }; // value = gzipped
  const MAGIC_BITS = "stealth_pngcomp".length * 8;

  // ---------------------------------------------------------------- bytes ---
  function toBytes(input) {
    if (input instanceof Uint8Array) return input;
    if (input instanceof ArrayBuffer) return new Uint8Array(input);
    if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
    throw new TypeError("PNG bytes expected");
  }
  function readU32(bytes, offset) {
    return ((bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0;
  }
  function writeU32(bytes, offset, value) {
    bytes[offset] = (value >>> 24) & 255;
    bytes[offset + 1] = (value >>> 16) & 255;
    bytes[offset + 2] = (value >>> 8) & 255;
    bytes[offset + 3] = value & 255;
  }
  const latin1 = (bytes) => {
    let out = "";
    for (let i = 0; i < bytes.length; i += 1) out += String.fromCharCode(bytes[i]);
    return out;
  };
  function decodeText(bytes) {
    // tEXt is Latin-1 by the spec, but NovelAI writes UTF-8 there.
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch (error) {
      return latin1(bytes);
    }
  }

  let crcTable = null;
  function crc32(bytes, start = 0, end = bytes.length) {
    if (!crcTable) {
      crcTable = new Uint32Array(256);
      for (let n = 0; n < 256; n += 1) {
        let c = n;
        for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
        crcTable[n] = c >>> 0;
      }
    }
    let crc = 0xFFFFFFFF;
    for (let i = start; i < end; i += 1) crc = crcTable[(crc ^ bytes[i]) & 255] ^ (crc >>> 8);
    return (crc ^ 0xFFFFFFFF) >>> 0;
  }

  async function streamBytes(bytes, transform) {
    const stream = new Blob([bytes]).stream().pipeThrough(transform);
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }
  const inflate = (bytes) => streamBytes(bytes, new DecompressionStream("deflate"));
  const deflate = (bytes) => streamBytes(bytes, new CompressionStream("deflate"));
  const gunzip = (bytes) => streamBytes(bytes, new DecompressionStream("gzip"));

  // --------------------------------------------------------------- chunks ---
  function isPng(input) {
    const bytes = toBytes(input);
    return bytes.length > 8 && PNG_SIGNATURE.every((v, i) => bytes[i] === v);
  }

  function readChunks(input) {
    const bytes = toBytes(input);
    if (!isPng(bytes)) throw new Error("PNG 파일이 아니에요.");
    const chunks = [];
    let offset = 8;
    while (offset + 12 <= bytes.length) {
      const length = readU32(bytes, offset);
      const type = latin1(bytes.subarray(offset + 4, offset + 8));
      const dataStart = offset + 8;
      const end = dataStart + length + 4;
      if (end > bytes.length) break;
      chunks.push({ type, start: offset, dataStart, length, end, data: bytes.subarray(dataStart, dataStart + length) });
      offset = end;
      if (type === "IEND") break;
    }
    return chunks;
  }

  async function readTextChunks(input) {
    const out = {};
    for (const chunk of readChunks(input)) {
      const data = chunk.data;
      if (chunk.type === "tEXt") {
        const zero = data.indexOf(0);
        if (zero > 0) out[latin1(data.subarray(0, zero))] = decodeText(data.subarray(zero + 1));
      } else if (chunk.type === "zTXt") {
        const zero = data.indexOf(0);
        if (zero > 0) {
          try {
            out[latin1(data.subarray(0, zero))] = decodeText(await inflate(data.subarray(zero + 2)));
          } catch (error) { void error; }
        }
      } else if (chunk.type === "iTXt") {
        const zero = data.indexOf(0);
        if (zero <= 0) continue;
        const key = latin1(data.subarray(0, zero));
        const compressed = data[zero + 1] === 1;
        let p = zero + 3;
        p = data.indexOf(0, p) + 1; // language tag
        p = data.indexOf(0, p) + 1; // translated keyword
        if (p <= 0) continue;
        try {
          const raw = data.subarray(p);
          out[key] = new TextDecoder("utf-8").decode(compressed ? await inflate(raw) : raw);
        } catch (error) { void error; }
      }
    }
    return out;
  }

  // --------------------------------------------------------------- pixels ---
  function header(chunks) {
    const ihdr = chunks.find((c) => c.type === "IHDR");
    if (!ihdr) throw new Error("IHDR 없음");
    const d = ihdr.data;
    return { width: readU32(d, 0), height: readU32(d, 4), bitDepth: d[8], colorType: d[9], interlace: d[12] };
  }
  const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

  function paeth(a, b, c) {
    const p = a + b - c;
    const pa = Math.abs(p - a);
    const pb = Math.abs(p - b);
    const pc = Math.abs(p - c);
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
  }

  // Decodes 8-bit, non-interlaced PNGs into raw scanlines (no filter bytes).
  async function decodePixels(input) {
    const bytes = toBytes(input);
    const chunks = readChunks(bytes);
    const info = header(chunks);
    const channels = CHANNELS[info.colorType];
    if (info.bitDepth !== 8 || info.interlace !== 0 || !channels) {
      return { ...info, supported: false };
    }
    const idat = chunks.filter((c) => c.type === "IDAT");
    const total = idat.reduce((n, c) => n + c.length, 0);
    const joined = new Uint8Array(total);
    let o = 0;
    for (const c of idat) {
      joined.set(c.data, o);
      o += c.length;
    }
    const raw = await inflate(joined);
    const stride = info.width * channels;
    const pixels = new Uint8Array(stride * info.height);
    for (let y = 0; y < info.height; y += 1) {
      const filter = raw[y * (stride + 1)];
      const src = y * (stride + 1) + 1;
      const dst = y * stride;
      for (let x = 0; x < stride; x += 1) {
        const v = raw[src + x];
        const a = x >= channels ? pixels[dst + x - channels] : 0;
        const b = y > 0 ? pixels[dst - stride + x] : 0;
        const c = x >= channels && y > 0 ? pixels[dst - stride + x - channels] : 0;
        let out;
        switch (filter) {
          case 0: out = v; break;
          case 1: out = v + a; break;
          case 2: out = v + b; break;
          case 3: out = v + ((a + b) >> 1); break;
          case 4: out = v + paeth(a, b, c); break;
          default: throw new Error(`알 수 없는 PNG 필터 ${filter}`);
        }
        pixels[dst + x] = out & 255;
      }
    }
    return { ...info, channels, stride, pixels, supported: true };
  }

  // Adaptive filtering (smallest sum of absolute values per row), like most
  // encoders, so the cleaned copy is about as small as the original.
  async function encodePixels({ width, height, colorType, pixels }, extraChunks = []) {
    const channels = CHANNELS[colorType];
    const stride = width * channels;
    const filtered = new Uint8Array((stride + 1) * height);
    const candidate = new Uint8Array(stride);
    const best = new Uint8Array(stride);
    for (let y = 0; y < height; y += 1) {
      const row = y * stride;
      let bestSum = Infinity;
      let bestFilter = 0;
      for (let f = 0; f < 5; f += 1) {
        let sum = 0;
        for (let x = 0; x < stride; x += 1) {
          const v = pixels[row + x];
          const a = x >= channels ? pixels[row + x - channels] : 0;
          const b = y > 0 ? pixels[row - stride + x] : 0;
          const c = x >= channels && y > 0 ? pixels[row - stride + x - channels] : 0;
          const out = (f === 0 ? v : f === 1 ? v - a : f === 2 ? v - b : f === 3 ? v - ((a + b) >> 1) : v - paeth(a, b, c)) & 255;
          candidate[x] = out;
          sum += out < 128 ? out : 256 - out;
          if (sum >= bestSum) break;
        }
        if (sum < bestSum) {
          bestSum = sum;
          bestFilter = f;
          best.set(candidate);
        }
      }
      filtered[y * (stride + 1)] = bestFilter;
      filtered.set(best, y * (stride + 1) + 1);
    }
    const ihdr = new Uint8Array(13);
    writeU32(ihdr, 0, width);
    writeU32(ihdr, 4, height);
    ihdr[8] = 8;
    ihdr[9] = colorType;
    const idat = await deflate(filtered);
    return assemble([{ type: "IHDR", data: ihdr }, ...extraChunks, { type: "IDAT", data: idat }, { type: "IEND", data: new Uint8Array(0) }]);
  }

  function assemble(chunks) {
    const size = 8 + chunks.reduce((n, c) => n + 12 + c.data.length, 0);
    const out = new Uint8Array(size);
    out.set(PNG_SIGNATURE, 0);
    let o = 8;
    for (const c of chunks) {
      writeU32(out, o, c.data.length);
      for (let i = 0; i < 4; i += 1) out[o + 4 + i] = c.type.charCodeAt(i);
      out.set(c.data, o + 8);
      writeU32(out, o + 8 + c.data.length, crc32(out, o + 4, o + 8 + c.data.length));
      o += 12 + c.data.length;
    }
    return out;
  }

  // -------------------------------------------------------------- stealth ---
  // Alpha LSBs, column by column (x outer, y inner), most significant bit first.
  function stealthBits(decoded) {
    const { width, height, channels, pixels, stride } = decoded;
    let x = 0;
    let y = 0;
    return function next() {
      if (x >= width) return null;
      const bit = pixels[y * stride + x * channels + channels - 1] & 1;
      y += 1;
      if (y >= height) {
        y = 0;
        x += 1;
      }
      return bit;
    };
  }
  function takeBytes(next, count) {
    const out = new Uint8Array(count);
    for (let i = 0; i < count; i += 1) {
      let v = 0;
      for (let b = 0; b < 8; b += 1) {
        const bit = next();
        if (bit == null) return null;
        v = (v << 1) | bit;
      }
      out[i] = v;
    }
    return out;
  }

  async function readStealth(input, decoded = null) {
    const d = decoded || await decodePixels(input);
    if (!d.supported || (d.colorType !== 6 && d.colorType !== 4)) return null;
    if (d.width * d.height < MAGIC_BITS + 32) return null;
    const next = stealthBits(d);
    const magicBytes = takeBytes(next, MAGIC_BITS / 8);
    const magic = magicBytes && latin1(magicBytes);
    if (!(magic in STEALTH_MAGIC)) return null;
    const lenBytes = takeBytes(next, 4);
    const bitLength = readU32(lenBytes, 0);
    if (!bitLength || bitLength % 8 || bitLength > d.width * d.height) return null;
    const payload = takeBytes(next, bitLength / 8);
    if (!payload) return null;
    try {
      const text = new TextDecoder("utf-8").decode(STEALTH_MAGIC[magic] ? await gunzip(payload) : payload);
      return { magic, text };
    } catch (error) {
      return null;
    }
  }


  // ================================================================ WebP ===
  // NovelAI's WebP download (checked against a real file): lossless VP8L with
  // alpha, the same stealth bits in the alpha LSBs as its PNGs, and an EXIF
  // chunk (big-endian TIFF) holding
  //   IFD0  0x010D DocumentName     = Title
  //         0x010E ImageDescription = Description
  //         0x0131 Software         = Source
  //   Exif  0x9286 UserComment      = "ASCII\0\0\0" + JSON of every PNG text field
  // so the PNG text map round-trips through UserComment.
  function isWebp(input) {
    const b = toBytes(input);
    return b.length >= 16 && latin1(b.subarray(0, 4)) === "RIFF" && latin1(b.subarray(8, 12)) === "WEBP";
  }
  const readU32LE = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
  const readU24LE = (b, o) => b[o] | (b[o + 1] << 8) | (b[o + 2] << 16);

  function webpChunks(input) {
    const b = toBytes(input);
    if (!isWebp(b)) throw new Error("WebP 파일이 아니에요.");
    const end = Math.min(b.length, readU32LE(b, 4) + 8);
    const chunks = [];
    let i = 12;
    while (i + 8 <= end) {
      const type = latin1(b.subarray(i, i + 4));
      const size = readU32LE(b, i + 4);
      if (i + 8 + size > b.length) break;
      chunks.push({ type, data: b.subarray(i + 8, i + 8 + size) });
      i += 8 + size + (size & 1);
    }
    return chunks;
  }

  function webpHeader(input) {
    const chunks = webpChunks(input);
    const x = chunks.find((c) => c.type === "VP8X");
    if (x && x.data.length >= 10) {
      const flags = x.data[0];
      return { width: readU24LE(x.data, 4) + 1, height: readU24LE(x.data, 7) + 1, alpha: Boolean(flags & 0x10), exif: Boolean(flags & 0x08), lossless: chunks.some((c) => c.type === "VP8L") };
    }
    const l = chunks.find((c) => c.type === "VP8L");
    if (l && l.data.length >= 5) {
      const v = readU32LE(l.data, 1);
      return { width: (v & 0x3fff) + 1, height: ((v >>> 14) & 0x3fff) + 1, alpha: Boolean((v >>> 28) & 1), exif: false, lossless: true };
    }
    const v = chunks.find((c) => c.type === "VP8 ");
    if (v && v.data.length >= 10) {
      return { width: (v.data[6] | (v.data[7] << 8)) & 0x3fff, height: (v.data[8] | (v.data[9] << 8)) & 0x3fff, alpha: false, exif: false, lossless: false };
    }
    return { width: 0, height: 0, alpha: false, exif: false, lossless: false };
  }

  function utf8(bytes) {
    let end = bytes.length;
    while (end > 0 && bytes[end - 1] === 0) end -= 1;
    return new TextDecoder("utf-8").decode(bytes.subarray(0, end));
  }

  // TIFF/EXIF -> { tag: bytes } for IFD0 and the Exif sub-IFD.
  function readExifTags(exif) {
    let b = exif;
    if (latin1(b.subarray(0, 6)) === "Exif\0\0") b = b.subarray(6);
    const order = latin1(b.subarray(0, 2));
    const le = order === "II";
    if (!le && order !== "MM") return {};
    const u16 = (o) => (le ? b[o] | (b[o + 1] << 8) : (b[o] << 8) | b[o + 1]);
    const u32 = (o) => (le ? readU32LE(b, o) : readU32(b, o));
    const SIZES = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8 };
    const tags = {};
    const walk = (off, depth) => {
      if (off + 2 > b.length || depth > 2) return;
      const n = u16(off);
      for (let k = 0; k < n; k += 1) {
        const e = off + 2 + 12 * k;
        if (e + 12 > b.length) return;
        const tag = u16(e);
        const type = u16(e + 2);
        const count = u32(e + 4);
        const size = (SIZES[type] || 1) * count;
        const start = size <= 4 ? e + 8 : u32(e + 8);
        if (start + size > b.length) continue;
        if (tag === 0x8769) walk(u32(e + 8), depth + 1);
        else tags[tag] = b.subarray(start, start + size);
      }
    };
    walk(u32(4), 0);
    return tags;
  }

  function userCommentText(bytes) {
    if (!bytes || bytes.length < 8) return "";
    const charset = latin1(bytes.subarray(0, 8)).replace(/\0+$/, "");
    const body = bytes.subarray(8);
    if (charset === "UNICODE") {
      const le = body[0] !== 0 && body[1] === 0;
      return new TextDecoder(le ? "utf-16le" : "utf-16be").decode(body).replace(/\0+$/, "");
    }
    return utf8(body);
  }

  // The PNG-style text map ({Comment, Description, Source, ...}) of a WebP.
  function readWebpText(input) {
    const exif = webpChunks(input).find((c) => c.type === "EXIF");
    if (!exif) return {};
    const tags = readExifTags(exif.data);
    const comment = userCommentText(tags[0x9286]);
    const parsed = parseJson(comment);
    const text = {};
    if (parsed && !Array.isArray(parsed)) {
      for (const [k, v] of Object.entries(parsed)) text[k] = typeof v === "string" ? v : JSON.stringify(v);
    } else if (comment) {
      text.Comment = comment;
    }
    if (!text.Description && tags[0x010e]) text.Description = utf8(tags[0x010e]);
    if (!text.Source && tags[0x0131]) text.Source = utf8(tags[0x0131]);
    if (!text.Title && tags[0x010d]) text.Title = utf8(tags[0x010d]);
    return text;
  }

  function buildExif(text) {
    const enc = new TextEncoder();
    const ascii = (v) => { const t = enc.encode(String(v)); const out = new Uint8Array(t.length + 1); out.set(t); return out; };
    const sorted = {};
    for (const k of Object.keys(text).sort()) sorted[k] = text[k];
    const comment = enc.encode(JSON.stringify(sorted));
    const userComment = new Uint8Array(8 + comment.length);
    userComment.set([65, 83, 67, 73, 73, 0, 0, 0]);
    userComment.set(comment, 8);
    const ifd0 = [];
    if (text.Title) ifd0.push([0x010d, 2, ascii(text.Title)]);
    if (text.Description) ifd0.push([0x010e, 2, ascii(text.Description)]);
    if (text.Source || text.Software) ifd0.push([0x0131, 2, ascii(text.Source || text.Software)]);
    const ifd0Size = 2 + 12 * (ifd0.length + 1) + 4;
    let dataLen = 0;
    for (const t of ifd0) if (t[2].length > 4) dataLen += t[2].length; // NovelAI packs values without word padding
    const exifOff = 8 + ifd0Size + dataLen;
    const exifSize = 2 + 12 + 4;
    const total = exifOff + exifSize + userComment.length;
    const b = new Uint8Array(total);
    const w16 = (o, v) => { b[o] = (v >> 8) & 255; b[o + 1] = v & 255; };
    const w32 = (o, v) => writeU32(b, o, v);
    b.set([77, 77, 0, 42]);
    w32(4, 8);
    w16(8, ifd0.length + 1);
    let data = 8 + ifd0Size;
    ifd0.forEach(([tag, type, bytes], k) => {
      const e = 10 + 12 * k;
      w16(e, tag); w16(e + 2, type); w32(e + 4, bytes.length);
      if (bytes.length <= 4) b.set(bytes, e + 8);
      else { w32(e + 8, data); b.set(bytes, data); data += bytes.length; }
    });
    const pe = 10 + 12 * ifd0.length;
    w16(pe, 0x8769); w16(pe + 2, 4); w32(pe + 4, 1); w32(pe + 8, exifOff);
    w32(pe + 12, 0);
    w16(exifOff, 1);
    w16(exifOff + 2, 0x9286); w16(exifOff + 4, 7); w32(exifOff + 6, userComment.length); w32(exifOff + 10, exifOff + exifSize);
    w32(exifOff + 14, 0);
    b.set(userComment, exifOff + exifSize);
    return b;
  }

  // Rebuilds a WebP container: VP8X (flags + size), the image chunks, then
  // EXIF when given. Colour-profile/XMP/old EXIF chunks are dropped.
  function assembleWebp(input, { exif = null } = {}) {
    const chunks = webpChunks(input);
    const info = webpHeader(input);
    const image = chunks.filter((c) => ["ALPH", "VP8 ", "VP8L"].includes(c.type));
    if (!image.length) throw new Error("WebP 그림 데이터를 찾지 못했어요.");
    const hasAlpha = image.some((c) => c.type === "ALPH") || (info.alpha && image.some((c) => c.type === "VP8L"));
    const vp8x = new Uint8Array(10);
    vp8x[0] = (hasAlpha ? 0x10 : 0) | (exif ? 0x08 : 0);
    const w = info.width - 1;
    const h = info.height - 1;
    vp8x.set([w & 255, (w >> 8) & 255, (w >> 16) & 255, h & 255, (h >> 8) & 255, (h >> 16) & 255], 4);
    const list = [{ type: "VP8X", data: vp8x }, ...image];
    if (exif) list.push({ type: "EXIF", data: exif });
    const size = 4 + list.reduce((n, c) => n + 8 + c.data.length + (c.data.length & 1), 0);
    const out = new Uint8Array(8 + size);
    out.set([82, 73, 70, 70]);
    const w32le = (o, v) => { out[o] = v & 255; out[o + 1] = (v >>> 8) & 255; out[o + 2] = (v >>> 16) & 255; out[o + 3] = (v >>> 24) & 255; };
    w32le(4, size);
    out.set([87, 69, 66, 80], 8);
    let o = 12;
    for (const c of list) {
      for (let k = 0; k < 4; k += 1) out[o + k] = c.type.charCodeAt(k);
      w32le(o + 4, c.data.length);
      out.set(c.data, o + 8);
      o += 8 + c.data.length + (c.data.length & 1);
    }
    return out;
  }

  const canUseCanvas = () => typeof OffscreenCanvas === "function" && typeof createImageBitmap === "function";

  // Pixels of any picture the browser can decode (WebP here), as RGBA.
  async function decodeWithBrowser(input, type = "image/webp") {
    if (!canUseCanvas()) return { supported: false };
    const bitmap = await createImageBitmap(new Blob([toBytes(input)], { type }), { premultiplyAlpha: "none", colorSpaceConversion: "none" });
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const g = canvas.getContext("2d", { willReadFrequently: true });
    g.drawImage(bitmap, 0, 0);
    const pixels = new Uint8Array(g.getImageData(0, 0, bitmap.width, bitmap.height).data.buffer);
    bitmap.close?.();
    return { width: canvas.width, height: canvas.height, channels: 4, stride: canvas.width * 4, pixels, colorType: 6, supported: true };
  }

  // RGBA (or RGB) pixels -> lossless WebP bytes (Chrome encodes quality 1 as VP8L).
  async function encodeWebp({ width, height, channels = 4, pixels }, text = null) {
    if (!canUseCanvas()) throw new Error("이 브라우저는 WebP로 저장할 수 없어요.");
    const rgba = new Uint8ClampedArray(width * height * 4);
    if (channels === 4) rgba.set(pixels);
    else for (let p = 0, q = 0; q < rgba.length; p += channels, q += 4) { rgba[q] = pixels[p]; rgba[q + 1] = pixels[p + (channels > 2 ? 1 : 0)]; rgba[q + 2] = pixels[p + (channels > 2 ? 2 : 0)]; rgba[q + 3] = channels === 2 ? pixels[p + 1] : 255; }
    const canvas = new OffscreenCanvas(width, height);
    canvas.getContext("2d").putImageData(new ImageData(rgba, width, height), 0, 0);
    const blob = await canvas.convertToBlob({ type: "image/webp", quality: 1 });
    const raw = new Uint8Array(await blob.arrayBuffer());
    if (!isWebp(raw)) throw new Error("WebP로 바꾸지 못했어요.");
    return assembleWebp(raw, { exif: text && Object.keys(text).length ? buildExif(text) : null });
  }

  // NovelAI PNG -> NovelAI-style WebP (same pixels, stealth bits and text).
  async function pngToWebp(input) {
    const bytes = toBytes(input);
    const decoded = await decodePixels(bytes);
    if (!decoded.supported) throw new Error("이 PNG 형식은 WebP로 바꿀 수 없어요.");
    return encodeWebp(decoded, await readTextChunks(bytes));
  }

  // NovelAI-style WebP -> PNG with the same text chunks.
  async function webpToPng(input) {
    const bytes = toBytes(input);
    const decoded = await decodeWithBrowser(bytes);
    if (!decoded.supported) throw new Error("이 브라우저는 WebP를 읽을 수 없어요.");
    const text = readWebpText(bytes);
    const enc = new TextEncoder();
    const chunks = Object.entries(text).map(([k, v]) => {
      const key = enc.encode(k);
      const val = enc.encode(String(v));
      const data = new Uint8Array(key.length + 5 + val.length);
      data.set(key); // iTXt: keyword\0 flag(0) method(0) lang\0 transkw\0 text
      data.set(val, key.length + 5);
      return { type: "iTXt", data };
    });
    return encodePixels({ width: decoded.width, height: decoded.height, colorType: 6, pixels: decoded.pixels }, chunks);
  }

  function imageType(input) {
    return isPng(input) ? "png" : isWebp(input) ? "webp" : null;
  }

  // ------------------------------------------------------------- normalise ---
  function parseJson(text) {
    if (text && typeof text === "object") return text;
    if (typeof text !== "string") return null;
    try {
      const value = JSON.parse(text);
      return value && typeof value === "object" ? value : null;
    } catch (error) {
      return null;
    }
  }

  // Turns NovelAI's text fields into one tidy object the UI can show.
  function normalize(text = {}, stealthText = null) {
    const stealth = parseJson(stealthText);
    const comment = parseJson(text.Comment) || parseJson(stealth?.Comment) || {};
    const v4p = comment.v4_prompt?.caption || null;
    const v4n = comment.v4_negative_prompt?.caption || null;
    const chars = Array.isArray(v4p?.char_captions) ? v4p.char_captions : [];
    const charNegs = Array.isArray(v4n?.char_captions) ? v4n.char_captions : [];
    const prompt = String(v4p?.base_caption ?? comment.prompt ?? text.Description ?? stealth?.Description ?? "").trim();
    const negative = String(v4n?.base_caption ?? comment.uc ?? "").trim();
    const characters = chars.map((c, i) => ({
      prompt: String(c?.char_caption || "").trim(),
      negative: String(charNegs[i]?.char_caption || "").trim(),
      center: Array.isArray(c?.centers) && c.centers[0] ? { x: c.centers[0].x, y: c.centers[0].y } : null,
    })).filter((c) => c.prompt || c.negative);
    const num = (v) => (v == null || v === "" || Number.isNaN(Number(v)) ? null : Number(v));
    const found = Boolean(prompt || negative || characters.length || Object.keys(comment).length);
    return {
      found,
      prompt,
      negative,
      characters,
      seed: num(comment.seed),
      steps: num(comment.steps),
      scale: num(comment.scale),
      cfgRescale: num(comment.cfg_rescale),
      sampler: comment.sampler || null,
      noiseSchedule: comment.noise_schedule || null,
      width: num(comment.width),
      height: num(comment.height),
      model: text.Source || stealth?.Source || null,
      software: text.Software || stealth?.Software || null,
      generationTime: num(text["Generation time"] ?? stealth?.["Generation time"]),
      requestType: comment.request_type || null,
      sources: { text: Object.keys(text).length > 0, stealth: Boolean(stealthText) },
      textKeys: Object.keys(text),
    };
  }

  // Everything readable from one PNG.
  async function read(input) {
    const bytes = toBytes(input);
    if (isWebp(bytes)) return readWebp(bytes);
    const text = await readTextChunks(bytes);
    let decoded = null;
    let stealth = null;
    try {
      decoded = await decodePixels(bytes);
      stealth = await readStealth(bytes, decoded);
    } catch (error) {
      void error;
    }
    const meta = normalize(text, stealth?.text || null);
    if (decoded) {
      meta.imageWidth = decoded.width;
      meta.imageHeight = decoded.height;
      meta.width = meta.width ?? decoded.width;
      meta.height = meta.height ?? decoded.height;
    }
    return meta;
  }

  // Faster read for big folders: when the text chunks already carry the
  // prompt, skip decoding the pixels (stealth presence is then unknown: null).
  async function readWebp(bytes, { fast = false } = {}) {
    const text = readWebpText(bytes);
    const info = webpHeader(bytes);
    let stealth = null;
    const skipPixels = fast && (text.Comment || text.Description);
    if (!skipPixels && info.alpha) {
      try {
        const decoded = await decodeWithBrowser(bytes);
        if (decoded.supported) stealth = await readStealth(null, decoded);
      } catch (error) {
        void error;
      }
    }
    const meta = normalize(text, stealth?.text || null);
    meta.imageWidth = info.width;
    meta.imageHeight = info.height;
    meta.width = meta.width ?? info.width;
    meta.height = meta.height ?? info.height;
    if (skipPixels || !info.alpha) meta.sources.stealth = skipPixels ? null : false;
    meta.format = "webp";
    return meta;
  }

  async function readFast(input) {
    const bytes = toBytes(input);
    if (isWebp(bytes)) return readWebp(bytes, { fast: true });
    const text = await readTextChunks(bytes);
    if (text.Comment || text.Description) {
      const meta = normalize(text, null);
      const info = header(readChunks(bytes));
      meta.imageWidth = info.width;
      meta.imageHeight = info.height;
      meta.width = meta.width ?? info.width;
      meta.height = meta.height ?? info.height;
      meta.sources.stealth = null;
      return meta;
    }
    return read(bytes);
  }

  // ---------------------------------------------------------------- strip ---
  // Returns { bytes, removedText:[keys], removedStealth:boolean, changedPixels }.
  // Text and unknown chunks are dropped. If the alpha channel carries data the
  // pixels are rewritten: fully opaque pictures become plain RGB (alpha can't
  // hide anything then); pictures with real transparency keep it, with every
  // alpha LSB forced to 1.
  async function strip(input, { clearAlphaAlways = true } = {}) {
    const bytes = toBytes(input);
    if (isWebp(bytes)) return stripWebp(bytes);
    const chunks = readChunks(bytes);
    const removedText = chunks.filter((c) => !KEEP_CHUNKS.has(c.type)).map((c) => c.type);
    const textKeys = Object.keys(await readTextChunks(bytes));
    const info = header(chunks);
    let decoded = null;
    try {
      decoded = await decodePixels(bytes);
    } catch (error) {
      decoded = null;
    }
    const hasAlpha = info.colorType === 6 || info.colorType === 4;
    const stealth = decoded?.supported ? await readStealth(bytes, decoded) : null;
    if (hasAlpha && (stealth || clearAlphaAlways)) {
      if (!decoded?.supported) {
        // 16-bit or interlaced: we can't safely rewrite pixels here.
        return { bytes: null, error: "이 PNG 형식(16비트/인터레이스)은 아직 못 지워요.", removedText: textKeys, removedStealth: false };
      }
      const { width, height, channels, pixels } = decoded;
      let opaque = true;
      for (let i = channels - 1; i < pixels.length; i += channels) {
        if (pixels[i] < 254) {
          opaque = false;
          break;
        }
      }
      let out;
      let colorType;
      if (opaque) {
        const colorChannels = channels - 1;
        out = new Uint8Array(width * height * colorChannels);
        for (let p = 0, q = 0; p < pixels.length; p += channels, q += colorChannels) {
          for (let k = 0; k < colorChannels; k += 1) out[q + k] = pixels[p + k];
        }
        colorType = info.colorType === 6 ? 2 : 0;
      } else {
        out = new Uint8Array(pixels);
        for (let i = channels - 1; i < out.length; i += channels) out[i] |= 1;
        colorType = info.colorType;
      }
      const keep = chunks.filter((c) => ["gAMA", "cHRM", "sRGB", "iCCP", "pHYs"].includes(c.type)).map((c) => ({ type: c.type, data: c.data }));
      return {
        bytes: await encodePixels({ width, height, colorType, pixels: out }, keep),
        removedText: textKeys,
        removedChunks: removedText,
        removedStealth: Boolean(stealth),
        changedPixels: true,
        madeOpaque: opaque,
      };
    }
    const kept = chunks.filter((c) => KEEP_CHUNKS.has(c.type)).map((c) => ({ type: c.type, data: c.data }));
    return { bytes: assemble(kept), removedText: textKeys, removedChunks: removedText, removedStealth: false, changedPixels: false };
  }

  // WebP: drop EXIF/XMP and, if there is alpha, rewrite the pixels like the PNG
  // path (opaque -> alpha 255, otherwise alpha LSB forced to 1). Lossless out.
  async function stripWebp(bytes) {
    const textKeys = Object.keys(readWebpText(bytes));
    const chunks = webpChunks(bytes);
    const removedChunks = chunks.filter((c) => ["EXIF", "XMP ", "ICCP"].includes(c.type)).map((c) => c.type);
    const info = webpHeader(bytes);
    if (!info.alpha) {
      return { bytes: assembleWebp(bytes), removedText: textKeys, removedChunks, removedStealth: false, changedPixels: false, format: "webp" };
    }
    const decoded = await decodeWithBrowser(bytes);
    if (!decoded.supported) {
      return { bytes: null, error: "이 브라우저에서는 WebP를 다시 저장할 수 없어요.", removedText: textKeys, removedStealth: false };
    }
    const stealth = await readStealth(null, decoded);
    const px = decoded.pixels;
    let opaque = true;
    for (let i = 3; i < px.length; i += 4) {
      if (px[i] < 254) { opaque = false; break; }
    }
    for (let i = 3; i < px.length; i += 4) px[i] = opaque ? 255 : px[i] | 1;
    return {
      bytes: await encodeWebp(decoded, null),
      removedText: textKeys,
      removedChunks,
      removedStealth: Boolean(stealth),
      changedPixels: true,
      madeOpaque: opaque,
      format: "webp",
    };
  }

  // Test helper: hide `text` in the alpha LSBs the way NovelAI does.
  async function embedStealth(decoded, text, { compress = true } = {}) {
    const payload = new TextEncoder().encode(text);
    const data = compress ? await streamBytes(payload, new CompressionStream("gzip")) : payload;
    const magic = compress ? "stealth_pngcomp" : "stealth_pnginfo";
    const bits = [];
    const pushByte = (v) => { for (let b = 7; b >= 0; b -= 1) bits.push((v >> b) & 1); };
    for (const ch of magic) pushByte(ch.charCodeAt(0));
    const len = data.length * 8;
    [24, 16, 8, 0].forEach((s) => pushByte((len >>> s) & 255));
    data.forEach(pushByte);
    const { width, height, channels, pixels } = decoded;
    if (bits.length > width * height) throw new Error("too small");
    const stride = width * channels;
    let i = 0;
    for (let x = 0; x < width && i < bits.length; x += 1) {
      for (let y = 0; y < height && i < bits.length; y += 1) {
        const idx = y * stride + x * channels + channels - 1;
        pixels[idx] = (pixels[idx] & 254) | bits[i];
        i += 1;
      }
    }
    return decoded;
  }

  const api = {
    isPng, readChunks, readTextChunks, decodePixels, encodePixels, readStealth, normalize, read, readFast, strip,
    embedStealth, assemble, crc32,
    isWebp, imageType, webpChunks, webpHeader, readWebpText, readExifTags, buildExif, assembleWebp, decodeWithBrowser, encodeWebp, pngToWebp, webpToPng,
  };
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }
  root.NAIMeta = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
