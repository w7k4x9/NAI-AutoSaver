(function attachQueueStore(global) {
  "use strict";

  const APP_NAME = "NAI-Auto-Saver";
  const QUEUE_SCHEMA_VERSION = 3;
  const DEFAULT_COUNT = 1;
  const MAX_COUNT = 9999;

  function cloneJson(value) {
    return value == null ? value : JSON.parse(JSON.stringify(value));
  }

  function normalizeCount(value) {
    const numeric = Number.parseInt(value, 10);
    if (!Number.isFinite(numeric) || numeric < 1) {
      return DEFAULT_COUNT;
    }
    return Math.min(MAX_COUNT, numeric);
  }

  function normalizeTitle(value, fallback = "무제") {
    const text = String(value == null ? "" : value).replace(/\s+/g, " ").trim().slice(0, 80);
    return text || fallback;
  }

  function normalizePrompt(value) {
    return String(value == null ? "" : value).replace(/\r\n?/g, "\n");
  }

  function generateId(seed) {
    if (seed) {
      return String(seed);
    }
    return `q_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  }

  // base prompt + character prompt(s) -> single NovelAI prompt string.
  // NovelAI V4 splits the base prompt and character prompts with the "|" character,
  // so "base | character" reliably routes each segment to the right box without
  // needing to target the dynamically-added character DOM nodes.
  function buildCombinedPrompt(basePrompt, characterPrompt) {
    const base = normalizePrompt(basePrompt).trim();
    const chars = normalizePrompt(characterPrompt)
      .split(/\s*(?:;;|；；)\s*/u)
      .map((part) => part.trim())
      .filter((part) => part.length > 0);
    if (!chars.length) {
      return base;
    }
    // When base is empty the result starts with "| ..." (empty base segment).
    return [base, ...chars].join(" | ").trimStart();
  }

  // Optional explicit character folder for an item (set by the combination
  // generator, so the folder stays right even when the name doesn't start with
  // the character). Only present when non-empty, to keep old data unchanged.
  function withFolderName(item, folderName) {
    const clean = sanitizeFolderSegment(folderName);
    if (clean) {
      item.folderName = clean;
    }
    return item;
  }

  // Which combination an item came from ({ char, bg, emo }), so the queue can
  // be regrouped by character or background later. Optional.
  function normalizeAxes(value) {
    if (!value || typeof value !== "object") return null;
    const pick = (v) => String(v == null ? "" : v).trim().slice(0, 80);
    const axes = { char: pick(value.char), bg: pick(value.bg), emo: pick(value.emo) };
    return axes.char || axes.bg || axes.emo ? axes : null;
  }
  function withAxes(item, value) {
    const axes = normalizeAxes(value);
    if (axes) item.axes = axes;
    return item;
  }

  function createItem(options = {}) {
    return withAxes(withFolderName({
      id: generateId(options.id),
      title: normalizeTitle(options.title),
      basePrompt: normalizePrompt(options.basePrompt),
      baseNegativePrompt: normalizePrompt(options.baseNegativePrompt),
      characterPrompt: normalizePrompt(options.characterPrompt),
      negativePrompt: normalizePrompt(options.negativePrompt),
      count: normalizeCount(options.count),
    }, options.folderName), options.axes);
  }

  // Expand a naming pattern. Tokens: {n} 1-based index, {nn} zero-padded to 2,
  // {nnn} padded to 3. Anything else is literal. index is 0-based.
  function applyNamePattern(pattern, index) {
    const n = index + 1;
    if (!pattern || !pattern.trim()) {
      return "";
    }
    return pattern
      .replace(/\{nnn\}/g, String(n).padStart(3, "0"))
      .replace(/\{nn\}/g, String(n).padStart(2, "0"))
      .replace(/\{n\}/g, String(n))
      .slice(0, 80);
  }

  // The base prompt actually sent for an item, honoring the global-base option.
  function effectiveBase(item, options = {}) {
    if (options.useGlobalBase && String(options.globalBase || "").trim()) {
      return normalizePrompt(options.globalBase);
    }
    return normalizePrompt(item.basePrompt);
  }

  // The base Undesired Content actually sent for an item. Shares the
  // `useGlobalBase` switch with the positive base: when the switch is on and a
  // shared negative is filled in, every item uses it. An empty shared negative
  // falls back to the item's own value, exactly like the positive base does, so
  // turning the switch on never silently wipes per-item negatives.
  function effectiveBaseNegative(item, options = {}) {
    if (options.useGlobalBase && String(options.globalBaseNegative || "").trim()) {
      return normalizePrompt(options.globalBaseNegative);
    }
    return normalizePrompt(item.baseNegativePrompt);
  }

  function normalizeItem(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return null;
    }
    // Migration: schema v2 stored a single `prompt` field. Fold it into basePrompt.
    let basePrompt = value.basePrompt;
    if (basePrompt == null && value.prompt != null) {
      basePrompt = value.prompt;
    }
    const characterPrompt = value.characterPrompt;

    const hasTitle = String(value.title == null ? "" : value.title).trim().length > 0;
    const hasBase = String(basePrompt == null ? "" : basePrompt).trim().length > 0;
    const hasChar = String(characterPrompt == null ? "" : characterPrompt).trim().length > 0;
    if (!hasTitle && !hasBase && !hasChar) {
      return null;
    }
    return withAxes(withFolderName({
      id: generateId(value.id),
      title: normalizeTitle(value.title),
      basePrompt: normalizePrompt(basePrompt),
      baseNegativePrompt: normalizePrompt(value.baseNegativePrompt),
      characterPrompt: normalizePrompt(characterPrompt),
      negativePrompt: normalizePrompt(value.negativePrompt),
      count: normalizeCount(value.count),
    }, value.folderName), value.axes);
  }

  function normalizeState(value) {
    const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
    const rawItems = Array.isArray(source.items) ? source.items : (Array.isArray(value) ? value : []);
    const items = [];
    for (const rawItem of rawItems) {
      const item = normalizeItem(rawItem);
      if (item) {
        items.push(item);
      }
    }
    const options = source.options && typeof source.options === "object" && !Array.isArray(source.options)
      ? source.options
      : {};
    return {
      schemaVersion: QUEUE_SCHEMA_VERSION,
      items,
      options: {
        loop: Boolean(options.loop),
        useGlobalBase: Boolean(options.useGlobalBase),
        globalBase: normalizePrompt(options.globalBase),
        globalBaseNegative: normalizePrompt(options.globalBaseNegative),
        namePattern: typeof options.namePattern === "string" ? options.namePattern.slice(0, 80) : "",
        groupFirst: options.groupFirst === "bg" ? "bg" : "char",
      },
    };
  }

  function createExportEnvelope(state, options = {}) {
    return {
      app: APP_NAME,
      queueSchemaVersion: QUEUE_SCHEMA_VERSION,
      exportedAt: options.exportedAt || new Date().toISOString(),
      queue: normalizeState(state),
    };
  }

  function parseExportEnvelope(input) {
    let parsed = input;
    if (typeof input === "string") {
      try {
        parsed = JSON.parse(input);
      } catch (error) {
        return { ok: false, error: "JSON 파일을 읽지 못했습니다." };
      }
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { ok: false, error: "대기열 파일 형식이 올바르지 않습니다." };
    }
    if (parsed.app !== APP_NAME) {
      return { ok: false, error: "NAI 자동저장기 대기열 파일이 아닙니다." };
    }
    if (!parsed.queue) {
      return { ok: false, error: "대기열 파일에 queue 데이터가 없습니다." };
    }
    return { ok: true, queue: normalizeState(parsed.queue) };
  }

  function sanitizeFileName(value, fallback = "image") {
    const safe = String(value == null ? "" : value)
      .replace(/[\\/:*?"<>|]/g, "_")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 120);
    return safe || fallback;
  }

  // ---------------------------------------------------------------------------
  // Save-folder classification: <folder>/<YYYY-MM-DD>/<character>/
  // ---------------------------------------------------------------------------
  const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i;

  // One folder segment that is safe on Windows/macOS. Empty when nothing usable.
  function sanitizeFolderSegment(value) {
    let seg = String(value == null ? "" : value)
      .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 60)
      .replace(/[. ]+$/g, "")
      .trim();
    if (!seg || seg === "." || seg === "..") {
      return "";
    }
    if (WINDOWS_RESERVED.test(seg)) {
      seg = `_${seg}`;
    }
    return seg;
  }

  // "김춘자_교실_웃음" -> "김춘자". No "_" (or nothing before it) -> "".
  function extractCharacterName(saveName) {
    const text = String(saveName == null ? "" : saveName).trim();
    const index = text.indexOf("_");
    if (index <= 0) {
      return "";
    }
    return sanitizeFolderSegment(text.slice(0, index));
  }

  function formatDateFolder(date = new Date()) {
    const d = date instanceof Date ? date : new Date(date);
    return [
      d.getFullYear(),
      String(d.getMonth() + 1).padStart(2, "0"),
      String(d.getDate()).padStart(2, "0"),
    ].join("-");
  }

  function buildSaveFolder(options = {}) {
    const base = String(options.folder == null ? "" : options.folder).trim() || "NovelAI";
    const parts = [base];
    if (options.byDate) {
      parts.push(formatDateFolder(options.date || new Date()));
    }
    if (options.byCharacter) {
      const character = sanitizeFolderSegment(options.characterName) || extractCharacterName(options.saveName);
      if (character) {
        parts.push(character);
      }
    }
    return parts.join("/");
  }

  // ---------------------------------------------------------------------------
  // Combination generator: names, order, plan
  // ---------------------------------------------------------------------------
  const COMBO_AXES = ["char", "bg", "emo"];
  const COMBO_SEPARATORS = ["_", "-", " "];

  function normalizeAxisOrder(value) {
    const list = Array.isArray(value) ? value.filter((axis) => COMBO_AXES.includes(axis)) : [];
    const unique = [...new Set(list)];
    for (const axis of COMBO_AXES) {
      if (!unique.includes(axis)) {
        unique.push(axis);
      }
    }
    return unique;
  }

  // Defaults reproduce the old fixed behaviour: name "캐릭터_배경_감정",
  // generated character → background → emotion.
  function normalizeComboNaming(value) {
    const source = value && typeof value === "object" ? value : {};
    const on = source.nameOn && typeof source.nameOn === "object" ? source.nameOn : {};
    const nameOn = {};
    for (const axis of COMBO_AXES) {
      nameOn[axis] = on[axis] !== false;
    }
    if (!COMBO_AXES.some((axis) => nameOn[axis])) {
      nameOn.char = true;
    }
    const naming = {
      nameOrder: normalizeAxisOrder(source.nameOrder),
      nameOn,
      nameSep: COMBO_SEPARATORS.includes(source.nameSep) ? source.nameSep : "_",
      loopOrder: normalizeAxisOrder(source.loopOrder),
    };
    // A free-form name like "{캐릭터}_{배경} {표정}" overrides order/separator.
    const template = typeof source.template === "string" ? source.template.trim().slice(0, 120) : "";
    if (template) naming.template = template;
    return naming;
  }

  const TEMPLATE_TOKENS = { 캐릭터: "char", char: "char", 배경: "bg", bg: "bg", 표정: "emo", 감정: "emo", emo: "emo" };
  // "{캐릭터}_{배경} {표정}" + { char, bg, emo } -> "김춘자_교실 웃음"
  function renderNameTemplate(template, values) {
    const out = String(template || "").replace(/\{\s*([^{}\s]+)\s*\}/g, (whole, key) => {
      const axis = TEMPLATE_TOKENS[key] || TEMPLATE_TOKENS[String(key).toLowerCase()];
      return axis ? String(values[axis] || "") : whole;
    });
    return out.replace(/[\\/:*?"<>|]/g, "_").replace(/\s+/g, " ").trim().slice(0, 120);
  }

  // "웃음 = smiling, open mouth" -> { name: "웃음", tags: "smiling, open mouth" }.
  // Lines without "=" keep working: { name: "", tags: line }.
  function parseComboLine(line) {
    const text = String(line == null ? "" : line).trim();
    const match = text.match(/^([^=,{}\[\]]{1,30}?)\s*=\s*(.*)$/s);
    if (!match || /=/.test(match[2].slice(0, 1))) {
      return { name: "", tags: text };
    }
    return { name: match[1].trim(), tags: match[2].trim() };
  }

  // chars: [{ name, emotionNames: [..], emotionCount }], bgs: [{ name }]
  // Returns entries in generation order with their file name.
  function buildComboPlan(chars, bgs, namingInput) {
    const naming = normalizeComboNaming(namingInput);
    const entries = [];
    (chars || []).forEach((ch, ci) => {
      const charName = String(ch && ch.name != null ? ch.name : "").trim();
      if (!charName) {
        return;
      }
      const count = Math.max(0, Number(ch.emotionCount) || 0);
      // A character can carry its own background list (when 배경 is not shared).
      (Array.isArray(ch.bgs) ? ch.bgs : bgs || []).forEach((bg, bi) => {
        const bgName = String(bg && bg.name != null ? bg.name : "").trim();
        if (!bgName) {
          return;
        }
        for (let ei = 0; ei < count; ei += 1) {
          const emoName = String((ch.emotionNames && ch.emotionNames[ei]) || "").trim() || String(ei + 1);
          const values = { char: charName, bg: bgName, emo: emoName };
          const title = (naming.template && renderNameTemplate(naming.template, values)) || naming.nameOrder
            .filter((axis) => naming.nameOn[axis])
            .map((axis) => values[axis])
            .join(naming.nameSep);
          entries.push({ ci, bi, ei, charName, bgName, emoName, emoNumber: ei + 1, title, folderName: charName });
        }
      });
    });
    const index = { char: "ci", bg: "bi", emo: "ei" };
    const keys = naming.loopOrder.map((axis) => index[axis]);
    entries.sort((a, b) => {
      for (const key of keys) {
        if (a[key] !== b[key]) {
          return a[key] - b[key];
        }
      }
      return 0;
    });
    return entries;
  }

  function findDuplicateTitles(entries) {
    const seen = new Map();
    for (const entry of entries) {
      seen.set(entry.title, (seen.get(entry.title) || 0) + 1);
    }
    return [...seen.entries()].filter(([, n]) => n > 1).map(([title, n]) => ({ title, count: n }));
  }

  const api = {
    renderNameTemplate,
    APP_NAME,
    COMBO_AXES,
    buildComboPlan,
    findDuplicateTitles,
    normalizeComboNaming,
    parseComboLine,
    buildSaveFolder,
    extractCharacterName,
    formatDateFolder,
    sanitizeFolderSegment,
    QUEUE_SCHEMA_VERSION,
    buildCombinedPrompt,
    applyNamePattern,
    effectiveBase,
    effectiveBaseNegative,
    cloneJson,
    createExportEnvelope,
    createItem,
    normalizeCount,
    normalizeItem,
    normalizePrompt,
    normalizeState,
    normalizeTitle,
    parseExportEnvelope,
    sanitizeFileName,
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
  global.NAIQueueStore = api;
})(typeof globalThis !== "undefined" ? globalThis : window);
