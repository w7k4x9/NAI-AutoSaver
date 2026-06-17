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
      .split("|")
      .map((part) => part.trim())
      .filter((part) => part.length > 0);
    if (!chars.length) {
      return base;
    }
    // When base is empty the result starts with "| ..." (empty base segment).
    return [base, ...chars].join(" | ").trimStart();
  }

  function createItem(options = {}) {
    return {
      id: generateId(options.id),
      title: normalizeTitle(options.title),
      basePrompt: normalizePrompt(options.basePrompt),
      characterPrompt: normalizePrompt(options.characterPrompt),
      count: normalizeCount(options.count),
    };
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
    return {
      id: generateId(value.id),
      title: normalizeTitle(value.title),
      basePrompt: normalizePrompt(basePrompt),
      characterPrompt: normalizePrompt(characterPrompt),
      count: normalizeCount(value.count),
    };
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
        namePattern: typeof options.namePattern === "string" ? options.namePattern.slice(0, 80) : "",
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

  const api = {
    APP_NAME,
    QUEUE_SCHEMA_VERSION,
    buildCombinedPrompt,
    applyNamePattern,
    effectiveBase,
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
