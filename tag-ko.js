// 태그 한국어 뜻: hover a tag (NovelAI's prompt box, the panel's text boxes, the
// 보관함 prompt view) and its Korean meaning shows above it.
//
// 1. A bundled dictionary (data/tags-ko.json, ~1,700 common Danbooru/NovelAI
//    tags translated by hand).
// 2. Anything else: Chrome's built-in on-device translator (free, offline after a
//    one-time model download), cached. Can be turned off in 설정.
(function initTagKo(root) {
  "use strict";
  if (root.TagKo) return;

  const CACHE_KEY = "naiAutoSaver.tagKoCache";
  const CACHE_MAX = 4000;
  let dict = null;
  let dictPromise = null;
  let cache = {};
  let cacheLoaded = false;
  let cacheTimer = null;
  const options = { enabled: true, machine: true };

  function dictUrl() {
    try {
      return chrome.runtime.getURL("data/tags-ko.json");
    } catch (error) {
      return "data/tags-ko.json";
    }
  }
  function loadDict() {
    if (!dictPromise) {
      dictPromise = fetch(dictUrl()).then((r) => r.json()).then((d) => { dict = d; return d; }).catch(() => { dict = {}; return dict; });
    }
    return dictPromise;
  }
  async function loadCache() {
    if (cacheLoaded) return;
    cacheLoaded = true;
    try {
      const got = await chrome.storage.local.get(CACHE_KEY);
      cache = got[CACHE_KEY] && typeof got[CACHE_KEY] === "object" ? got[CACHE_KEY] : {};
    } catch (error) {
      cache = {};
    }
  }
  function saveCacheSoon() {
    clearTimeout(cacheTimer);
    cacheTimer = setTimeout(() => {
      const keys = Object.keys(cache);
      if (keys.length > CACHE_MAX) {
        for (const k of keys.slice(0, keys.length - CACHE_MAX)) delete cache[k];
      }
      try {
        chrome.storage.local.set({ [CACHE_KEY]: cache });
      } catch (error) {
        void error;
      }
    }, 1500);
  }

  // "1.2::{black hair}::" -> "black hair"; "artist:foo" -> artist.
  function normalize(raw) {
    let t = String(raw || "").trim();
    if (!t) return null;
    t = t.replace(/^-?\d+(?:\.\d+)?::/, "").replace(/::\s*$/, "");
    t = t.replace(/^[{[]+|[}\]]+$/g, "").replace(/[{}[\]]/g, "");
    t = t.replace(/\\([()])/g, "$1").trim();
    if (!t) return null;
    const artist = /^artist\s*:\s*(.+)$/i.exec(t);
    if (artist) return { kind: "artist", key: artist[1].trim(), text: t };
    const key = t.toLowerCase().replace(/_/g, " ").replace(/\s+/g, " ").trim();
    if (!key || key.length > 80) return null;
    return { kind: "tag", key, text: t };
  }

  function lookupDict(key) {
    if (!dict) return null;
    if (dict[key]) return dict[key];
    // Simple fallbacks: plural / "-ing" forms seen in prompts.
    if (key.endsWith("s") && dict[key.slice(0, -1)]) return dict[key.slice(0, -1)];
    return null;
  }

  // --- Chrome's built-in translator -----------------------------------------
  let translator = null;
  let translatorState = "unknown"; // unknown | unsupported | needs-click | ready | failed
  let translatorPending = null;
  async function ensureTranslator(fromGesture = false) {
    if (translator) return translator;
    if (!options.machine) return null;
    const T = root.Translator;
    if (!T || typeof T.create !== "function") {
      translatorState = "unsupported";
      return null;
    }
    if (translatorPending) return translatorPending;
    translatorPending = (async () => {
      try {
        const availability = await Promise.race([
          T.availability({ sourceLanguage: "en", targetLanguage: "ko" }),
          new Promise((resolve) => setTimeout(() => resolve("timeout"), 3000)),
        ]);
        if (availability === "timeout") {
          translatorState = "failed";
          return null;
        }
        if (availability === "unavailable") {
          translatorState = "unsupported";
          return null;
        }
        if (availability !== "available" && !fromGesture && !(navigator.userActivation && navigator.userActivation.isActive)) {
          translatorState = "needs-click";
          return null;
        }
        translator = await T.create({ sourceLanguage: "en", targetLanguage: "ko" });
        translatorState = "ready";
        return translator;
      } catch (error) {
        translatorState = error && error.name === "NotAllowedError" ? "needs-click" : "failed";
        return null;
      } finally {
        translatorPending = null;
      }
    })();
    return translatorPending;
  }
  // Creating a translator may need a click (user activation) the first time.
  if (typeof document !== "undefined") {
    document.addEventListener("pointerdown", () => {
      if (translatorState === "needs-click") void ensureTranslator(true);
    }, true);
  }

  async function translate(key) {
    await loadCache();
    if (cache[key]) return cache[key];
    const t = await ensureTranslator(false);
    if (!t) return null;
    try {
      const out = String(await t.translate(key)).trim();
      if (out && out.toLowerCase() !== key) {
        cache[key] = out;
        saveCacheSoon();
        return out;
      }
    } catch (error) {
      void error;
    }
    return null;
  }

  // Returns { tag, ko, source: "dict"|"machine"|"artist"|null }
  async function meaning(raw) {
    const n = normalize(raw);
    if (!n) return null;
    if (n.kind === "artist") return { tag: n.text, ko: `작가 ${n.key}의 그림체`, source: "artist" };
    await loadDict();
    const hit = lookupDict(n.key);
    if (hit) return { tag: n.key, ko: hit, source: "dict" };
    if (/^\d+(girls?|boys?|others?)$/.test(n.key.replace(/\s/g, "")) || /^[\d.\s]+$/.test(n.key)) return null;
    if (!options.machine) return { tag: n.key, ko: null, source: null };
    const ko = await translate(n.key);
    return { tag: n.key, ko, source: ko ? "machine" : null };
  }

  // ------------------------------------------------------------- hover UI ---
  // Finds the comma-separated tag under the pointer in a block of text.
  function tagAt(text, offset) {
    if (offset < 0 || offset > text.length) return null;
    const isSep = (c) => c === "," || c === "\n" || c === "|";
    if (offset < text.length && isSep(text[offset])) return null;
    let start = offset;
    while (start > 0 && !isSep(text[start - 1])) start -= 1;
    let end = offset;
    while (end < text.length && !isSep(text[end])) end += 1;
    const raw = text.slice(start, end);
    const lead = raw.length - raw.trimStart().length;
    const trimmed = raw.trim();
    if (!trimmed || trimmed.length > 90 || trimmed.includes(";;")) return null;
    return { raw: trimmed, start: start + lead, end: start + lead + trimmed.length };
  }

  let tip = null;
  let tipHost = null;
  function ensureTip() {
    if (tip) return tip;
    tipHost = document.createElement("div");
    tipHost.id = "nai-autosaver-tag-tip";
    tipHost.style.cssText = "position:fixed;left:0;top:0;width:0;height:0;z-index:2147483646;pointer-events:none;";
    const shadow = tipHost.attachShadow({ mode: "open" });
    shadow.innerHTML = `<style>
      .tip { position: fixed; max-width: 320px; padding: 6px 10px 7px; border-radius: 8px; background: rgba(28,28,30,0.96); color: #F2F2F2;
        font: 13px/1.35 "NAS Pretendard", -apple-system, "Apple SD Gothic Neo", "Malgun Gothic", sans-serif; letter-spacing: -0.005em;
        box-shadow: 0 0 0 0.5px rgba(255,255,255,0.16), 0 10px 26px rgba(0,0,0,0.45); opacity: 0; transform: translateY(3px); transition: opacity .12s, transform .12s; }
      .tip[data-show="true"] { opacity: 1; transform: none; }
      .ko { font-weight: 650; }
      .en { display: block; font-size: 11.5px; color: #A1A1A6; margin-top: 1px; }
      .src { font-size: 11px; color: #8E8E93; margin-left: 6px; font-weight: 400; }
    </style><div class="tip" role="tooltip"><span class="ko"></span><span class="src"></span><span class="en"></span></div>`;
    (document.body || document.documentElement).append(tipHost);
    tip = shadow.querySelector(".tip");
    return tip;
  }
  function hideTip() {
    if (tip) tip.dataset.show = "false";
  }
  function showTip(rect, info) {
    const el = ensureTip();
    el.querySelector(".ko").textContent = info.ko || "뜻을 못 찾았어요";
    el.querySelector(".src").textContent = info.source === "machine" ? "자동 번역" : "";
    el.querySelector(".en").textContent = info.tag;
    el.dataset.show = "true";
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    let left = Math.min(window.innerWidth - w - 8, Math.max(8, rect.left + rect.width / 2 - w / 2));
    let top = rect.top - h - 8;
    if (top < 6) top = rect.bottom + 8;
    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
  }

  // caretRangeFromPoint gives the gap between two characters; the pointer is on
  // the character to the left or right of it. Returns that character's index.
  function charUnderPoint(node, gap, x, y) {
    const probe = document.createRange();
    for (const i of [gap, gap - 1]) {
      if (i < 0 || i >= node.length) continue;
      probe.setStart(node, i);
      probe.setEnd(node, i + 1);
      const r = probe.getBoundingClientRect();
      if (r.width && x >= r.left - 1 && x <= r.right + 1 && y >= r.top - 1 && y <= r.bottom + 1) return i;
    }
    return -1;
  }

  // Character index under (x, y) inside a <textarea>, via an invisible copy.
  let mirror = null;
  const MIRROR_PROPS = ["boxSizing", "width", "height", "fontFamily", "fontSize", "fontWeight", "fontStyle", "letterSpacing", "lineHeight", "paddingTop", "paddingRight", "paddingBottom", "paddingLeft", "borderTopWidth", "borderRightWidth", "borderBottomWidth", "borderLeftWidth", "textTransform", "wordSpacing", "tabSize", "textIndent"];
  function textareaPoint(area, x, y) {
    const r = area.getBoundingClientRect();
    if (!mirror) {
      mirror = document.createElement("div");
      mirror.setAttribute("aria-hidden", "true");
      (document.body || document.documentElement).append(mirror);
    }
    const cs = getComputedStyle(area);
    const s = mirror.style;
    for (const p of MIRROR_PROPS) s[p] = cs[p];
    s.position = "fixed";
    s.left = `${r.left}px`;
    s.top = `${r.top}px`;
    s.whiteSpace = "pre-wrap";
    s.overflowWrap = "break-word";
    s.wordBreak = cs.wordBreak;
    s.overflow = "hidden";
    s.borderStyle = "solid";
    s.borderColor = "transparent";
    s.color = "transparent";
    s.background = "transparent";
    s.zIndex = "2147483647";
    s.pointerEvents = "auto";
    s.visibility = "visible";
    s.opacity = "0";
    mirror.textContent = `${area.value}​`;
    mirror.scrollTop = area.scrollTop;
    let result = null;
    try {
      const range = document.caretRangeFromPoint(x, y);
      if (range && mirror.contains(range.startContainer)) {
        const node = mirror.firstChild;
        const at = charUnderPoint(node, range.startOffset, x, y);
        const tag = at >= 0 && at < area.value.length ? tagAt(area.value, at) : null;
        if (tag) {
          const tr = document.createRange();
          tr.setStart(node, tag.start);
          tr.setEnd(node, tag.end);
          const rects = Array.from(tr.getClientRects());
          const hitRect = rects.find((q) => y >= q.top - 2 && y <= q.bottom + 2) || rects[0];
          result = { raw: tag.raw, rect: hitRect ? { left: hitRect.left, right: hitRect.right, top: hitRect.top, bottom: hitRect.bottom, width: hitRect.width } : r };
        }
      }
    } catch (error) {
      result = null;
    }
    s.pointerEvents = "none";
    s.visibility = "hidden";
    return result;
  }

  // Tag under (x, y) in normal page text (ProseMirror editors, <p> blocks).
  function textPoint(x, y, scopeTest) {
    const range = document.caretRangeFromPoint ? document.caretRangeFromPoint(x, y) : null;
    if (!range || range.startContainer.nodeType !== Node.TEXT_NODE) return null;
    const node = range.startContainer;
    const block = node.parentElement && node.parentElement.closest("p, div, li, [data-tag-hover]");
    if (!block || !scopeTest(block)) return null;
    const off = charUnderPoint(node, range.startOffset, x, y);
    if (off < 0) return null;
    const cr = (() => {
      const r = document.createRange();
      r.setStart(node, off);
      r.setEnd(node, off + 1);
      return r.getBoundingClientRect();
    })();
    // Offset inside the whole block's text.
    const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
    let text = "";
    let at = -1;
    const nodes = [];
    while (walker.nextNode()) {
      const n = walker.currentNode;
      if (n === node) at = text.length + off;
      nodes.push({ n, start: text.length });
      text += n.data;
    }
    if (at < 0) return null;
    const tag = tagAt(text, at);
    if (!tag) return null;
    const startNode = nodes.filter((e) => e.start <= tag.start).pop();
    const endNode = nodes.filter((e) => e.start <= tag.end - 1).pop();
    let rect = cr;
    try {
      const tr = document.createRange();
      tr.setStart(startNode.n, tag.start - startNode.start);
      tr.setEnd(endNode.n, tag.end - endNode.start);
      const rects = Array.from(tr.getClientRects());
      rect = rects.find((q) => y >= q.top - 2 && y <= q.bottom + 2) || rects[0] || cr;
    } catch (error) {
      void error;
    }
    return { raw: tag.raw, rect };
  }

  // attachHover({ roots: [document, shadowRoot…], scope: (element) => boolean })
  function attachHover({ roots = [document], scope = () => true, textareas = () => true } = {}) {
    let timer = null;
    let last = "";
    let lastKey = "";
    let token = 0;
    const onMove = (event) => {
      if (!options.enabled) return;
      const target = event.composedPath ? event.composedPath()[0] : event.target;
      const x = event.clientX;
      const y = event.clientY;
      clearTimeout(timer);
      timer = setTimeout(async () => {
        let hit = null;
        if (target && target.tagName === "TEXTAREA" && textareas(target)) {
          hit = textareaPoint(target, x, y);
        } else if (target && (target.isContentEditable || target.closest?.("[contenteditable], [data-tag-hover]"))) {
          hit = textPoint(x, y, (block) => scope(block));
        }
        if (!hit) {
          last = "";
          hideTip();
          return;
        }
        const key = `${hit.raw}|${Math.round(hit.rect.left)}|${Math.round(hit.rect.top)}`;
        if (key === lastKey && tip && tip.dataset.show === "true") return;
        if (hit.raw !== last) hideTip();
        lastKey = key;
        last = hit.raw;
        const mine = ++token;
        const info = await meaning(hit.raw);
        if (mine !== token || last !== hit.raw) return;
        if (!info || !info.ko) {
          hideTip();
          return;
        }
        showTip(hit.rect, info);
      }, 260);
    };
    const onLeave = () => {
      clearTimeout(timer);
      last = "";
      lastKey = "";
      hideTip();
    };
    for (const r of roots) {
      r.addEventListener("mousemove", onMove, { passive: true, capture: true });
      r.addEventListener("keydown", onLeave, true);
      r.addEventListener("scroll", onLeave, true);
      r.addEventListener("mousedown", onLeave, true);
    }
    window.addEventListener("blur", onLeave);
    void loadDict();
    return { hide: onLeave };
  }

  function setOptions(next = {}) {
    if ("enabled" in next) options.enabled = Boolean(next.enabled);
    if ("machine" in next) options.machine = Boolean(next.machine);
    if (!options.enabled) hideTip();
  }

  const api = { loadDict, normalize, meaning, tagAt, attachHover, setOptions, options, translatorStatus: () => translatorState, ensureTranslator };
  root.TagKo = api;
  if (typeof module === "object" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
