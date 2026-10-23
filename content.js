(function bootstrapNaiAutoSaver(global) {
  "use strict";

  if (window.__naiAutoSaverLoaded) {
    return;
  }
  window.__naiAutoSaverLoaded = true;

  const Store = global.NAIQueueStore;
  if (!Store) {
    return;
  }
  const SafeStoreLib = global.NAISafeStore;
  if (!SafeStoreLib) {
    return;
  }
  // Keys that are NOT copied into the page-side mirror (large / disposable).
  const MIRROR_EXCLUDED_KEYS = new Set(["diagLog"]);
  let storageHealth = { ok: true, reason: "", contextAlive: true };
  const safeStore = SafeStoreLib.createSafeStore({
    getChrome: () => (typeof chrome !== "undefined" ? chrome : undefined),
    pageStorage: (() => {
      try {
        return window.localStorage;
      } catch (error) {
        return null;
      }
    })(),
    shouldMirror: (area, key) => !MIRROR_EXCLUDED_KEYS.has(key)
      && (area === "sync" || String(key).startsWith("naiAutoSaver.")),
    mergers: { "naiAutoSaver.promptMemos": SafeStoreLib.mergeMemoStates },
    onHealth: (next) => {
      storageHealth = next;
      renderStorageAlert();
    },
  });

  const QUEUE_STORAGE_KEY = "naiAutoSaver.queue";
  const UI_STORAGE_KEY = "naiAutoSaver.ui";
  const GENERATOR_STORAGE_KEY = "naiAutoSaver.generator";
  const MEMO_STORAGE_KEY = "naiAutoSaver.promptMemos";
  // Deleted memos and pre-edit versions are kept here for MEMO_TRASH_DAYS.
  const MEMO_TRASH_KEY = "naiAutoSaver.memoTrash";
  const MEMO_TRASH_DAYS = 30;
  const MEMO_TRASH_MAX = 300;
  // The memo editor's unsaved text lives in the page's localStorage so a page
  // reload, a crash, or a dead extension context never eats what was typed.
  const MEMO_DRAFT_LS_KEY = "naiAutoSaver.memoDraft.v1";
  const AUTO_REFRESH_MS = 500;
  // NovelAI generations are at least 512px on the short side. Low-res preview
  // placeholders that flash in during the image swap are much smaller in their
  // *natural* size, so a floor here rejects them and prevents blank saves.
  const MIN_IMAGE_DIM = 256;
  const HOST_ID = "nai-auto-saver-host";

  // NovelAI V4 splits each prompt area into "Prompt" and "Undesired Content"
  // tabs. The UC editor lives under this wrapper. Positive prompts must never be
  // written into it, and the negative prompt must only be written into it.
  const UC_SELECTOR = ".prompt-input-box-undesired-content";
  function isInUndesired(element) {
    return Boolean(element && element.closest && element.closest(UC_SELECTOR));
  }

  // NovelAI versions the character-prompt wrapper class with a 1-based suffix
  // (e.g. ".prompt-input-box-character-prompts-1", ".prompt-input-box-character-prompts-2").
  // Older builds used the unsuffixed singular ".prompt-input-box-character-prompt".
  // Match BOTH with a substring selector so a NovelAI rename can't silently break
  // character detection (which previously caused character-negative to be dropped
  // and the base prompt to swallow the character-negative box).
  const CHAR_WRAPPER_SELECTOR = '[class*="prompt-input-box-character-prompt"]';
  // Base prompt wrapper. Accept the known stable names plus any versioned
  // "...base-prompt" variant defensively, mirroring the character fix above.
  const BASE_WRAPPER_SELECTOR =
    '.prompt-input-box-base-prompt, .prompt-input-box-prompt, [class*="prompt-input-box-base-prompt"]';

  // Downloads can only go to a SUBFOLDER under the browser's Downloads dir, never
  // an absolute path. If the user pastes "C:\...\NovelAI", keep just the final
  // folder name so we don't create an ugly "C_/Users/.../NovelAI" tree.
  function normalizeFolderInput(value) {
    let v = String(value == null ? "" : value).trim().replace(/\\/g, "/");
    const looksAbsolute = /^[a-zA-Z]:/.test(v) || v.startsWith("/") || v.startsWith("//");
    if (looksAbsolute) {
      const segs = v.split("/").map((s) => s.trim()).filter(Boolean);
      v = segs.length ? segs[segs.length - 1] : "NovelAI";
    }
    return v;
  }

  // One filled icon family everywhere (icons.js, loaded before this script).
  const ICON_ALIASES = { play_arrow: "play", keyboard_arrow_up: "up", keyboard_arrow_down: "down" };
  function icon(name, size = 22) {
    const lib = globalThis.NAIIcons;
    return lib ? lib.svg(ICON_ALIASES[name] || name, size, "ias-ic") : "";
  }

  const SYNC_KEYS = [
    "intervalTime",
    "gcount",
    "singleSaveName",
    "saveFolder",
    "autoBase",
    "autoBaseNeg",
    "autoChar",
    "autoCharNeg",
    "autoSaveEnabled",
    "autoCompletionNotificationEnabled",
    "backgroundKeepAliveEnabled",
    "volume",
    "folderByDate",
    "folderByCharacter",
    "saveFormat",
    "autoBackupEnabled",
    "appearance",
    "autoPromptMode",
    "tagHover",
    "tagHoverMachine",
  ];

  let panelHost = null;
  let panelShadow = null;
  let ui = {};
  let queueState = { schemaVersion: 3, items: [], options: { loop: false } };
  let selectedQueueId = null;
  let queueSaveTimer = null;
  let memoState = { schemaVersion: 1, items: [] };
  let memoTrash = { items: [] };
  let memoLoaded = false;
  let selectedMemoId = null;
  let panelCollapsed = true;
  let activeTab = "auto";
  let editorExpanded = false;
  let panelFullscreen = false;
  let panelCompact = false;
  let panelPosition = null;
  let panelSize = null;
  let statusTimer = null;

  // key-shield.js installs itself at document_start; it is absent only if the
  // extension was reloaded without refreshing the NovelAI tab.
  const keyShield = (typeof globalThis !== "undefined" ? globalThis : window).__NAI_AUTOSAVER_KEY_SHIELD__ || null;

  // The panel lives in a shadow root, so `document.activeElement` is always the
  // host element, never the field the user is typing in. Every "don't clobber
  // the field being edited" check has to go through the shadow root instead.
  function isPanelElementFocused(element) {
    if (!element || !panelShadow) {
      return false;
    }
    return panelShadow.activeElement === element;
  }

  // ETA: rolling per-image wall-clock samples (generation + interval).
  const ETA_SEED_KEY = "naiAutoSaver.avgImageMs";
  const etaTracker = {
    samples: [],
    lastCompleteTs: 0,
    maxSamples: 8,
  };
  // Average ms/image measured in a previous run; used for the pre-run estimate.
  let seedImageMs = null;

  let saveContext = { baseName: "", folderName: "", counter: 0, lastSavedSrc: "" };
  let todaySavedCount = 0;

  const autoRun = {
    active: false,
    count: 0,
    completedCount: 0,
    target: 0,
    timerId: null,
    timeoutId: null,
    waitingForCompletion: false,
    waitingForExistingGeneration: false,
    stopAfterCurrent: false,
    ignoreReadyUntil: 0,
    token: 0,
    onComplete: null,
  };

  const queueRun = {
    active: false,
    index: 0,
    items: [],
    loop: false,
    token: 0,
    advancing: false,
    totalGenerated: 0,
    resolveItem: null,
  };

  // ---------------------------------------------------------------------------
  // utils
  // ---------------------------------------------------------------------------
  function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // ---------------------------------------------------------------------------
  // diagnostic log
  // ---------------------------------------------------------------------------
  // Every status line, every prompt-write result and every caught exception is
  // kept in a ring buffer and mirrored to chrome.storage.local, so a run that
  // failed can be exported afterwards (설정 → 문제 진단 → 오류 로그 내보내기)
  // even after the tab was reloaded.
  const DIAG_LOG_MAX = 500;
  const DIAG_LOG_KEY = "diagLog";
  const diag = { entries: [], saveTimer: null, loaded: false, lastKey: "" };

  function diagStamp(date = new Date()) {
    const pad = (n, w = 2) => String(n).padStart(w, "0");
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} `
      + `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`;
  }

  function diagSerialize(value) {
    if (value == null) {
      return "";
    }
    if (value instanceof Error || (typeof value === "object" && typeof value.message === "string" && "stack" in value)) {
      return `${value.name || "Error"}: ${value.message}${value.stack ? `\n${value.stack}` : ""}`;
    }
    if (typeof value === "string") {
      return value;
    }
    try {
      return JSON.stringify(value);
    } catch (error) {
      return String(value);
    }
  }

  function logEvent(level, message, extra) {
    const entry = {
      t: Date.now(),
      level,
      message: String(message == null ? "" : message),
      extra: extra === undefined ? "" : diagSerialize(extra),
      hidden: typeof document !== "undefined" && document.visibilityState === "hidden",
    };
    // Collapse exact repeats (the 500 ms progress poll can repeat a status).
    const key = `${entry.level}|${entry.message}|${entry.extra}`;
    if (key === diag.lastKey) {
      const last = diag.entries[diag.entries.length - 1];
      if (last) {
        last.repeat = (last.repeat || 1) + 1;
        last.t = entry.t;
      }
      scheduleDiagSave();
      return;
    }
    diag.lastKey = key;
    diag.entries.push(entry);
    if (diag.entries.length > DIAG_LOG_MAX) {
      diag.entries.splice(0, diag.entries.length - DIAG_LOG_MAX);
    }
    scheduleDiagSave();
  }

  function scheduleDiagSave() {
    if (diag.saveTimer) {
      return;
    }
    diag.saveTimer = setTimeout(() => {
      diag.saveTimer = null;
      try {
        chrome.storage.local.set({ [DIAG_LOG_KEY]: diag.entries }, () => {
          void chrome.runtime.lastError;
        });
      } catch (error) {
        void error;
      }
    }, 800);
  }

  async function loadDiagLog() {
    if (diag.loaded) {
      return;
    }
    diag.loaded = true;
    try {
      const stored = await storageGet("local", [DIAG_LOG_KEY]);
      const previous = Array.isArray(stored[DIAG_LOG_KEY]) ? stored[DIAG_LOG_KEY] : [];
      // Entries written before this page load come first.
      diag.entries = previous.concat(diag.entries).slice(-DIAG_LOG_MAX);
    } catch (error) {
      void error;
    }
    const manifest = (() => {
      try {
        return chrome.runtime.getManifest();
      } catch (error) {
        return {};
      }
    })();
    logEvent("info", `--- 페이지 로드 · NAI 자동저장 v${manifest.version || "?"} ---`, { url: location.href });
  }

  function clearDiagLog() {
    diag.entries = [];
    diag.lastKey = "";
    try {
      chrome.storage.local.remove(DIAG_LOG_KEY, () => {
        void chrome.runtime.lastError;
      });
    } catch (error) {
      void error;
    }
  }

  // Snapshot of what the extension can currently see on the NovelAI page.
  // This is what makes a log actionable: it says whether the DOM the code
  // expects (base editor, character cards, generate button) actually exists.
  function diagSnapshot() {
    const safe = (fn, fallback = null) => {
      try {
        return fn();
      } catch (error) {
        return `error: ${error?.message || error}`;
      }
    };
    const manifest = safe(() => chrome.runtime.getManifest(), {}) || {};
    const generateButton = safe(() => findGenerateButton());
    const containers = safe(() => getCharacterContainers(), []) || [];
    const base = safe(() => getBasePromptEditor());
    return {
      extensionVersion: manifest.version || "?",
      url: safe(() => location.href),
      userAgent: safe(() => navigator.userAgent),
      language: safe(() => navigator.language),
      viewport: safe(() => `${window.innerWidth}x${window.innerHeight}`),
      visibilityState: safe(() => document.visibilityState),
      documentHasFocus: safe(() => document.hasFocus()),
      keyShieldPresent: Boolean(keyShield),
      generateButton: generateButton ? {
        text: normalizeButtonText(generateButton),
        disabled: Boolean(generateButton.disabled),
      } : null,
      basePromptEditorFound: Boolean(base),
      basePromptEditorClass: base ? safe(() => base.className) : null,
      basePromptLength: base ? safe(() => readEditableText(base).length) : null,
      characterCardCount: Array.isArray(containers) ? containers.length : containers,
      characterCardClasses: Array.isArray(containers)
        ? containers.map((c) => safe(() => Array.from(c.classList).join(" ")))
        : null,
      characterEditorsVisible: Array.isArray(containers)
        ? containers.map((c) => Boolean(safe(() => getCharacterBoxEditor(c))))
        : null,
      contentEditableCount: safe(() => document.querySelectorAll("[contenteditable]").length),
      autoRun: safe(() => ({
        active: autoRun.active,
        count: autoRun.count,
        target: autoRun.target,
        waitingForCompletion: autoRun.waitingForCompletion,
        waitingForExistingGeneration: autoRun.waitingForExistingGeneration,
      })),
      queueRun: safe(() => ({
        active: queueRun.active,
        index: queueRun.index,
        items: queueRun.items.length,
        loop: queueRun.loop,
      })),
      queueItemsSaved: safe(() => queueState.items.length),
      settings: safe(() => ({
        interval: ui.intervalInput?.value,
        count: ui.countInput?.value,
        folder: ui.folderInput?.value,
        autoSave: ui.autoSaveToggle?.checked,
        backgroundKeepAlive: backgroundKeepAliveEnabled,
        keepAliveToneRunning: Boolean(keepAlive.context),
      })),
      panel: safe(() => ({ collapsed: panelCollapsed, tab: activeTab, fullscreen: panelFullscreen })),
    };
  }

  function buildDiagReport() {
    const lines = [];
    lines.push("NAI 자동저장 진단 로그");
    lines.push(`내보낸 시각: ${diagStamp()}`);
    lines.push("");
    lines.push("== 현재 상태 스냅샷 ==");
    lines.push(JSON.stringify(diagSnapshot(), null, 2));
    lines.push("");
    lines.push(`== 이벤트 로그 (최근 ${diag.entries.length}건, 오래된 순) ==`);
    for (const entry of diag.entries) {
      const level = String(entry.level || "info").toUpperCase().padEnd(5, " ");
      const bg = entry.hidden ? " [백그라운드 탭]" : "";
      const repeat = entry.repeat > 1 ? ` (x${entry.repeat})` : "";
      lines.push(`${diagStamp(new Date(entry.t))} ${level} ${entry.message}${repeat}${bg}`);
      if (entry.extra) {
        for (const extraLine of String(entry.extra).split("\n")) {
          lines.push(`    ${extraLine}`);
        }
      }
    }
    lines.push("");
    return `${lines.join("\n")}\n`;
  }

  function exportDiagLog() {
    const text = buildDiagReport();
    const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    const stamp = diagStamp().replace(/[: ]/g, "-").replace(/\..*$/, "");
    link.href = url;
    link.download = `nai-autosaver-log-${stamp}.txt`;
    document.documentElement.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    setStatus(`진단 로그를 내보냈어요. (${diag.entries.length}건)`, "ok");
  }

  // Exceptions thrown by this content script (its own isolated world) surface
  // on this window, not on NovelAI's. Record them; never swallow.
  try {
    window.addEventListener("error", (event) => {
      logEvent("error", `잡히지 않은 예외: ${event?.message || "?"}`, event?.error || `${event?.filename || ""}:${event?.lineno || ""}`);
    });
    window.addEventListener("unhandledrejection", (event) => {
      logEvent("error", "처리되지 않은 Promise 거부", event?.reason);
    });
  } catch (error) {
    void error;
  }

  // ---------------------------------------------------------------------------
  // background tab keep-alive
  // ---------------------------------------------------------------------------
  // Chrome throttles setTimeout/setInterval in a hidden tab to once per second,
  // and after the tab has been hidden for five minutes to once per MINUTE
  // ("intensive throttling"). That is why switching to another tab stalled the
  // run and stopped downloads. A page that is producing audio output is exempt
  // from both, so an inaudible tone is kept running for the duration of a run.
  // Amplitude is ~-56 dBFS: above Chrome's -72 dBFS audibility threshold, far
  // below anything a person can hear, and at 20 Hz which normal speakers cannot
  // reproduce anyway.
  let backgroundKeepAliveEnabled = true;
  const keepAlive = { context: null, oscillator: null, gain: null };

  function startBackgroundKeepAlive() {
    if (!backgroundKeepAliveEnabled || keepAlive.context) {
      return;
    }
    try {
      const AudioCtor = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtor) {
        return;
      }
      const context = new AudioCtor();
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      oscillator.type = "sine";
      oscillator.frequency.value = 20;
      gain.gain.value = 0.0016;
      oscillator.connect(gain);
      gain.connect(context.destination);
      oscillator.start();
      keepAlive.context = context;
      keepAlive.oscillator = oscillator;
      keepAlive.gain = gain;
      void context.resume?.();
    } catch (error) {
      void error;
    }
  }

  function stopBackgroundKeepAlive() {
    try {
      keepAlive.oscillator?.stop?.();
    } catch (error) {
      void error;
    }
    try {
      keepAlive.oscillator?.disconnect?.();
      keepAlive.gain?.disconnect?.();
      void keepAlive.context?.close?.();
    } catch (error) {
      void error;
    }
    keepAlive.oscillator = null;
    keepAlive.gain = null;
    keepAlive.context = null;
  }

  // Single source of truth: the tone runs exactly while something is running.
  // Ref counting was fragile because a queue run nests many single runs inside
  // itself, so the counter never returned to zero and the tone never stopped.
  function syncBackgroundKeepAlive() {
    const shouldRun = backgroundKeepAliveEnabled && (autoRun.active || queueRun.active);
    if (shouldRun) {
      startBackgroundKeepAlive();
    } else if (keepAlive.context) {
      stopBackgroundKeepAlive();
    }
  }

  // All storage goes through SafeStore (safe-store.js): writes are mirrored
  // into the NovelAI page's localStorage, failures are reported instead of
  // swallowed, and a fresh install restores from the mirror.
  function storageGet(area, keys) {
    return safeStore.get(area, keys);
  }

  // Resolves to { ok, mirrored, error }. Never rejects.
  function storageSet(area, values) {
    return safeStore.set(area, values);
  }

  function escapeHTML(text) {
    return String(text)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function isVisible(element) {
    if (!(element instanceof Element)) {
      return false;
    }
    const style = window.getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) {
      return false;
    }
    const rect = element.getBoundingClientRect();
    return rect.width > 16 && rect.height > 16;
  }

  // Small icon controls in NovelAI can be only 14–16px internally.  The general
  // isVisible() threshold is intentionally stricter for editors, but it must not
  // reject a real Character-header trash button.  This helper only checks whether
  // the element is actually rendered and clickable.
  function isRenderedControl(element) {
    if (!(element instanceof Element) || !element.isConnected) {
      return false;
    }
    const style = window.getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) {
      return false;
    }
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  // ---------------------------------------------------------------------------
  // NovelAI DOM interaction
  // ---------------------------------------------------------------------------
  function findGenerateButton() {
    return Array.from(document.querySelectorAll("button"))
      .find((button) => /Generate\s+\d+\s+Image(s)?/i.test(button.textContent || "")) || null;
  }

  function normalizeButtonText(button) {
    return String(button?.textContent || "").trim().replace(/\s+/g, " ");
  }

  function findButtonByText(root, matcher) {
    if (!root) {
      return null;
    }
    return Array.from(root.querySelectorAll("button"))
      .filter(isVisible)
      .find((button) => matcher(normalizeButtonText(button))) || null;
  }

  function findPromptEditors() {
    return Array.from(document.querySelectorAll("[contenteditable]"))
      .filter((element) => element instanceof HTMLElement)
      .filter((element) => element.isContentEditable)
      .filter(isVisible)
      .filter((element) => !element.closest(`#${HOST_ID}`))
      .filter((element) => !isInUndesired(element))
      .filter((element) => {
        const rect = element.getBoundingClientRect();
        return rect.width >= 140 && rect.height >= 24;
      })
      .sort((a, b) => {
        const aRect = a.getBoundingClientRect();
        const bRect = b.getBoundingClientRect();
        return aRect.top - bRect.top || aRect.left - bRect.left;
      });
  }

  function getBasePromptEditor() {
    const root = Array.from(document.querySelectorAll(".image-gen-prompt-main")).filter(isVisible)[0] || null;
    if (root) {
      const editors = Array.from(root.querySelectorAll("[contenteditable]"))
        .filter((element) => element instanceof HTMLElement)
        .filter((element) => element.isContentEditable)
        .filter((element) => !isInUndesired(element))
        .filter(isVisible);
      for (const editor of editors) {
        const wrapper = editor.closest(BASE_WRAPPER_SELECTOR);
        if (wrapper && !editor.closest(CHAR_WRAPPER_SELECTOR)) {
          return editor;
        }
      }
    }
    // Fallback: topmost prompt editor that is NOT a character box, so the base
    // prompt can never accidentally read/write a character-negative box.
    return findPromptEditors().filter((el) => !el.closest(CHAR_WRAPPER_SELECTOR))[0] || null;
  }

  function plainTextToHTML(text) {
    return String(text).split(/\r?\n/).map((line) => {
      if (!line) {
        return '<p><br class="ProseMirror-trailingBreak"></p>';
      }
      return `<p>${escapeHTML(line)}</p>`;
    }).join("");
  }

  function htmlToPlainText(html) {
    const container = document.createElement("div");
    container.innerHTML = html || "";
    const lines = [];
    for (const child of Array.from(container.childNodes)) {
      lines.push(child.textContent || "");
    }
    return lines.join("\n").trim();
  }

  function setEditablePlainText(editor, value) {
    editor.focus();
    editor.innerHTML = plainTextToHTML(value);
    try {
      editor.dispatchEvent(new InputEvent("input", {
        bubbles: true,
        cancelable: true,
        inputType: "insertText",
        data: value,
      }));
    } catch (error) {
      editor.dispatchEvent(new Event("input", { bubbles: true }));
    }
    editor.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function readEditableText(editor) {
    if (!editor) {
      return "";
    }
    const inner = typeof editor.innerText === "string" ? editor.innerText : "";
    return (inner || htmlToPlainText(editor.innerHTML) || editor.textContent || "")
      .replace(/\u00a0/g, " ")
      .trim();
  }

  function promptTagParts(value) {
    return String(value == null ? "" : value)
      .split(/[,\n]+/u)
      .map((part) => part.trim())
      .filter(Boolean);
  }

  function canonicalPromptTag(value) {
    const tag = String(value == null ? "" : value).replace(/\s+/g, " ").trim().toLowerCase();
    // NovelAI normalises the gender seed selected from the Add Character menu:
    // `1girl` is rendered as `girl,` and `1boy` as `boy,`. Treat those forms as
    // equivalent so a successful write is not mistaken for a failure/retried.
    if (tag === "1girl" || tag === "girl") {
      return "girl";
    }
    if (tag === "1boy" || tag === "boy") {
      return "boy";
    }
    return tag;
  }

  function normalizedPromptTags(value) {
    return promptTagParts(value).map(canonicalPromptTag);
  }

  function selectEditableContents(editor) {
    editor.focus();
    const selection = window.getSelection();
    if (!selection) {
      return false;
    }
    const range = document.createRange();
    range.selectNodeContents(editor);
    selection.removeAllRanges();
    selection.addRange(range);
    return true;
  }

  function moveCaretToEditableEnd(editor) {
    editor.focus();
    const selection = window.getSelection();
    if (!selection) {
      return false;
    }
    const range = document.createRange();
    range.selectNodeContents(editor);
    range.collapse(false);
    selection.removeAllRanges();
    selection.addRange(range);
    return true;
  }

  function execInsertText(text) {
    try {
      return document.execCommand("insertText", false, String(text));
    } catch (error) {
      return false;
    }
  }

  // ---------------------------------------------------------------------------
  // ProseMirror-native writing
  // ---------------------------------------------------------------------------
  // NovelAI's prompt boxes are ProseMirror editors. Rewriting their DOM
  // (innerHTML = "", innerHTML = "<p>…</p>") is exactly what ProseMirror is
  // built to undo: it keeps its own document and restores it after a foreign
  // mutation, which is why writes "took" for a moment and then vanished, and
  // why the read-back verification kept failing and falling into the slow
  // tag-by-tag retry loops.
  //
  // A synthetic `paste` event is different: ProseMirror handles paste itself,
  // replacing the current selection in ONE transaction, and calls
  // preventDefault() when it has consumed the event. That flag is the signal
  // that the editor really accepted the text.
  function dispatchPaste(editor, text) {
    try {
      const data = new DataTransfer();
      data.setData("text/plain", String(text));
      const event = new ClipboardEvent("paste", {
        bubbles: true,
        cancelable: true,
        composed: true,
        clipboardData: data,
      });
      editor.dispatchEvent(event);
      return event.defaultPrevented;
    } catch (error) {
      return false;
    }
  }

  // Let ProseMirror pick up a DOM selection we just created. It syncs from the
  // `selectionchange` event, which the browser fires asynchronously.
  async function settleEditorSelection() {
    try {
      document.dispatchEvent(new Event("selectionchange"));
    } catch (error) {
      void error;
    }
    await delay(40);
  }

  // Clear through the editing pipeline (select-all + delete). Returns true when
  // the editor is empty afterwards. Never touches innerHTML here.
  async function clearEditableViaEditing(editor) {
    selectEditableContents(editor);
    await settleEditorSelection();
    try {
      document.execCommand("delete", false, null);
    } catch (error) {
      void error;
    }
    await delay(60);
    return !readEditableText(editor);
  }

  // Replace (or append to) the editor's content with one paste. Returns true
  // when ProseMirror consumed the paste; the caller still verifies the result.
  async function pasteTextIntoEditor(editor, text, { replaceAll = true } = {}) {
    if (!editor) {
      return false;
    }
    const value = String(text == null ? "" : text);
    editor.focus();
    if (replaceAll) {
      selectEditableContents(editor);
    } else {
      moveCaretToEditableEnd(editor);
    }
    await settleEditorSelection();
    if (!value) {
      return clearEditableViaEditing(editor);
    }
    const handled = dispatchPaste(editor, value);
    await delay(90);
    return handled;
  }

  function normalizePlainText(value) {
    return String(value == null ? "" : value)
      .replace(/\u00a0/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  // NovelAI copies a prompt editor's text into its generation settings when the
  // editor loses focus. A write that leaves the editor focused (or that happens
  // while the window itself is unfocused, where element.blur() fires nothing)
  // is visible on screen but NOT used for generation until the user clicks the
  // box and clicks away. Blur explicitly, and if no real blur event fired,
  // deliver one ourselves.
  async function commitEditorValue(editor) {
    if (!(editor instanceof HTMLElement) || !editor.isConnected) {
      return;
    }
    let fired = false;
    const mark = () => {
      fired = true;
    };
    editor.addEventListener("blur", mark, true);
    try {
      const active = document.activeElement;
      if (active === editor || (active && editor.contains(active))) {
        editor.blur();
      }
    } catch (error) {
      void error;
    }
    editor.removeEventListener("blur", mark, true);
    if (!fired) {
      try {
        editor.dispatchEvent(new FocusEvent("focusout", { bubbles: true, composed: true, relatedTarget: null }));
        editor.dispatchEvent(new FocusEvent("blur", { bubbles: false, relatedTarget: null }));
      } catch (error) {
        void error;
      }
    }
    await delay(40);
  }

  // Before pressing Generate: make sure no NovelAI editor still holds an
  // uncommitted edit.
  async function commitActivePageEditor() {
    const active = document.activeElement;
    if (active instanceof HTMLElement && active.isContentEditable && !active.closest(`#${HOST_ID}`)) {
      const root = active.closest(".ProseMirror") || active;
      await commitEditorValue(root);
    }
  }

  // Full-text write for the base prompt and every Undesired Content box.
  // Paste first; only if ProseMirror did not accept it fall back to the legacy
  // DOM write. Returns { ok, expected, actual } so callers can report a real
  // diff instead of "unknown error".
  // NovelAI stores what is typed into the character card that is currently
  // SELECTED (the one the user last clicked/focused), not necessarily the card
  // whose editor received the text. Clicking and focusing the editor first, the
  // way a user does, selects its card so the text lands in the right character.
  async function activateEditorForWrite(editor) {
    if (!(editor instanceof HTMLElement) || !editor.isConnected) {
      return;
    }
    let focused = false;
    const mark = () => {
      focused = true;
    };
    editor.addEventListener("focus", mark, true);
    try {
      clickControlLikeUser(editor);
      editor.focus();
    } catch (error) {
      void error;
    }
    editor.removeEventListener("focus", mark, true);
    if (!focused) {
      try {
        editor.dispatchEvent(new FocusEvent("focusin", { bubbles: true, composed: true }));
        editor.dispatchEvent(new FocusEvent("focus", { bubbles: false }));
      } catch (error) {
        void error;
      }
    }
    await delay(120);
  }

  async function writeEditablePlainText(editor, value) {
    await activateEditorForWrite(editor);
    const result = await writeEditablePlainTextRaw(editor, value);
    await commitEditorValue(editor);
    return result;
  }

  async function writeEditablePlainTextRaw(editor, value) {
    const text = String(value == null ? "" : value);
    const expected = normalizePlainText(text);
    const matches = () => normalizePlainText(readEditableText(editor)) === expected;
    if (!editor) {
      return { ok: false, expected, actual: "" };
    }
    await pasteTextIntoEditor(editor, text, { replaceAll: true });
    if (matches()) {
      editor.dispatchEvent(new Event("change", { bubbles: true }));
      return { ok: true, expected, actual: expected };
    }
    logEvent("warn", "전체 텍스트 붙여넣기 1차 불일치 → 지우고 재시도", describeMismatch(expected, readEditableText(editor), 120));
    // Second try: clear via editing, then paste again (a leftover selection can
    // make the first paste land as an insert instead of a replace).
    await clearEditableViaEditing(editor);
    await pasteTextIntoEditor(editor, text, { replaceAll: false });
    if (matches()) {
      editor.dispatchEvent(new Event("change", { bubbles: true }));
      return { ok: true, expected, actual: expected };
    }
    // Last resort: legacy DOM write.
    logEvent("warn", "붙여넣기 2차 불일치 → 레거시 DOM 쓰기로 폴백", describeMismatch(expected, readEditableText(editor), 120));
    setEditablePlainText(editor, text);
    await delay(120);
    const actual = normalizePlainText(readEditableText(editor));
    logEvent(actual === expected ? "info" : "error", `레거시 DOM 쓰기 ${actual === expected ? "성공" : "실패"}`, actual === expected ? undefined : describeMismatch(expected, actual, 120));
    return { ok: actual === expected, expected, actual };
  }

  function describeMismatch(expected, actual, limit = 60) {
    const clip = (value) => {
      const s = String(value == null ? "" : value);
      return s.length > limit ? `${s.slice(0, limit)}…` : s;
    };
    return `기대 "${clip(expected)}" / 실제 "${clip(actual) || "(비어 있음)"}"`;
  }

  async function typePromptTags(editor, value, { clear = true } = {}) {
    const text = String(value == null ? "" : value).trim();
    if (!editor) {
      return false;
    }

    const tags = promptTagParts(text);
    const expectedTags = tags.map(canonicalPromptTag);
    const matches = () => normalizedPromptTags(readEditableText(editor)).join("|") === expectedTags.join("|");

    if (!text) {
      const emptied = clear ? await clearEditableViaEditing(editor) : true;
      editor.dispatchEvent(new Event("change", { bubbles: true }));
      return emptied;
    }

    // Fast path: ONE paste over the whole selection (or at the end when
    // appending). ProseMirror replaces its own selection in a single
    // transaction, so there is no clear step for it to "restore" from.
    if (clear) {
      await pasteTextIntoEditor(editor, tags.join(", "), { replaceAll: true });
      if (matches()) {
        editor.dispatchEvent(new Event("change", { bubbles: true }));
        return true;
      }
      // A stale selection can turn the replace into an insert. Clear through
      // the editing pipeline and paste once more before giving up on paste.
      logEvent("warn", "태그 붙여넣기 1차 불일치 → 지우고 재시도", describeMismatch(tags.join(", "), readEditableText(editor), 120));
      await clearEditableViaEditing(editor);
      await pasteTextIntoEditor(editor, tags.join(", "), { replaceAll: false });
      if (matches()) {
        editor.dispatchEvent(new Event("change", { bubbles: true }));
        return true;
      }
    } else {
      const handled = await pasteTextIntoEditor(editor, tags.join(", "), { replaceAll: false });
      if (handled) {
        editor.dispatchEvent(new Event("change", { bubbles: true }));
        return true;
      }
    }

    // Legacy fast path: execCommand insertText in one shot.
    logEvent("warn", "붙여넣기가 받아들여지지 않음 → execCommand 폴백", describeMismatch(tags.join(", "), readEditableText(editor), 120));
    if (clear) {
      await clearEditableViaEditing(editor);
    }
    editor.focus();
    moveCaretToEditableEnd(editor);
    if (clear && execInsertText(tags.join(", "))) {
      editor.dispatchEvent(new Event("change", { bubbles: true }));
      await delay(60);
      if (matches()) {
        return true;
      }
      // The editor must be genuinely EMPTY before the tag-by-tag loop, otherwise
      // it appends onto the survivors and produces duplicated tags.
      if (!(await clearEditableViaEditing(editor))) {
        editor.innerHTML = "";
        editor.dispatchEvent(new Event("input", { bubbles: true }));
        await delay(45);
      }
    }

    logEvent("warn", `태그 하나씩 입력하는 느린 경로 진입 (${tags.length}개 태그)`);
    // Slow path (last resort): NovelAI's character editor tokenizes at commas.
    // Enter each tag and delimiter through the browser editing pipeline, with a
    // short pause after commas so the next token is not lost during rerendering.
    for (let i = 0; i < tags.length; i += 1) {
      editor.focus();
      if (i > 0) {
        moveCaretToEditableEnd(editor);
        execInsertText(", ");
        await delay(75);
      }
      moveCaretToEditableEnd(editor);
      execInsertText(tags[i]);
      await delay(35);
    }
    editor.dispatchEvent(new Event("change", { bubbles: true }));
    await delay(110);
    return true;
  }

  async function appendCharacterPromptTags(editor, tags) {
    const parts = Array.isArray(tags) ? tags.filter(Boolean) : [];
    if (!editor || !parts.length) {
      return;
    }
    // Fast path: append every missing tag in one paste at the end.
    {
      const current = readEditableText(editor);
      const lead = /,\s*$/u.test(current) ? " " : (current ? ", " : "");
      const expected = normalizedPromptTags(`${current}, ${parts.join(", ")}`).join("|");
      await pasteTextIntoEditor(editor, `${lead}${parts.join(", ")}`, { replaceAll: false });
      if (normalizedPromptTags(readEditableText(editor)).join("|") === expected) {
        editor.dispatchEvent(new Event("change", { bubbles: true }));
        return;
      }
    }
    // Legacy fast path: execCommand insertText.
    editor.focus();
    moveCaretToEditableEnd(editor);
    {
      const current = readEditableText(editor);
      const lead = /,\s*$/u.test(current) ? " " : (current ? ", " : "");
      const expected = normalizedPromptTags(`${current}, ${parts.join(", ")}`).join("|");
      if (execInsertText(`${lead}${parts.join(", ")}`)) {
        editor.dispatchEvent(new Event("change", { bubbles: true }));
        await delay(70);
        if (normalizedPromptTags(readEditableText(editor)).join("|") === expected) {
          return;
        }
      }
    }

    // Slow fallback. The single-shot insert above may have landed partially, so
    // skip whatever already made it into the editor instead of duplicating it.
    const alreadyThere = normalizedPromptTags(readEditableText(editor));
    const remaining = parts.filter((part) => {
      const index = alreadyThere.indexOf(canonicalPromptTag(part));
      if (index < 0) {
        return true;
      }
      alreadyThere.splice(index, 1);
      return false;
    });
    for (let i = 0; i < remaining.length; i += 1) {
      editor.focus();
      moveCaretToEditableEnd(editor);
      const current = readEditableText(editor);
      // The gender option creates `girl,` / `boy,` with a trailing comma. Do not
      // add a second comma before the first custom tag.
      const separator = /,\s*$/u.test(current)
        ? " "
        : (current ? ", " : "");
      if (separator) {
        execInsertText(separator);
        await delay(80);
      }
      execInsertText(remaining[i]);
      await delay(55);
    }
    editor.dispatchEvent(new Event("change", { bubbles: true }));
    await delay(130);
  }

  async function setCharacterPromptText(editor, value) {
    await activateEditorForWrite(editor);
    const ok = await setCharacterPromptTextRaw(editor, value);
    await commitEditorValue(editor);
    return ok;
  }

  async function setCharacterPromptTextRaw(editor, value) {
    const parts = promptTagParts(value);
    const expected = parts.map(canonicalPromptTag);
    let actual = normalizedPromptTags(readEditableText(editor));

    // A freshly-created character already contains `girl,` or `boy,`. Preserve
    // that native token and append only the missing tags; clearing/replacing it
    // causes NovelAI's editor to keep the gender token but discard the tail.
    const isPrefix = actual.length > 0
      && actual.length <= expected.length
      && actual.every((tag, index) => tag === expected[index]);
    if (isPrefix && actual.length < expected.length) {
      await appendCharacterPromptTags(editor, parts.slice(actual.length));
    } else if (actual.join("|") !== expected.join("|")) {
      await typePromptTags(editor, value, { clear: true });
    }

    actual = normalizedPromptTags(readEditableText(editor));
    if (expected.length && actual.join("|") !== expected.join("|")) {
      // After a rerender, append a still-missing suffix instead of clearing the
      // whole character again. This is especially important for collapsed cards.
      const retryPrefix = actual.length > 0
        && actual.length <= expected.length
        && actual.every((tag, index) => tag === expected[index]);
      if (retryPrefix && actual.length < expected.length) {
        await delay(180);
        await appendCharacterPromptTags(editor, parts.slice(actual.length));
      } else {
        await delay(180);
        await typePromptTags(editor, value, { clear: true });
      }
      actual = normalizedPromptTags(readEditableText(editor));
    }

    return expected.join("|") === actual.join("|");
  }


  async function readCurrentNaiPrompt() {
    const scope = getBaseArea() || document.body;
    await revealTabInScope(scope, "prompt", { excludeCharacterBoxes: true });
    const editor = getBasePromptEditor();
    return editor ? htmlToPlainText(editor.innerHTML) : "";
  }

  async function readCurrentNaiNegativePrompt() {
    const scope = getBaseArea() || document.body;
    await revealTabInScope(scope, "uc", { excludeCharacterBoxes: true });
    const editor = getBaseNegativeEditor();
    const text = editor ? htmlToPlainText(editor.innerHTML) : "";
    await revealTabInScope(scope, "prompt", { excludeCharacterBoxes: true });
    return text;
  }

  async function readCurrentNaiCharacterNegative() {
    const containers = getCharacterContainers();
    if (!containers.length) {
      return "";
    }
    const parts = [];
    for (const container of containers) {
      await revealTabInScope(container, "uc");
      const editor = getCharacterBoxEditor(container);
      parts.push(editor ? htmlToPlainText(editor.innerHTML).trim() : "");
      await revealTabInScope(container, "prompt");
    }
    return parts.join(" ;; ").replace(/(\s*;;\s*)+$/, "").trim();
  }

  function getCharacterPromptEditors() {
    // Character Prompts are rendered as a sibling section below the base prompt
    // in the current NovelAI layout, not necessarily inside .image-gen-prompt-main.
    // Search the page rather than the base-prompt-only wrapper.
    const root = document;
    // Preferred: explicit character-prompt wrappers.
    let editors = Array.from(root.querySelectorAll(`${CHAR_WRAPPER_SELECTOR} [contenteditable]`))
      .filter((element) => element instanceof HTMLElement)
      .filter((element) => element.isContentEditable)
      .filter(isVisible)
      .filter((element) => !isInUndesired(element))
      .filter((element) => !element.closest(`#${HOST_ID}`));
    // Fallback: every visible prompt editor except the base prompt editor.
    if (!editors.length) {
      const base = getBasePromptEditor();
      editors = findPromptEditors().filter((element) => element !== base);
    }
    return editors.sort((a, b) => {
      const aRect = a.getBoundingClientRect();
      const bRect = b.getBoundingClientRect();
      return aRect.top - bRect.top || aRect.left - bRect.left;
    });
  }

  function accessibleControlText(element) {
    if (!element) {
      return "";
    }
    return [
      element.textContent,
      element.getAttribute?.("aria-label"),
      element.getAttribute?.("title"),
      element.getAttribute?.("data-tooltip"),
      element.getAttribute?.("data-tip"),
      element.getAttribute?.("data-testid"),
    ]
      .filter(Boolean)
      .join(" ")
      .trim()
      .replace(/\s+/g, " ");
  }

  function ownControlText(element) {
    if (!element) {
      return "";
    }
    return Array.from(element.childNodes || [])
      .filter((node) => node.nodeType === Node.TEXT_NODE)
      .map((node) => node.textContent || "")
      .join(" ")
      .trim()
      .replace(/\s+/g, " ");
  }

  function characterSectionsOnPage() {
    const onScreen = (element) => {
      const rect = element.getBoundingClientRect();
      const width = window.innerWidth || document.documentElement.clientWidth || 0;
      return rect.right > 0 && rect.left < width && !element.closest(".image-gen-mobile-sheet");
    };
    return Array.from(document.querySelectorAll(".image-gen-character-prompts"))
      .filter((element) => !element.closest(`#${HOST_ID}`))
      .filter(isRenderedControl)
      .sort((a, b) => Number(onScreen(b)) - Number(onScreen(a)));
  }

  function findAddCharacterButton(surface = null) {
    const selector = 'button, [role="button"]';
    const usable = (element) => !element.closest(`#${HOST_ID}`)
      && isRenderedControl(element)
      && !element.disabled
      && element.getAttribute?.("aria-disabled") !== "true";
    const matchByLabel = (scope) => Array.from(scope.querySelectorAll(selector))
      .filter(usable)
      .find((element) => /add\s*character|character\s*add|캐릭터\s*추가/i.test(accessibleControlText(element))) || null;

    // Current NovelAI: the Character Prompts section sits OUTSIDE
    // .image-gen-prompt-main and its "+" is an icon-only button in the header
    // row, next to the "Character Prompts" title (the Position buttons live in
    // a second row of the same header and all carry text).
    const sections = [];
    const own = surface instanceof Element
      ? (surface.closest(".image-gen-character-prompts") || surface.querySelector?.(".image-gen-character-prompts"))
      : null;
    if (own) sections.push(own);
    for (const section of characterSectionsOnPage()) {
      if (!sections.includes(section)) sections.push(section);
    }
    for (const section of sections) {
      const byLabel = matchByLabel(section);
      if (byLabel) {
        return byLabel;
      }
      const header = section.querySelector(".image-gen-character-prompts-header") || section;
      const iconOnly = Array.from(header.querySelectorAll(selector))
        .filter(usable)
        .filter((element) => !element.closest(".character-prompt-input,[class*='character-prompt-input-']"))
        .filter((element) => !accessibleControlText(element))
        .filter((element) => element.querySelector("div,svg,span"));
      if (iconOnly.length) {
        const title = Array.from(header.querySelectorAll("div,span,p,h1,h2,h3,h4,h5,h6"))
          .find((element) => /^character\s*prompts?$/i.test(ownControlText(element)));
        if (!title) {
          return iconOnly[0];
        }
        const titleRect = title.getBoundingClientRect();
        const mid = titleRect.top + titleRect.height / 2;
        return iconOnly
          .map((button) => {
            const rect = button.getBoundingClientRect();
            return { button, gap: Math.abs(rect.top + rect.height / 2 - mid) };
          })
          .sort((a, b) => a.gap - b.gap)[0].button;
      }
    }

    const direct = matchByLabel(document.body);
    if (direct) {
      return direct;
    }

    // Older layouts: locate the "Character Prompts" heading anywhere on the page
    // and choose the nearest untitled button in the same compact header row.
    const labels = Array.from(document.querySelectorAll("h1,h2,h3,h4,h5,h6,label,p,span,div"))
      .filter((element) => !element.closest(`#${HOST_ID}`))
      .filter(isVisible)
      .filter((element) => /^character\s*prompts?$/i.test(ownControlText(element)));

    for (const label of labels) {
      const labelRect = label.getBoundingClientRect();
      let scope = label.parentElement;
      for (let depth = 0; scope && scope !== document.body && depth < 5; depth += 1, scope = scope.parentElement) {
        const buttons = Array.from(scope.querySelectorAll(selector))
          .filter(usable)
          .filter((element) => !/^(?:female|male|other|여성|남성|기타|ai.?s choice|custom)$/i.test(accessibleControlText(element)));
        if (!buttons.length) {
          continue;
        }
        const nearby = buttons
          .map((button) => {
            const rect = button.getBoundingClientRect();
            const verticalDistance = Math.abs((rect.top + rect.height / 2) - (labelRect.top + labelRect.height / 2));
            const horizontalDistance = Math.abs(rect.left - labelRect.right);
            return { button, score: verticalDistance * 3 + horizontalDistance };
          })
          .sort((a, b) => a.score - b.score)[0];
        if (nearby && nearby.score < 500) {
          return nearby.button;
        }
      }
    }
    return null;
  }

  function inferCharacterGender(prompt) {
    const value = String(prompt == null ? "" : prompt).toLowerCase();
    const female = /(?:^|[^a-z0-9_])(?:1girl|[2-9]girls?|girls?|female|woman|women)(?=$|[^a-z0-9_])/i.test(value);
    const male = /(?:^|[^a-z0-9_])(?:1boy|[2-9]boys?|boys?|male|man|men)(?=$|[^a-z0-9_])/i.test(value);
    if (female && !male) {
      return "female";
    }
    if (male && !female) {
      return "male";
    }
    return "other";
  }

  function normalizeGenderOptionText(value) {
    return String(value == null ? "" : value)
      // The current menu labels are rendered as "♀ Female", "♂ Male",
      // and "⚧ Other". Strip glyphs/variation selectors before matching.
      .replace(/[♀♂⚧⚥⚲\u200B-\u200D\uFE0E\uFE0F]/gu, " ")
      .trim()
      .replace(/\s+/g, " ")
      .toLowerCase();
  }

  function findCharacterGenderOption(preferredGender) {
    const names = {
      female: new Set(["female", "여성"]),
      male: new Set(["male", "남성"]),
      other: new Set(["other", "기타"]),
    };
    const order = [preferredGender, "other", "female", "male"]
      .filter((value, index, list) => value && list.indexOf(value) === index);
    const raw = Array.from(document.querySelectorAll('button, [role="menuitem"], [role="option"], [role="button"], li, [tabindex]'))
      .filter((element) => !element.closest(`#${HOST_ID}`))
      .filter(isVisible)
      .filter((element) => element.getAttribute?.("aria-disabled") !== "true" && !element.disabled)
      .map((element) => ({
        element,
        label: normalizeGenderOptionText(accessibleControlText(element)),
      }));

    for (const gender of order) {
      const option = raw.find(({ label }) => {
        const tokens = label.split(/\s+/u).filter(Boolean);
        return tokens.length > 0 && tokens.every((token) => names[gender].has(token));
      });
      if (option) {
        return option.element;
      }
    }
    return null;
  }

  function characterCountForSurface(surface) {
    if (surface instanceof Element && surface.isConnected) {
      return getCharacterContainersInSurface(surface).length;
    }
    return getCharacterContainers().length;
  }

  async function waitForCharacterBoxIncrease(before, attempts = 12, surface = null) {
    for (let i = 0; i < attempts; i += 1) {
      await delay(120);
      if (characterCountForSurface(surface) > before) {
        return true;
      }
    }
    return false;
  }

  function clickControlLikeUser(element) {
    if (!(element instanceof Element)) {
      return false;
    }
    const rect = element.getBoundingClientRect();
    const clientX = Math.max(rect.left + 2, Math.min(rect.right - 2, rect.left + rect.width / 2));
    const clientY = Math.max(rect.top + 2, Math.min(rect.bottom - 2, rect.top + rect.height / 2));
    const eventInit = { bubbles: true, cancelable: true, composed: true, clientX, clientY, button: 0, buttons: 1 };
    try {
      if (typeof PointerEvent === "function") {
        element.dispatchEvent(new PointerEvent("pointerdown", { ...eventInit, pointerId: 1, pointerType: "mouse", isPrimary: true }));
      }
      element.dispatchEvent(new MouseEvent("mousedown", eventInit));
      element.dispatchEvent(new MouseEvent("mouseup", { ...eventInit, buttons: 0 }));
      if (typeof PointerEvent === "function") {
        element.dispatchEvent(new PointerEvent("pointerup", { ...eventInit, buttons: 0, pointerId: 1, pointerType: "mouse", isPrimary: true }));
      }
      element.dispatchEvent(new MouseEvent("click", { ...eventInit, buttons: 0 }));
      return true;
    } catch (error) {
      try {
        element.click();
        return true;
      } catch (innerError) {
        return false;
      }
    }
  }

  async function clickAddCharacterBox(characterPrompt = "", surface = null) {
    void characterPrompt;
    const before = characterCountForSurface(surface);
    const button = findAddCharacterButton(surface);
    if (!button || button.disabled || button.getAttribute?.("aria-disabled") === "true") {
      logEvent("warn", "Character 추가(+) 버튼을 찾지 못함");
      return false;
    }
    clickControlLikeUser(button);

    // Female / Male / Other only seeds the new Character card.  The queue writes
    // the full prompt immediately afterwards, so any visible option is valid and
    // there is no reason to reset every card merely to match an inferred gender.
    for (let attempt = 0; attempt < 10; attempt += 1) {
      await delay(80);
      const genderOption = findCharacterGenderOption("female")
        || findCharacterGenderOption("male")
        || findCharacterGenderOption("other");
      if (genderOption) {
        clickControlLikeUser(genderOption);
        return waitForCharacterBoxIncrease(before, 16, surface);
      }
      if (characterCountForSurface(surface) > before) {
        return true;
      }
    }
    return characterCountForSurface(surface) > before;
  }

  async function readCurrentNaiCharacterPrompt() {
    const containers = getCharacterContainers();
    if (!containers.length) {
      return "";
    }
    const parts = [];
    for (const container of containers) {
      await revealTabInScope(container, "prompt");
      const editor = getCharacterBoxEditor(container);
      // Keep an empty card as an empty block so the character negatives read
      // from the same cards stay lined up with their characters.
      parts.push(editor ? htmlToPlainText(editor.innerHTML).trim() : "");
    }
    while (parts.length && !parts[parts.length - 1]) {
      parts.pop();
    }
    return parts.join(" ;; ");
  }

  async function applyPromptToNovelAi(text) {
    if (text == null || String(text).trim() === "") {
      return { ok: true, skipped: true };
    }
    const scope = getBaseArea() || document.body;
    await revealTabInScope(scope, "prompt", { excludeCharacterBoxes: true });
    const editor = getBasePromptEditor();
    if (!editor) {
      return { ok: false, error: "NovelAI 프롬프트 입력 영역을 찾지 못했어요." };
    }
    const written = await writeEditablePlainText(editor, text);
    await delay(120);
    if (!written.ok) {
      // Generating with a half-applied base prompt produces images the user did
      // not ask for. Stop with the actual diff so the cause is visible.
      return {
        ok: false,
        error: `베이스 프롬프트가 NovelAI에 입력되지 않았어요. ${describeMismatch(written.expected, written.actual)}`,
      };
    }
    return { ok: true };
  }

  // NovelAI V4 gives the base prompt AND each character their own "Prompt" /
  // "Undesired Content" tab pair. We must write negatives ONLY into a real UC
  // editor, never into a prompt editor. The prompt wrappers below are the
  // known-correct positive-prompt boxes, so "a visible editor that is NOT inside
  // one of these" is the UC editor — this avoids guessing the UC class name and
  // makes it impossible to contaminate a prompt box.
  const UC_TAB_RE = /undesired|네거티브|negative|^\s*uc\s*$/i;
  const PROMPT_TAB_RE = /^\s*prompt\s*$|프롬프트|base\s*prompt/i;
  const PROMPT_WRAPPER_SELECTOR =
    `${BASE_WRAPPER_SELECTOR}, ${CHAR_WRAPPER_SELECTOR}`;

  function isPromptEditor(element) {
    return Boolean(element && element.closest && element.closest(PROMPT_WRAPPER_SELECTOR));
  }

  function findTabButton(root, labelRegex, { excludeCharacterBoxes = false } = {}) {
    if (!root) {
      return null;
    }
    return Array.from(root.querySelectorAll("button"))
      .filter(isVisible)
      .filter((button) => !button.closest(`#${HOST_ID}`))
      .filter((button) => !excludeCharacterBoxes || !button.closest(CHAR_WRAPPER_SELECTOR))
      .find((button) => labelRegex.test(normalizeButtonText(button))) || null;
  }

  function getBaseArea() {
    return Array.from(document.querySelectorAll(".image-gen-prompt-main")).filter(isVisible)[0] || null;
  }

  // NovelAI may unmount/hide the prompt editor when a character card is
  // collapsed. Count cards by their `Character N` headers first, then fall back
  // to prompt wrappers. This keeps Add Character from creating duplicates just
  // because the newly-added card is collapsed.
  const CHARACTER_HEADER_RE = /^(?:♀|♂|⚧)?\s*character\s+(\d+)\s*$/i;

  function normalizeCharacterHeaderText(value) {
    return String(value == null ? "" : value)
      // Emoji-style gender glyphs can include variation selectors / joiners.
      .replace(/[\u200B-\u200D\uFE0E\uFE0F]/gu, "")
      .trim()
      .replace(/\s+/g, " ");
  }

  function getCharacterHeaderElements(root = document) {
    // The current NovelAI UI nests the visible `Character N` text inside one or
    // more spans. Looking only at an element's direct text nodes therefore misses
    // every card and makes the extension think no character boxes exist. Match an
    // element whose COMPLETE rendered text is exactly the header, then keep the
    // deepest matching element so parent wrappers are not counted twice.
    const candidates = Array.from(root.querySelectorAll("button,[role='button'],h1,h2,h3,h4,h5,h6,div,span,p"))
      .filter((element) => !element.closest(`#${HOST_ID}`))
      .filter(isVisible)
      .filter((element) => {
        const text = normalizeCharacterHeaderText(element.textContent);
        const own = normalizeCharacterHeaderText(ownControlText(element));
        return CHARACTER_HEADER_RE.test(text) || CHARACTER_HEADER_RE.test(own);
      })
      .sort((a, b) => {
        const depth = (node) => {
          let value = 0;
          for (let cur = node; cur && cur !== root; cur = cur.parentElement) value += 1;
          return value;
        };
        return depth(b) - depth(a);
      });

    const selected = [];
    for (const candidate of candidates) {
      if (selected.some((child) => candidate.contains(child))) {
        continue;
      }
      selected.push(candidate);
    }
    return selected.sort((a, b) => {
      const ar = a.getBoundingClientRect();
      const br = b.getBoundingClientRect();
      return ar.top - br.top || ar.left - br.left;
    });
  }

  function getCharacterHeaderIndex(element) {
    const direct = normalizeCharacterHeaderText(ownControlText(element));
    const full = normalizeCharacterHeaderText(element?.textContent);
    const match = CHARACTER_HEADER_RE.exec(direct) || CHARACTER_HEADER_RE.exec(full);
    return match ? Number.parseInt(match[1], 10) : Number.NaN;
  }

  function findCharacterCardFromHeader(header) {
    if (!header) {
      return null;
    }
    let node = header;
    while (node && node !== document.body) {
      const rect = node.getBoundingClientRect();
      const indices = new Set(
        getCharacterHeaderElements(node)
          .map(getCharacterHeaderIndex)
          .filter(Number.isFinite)
      );
      const text = String(node.textContent || "");
      const hasBodySignal = Boolean(node.querySelector(CHAR_WRAPPER_SELECTOR))
        || /(?:\bposition\b|\btokens?\b|ai[’']?s choice|undesired content|\bprompt\b)/i.test(text);
      if (indices.size === 1 && rect.width >= 180 && rect.height >= 60 && hasBodySignal) {
        return node;
      }
      if (indices.size > 1) {
        break;
      }
      node = node.parentElement;
    }
    return header.parentElement;
  }

  function getCharacterContainers() {
    // Current NovelAI exposes a stable, ordinal class on every real Character
    // card: .character-prompt-input-N.  Prefer those roots directly instead of
    // inferring card boundaries from text.  The page can keep both desktop and
    // mobile copies in the DOM, so group roots by their UI surface and use one
    // coherent visible surface only.
    const directRoots = Array.from(document.querySelectorAll('.character-prompt-input,[class*="character-prompt-input-"]'))
      .filter((element) => !element.closest(`#${HOST_ID}`))
      .filter(isRenderedControl)
      .map((element) => {
        const className = Array.from(element.classList || []).find((name) => /^character-prompt-input-\d+$/.test(name));
        const match = className && /-(\d+)$/.exec(className);
        return { element, index: match ? Number.parseInt(match[1], 10) : Number.NaN };
      })
      .filter(({ index }) => Number.isFinite(index));

    if (directRoots.length) {
      const groups = new Map();
      for (const entry of directRoots) {
        const surface = entry.element.closest('.image-gen-character-prompts,.settings-panel,.mobile-tray-contents') || entry.element.parentElement;
        if (!groups.has(surface)) groups.set(surface, []);
        groups.get(surface).push(entry);
      }
      // Area clipped to the DOCUMENT, not to the viewport. Clipping to the
      // viewport made surface choice depend on scroll position and on the tab
      // being on screen, so a scrolled or backgrounded tab scored every real
      // card as "invisible" and could pick a stale hidden copy — or report the
      // wrong count and abort the run. Document-space clipping still rejects
      // the parked off-screen mobile tray (left:-9999px / translateX(-100%))
      // while being completely independent of scrolling and tab visibility.
      const viewportArea = (element) => {
        if (!(element instanceof Element)) {
          return 0;
        }
        const rect = element.getBoundingClientRect();
        const docWidth = Math.max(document.documentElement.scrollWidth, window.innerWidth || 0);
        const docHeight = Math.max(document.documentElement.scrollHeight, window.innerHeight || 0);
        const left = rect.left + (window.scrollX || 0);
        const top = rect.top + (window.scrollY || 0);
        const width = Math.max(0, Math.min(left + rect.width, docWidth) - Math.max(left, 0));
        const height = Math.max(0, Math.min(top + rect.height, docHeight) - Math.max(top, 0));
        return width * height;
      };
      const best = Array.from(groups.entries())
        .map(([surface, entries]) => {
          const unique = new Map();
          for (const entry of entries) {
            if (!unique.has(entry.index)) unique.set(entry.index, entry.element);
          }
          const cards = Array.from(unique.values());
          const cardAreas = cards.map(viewportArea);
          const visibleCardCount = cardAreas.filter((area) => area > 0).length;
          const visibleArea = cardAreas.reduce((sum, area) => sum + area, 0);
          const surfaceArea = surface && isRenderedControl(surface) ? viewportArea(surface) : 0;
          const surfaceIsOnscreen = surfaceArea > 0 || visibleCardCount > 0;

          // NovelAI can retain an off-screen mobile tray with the old Character
          // count while the visible desktop panel has already rerendered.  The
          // old scoring preferred whichever surface had MORE cards, so after a
          // successful 4 → 3 deletion it could keep reporting the stale hidden
          // four-card copy.  Always prefer an on-screen coherent surface first.
          const score = (surfaceIsOnscreen ? 1e15 : 0)
            + visibleCardCount * 1e12
            + visibleArea * 1e3
            + surfaceArea
            + unique.size;
          return { unique, score };
        })
        .sort((a, b) => b.score - a.score)[0];
      if (best?.unique?.size) {
        return Array.from(best.unique.entries())
          .sort((a, b) => a[0] - b[0])
          .map((entry) => entry[1]);
      }
    }

    // Fallback for older NovelAI builds without ordinal card classes.
    const root = document;
    const indexed = new Map();
    for (const header of getCharacterHeaderElements(root)) {
      const index = getCharacterHeaderIndex(header);
      const card = findCharacterCardFromHeader(header);
      if (Number.isFinite(index) && card && !indexed.has(index)) {
        indexed.set(index, card);
      }
    }
    if (!indexed.size) {
      const promptBoxes = Array.from(root.querySelectorAll(CHAR_WRAPPER_SELECTOR));
      let fallbackIndex = 1;
      for (const box of promptBoxes) {
        let node = box.parentElement;
        let found = null;
        while (node && node !== document.body) {
          const hasUcTab = Array.from(node.querySelectorAll("button"))
            .some((button) => !button.closest(`#${HOST_ID}`) && UC_TAB_RE.test(normalizeButtonText(button)));
          const charCount = node.querySelectorAll(CHAR_WRAPPER_SELECTOR).length;
          if (hasUcTab && charCount === 1) {
            found = node;
            break;
          }
          node = node.parentElement;
        }
        const container = found || box.parentElement;
        if (container && !Array.from(indexed.values()).includes(container)) {
          indexed.set(fallbackIndex, container);
          fallbackIndex += 1;
        }
      }
    }
    return Array.from(indexed.entries())
      .sort((a, b) => a[0] - b[0])
      .map((entry) => entry[1]);
  }

  function getCharacterHeaderInContainer(container) {
    return getCharacterHeaderElements(container)[0] || null;
  }

  async function waitForCharacterEditorAt(index, attempts = 12) {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const container = getCharacterContainers()[index];
      const editor = getCharacterBoxEditor(container);
      if (editor) {
        return { container, editor };
      }
      await delay(100);
    }
    return { container: getCharacterContainers()[index] || null, editor: null };
  }

  function getCharacterActivationTarget(container, attempt) {
    if (!container) {
      return null;
    }
    const header = getCharacterHeaderInContainer(container);
    const cardRect = container.getBoundingClientRect();
    const headerRect = header?.getBoundingClientRect?.() || cardRect;

    // In the current UI, only the selected character owns the large ProseMirror
    // editor. Other cards are compact previews. Clicking the visible prompt
    // preview (not the reorder/check/trash buttons) selects that card.
    // Hit-testing with document.elementFromPoint only works for coordinates
    // inside the current viewport, so it returned null whenever the card was
    // scrolled out of view or the tab was in the background. Resolve the same
    // target structurally instead.
    if (attempt === 1 || attempt === 2) {
      const wanted = headerRect.bottom + (attempt === 1 ? 34 : 58);
      // Keep the old horizontal clamp: only the LEFT part of the card body is
      // eligible, and never a button. The right-hand column holds the trash and
      // reorder controls, and clicking those mid-run would delete a character.
      const maxLeft = Math.min(
        cardRect.right - 28,
        cardRect.left + Math.max(42, Math.min(92, cardRect.width * 0.24)),
      );
      const atPoint = Array.from(container.querySelectorAll("*"))
        .filter((element) => !element.closest(`#${HOST_ID}`))
        .filter((element) => !element.matches("button,[role='button'],input,select,svg,path"))
        .filter((element) => !element.closest("button,[role='button']"))
        .filter(isRenderedControl)
        .map((element) => ({ element, rect: element.getBoundingClientRect() }))
        .filter(({ rect }) => rect.top >= headerRect.bottom - 4
          && rect.left <= maxLeft
          && rect.right >= cardRect.left)
        .sort((a, b) => Math.abs(a.rect.top - wanted) - Math.abs(b.rect.top - wanted))[0]?.element;
      if (atPoint && container.contains(atPoint)) {
        return atPoint;
      }
    }

    const broadClickable = Array.from(container.querySelectorAll("[role='button'],[tabindex]"))
      .filter((element) => !element.closest(`#${HOST_ID}`))
      .filter(isVisible)
      .filter((element) => {
        const rect = element.getBoundingClientRect();
        const label = accessibleControlText(element);
        // Exclude the small header controls (move up/down, enable) and trash.
        if (/delete|remove|trash|삭제|undesired|prompt/i.test(label)) {
          return false;
        }
        if (rect.width < 42 && rect.height < 42 && rect.left > cardRect.left + cardRect.width * 0.68) {
          return false;
        }
        return true;
      })
      .sort((a, b) => {
        const ar = a.getBoundingClientRect();
        const br = b.getBoundingClientRect();
        return (br.width * br.height) - (ar.width * ar.height);
      })[0] || null;

    const targets = [
      header?.closest("[role='button'],[tabindex]"),
      header,
      header?.parentElement,
      broadClickable,
      container,
    ].filter((target, pos, list) => target && list.indexOf(target) === pos);
    return targets[attempt] || targets[targets.length - 1] || null;
  }

  // Current NovelAI collapses every character card except the selected one:
  // the editors are wrapped in a display:none div and the card instead shows a
  // preview BUTTON (a direct child of the card) with the prompt text. Clicking
  // that button expands the card. It is the only safe button to click: the
  // header buttons are move/duplicate/delete/toggle.
  function characterPreviewButton(container) {
    if (!(container instanceof Element)) {
      return null;
    }
    return Array.from(container.children)
      .filter((child) => child.tagName === "BUTTON")
      .filter((button) => !button.disabled)
      .find(isRenderedControl) || null;
  }

  function readCharacterPreviewText(container) {
    const button = characterPreviewButton(container);
    return button ? String(button.textContent || "").replace(/\u00a0/g, " ").trim() : "";
  }

  async function ensureCharacterExpandedAt(index) {
    // Prompt writing does not require locating the trash button. The previous
    // implementation used the selected card's icon-only control as proof of
    // selection, but NovelAI reuses that icon for prompt/position actions. That
    // made queue startup spend many seconds retrying every Character card.
    let resolved = await waitForCharacterEditorAt(index, 1);
    if (resolved.editor) {
      return resolved;
    }

    // Cap: 5 click targets x 6 polls x 100 ms = 3 s per card at most. The old
    // 7 x 14 x 100 ms (~10 s per card, per prompt AND per negative) is what made
    // "프롬프트 적용 중" hang for a minute when a card never exposed its editor.
    // Collapsed card: click its preview button.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const container = getCharacterContainers()[index];
      const preview = characterPreviewButton(container);
      if (!preview) {
        break;
      }
      try {
        container.scrollIntoView({ block: "nearest", inline: "nearest" });
      } catch (error) {
        void error;
      }
      clickControlLikeUser(preview);
      resolved = await waitForCharacterEditorAt(index, 10);
      if (resolved.editor) {
        logEvent("info", `캐릭터 ${index + 1} 접힌 카드를 펼침`);
        return resolved;
      }
    }

    logEvent("warn", `캐릭터 ${index + 1} 편집기가 바로 보이지 않음 → 카드 클릭으로 활성화 시도`);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const container = getCharacterContainers()[index];
      if (!container) {
        break;
      }
      const target = getCharacterActivationTarget(container, attempt);
      if (!target) {
        continue;
      }
      clickControlLikeUser(target);
      resolved = await waitForCharacterEditorAt(index, 6);
      if (resolved.editor) {
        return resolved;
      }
    }
    return resolved;
  }

  function getCharacterSurface(container) {
    if (!(container instanceof Element)) {
      return null;
    }
    return container.closest('.image-gen-character-prompts,.settings-panel,.mobile-tray-contents') || container.parentElement || null;
  }

  function getCharacterContainersInSurface(surface) {
    if (!(surface instanceof Element) || !surface.isConnected) {
      return [];
    }
    const indexed = new Map();
    for (const element of surface.querySelectorAll('.character-prompt-input,[class*="character-prompt-input-"]')) {
      if (element.closest(`#${HOST_ID}`)) {
        continue;
      }
      const className = Array.from(element.classList || [])
        .find((name) => /^character-prompt-input-\d+$/.test(name));
      const match = className && /-(\d+)$/.exec(className);
      const index = match ? Number.parseInt(match[1], 10) : Number.NaN;
      if (Number.isFinite(index) && !indexed.has(index)) {
        indexed.set(index, element);
      }
    }
    return Array.from(indexed.entries())
      .sort((a, b) => a[0] - b[0])
      .map((entry) => entry[1]);
  }

  function exactCharacterTrashButton(container) {
    if (!(container instanceof Element)) {
      return null;
    }
    const characterRoot = container.matches('.character-prompt-input,[class*="character-prompt-input-"]')
      ? container
      : container.closest('.character-prompt-input,[class*="character-prompt-input-"]')
        || container.querySelector('.character-prompt-input,[class*="character-prompt-input-"]');
    if (!(characterRoot instanceof Element)) {
      return null;
    }

    // NovelAI trash control: an icon-only header button whose icon is the
    // styled-component "…-33" (the component prefix is a build hash that
    // changes: sc-7d0727b8-33 before, sc-e95dc911-33 now, and the icon
    // shrank from 16px to 14px). Match the stable suffix, not the hash.
    const buttons = Array.from(characterRoot.querySelectorAll('button'))
      .filter((button) => !button.closest(`#${HOST_ID}`))
      .filter((button) => !button.disabled && button.getAttribute('aria-disabled') !== 'true')
      .filter(isRenderedControl);
    const labeled = buttons.find((button) => /delete|remove|trash|삭제/i.test(accessibleControlText(button)));
    if (labeled) {
      return labeled;
    }
    const TRASH_ICON_CLASS = /^sc-[0-9a-z]+-33$/i;
    for (const button of buttons) {
      if (accessibleControlText(button)) {
        continue;
      }
      const icon = Array.from(button.children).find((child) => Array.from(child.classList || []).some((name) => TRASH_ICON_CLASS.test(name)));
      if (!icon) {
        continue;
      }
      const style = getComputedStyle(icon);
      const rect = icon.getBoundingClientRect();
      const width = Number.parseFloat(style.width) || rect.width;
      const height = Number.parseFloat(style.height) || rect.height;
      if (width >= 10 && width <= 20 && height >= 10 && height <= 20) {
        return button;
      }
    }
    return null;
  }

  async function activateCharacterForDeletion(index, surface) {
    for (let attempt = 0; attempt < 9; attempt += 1) {
      const containers = getCharacterContainersInSurface(surface);
      const container = containers[index];
      if (!container) {
        return { container: null, button: null };
      }
      const existing = exactCharacterTrashButton(container);
      if (existing) {
        return { container, button: existing };
      }
      const target = getCharacterActivationTarget(container, attempt)
        || getCharacterHeaderInContainer(container)
        || container;
      clickControlLikeUser(target);
      await delay(140);
    }
    const container = getCharacterContainersInSurface(surface)[index] || null;
    return { container, button: exactCharacterTrashButton(container) };
  }

  function findCharacterDeleteConfirmationButton() {
    const scopes = Array.from(document.querySelectorAll('[role="dialog"], [aria-modal="true"]'))
      .filter(isVisible);
    for (const scope of scopes) {
      const button = Array.from(scope.querySelectorAll("button,[role='button']"))
        .filter(isRenderedControl)
        .filter((element) => !element.closest(`#${HOST_ID}`))
        .find((element) => {
          const label = accessibleControlText(element);
          return /delete|remove|confirm|yes|삭제|지우기|확인/i.test(label)
            && !/cancel|no|취소|아니/i.test(label);
        });
      if (button) {
        return button;
      }
    }
    return null;
  }

  async function waitForCharacterCountBelow(before, surface, attempts = 36) {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      await delay(120);
      const sameSurfaceCount = getCharacterContainersInSurface(surface).length;
      if (sameSurfaceCount < before) {
        return true;
      }
      if ((!surface || !surface.isConnected) && getCharacterContainers().length < before) {
        return true;
      }
    }
    return false;
  }

  async function removeLastCharacterBox(surface) {
    const beforeContainers = getCharacterContainersInSurface(surface);
    const before = beforeContainers.length;
    if (!before) {
      return true;
    }

    const lastIndex = before - 1;
    const initialContainer = beforeContainers[lastIndex];
    try {
      initialContainer.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    } catch (error) {
      void error;
    }
    await delay(100);

    const activated = await activateCharacterForDeletion(lastIndex, surface);
    const button = activated.button;
    if (!button || !activated.container?.contains(button)) {
      setStatus(`Character ${before}에서 휴지통 버튼을 찾지 못했어요. (NovelAI UI 변경 가능성)`, 'warn');
      return false;
    }

    clickControlLikeUser(button);
    if (await waitForCharacterCountBelow(before, surface, 28)) {
      return true;
    }
    if (characterCountForSurface(surface) > before) {
      // The guessed button was not the trash (e.g. a duplicate control).
      setStatus(`Character ${before} 삭제 버튼 추정이 틀렸어요. 카드가 늘어났으니 확인해 주세요.`, 'warn');
      logEvent('error', '휴지통으로 추정한 버튼이 카드를 늘림');
      return false;
    }

    const confirmation = findCharacterDeleteConfirmationButton();
    if (confirmation) {
      clickControlLikeUser(confirmation);
      if (await waitForCharacterCountBelow(before, surface, 28)) {
        return true;
      }
    }

    setStatus(`Character ${before} 휴지통을 눌렀지만 삭제가 반영되지 않았어요.`, 'warn');
    return false;
  }

  async function resetCharacterBoxes(surface) {
    let guard = 0;
    while (getCharacterContainersInSurface(surface).length > 0 && guard < 16) {
      const before = getCharacterContainersInSurface(surface).length;
      noteProgress(`캐릭터 전체 삭제 중: ${before}개 남음`);
      const removed = await removeLastCharacterBox(surface);
      if (!removed) {
        return false;
      }
      guard += 1;
      await delay(180);
    }
    return getCharacterContainersInSurface(surface).length === 0;
  }

  // NOTE: always measure with characterCountForSurface(). Measuring with
  // getCharacterContainersInSurface() returns [] when `surface` is null, so the
  // add loop never saw its own additions and kept clicking "add character".
  async function addMissingCharacterBoxes(segments, surface) {
    let count = characterCountForSurface(surface);
    let guard = 0;
    while (count < segments.length && guard < 16) {
      const added = await clickAddCharacterBox(segments[count] || '', surface);
      const next = characterCountForSurface(surface);
      if (!added || next <= count) {
        return false;
      }
      count = next;
      guard += 1;
    }
    return count === segments.length;
  }

  async function trimCharacterBoxesTo(targetCount, surface) {
    let guard = 0;
    while (characterCountForSurface(surface) > targetCount && guard < 16) {
      const before = characterCountForSurface(surface);
      noteProgress(`캐릭터 카드 정리 중: ${before}개 → ${targetCount}개`);
      const removed = await removeLastCharacterBox(surface);
      if (!removed || characterCountForSurface(surface) >= before) {
        return false;
      }
      guard += 1;
    }
    return characterCountForSurface(surface) <= targetCount;
  }

  async function ensureCharacterCardLayout(segments) {
    const targetCount = segments.length;
    const currentContainers = getCharacterContainers();
    const surface = getCharacterSurface(currentContainers[0])
      || characterSectionsOnPage().find(isVisible)
      || Array.from(document.querySelectorAll('.settings-panel,.mobile-tray-contents')).find(isVisible)
      || null;

    // Keep every card that can be reused. Deleting all cards and recreating them
    // on every queue item forced a full retype of every character prompt (and a
    // long delete/create animation per card), which is what made runs crawl.
    // Only the surplus is trimmed and only the shortfall is added; surviving
    // cards let setCharacterPromptText take its "already correct" fast path.
    for (let cycle = 0; cycle < 3; cycle += 1) {
      let count = characterCountForSurface(surface);
      if (count > targetCount) {
        const trimmed = await trimCharacterBoxesTo(targetCount, surface);
        if (!trimmed) {
          return false;
        }
        count = characterCountForSurface(surface);
      }
      if (count < targetCount) {
        const added = await addMissingCharacterBoxes(segments, surface);
        if (!added) {
          return false;
        }
        count = characterCountForSurface(surface);
      }
      if (count === targetCount) {
        return true;
      }
    }

    return characterCountForSurface(surface) === targetCount;
  }


  // Within `scope`, return the visible editable element that is NOT a prompt box
  // (i.e. the Undesired Content editor) and, optionally, not inside a character
  // container (for the base UC). Excludes our own panel.
  function findUcEditorInScope(scope, { excludeContainers = [] } = {}) {
    return Array.from(scope.querySelectorAll("[contenteditable]"))
      .filter((el) => el instanceof HTMLElement)
      .filter((el) => el.isContentEditable)
      .filter((el) => !el.closest(`#${HOST_ID}`))
      .filter((el) => !isPromptEditor(el))
      .filter((el) => !excludeContainers.some((c) => c.contains(el)))
      .filter(isVisible)[0] || null;
  }

  // NovelAI V4 reuses ONE box per scope and swaps its contents by tab. For a
  // character, the "Prompt" and "Undesired Content" tabs share the same wrapper
  // class (e.g. prompt-input-box-character-prompts-1), so the ONLY reliable way
  // to target the prompt vs the negative is to click the right tab first, then
  // read/write whatever box is now visible. `which` is "prompt" or "uc".
  async function revealTabInScope(scope, which, { excludeCharacterBoxes = false } = {}) {
    if (!scope) {
      return false;
    }
    const re = which === "uc" ? UC_TAB_RE : PROMPT_TAB_RE;
    const tab = findTabButton(scope, re, { excludeCharacterBoxes });
    if (tab) {
      tab.click();
      await delay(180);
      return true;
    }
    return false;
  }

  // The single visible editable box inside a character container — whatever the
  // currently active tab (Prompt or Undesired Content) is showing.
  function getCharacterBoxEditor(container) {
    if (!container) {
      return null;
    }

    const valid = (el) => el instanceof HTMLElement
      && el.isContentEditable
      && !el.closest(`#${HOST_ID}`)
      && isVisible(el);

    // Preferred selector for older/current builds that expose a stable wrapper.
    const explicit = Array.from(container.querySelectorAll(`${CHAR_WRAPPER_SELECTOR} [contenteditable]`))
      .filter(valid)[0];
    if (explicit) {
      return explicit;
    }

    // Current NovelAI can render the ProseMirror editor without the historical
    // prompt-input-box-character-prompts-N class. Once we are already scoped to
    // a single Character N card, its only visible contenteditable is the active
    // Prompt/Undesired Content editor, so class-free lookup is safe here.
    const scoped = Array.from(container.querySelectorAll("[contenteditable='true'],[contenteditable='plaintext-only'],[contenteditable]"))
      .filter(valid)[0];
    if (scoped) {
      return scoped;
    }

    // Geometry fallback: a card ancestor can be unusually shallow after a React
    // rerender. Find the editable whose vertical centre sits below this card's
    // header and above the next Character N header. Never allow the base editor.
    const root = document;
    const header = getCharacterHeaderInContainer(container);
    if (!header) {
      return null;
    }
    const headers = getCharacterHeaderElements(root);
    const index = headers.indexOf(header);
    const top = header.getBoundingClientRect().top - 4;
    const nextTop = index >= 0 && headers[index + 1]
      ? headers[index + 1].getBoundingClientRect().top - 4
      : Number.POSITIVE_INFINITY;
    const base = getBasePromptEditor();
    return Array.from(root.querySelectorAll("[contenteditable='true'],[contenteditable='plaintext-only'],[contenteditable]"))
      .filter(valid)
      .filter((el) => el !== base)
      .filter((el) => {
        const rect = el.getBoundingClientRect();
        const mid = rect.top + rect.height / 2;
        return mid > top && mid < nextTop;
      })[0] || null;
  }

  // Reveal the UC tab in `scope` if needed, write, then restore the Prompt tab.
  // The editor is resolved AFTER the tab switch so we always target the box that
  // is actually visible. Returns {ok} — never writes into a prompt editor.
  async function writeNegativeIntoScope(scope, resolveEditor, text, { excludeCharacterBoxes = false } = {}) {
    let editor = resolveEditor();
    let switchedTab = false;
    if (!editor) {
      const ucTab = findTabButton(scope, UC_TAB_RE, { excludeCharacterBoxes });
      if (ucTab) {
        ucTab.click();
        switchedTab = true;
        await delay(200);
        editor = resolveEditor();
      }
    }
    if (!editor || isPromptEditor(editor)) {
      if (switchedTab) {
        const promptTab = findTabButton(scope, PROMPT_TAB_RE, { excludeCharacterBoxes });
        if (promptTab) {
          promptTab.click();
          await delay(110);
        }
      }
      return { ok: false };
    }
    const written = await writeEditablePlainText(editor, text);
    await delay(100);
    if (switchedTab) {
      const promptTab = findTabButton(scope, PROMPT_TAB_RE, { excludeCharacterBoxes });
      if (promptTab) {
        promptTab.click();
        await delay(110);
      }
    }
    if (!written.ok) {
      setStatus(`네거티브가 정확히 입력되지 않았어요. ${describeMismatch(written.expected, written.actual)}`, "warn");
    }
    return { ok: written.ok };
  }

  // Base (image-level) UC editor: the non-prompt visible editor in the base area
  // that is not inside any character container.
  function getBaseNegativeEditor() {
    const root = getBaseArea() || document;
    // The base UC box has its own dedicated class, distinct from per-character
    // UC boxes (which reuse the character-prompt wrapper). Prefer it directly.
    const direct = Array.from(root.querySelectorAll(`${UC_SELECTOR} [contenteditable]`))
      .filter((el) => el instanceof HTMLElement)
      .filter((el) => el.isContentEditable)
      .filter((el) => !el.closest(`#${HOST_ID}`))
      .filter(isVisible)[0];
    if (direct) {
      return direct;
    }
    return findUcEditorInScope(root, { excludeContainers: getCharacterContainers() });
  }
  function getNegativePromptEditor() {
    return getBaseNegativeEditor();
  }

  async function applyBaseNegativeToNovelAi(text) {
    if (text == null || String(text).trim() === "") {
      return { ok: true, skipped: true };
    }
    const scope = getBaseArea() || document.body;
    await revealTabInScope(scope, "uc", { excludeCharacterBoxes: true });
    const editor = getBaseNegativeEditor();
    if (!editor) {
      await revealTabInScope(scope, "prompt", { excludeCharacterBoxes: true });
      setStatus("베이스 네거티브(Undesired Content) 입력란을 찾지 못해 건너뛰었어요.", "warn");
      return { ok: false };
    }
    const written = await writeEditablePlainText(editor, text);
    await delay(100);
    await revealTabInScope(scope, "prompt", { excludeCharacterBoxes: true });
    if (!written.ok) {
      setStatus(`베이스 네거티브가 정확히 입력되지 않았어요. ${describeMismatch(written.expected, written.actual)}`, "warn");
    }
    return { ok: written.ok };
  }

  function getCharacterNegativeEditor(container) {
    return findUcEditorInScope(container);
  }

  function splitCharacterBlocks(value) {
    // ASCII/full-width double semicolons are accepted. Blocks keep their
    // POSITION: an empty block in the middle is preserved so that character
    // negatives stay lined up with the character prompts. (Previously empty
    // blocks were dropped, so "prompt A ;; prompt B" with a negative for the
    // second character only silently applied that negative to character 1.)
    // Only trailing empties are trimmed.
    const parts = String(value == null ? "" : value)
      .split(/\s*(?:;;|；；)\s*/u)
      .map((part) => part.trim());
    while (parts.length && !parts[parts.length - 1]) {
      parts.pop();
    }
    return parts;
  }

  // ---------------------------------------------------------------------------
  // character blocks  <->  ";;" storage
  // ---------------------------------------------------------------------------
  // Everything is still STORED in the original ";;" form, so queues, memos and
  // exported JSON from older versions keep working unchanged. The UI just shows
  // that string as a list of [prompt, negative] blocks.
  function charBlocksFromStrings(promptText, negativeText) {
    const prompts = splitCharacterBlocks(promptText);
    const negatives = splitCharacterBlocks(negativeText);
    const count = Math.max(prompts.length, negatives.length);
    const blocks = [];
    for (let i = 0; i < count; i += 1) {
      blocks.push({ prompt: prompts[i] || "", negative: negatives[i] || "" });
    }
    return blocks;
  }

  function charBlocksToStrings(blocks) {
    const list = Array.isArray(blocks) ? blocks : [];
    const trimmed = list.map((block) => ({
      prompt: String(block?.prompt || "").trim(),
      negative: String(block?.negative || "").trim(),
    }));
    while (trimmed.length && !trimmed[trimmed.length - 1].prompt && !trimmed[trimmed.length - 1].negative) {
      trimmed.pop();
    }
    // A character with no prompt is never created in NovelAI, so a trailing
    // block that only has a negative would show in the panel but do nothing.
    // Drop it, so what the editor shows is what actually runs. (Kept when NO
    // block has a prompt at all — that is the "negatives only, use the current
    // NovelAI characters" case.)
    if (trimmed.some((block) => block.prompt)) {
      while (trimmed.length && !trimmed[trimmed.length - 1].prompt) {
        trimmed.pop();
      }
    }
    // Each column drops its own trailing empties, so a character with no
    // negative never leaves a dangling " ;; " in the stored string. Interior
    // gaps are kept because they carry position.
    const joinOrEmpty = (input) => {
      const values = input.slice();
      while (values.length && !values[values.length - 1]) {
        values.pop();
      }
      return values.length ? values.join(" ;; ") : "";
    };
    return {
      prompt: joinOrEmpty(trimmed.map((block) => block.prompt)),
      negative: joinOrEmpty(trimmed.map((block) => block.negative)),
    };
  }


  // ---------------------------------------------------------------------------
  // Shared prompt editor: [베이스 | 캐릭터 1 | 캐릭터 2 | +] tabs, one big text
  // box, and a "네거티브" disclosure. Used by 바로 생성, 대기열 and 메모 so the
  // three screens edit prompts the same way.
  //
  // Like the old block editor, the four textareas passed in stay in the DOM
  // (hidden) as the single source of truth, in the original ";;" form. Writes go
  // back through them with a bubbling "input" event, so every existing reader
  // (queue item save, memo draft, settings save, JSON export) keeps working.
  // Assigning `.value` from elsewhere redraws the editor.
  // ---------------------------------------------------------------------------
  function attachPromptEditor(fields, options = {}) {
    const { base, baseNeg, char, charNeg } = fields || {};
    if (!char || !charNeg || char.dataset.iasPe === "on") {
      return null;
    }
    const {
      showBase = true,
      showChars = true,
      basePlaceholder = "비우면 NovelAI에 있는 값을 그대로 써요",
      charPlaceholder = "예: girl, black hair, long hair",
      baseNote = () => "",
      rows = 6,
      tourTarget = "",
    } = options;
    const sources = [base, baseNeg, char, charNeg].filter(Boolean);
    for (const field of sources) {
      field.dataset.iasPe = "on";
      field.hidden = true;
      field.style.display = "none";
    }
    const nativeValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value");
    let syncing = false;
    let disabled = false;
    let active = showBase && base ? "base" : "c0";
    let negOpen = null; // null = follow content
    let blocks = [];

    const root = document.createElement("div");
    root.className = "ias-pe";
    root.innerHTML = `
      <div class="ias-pe-bar">
        <div class="ias-seg ias-pe-tabs" role="tablist" aria-label="프롬프트 부분"${tourTarget ? ` data-tour="${tourTarget}"` : ""}></div>
        <span class="ias-pe-tools">
        <span class="ias-pe-note"></span>
        <span class="ias-pe-move" hidden>
          <button type="button" class="ias-icon-btn" data-pe-move="-1" aria-label="이 캐릭터를 앞으로" title="앞으로 (캐릭터 순서)">‹</button>
          <button type="button" class="ias-icon-btn" data-pe-move="1" aria-label="이 캐릭터를 뒤로" title="뒤로 (캐릭터 순서)">›</button>
        </span>
        <button type="button" class="ias-pe-remove" hidden>캐릭터 빼기</button>
        </span>
      </div>
      <textarea class="ias-input ias-pe-text" rows="${rows}" aria-label="프롬프트"></textarea>
      <button type="button" class="ias-pe-neg-toggle" aria-expanded="false"><span class="ias-pe-chev" aria-hidden="true"></span><span class="ias-pe-neg-label">네거티브</span></button>
      <textarea class="ias-input ias-pe-neg" rows="2" aria-label="네거티브" placeholder="비어 있음" hidden></textarea>
    `;
    const tabsEl = root.querySelector(".ias-pe-tabs");
    const noteEl = root.querySelector(".ias-pe-note");
    const removeEl = root.querySelector(".ias-pe-remove");
    const moveEl = root.querySelector(".ias-pe-move");
    const moveButtons = Array.from(moveEl.querySelectorAll("[data-pe-move]"));
    const textEl = root.querySelector(".ias-pe-text");
    const negToggle = root.querySelector(".ias-pe-neg-toggle");
    const negLabel = root.querySelector(".ias-pe-neg-label");
    const negEl = root.querySelector(".ias-pe-neg");
    char.parentNode.insertBefore(root, char);

    function readBlocks() {
      blocks = charBlocksFromStrings(nativeValue.get.call(char), nativeValue.get.call(charNeg));
      if (!blocks.length) {
        blocks = [{ prompt: "", negative: "" }];
      }
    }
    function charIndex() {
      return active.startsWith("c") ? Number(active.slice(1)) || 0 : -1;
    }
    function currentPart() {
      if (active === "base") {
        return { text: base ? nativeValue.get.call(base) : "", neg: baseNeg ? nativeValue.get.call(baseNeg) : "" };
      }
      const block = blocks[charIndex()] || { prompt: "", negative: "" };
      return { text: block.prompt, neg: block.negative };
    }
    function genderLabel(prompt) {
      if (!String(prompt || "").trim()) {
        return "";
      }
      const gender = inferCharacterGender(prompt);
      return gender === "male" ? "남자" : gender === "female" ? "여자" : "";
    }
    function countTags(value) {
      return String(value || "").split(",").filter((part) => part.trim()).length;
    }
    function writeSource(field, value) {
      if (!field) {
        return;
      }
      syncing = true;
      nativeValue.set.call(field, value);
      syncing = false;
      field.dispatchEvent(new Event("input", { bubbles: true }));
    }
    function writeBlocks() {
      const strings = charBlocksToStrings(blocks);
      if (nativeValue.get.call(char) !== strings.prompt) {
        writeSource(char, strings.prompt);
      }
      if (nativeValue.get.call(charNeg) !== strings.negative) {
        writeSource(charNeg, strings.negative);
      }
    }

    function renderTabs() {
      const parts = [];
      if (showBase && base) {
        parts.push({ key: "base", label: "베이스", filled: Boolean(nativeValue.get.call(base).trim() || (baseNeg && nativeValue.get.call(baseNeg).trim())) });
      }
      if (showChars) {
        blocks.forEach((block, i) => {
          parts.push({ key: `c${i}`, label: `캐릭터 ${i + 1}`, filled: Boolean(block.prompt.trim() || block.negative.trim()) });
        });
      }
      if (!parts.some((part) => part.key === active)) {
        active = parts[0]?.key || "base";
      }
      const canDrag = !disabled && blocks.length > 1;
      tabsEl.innerHTML = parts.map((part) => `<button type="button" role="tab" class="ias-seg-btn" data-pe-tab="${part.key}" aria-selected="${part.key === active}"${part.filled ? ' data-filled="true"' : ""}${canDrag && part.key !== "base" ? ' draggable="true" title="끌어서 캐릭터 순서 바꾸기"' : ""}>${part.label}</button>`).join("")
        + (showChars ? '<button type="button" class="ias-seg-btn ias-pe-add" data-pe-add aria-label="캐릭터 추가" title="캐릭터 추가">+</button>' : "");
    }

    function render({ keepText = false } = {}) {
      renderTabs();
      const part = currentPart();
      if (!keepText) {
        textEl.value = part.text;
      }
      if (document.activeElement !== negEl && root.getRootNode()?.activeElement !== negEl) {
        negEl.value = part.neg;
      }
      const index = charIndex();
      textEl.placeholder = active === "base" ? basePlaceholder : (index === 0 && blocks.length === 1 ? `${charPlaceholder} · 비우면 NovelAI 캐릭터 그대로` : charPlaceholder);
      noteEl.textContent = active === "base" ? (baseNote() || "") : genderLabel(blocks[index]?.prompt);
      removeEl.hidden = !(index >= 0 && blocks.length > 1);
      moveEl.hidden = removeEl.hidden;
      moveButtons[0].disabled = disabled || index <= 0;
      moveButtons[1].disabled = disabled || index < 0 || index >= blocks.length - 1;
      const open = negOpen == null ? Boolean(part.neg.trim()) : negOpen;
      negEl.hidden = !open;
      negToggle.setAttribute("aria-expanded", String(open));
      const tags = countTags(part.neg);
      negLabel.textContent = tags ? `네거티브 · ${tags}개` : "네거티브";
      for (const el of [textEl, negEl, removeEl, negToggle]) {
        el.disabled = disabled;
      }
      tabsEl.querySelectorAll("button").forEach((button) => {
        button.disabled = disabled && !button.dataset.peTab;
      });
    }

    function partFilled(key) {
      if (key === "base") {
        return Boolean((base && nativeValue.get.call(base).trim()) || (baseNeg && nativeValue.get.call(baseNeg).trim()));
      }
      const block = blocks[Number(key.slice(1)) || 0];
      return Boolean(block && (block.prompt.trim() || block.negative.trim()));
    }

    function refresh() {
      readBlocks();
      // New content loaded from outside (another memo, another queue item): open
      // the first part that has something in it instead of an empty tab.
      const keys = [...(showBase && base ? ["base"] : []), ...(showChars ? blocks.map((_, i) => `c${i}`) : [])];
      if (!keys.includes(active) || (!partFilled(active) && keys.some(partFilled))) {
        active = keys.find(partFilled) || keys[0] || "base";
        negOpen = null;
      }
      render();
    }

    function select(key) {
      active = key;
      negOpen = null;
      render();
    }

    tabsEl.addEventListener("click", (event) => {
      const tab = event.target.closest("[data-pe-tab]");
      if (tab) {
        select(tab.dataset.peTab);
        return;
      }
      if (event.target.closest("[data-pe-add]") && !disabled) {
        blocks.push({ prompt: "", negative: "" });
        active = `c${blocks.length - 1}`;
        negOpen = null;
        render();
        textEl.focus();
      }
    });
    // Character order: drag a character tab onto another, or use ‹ ›. The
    // prompt and its negative always move together.
    function moveCharacter(from, to) {
      if (disabled || from === to || from < 0 || to < 0 || from >= blocks.length || to >= blocks.length) {
        return;
      }
      const [moved] = blocks.splice(from, 1);
      blocks.splice(to, 0, moved);
      active = `c${to}`;
      writeBlocks();
      render();
    }
    moveEl.addEventListener("click", (event) => {
      const button = event.target.closest("[data-pe-move]");
      if (button) {
        const index = charIndex();
        moveCharacter(index, index + Number(button.dataset.peMove));
      }
    });
    let dragFrom = -1;
    tabsEl.addEventListener("dragstart", (event) => {
      const tab = event.target.closest?.('[data-pe-tab^="c"]');
      if (!tab || disabled) {
        return;
      }
      dragFrom = Number(tab.dataset.peTab.slice(1));
      tab.dataset.dragging = "true";
      try {
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("text/plain", tab.dataset.peTab);
      } catch (error) {
        void error;
      }
    });
    const clearDrop = () => tabsEl.querySelectorAll("[data-drop]").forEach((el) => delete el.dataset.drop);
    tabsEl.addEventListener("dragover", (event) => {
      const tab = event.target.closest?.('[data-pe-tab^="c"]');
      if (dragFrom < 0 || !tab) {
        return;
      }
      event.preventDefault();
      clearDrop();
      const to = Number(tab.dataset.peTab.slice(1));
      if (to !== dragFrom) {
        tab.dataset.drop = to < dragFrom ? "before" : "after";
      }
    });
    tabsEl.addEventListener("drop", (event) => {
      const tab = event.target.closest?.('[data-pe-tab^="c"]');
      if (dragFrom < 0 || !tab) {
        return;
      }
      event.preventDefault();
      const from = dragFrom;
      dragFrom = -1;
      moveCharacter(from, Number(tab.dataset.peTab.slice(1)));
    });
    tabsEl.addEventListener("dragend", () => {
      dragFrom = -1;
      clearDrop();
      tabsEl.querySelectorAll("[data-dragging]").forEach((el) => delete el.dataset.dragging);
    });

    removeEl.addEventListener("click", () => {
      const index = charIndex();
      if (index < 0 || blocks.length < 2 || disabled) {
        return;
      }
      blocks.splice(index, 1);
      active = `c${Math.max(0, index - 1)}`;
      writeBlocks();
      render();
    });
    negToggle.addEventListener("click", () => {
      negOpen = negEl.hidden;
      render({ keepText: true });
      if (negOpen) {
        negEl.focus();
      }
    });

    function splitTyped(value) {
      // Typing or pasting ";;" in a character box splits it into more characters,
      // the same as the old one-line ";;" input.
      const pieces = value.split(/\s*(?:;;|；；)\s*/u);
      if (pieces.length < 2) {
        return false;
      }
      const index = charIndex();
      const current = blocks[index] || { prompt: "", negative: "" };
      const added = pieces.slice(1).map((prompt) => ({ prompt: prompt.trim(), negative: "" }));
      blocks.splice(index, 1, { ...current, prompt: pieces[0].trim() }, ...added);
      active = `c${index + added.length}`;
      writeBlocks();
      render();
      textEl.focus();
      textEl.setSelectionRange?.(textEl.value.length, textEl.value.length);
      return true;
    }

    textEl.addEventListener("input", (event) => {
      event.stopPropagation();
      const value = textEl.value;
      if (active === "base") {
        writeSource(base, value);
      } else {
        if (showChars && splitTyped(value)) {
          return;
        }
        const index = charIndex();
        blocks[index] = { ...(blocks[index] || { negative: "" }), prompt: value };
        writeBlocks();
      }
      renderTabs();
      if (active !== "base") {
        noteEl.textContent = genderLabel(value);
      }
    });
    negEl.addEventListener("input", (event) => {
      event.stopPropagation();
      const value = negEl.value;
      if (active === "base") {
        writeSource(baseNeg, value);
      } else {
        const index = charIndex();
        blocks[index] = { ...(blocks[index] || { prompt: "" }), negative: value };
        writeBlocks();
      }
      renderTabs();
      const tags = countTags(value);
      negLabel.textContent = tags ? `네거티브 · ${tags}개` : "네거티브";
    });
    for (const el of [textEl, negEl]) {
      el.addEventListener("change", (event) => {
        event.stopPropagation();
        const target = active === "base" ? (el === textEl ? base : baseNeg) : (el === textEl ? char : charNeg);
        target?.dispatchEvent(new Event("change", { bubbles: true }));
      });
    }

    for (const field of sources) {
      try {
        Object.defineProperty(field, "value", {
          configurable: true,
          enumerable: true,
          get() {
            return nativeValue.get.call(this);
          },
          set(next) {
            nativeValue.set.call(this, next);
            if (!syncing) {
              refresh();
            }
          },
        });
      } catch (error) {
        void error;
      }
    }

    const api = {
      root,
      refresh,
      select,
      focus: () => textEl.focus(),
      active: () => active,
      setDisabled(next) {
        disabled = Boolean(next);
        render({ keepText: true });
      },
    };
    refresh();
    return api;
  }

  // Apply per-character negatives to each character's own Undesired Content box.
  // ";;" separates negatives per character; a single block applies to character 1.
  // `slots` is how many character cards this item OWNS. Character cards are now
  // reused between queue items instead of being deleted and recreated, so an
  // owned card whose block has no negative must be CLEARED — otherwise the
  // previous item's negative silently keeps applying.
  async function applyCharacterNegativesToNovelAi(text, { slots = 0 } = {}) {
    const hasText = text != null && String(text).trim() !== "";
    if (!hasText && slots <= 0) {
      return { ok: true, skipped: true };
    }
    const segments = splitCharacterBlocks(text);
    const containers = getCharacterContainers();
    if (!containers.length) {
      if (hasText) {
        setStatus("캐릭터 박스를 찾지 못해 캐릭터 네거티브를 건너뛰었어요.", "warn");
        return { ok: false };
      }
      return { ok: true, skipped: true };
    }
    const wanted = Math.max(segments.length, slots);
    const count = Math.min(wanted, containers.length);
    if (wanted > containers.length) {
      setStatus(`캐릭터 네거티브 ${wanted}개 중 ${containers.length}개만 적용해요. (캐릭터 카드가 부족)`, "warn");
    }
    let applied = 0;
    for (let i = 0; i < count; i += 1) {
      const seg = segments[i] || "";
      if (!seg && i >= slots) {
        continue;
      }
      const expanded = await ensureCharacterExpandedAt(i);
      let container = expanded.container;
      if (!container) {
        continue;
      }
      await revealTabInScope(container, "uc");
      container = getCharacterContainers()[i] || container;
      const editor = getCharacterBoxEditor(container);
      if (editor) {
        const written = await writeEditablePlainText(editor, seg);
        await delay(100);
        if (written.ok) {
          applied += 1;
        } else {
          setStatus(`캐릭터 ${i + 1} 네거티브가 정확히 입력되지 않았어요. ${describeMismatch(written.expected, written.actual)}`, "warn");
        }
      }
      await revealTabInScope(container, "prompt");
    }
    if (!applied && hasText) {
      setStatus("캐릭터 네거티브를 적용하지 못했어요. (캐릭터 박스의 Undesired Content 칸을 못 찾음)", "warn");
      return { ok: false };
    }
    return { ok: true, applied };
  }

  // Write each character segment into NovelAI's real character prompt box,
  // adding boxes when needed. This is what makes the queue actually drive the
  // output (the "|" merge into the base box is ignored once character boxes exist).
  async function applyCharacterPromptsToNovelAi(segments) {
    if (!segments.length) {
      return { ok: true, applied: 0, requested: 0 };
    }

    // Keep the card count/order/gender aligned with the ;; blocks. A stale
    // Female card for a 1boy block is deleted and recreated as Male.
    const layoutStartedAt = Date.now();
    let layoutReady = await ensureCharacterCardLayout(segments);
    let containers = getCharacterContainers();
    logEvent(layoutReady ? "info" : "warn", `캐릭터 카드 정렬 ${layoutReady ? "완료" : "실패"} · 현재 ${containers.length}개 / 필요 ${segments.length}개 · ${((Date.now() - layoutStartedAt) / 1000).toFixed(1)}초`);
    if (!layoutReady || containers.length !== segments.length) {
      // Most failures here are a transient NovelAI rerender rather than a real
      // problem, and they were common enough to kill whole queue runs. Let the
      // UI settle and try once more before giving up.
      setStatus("캐릭터 카드를 다시 맞추는 중이에요…", "warn");
      await delay(700);
      layoutReady = await ensureCharacterCardLayout(segments);
      containers = getCharacterContainers();
    }
    if (containers.length !== segments.length) {
      // Generating with the wrong number of characters produces images the user
      // did not ask for, so this still stops rather than guessing.
      return {
        ok: false,
        error: `캐릭터 카드 수를 맞추지 못했어요. 현재 ${containers.length}개 / 필요한 ${segments.length}개예요. 잘못된 캐릭터 구성으로는 생성하지 않아요.`,
      };
    }

    if (!containers.length) {
      // Never merge character text into Base Prompt. NovelAI ignores that legacy
      // pipe form when Character Prompts are enabled, and it visibly contaminates
      // the user's base prompt. Stop with a clear error instead.
      return {
        ok: false,
        error: "캐릭터 카드는 생성됐지만 Character N 영역을 찾지 못했어요. 페이지를 새로고침한 뒤 다시 실행해 주세요.",
      };
    }

    const count = Math.min(segments.length, containers.length);
    let applied = 0;
    const failures = [];
    for (let i = 0; i < count; i += 1) {
      const expanded = await ensureCharacterExpandedAt(i);
      let container = expanded.container;
      if (!container) {
        failures.push(`캐릭터 ${i + 1}: 카드를 찾지 못함`);
        continue;
      }
      await revealTabInScope(container, "prompt");
      // Tab switching may rerender the card, so resolve it again by ordinal.
      const current = await waitForCharacterEditorAt(i, 10);
      const editor = current.editor;
      if (!editor) {
        failures.push(`캐릭터 ${i + 1}: 입력 칸(에디터)을 펼치지 못함`);
        continue;
      }
      const writeStartedAt = Date.now();
      const written = await setCharacterPromptText(editor, segments[i]);
      logEvent(written ? "info" : "error", `캐릭터 ${i + 1} 프롬프트 쓰기 ${written ? "성공" : "실패"} · ${((Date.now() - writeStartedAt) / 1000).toFixed(1)}초`,
        written ? undefined : describeMismatch(segments[i], readEditableText(editor), 200));
      if (!written) {
        failures.push(`캐릭터 ${i + 1}: ${describeMismatch(segments[i], readEditableText(editor))}`);
      } else {
        applied += 1;
      }
      await delay(100);
    }
    // Second pass: if NovelAI re-rendered a card with different text (the
    // write went to another character), write that card again.
    if (!failures.length) {
      await delay(250);
      for (let i = 0; i < count; i += 1) {
        const again = await waitForCharacterEditorAt(i, 1);
        const shown = again.editor
          ? readEditableText(again.editor)
          : readCharacterPreviewText(getCharacterContainers()[i]);
        const want = normalizedPromptTags(segments[i]).join("|");
        if (normalizedPromptTags(shown).join("|") === want) continue;
        if (!again.editor && !shown) continue; // nothing readable; don't guess
        logEvent("warn", `캐릭터 ${i + 1} 내용이 기대와 다름 → 다시 입력`, describeMismatch(segments[i], shown, 120));
        const reopened = await ensureCharacterExpandedAt(i);
        if (reopened.container) await revealTabInScope(reopened.container, "prompt");
        const retry = await waitForCharacterEditorAt(i, 5);
        if (!retry.editor || !(await setCharacterPromptText(retry.editor, segments[i]))) {
          failures.push(`캐릭터 ${i + 1}: 재입력 실패`);
          applied -= 1;
        }
      }
    }
    if (failures.length) {
      setStatus(`캐릭터 프롬프트 ${applied}/${count}개 적용 · ${failures.join(" · ")}`, "warn");
    }
    if (!applied) {
      // This used to return ok:false with no message, which the queue rendered
      // as "알 수 없는 오류". Say what actually happened.
      return {
        ok: false,
        applied,
        requested: segments.length,
        error: `캐릭터 프롬프트를 하나도 적용하지 못했어요. ${failures.join(" · ") || "원인 불명"}`,
      };
    }
    return { ok: true, applied, requested: segments.length };
  }


  // Apply a queue item's base prompt (to the base box) and character prompt
  // (to the character boxes) separately.
  async function applyStructuredPrompt(basePrompt, characterPrompt) {
    let base = basePrompt == null ? "" : String(basePrompt);
    let segments = splitCharacterBlocks(characterPrompt);
    // If the base prompt itself carries "|" character pipes, peel them off so the
    // base box never duplicates character content. Use them as characters only
    // when the character field is empty.
    // 이 블록 전체를 삭제하거나 주석 처리하세요.
    /*
    if (base.includes("|")) {
      const parts = base.split("|");
      base = parts[0].trim();
      const basePipes = parts.slice(1).map((part) => part.trim()).filter(Boolean);
      if (!segments.length) {
        segments = basePipes;
      }
    }
    */
    if (base.trim() !== "") {
      const baseResult = await applyPromptToNovelAi(base);
      if (!baseResult.ok) {
        return baseResult;
      }
    }
    if (segments.length) {
      const charResult = await applyCharacterPromptsToNovelAi(segments);
      if (!charResult.ok) {
        return charResult;
      }
      if (charResult.applied < charResult.requested) {
        // Some cards could not be written: generating would give the wrong
      // picture, so stop instead of silently continuing.
      return {
        ok: false,
        error: `캐릭터 ${charResult.requested}명 중 ${charResult.applied}명만 입력되어 생성하지 않았어요. (진단 로그 확인)`,
      };
      }
    }
    return { ok: true };
  }

  function findCurrentImage() {
    return Array.from(document.images)
      .filter(isVisible)
      .filter((image) => image.src && !image.src.startsWith("chrome-extension://"))
      .sort((a, b) => {
        const aRect = a.getBoundingClientRect();
        const bRect = b.getBoundingClientRect();
        return (bRect.width * bRect.height) - (aRect.width * aRect.height);
      })[0] || null;
  }

  function checkGenerationCost() {
    const genButton = findGenerateButton();
    if (!genButton) {
      return "";
    }
    const costText = (genButton.textContent || "").match(/(\d+)\s*Anlas/i)?.[1] || "";
    const numericCost = Number.parseInt(costText, 10);
    if (Number.isFinite(numericCost) && numericCost > 0) {
      return `생성 비용이 ${numericCost} Anlas예요. 비용이 0이 아니면 시작하지 않아요.`;
    }
    return "";
  }

  // iOS-style alert in the panel's shadow root (replaces the browser's own
  // alert/confirm boxes). Resolves with the chosen button's value; Esc and a
  // click outside pick the cancel button.
  let iosAlertKeyHandler = null;
  function iosAlert({ title, message = "", buttons = [{ label: "확인", value: true, primary: true }] }) {
    return new Promise((resolve) => {
      const shell = ui.shell || panelShadow?.querySelector(".ias-shell");
      if (!shell) {
        resolve(buttons.find((b) => b.primary)?.value ?? true);
        return;
      }
      const layer = document.createElement("div");
      layer.className = "ias-ios-layer";
      layer.innerHTML = `<div class="ias-ios-alert" role="alertdialog" aria-modal="true"><div class="ias-ios-body"><strong></strong><p></p></div><div class="ias-ios-buttons" data-count="${buttons.length}"></div></div>`;
      layer.querySelector("strong").textContent = title;
      const p = layer.querySelector("p");
      p.textContent = message;
      p.hidden = !message;
      const row = layer.querySelector(".ias-ios-buttons");
      const cancel = buttons.find((b) => b.cancel) || buttons[0];
      const finish = (value) => {
        layer.remove();
        if (iosAlertKeyHandler === onKey) iosAlertKeyHandler = null;
        resolve(value);
      };
      for (const b of buttons) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.textContent = b.label;
        if (b.primary) btn.dataset.primary = "true";
        if (b.destructive) btn.dataset.destructive = "true";
        btn.addEventListener("click", () => finish(b.value));
        row.append(btn);
      }
      const onKey = (event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          finish(cancel.value);
        } else if (event.key === "Enter") {
          event.preventDefault();
          event.stopPropagation();
          finish((buttons.find((b) => b.primary) || cancel).value);
        }
      };
      // Keys from inside the panel come through the key shield's hook
      // (handlePanelKeydown); the layer listener covers the no-shield case.
      iosAlertKeyHandler = onKey;
      layer.addEventListener("keydown", (event) => {
        if (iosAlertKeyHandler === onKey && !event.defaultPrevented) onKey(event);
      });
      layer.addEventListener("pointerdown", (event) => {
        if (event.target === layer) finish(cancel.value);
      });
      // Centred on the panel window when it is open, on the page otherwise.
      (!panelCollapsed && ui.card ? ui.card : shell).append(layer);
      (row.querySelector('[data-primary="true"]') || row.lastElementChild)?.focus();
    });
  }

  function runSafetyChecks({ alertUser = true } = {}) {
    if (!location.href.startsWith("https://novelai.net/image")) {
      const message = "NovelAI 이미지 페이지에서만 사용할 수 있어요.";
      setStatus(message, "warn");
      if (alertUser) {
        void iosAlert({ title: "여기서는 시작할 수 없어요", message });
      }
      return false;
    }
    const warning = checkGenerationCost();
    if (warning) {
      setStatus(warning, "warn");
      if (alertUser) {
        void iosAlert({ title: "생성을 시작하지 않았어요", message: warning });
      }
      return false;
    }
    return true;
  }

  async function playSound(filename) {
    const { volume = 0.5 } = await storageGet("sync", ["volume"]);
    const parsedVolume = Number(volume);
    const safeVolume = Number.isFinite(parsedVolume)
      ? Math.max(0, Math.min(1, parsedVolume))
      : 0.5;

    // Content-script audio is subject to the host page's autoplay policy.
    // Route playback through an extension offscreen document instead so both
    // click-triggered start sounds and asynchronous completion sounds work.
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({
        action: "playExtensionSound",
        filename,
        volume: safeVolume,
      }, (response) => {
        void chrome.runtime.lastError;
        resolve(Boolean(response?.ok));
      });
    });
  }

  // <저장 폴더>/<날짜>/<캐릭터> according to the two toggles in Settings.
  function currentSaveFolder(saveName, characterName = "", date = new Date()) {
    return Store.buildSaveFolder({
      folder: normalizeFolderInput((ui.folderInput?.value || "").trim()) || "NovelAI",
      saveName,
      characterName,
      date,
      byDate: ui.folderByDateToggle ? ui.folderByDateToggle.checked : true,
      byCharacter: ui.folderByCharToggle ? ui.folderByCharToggle.checked : true,
    });
  }


  function defaultSaveName() {
    const now = new Date();
    const stamp = [
      now.getFullYear(),
      String(now.getMonth() + 1).padStart(2, "0"),
      String(now.getDate()).padStart(2, "0"),
      String(now.getHours()).padStart(2, "0"),
      String(now.getMinutes()).padStart(2, "0"),
    ].join("");
    return `NAI_${stamp}`;
  }

  function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error || new Error("FileReader 실패"));
      reader.readAsDataURL(blob);
    });
  }

  // Turn the live <img> into a self-contained data: URL *inside the page*, while
  // the blob: URL is still alive. NovelAI revokes the previous blob when the next
  // generation starts, so passing the raw blob: URL to the background download
  // races that revocation and occasionally writes an empty file. A data: URL has
  // the bytes baked in and never goes stale.
  async function captureImageDataUrl(image) {
    // Preferred path: fetch the blob and keep the exact PNG bytes.
    try {
      const response = await fetch(image.src);
      const blob = await response.blob();
      if (blob && blob.size > 0) {
        return await blobToDataUrl(blob);
      }
    } catch (error) {
      void error;
    }
    // Fallback: re-encode via canvas (works for same-origin blob/https images).
    try {
      if (!(image.complete && image.naturalWidth > 0)) {
        try {
          await image.decode();
        } catch (decodeError) {
          void decodeError;
        }
      }
      if (image.naturalWidth > 0 && image.naturalHeight > 0) {
        const canvas = document.createElement("canvas");
        canvas.width = image.naturalWidth;
        canvas.height = image.naturalHeight;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(image, 0, 0);
        const dataUrl = canvas.toDataURL("image/png");
        // Free the (potentially multi-MB) bitmap immediately instead of waiting
        // for GC. Over a long batch this keeps the renderer's peak memory down.
        canvas.width = 0;
        canvas.height = 0;
        if (dataUrl && dataUrl.length > "data:image/png;base64,".length) {
          return dataUrl;
        }
      }
    } catch (error) {
      void error;
    }
    return null;
  }

  // An <img> qualifies as a freshly generated result only when it is fully
  // decoded, at least MIN_IMAGE_DIM on each side in its *natural* resolution
  // (so scaled-up previews are rejected), and not the one we just saved.
  function isFreshGeneratedImage(image, excludeSrc) {
    if (!image || !image.src) {
      return false;
    }
    if (excludeSrc && image.src === excludeSrc) {
      return false;
    }
    if (!image.complete) {
      return false;
    }
    return image.naturalWidth >= MIN_IMAGE_DIM && image.naturalHeight >= MIN_IMAGE_DIM;
  }

  // Roughly the size of an empty/near-blank PNG payload. Real generations are
  // far larger, so anything under this floor is treated as a failed capture.
  const MIN_DATAURL_LENGTH = 3000;

  async function maybeDownloadCurrentImage() {
    const { autoSaveEnabled = true } = await storageGet("sync", ["autoSaveEnabled"]);
    if (autoSaveEnabled === false) {
      return;
    }

    // Wait for a genuinely NEW, fully-decoded, full-resolution image. The
    // generate button can re-enable a beat before the previous image is swapped
    // out, and NovelAI briefly shows a low-res preview during the swap — both
    // would otherwise be captured as blank/duplicate files.
    const previousSrc = saveContext.lastSavedSrc;
    let image = findCurrentImage();
    for (let i = 0; i < 16; i += 1) {
      if (isFreshGeneratedImage(image, previousSrc)) {
        break;
      }
      await delay(250);
      image = findCurrentImage();
      if (image?.src && !image.complete) {
        try {
          await image.decode();
        } catch (error) {
          void error;
        }
      }
    }
    if (!isFreshGeneratedImage(image, previousSrc)) {
      // Last resort: accept any complete, full-size image even if src looks
      // unchanged, rather than silently skipping a real result.
      image = findCurrentImage();
      if (!image?.src || !image.complete || image.naturalWidth < MIN_IMAGE_DIM) {
        setStatus("자동 저장할 이미지를 찾지 못했어요.", "warn");
        return;
      }
    }

    // Capture to a data URL, retrying a few times to dodge blob/timing races.
    let dataUrl = null;
    for (let i = 0; i < 6 && !dataUrl; i += 1) {
      const candidate = await captureImageDataUrl(image);
      if (candidate && candidate.length >= MIN_DATAURL_LENGTH) {
        dataUrl = candidate;
        break;
      }
      await delay(250);
      const fresh = findCurrentImage();
      if (fresh?.src && fresh.complete && fresh.naturalWidth >= MIN_IMAGE_DIM) {
        image = fresh;
      }
    }
    if (!dataUrl) {
      setStatus("이미지를 읽지 못해 이번 저장은 건너뛰었어요.", "warn");
      return;
    }

    saveContext.lastSavedSrc = image.src;
    saveContext.counter += 1;
    const base = Store.sanitizeFileName(saveContext.baseName || defaultSaveName());
    const folder = currentSaveFolder(saveContext.baseName, saveContext.folderName);
    const fileName = `${base} (${saveContext.counter})`;
    chrome.runtime.sendMessage({
      action: "downloadImage",
      imageUrl: dataUrl,
      fileName,
      folder,
      format: effectiveFormat(),
    }, (response) => {
      const lastError = chrome.runtime.lastError;
      if (lastError) {
        logEvent("error", `다운로드 요청 실패: ${fileName}`, lastError.message);
      } else if (response && response.ok === false) {
        logEvent("error", `다운로드 거부됨: ${folder}/${fileName}.${effectiveFormat()}`, response.error);
        setStatus(`그림을 저장하지 못했어요: ${response.error || "알 수 없는 오류"}`, "warn");
      } else {
        logEvent("info", `다운로드 요청: ${response?.filename || `${folder}/${fileName}.${effectiveFormat()}`} (${image.naturalWidth}x${image.naturalHeight})`);
        if (response?.warning) {
          setStatus(`WebP로 바꾸지 못해 원래 형식으로 저장했어요. (${response.warning})`, "warn");
        }
        todaySavedCount += 1;
      }
    });
  }

  // ---------------------------------------------------------------------------
  // auto-generation engine
  // ---------------------------------------------------------------------------
  function isGenerationCancelled(shouldContinue) {
    return typeof shouldContinue === "function" && !shouldContinue();
  }

  async function clickGenerate({ shouldContinue = null, silent = false } = {}) {
    if (isGenerationCancelled(shouldContinue)) {
      return { ok: false, cancelled: true };
    }
    if (!runSafetyChecks({ alertUser: !silent })) {
      return { ok: false, error: "안전 점검에 실패했어요." };
    }
    const button = findGenerateButton();
    if (!button) {
      const message = "NovelAI 화면에서 생성(Generate) 버튼을 찾지 못했어요. 이미지 생성 페이지가 맞는지 확인해 주세요.";
      setStatus(message, "warn");
      return { ok: false, error: message };
    }
    if (button.disabled) {
      return { ok: false, error: "생성 버튼이 아직 비활성화 상태예요." };
    }
    await commitActivePageEditor();
    button.click();
    return { ok: true };
  }

  function clearAutoTimers() {
    if (autoRun.timerId) {
      clearInterval(autoRun.timerId);
      autoRun.timerId = null;
    }
    if (autoRun.timeoutId) {
      clearTimeout(autoRun.timeoutId);
      autoRun.timeoutId = null;
    }
  }

  async function stopAutoGenerate({ playAudio = false, force = false, keepQueue = false, quiet = false } = {}) {
    // If an image is currently being generated, let it finish and get saved
    // before we tear everything down — otherwise the last image is lost. A
    // second stop click (force) skips the wait and stops immediately.
    if (!force && autoRun.active && autoRun.waitingForCompletion && !autoRun.stopAfterCurrent) {
      autoRun.stopAfterCurrent = true;
      renderControls();
      setStatus("정지 대기 중 — 마지막 이미지를 저장한 뒤 정지해요. (다시 누르면 즉시 정지)", "warn");
      return { ok: true, pending: true };
    }
    return finalizeStop({ playAudio, keepQueue, quiet });
  }

  // quiet: an internal reset or a stop right after an error the user has
  // already been told about — no second, contradicting message.
  async function finalizeStop({ playAudio = false, keepQueue = false, quiet = false } = {}) {
    const wasActive = autoRun.active;
    clearAutoTimers();
    autoRun.token += 1;
    autoRun.active = false;
    syncBackgroundKeepAlive();
    autoRun.waitingForCompletion = false;
    autoRun.waitingForExistingGeneration = false;
    autoRun.stopAfterCurrent = false;
    autoRun.onComplete = null;
    // A user stop always ends the queue, even while the next item's prompts
    // are being typed. Only startAutoGenerate's own internal reset keeps it.
    if (queueRun.active && !keepQueue) {
      cancelQueueRun();
    }
    await storageSet("sync", { autoClickEnabled: false });
    renderControls();
    if (playAudio && wasActive) {
      await playSound("stop.mp3");
    }
    if (!queueRun.active && wasActive && !quiet) {
      setStatus("생성을 멈췄어요.", "ok");
    }
    return { ok: true };
  }

  async function clickForAutoRun() {
    const token = autoRun.token;
    const result = await clickGenerate({
      silent: true,
      shouldContinue: () => autoRun.active && token === autoRun.token,
    });
    if (!result.ok) {
      return result;
    }
    autoRun.count += 1;
    autoRun.waitingForCompletion = true;
    autoRun.waitingForExistingGeneration = false;
    autoRun.ignoreReadyUntil = Date.now() + 900;
    renderControls();
    if (!queueRun.active) {
      noteProgress(`생성 중: ${autoRun.count}${autoRun.target ? ` / ${autoRun.target}` : ""}`);
    }
    return result;
  }

  async function completeAutoRun() {
    const count = autoRun.completedCount || autoRun.count;
    clearAutoTimers();
    autoRun.active = false;
    syncBackgroundKeepAlive();
    autoRun.waitingForCompletion = false;
    autoRun.waitingForExistingGeneration = false;
    await storageSet("sync", { autoClickEnabled: false });
    renderControls();

    const onComplete = autoRun.onComplete;
    autoRun.onComplete = null;
    if (typeof onComplete === "function") {
      onComplete({ count });
      return;
    }
    await playSound("stop.mp3");
    chrome.runtime.sendMessage({ action: "showCompletionNotification", count }, () => {
      void chrome.runtime.lastError;
    });
    setStatus(`다 생성했어요. (${count}장)`, "ok");
  }

  async function scheduleNextAutoClick({ afterExistingGeneration = false } = {}) {
    const token = autoRun.token;
    const { intervalTime = 3 } = await storageGet("sync", ["intervalTime"]);
    const intervalSeconds = Math.max(0.1, Number.parseFloat(intervalTime) || 3);
    if (!autoRun.active || token !== autoRun.token) {
      return;
    }
    if (autoRun.timeoutId) {
      clearTimeout(autoRun.timeoutId);
    }
    if (afterExistingGeneration && !queueRun.active) {
      setStatus(`기존 생성 완료. ${intervalSeconds}초 후 시작해요.`, "ok");
    }
    autoRun.timeoutId = setTimeout(async () => {
      autoRun.timeoutId = null;
      if (!autoRun.active || token !== autoRun.token) {
        return;
      }
      const result = await clickForAutoRun();
      if (!result.ok && !result.cancelled) {
        await stopAutoGenerate({ playAudio: true });
      }
    }, intervalSeconds * 1000);
  }

  async function handleAutoProgress() {
    const waiting = autoRun.waitingForCompletion || autoRun.waitingForExistingGeneration;
    if (!autoRun.active || !waiting || Date.now() < autoRun.ignoreReadyUntil) {
      return;
    }
    const button = findGenerateButton();
    if (!button || button.disabled) {
      return;
    }
    if (autoRun.waitingForExistingGeneration) {
      autoRun.waitingForExistingGeneration = false;
      renderControls();
      await scheduleNextAutoClick({ afterExistingGeneration: true });
      return;
    }
    autoRun.waitingForCompletion = false;
    await maybeDownloadCurrentImage();
    autoRun.completedCount = autoRun.count;
    recordImageCompletion();
    noteProgress(progressLine() + liveEtaSuffix());
    renderControls();
    if (autoRun.stopAfterCurrent) {
      setStatus("마지막 이미지를 저장하고 정지했어요.", "ok");
      await finalizeStop({ playAudio: true });
      return;
    }
    if (autoRun.target > 0 && autoRun.count >= autoRun.target) {
      await completeAutoRun();
      return;
    }
    await scheduleNextAutoClick();
  }

  async function startAutoGenerate({ target = 0, saveName = "", folderName = "", applyPrompt = null, applyBasePrompt = null, applyCharacterPrompt = null, applyBaseNegative = null, applyCharacterNegative = null, shouldContinue = null } = {}) {
    if (!runSafetyChecks({ alertUser: true })) {
      return { ok: false, error: "안전 점검 실패" };
    }
    await stopAutoGenerate({ playAudio: false, keepQueue: true, quiet: true });
    autoRun.token += 1;
    // Typing prompts takes seconds. If the user presses stop meanwhile
    // (finalizeStop bumps the token / the queue is cancelled), never go on to
    // press Generate or play the start sound.
    const startToken = autoRun.token;
    const stillWanted = () => startToken === autoRun.token
      && (typeof shouldContinue !== "function" || shouldContinue());
    const cancelled = () => {
      logEvent("info", "프롬프트 적용 중 정지됨 → 생성하지 않음");
      return { ok: false, cancelled: true };
    };

    if (applyBasePrompt != null || applyCharacterPrompt != null) {
      const applied = await applyStructuredPrompt(applyBasePrompt, applyCharacterPrompt);
      if (!applied.ok) {
        applied.error = applied.error || "프롬프트를 적용하지 못했어요. (상세 원인 없음)";
        setStatus(applied.error, "warn");
        return applied;
      }
    } else if (applyPrompt != null) {
      const applied = await applyPromptToNovelAi(applyPrompt);
      if (!applied.ok) {
        applied.error = applied.error || "프롬프트를 적용하지 못했어요. (상세 원인 없음)";
        setStatus(applied.error, "warn");
        return applied;
      }
    }

    if (!stillWanted()) {
      return cancelled();
    }
    // Negatives are independent of the positive flow. The common/global negative
    // goes to the base Undesired Content; per-character negatives go to each
    // character's own Undesired Content. Failures are non-fatal (warn, continue).
    // When this run defines its own characters, every one of those cards is
    // rewritten — including clearing a card whose block has no negative.
    const ownedCharacterSlots = applyCharacterPrompt != null
      ? splitCharacterBlocks(applyCharacterPrompt).length
      : 0;
    if ((applyCharacterNegative != null && String(applyCharacterNegative).trim() !== "") || ownedCharacterSlots > 0) {
      await applyCharacterNegativesToNovelAi(applyCharacterNegative, { slots: ownedCharacterSlots });
    }
    if (applyBaseNegative != null && String(applyBaseNegative).trim() !== "") {
      await applyBaseNegativeToNovelAi(applyBaseNegative);
    }
    if (!stillWanted()) {
      return cancelled();
    }

    // Reset per-run name/counter, but carry the last saved image src forward so
    // the "is this a new image?" gate still works across queue-item boundaries
    // (otherwise the first save of the next item could grab the prior image).
    saveContext = {
      baseName: saveName || "",
      folderName: folderName || "",
      counter: 0,
      lastSavedSrc: saveContext.lastSavedSrc || "",
    };
    // For a standalone single run, restart timing. During a queue run the
    // tracker spans all items, so startQueueRun owns the reset instead.
    if (!queueRun.active) {
      resetEtaTracker();
    }
    autoRun.active = true;
    syncBackgroundKeepAlive();
    autoRun.count = 0;
    autoRun.completedCount = 0;
    autoRun.target = Math.max(0, Number.parseInt(target, 10) || 0);
    autoRun.waitingForCompletion = false;
    autoRun.waitingForExistingGeneration = false;
    autoRun.stopAfterCurrent = false;
    autoRun.ignoreReadyUntil = 0;
    renderControls();

    await storageSet("sync", { autoClickEnabled: true });
    if (typeof shouldContinue !== "function") {
      await playSound("start.mp3");
    }
    if (!stillWanted()) {
      await finalizeStop({ playAudio: false });
      return cancelled();
    }

    autoRun.timerId = setInterval(() => {
      void handleAutoProgress();
    }, AUTO_REFRESH_MS);

    const generateButton = findGenerateButton();
    if (generateButton?.disabled) {
      autoRun.waitingForExistingGeneration = true;
      autoRun.ignoreReadyUntil = Date.now() + 900;
      renderControls();
      setStatus("기존 생성 완료를 기다린 뒤 시작해요.", "ok");
      return { ok: true, delayed: true };
    }

    const result = await clickForAutoRun();
    if (!result.ok && !result.cancelled) {
      await stopAutoGenerate({ playAudio: true, quiet: true });
      return result;
    }
    return { ok: true };
  }

  // ---------------------------------------------------------------------------
  // queue
  // ---------------------------------------------------------------------------
  async function loadQueueState() {
    const result = await storageGet("local", [QUEUE_STORAGE_KEY]);
    queueState = Store.normalizeState(result[QUEUE_STORAGE_KEY]);
    return queueState;
  }

  async function persistQueueState() {
    queueState = Store.normalizeState(queueState);
    await storageSet("local", { [QUEUE_STORAGE_KEY]: queueState });
    renderQueue();
    renderControls();
  }

  function getItemIndexById(id) {
    return queueState.items.findIndex((item) => item.id === id);
  }

  async function addQueueItem() {
    await loadQueueState();
    let basePrompt = await readCurrentNaiPrompt();
    let characterPrompt = await readCurrentNaiCharacterPrompt();
    // If the base box itself uses NovelAI's "|" syntax and there are no separate
    // character boxes, split it so base/character land in the right fields.
    // 이 블록 역시 전체를 삭제하거나 주석 처리하세요.
    /*
    if (!characterPrompt && basePrompt.includes("|")) {
      const parts = basePrompt.split("|");
      basePrompt = parts[0].trim();
      characterPrompt = parts.slice(1).map((part) => part.trim()).filter(Boolean).join(" | ");
    }
    */
    const count = Math.max(1, Number.parseInt(ui.countInput?.value, 10) || 1);
    const negativePrompt = await readCurrentNaiCharacterNegative();
    const baseNegativePrompt = await readCurrentNaiNegativePrompt();
    const pattern = queueState.options.namePattern || "";
    const patterned = pattern.trim() ? Store.applyNamePattern(pattern, queueState.items.length) : "";
    const title = patterned || `대기열 ${queueState.items.length + 1}`;
    const newItem = Store.createItem({ title, basePrompt, baseNegativePrompt, characterPrompt, negativePrompt, count });
    queueState.items.push(newItem);
    selectedQueueId = newItem.id;
    await persistQueueState();
    setStatus(`대기열에 넣었어요. (${queueState.items.length}개) 오른쪽에서 고칠 수 있어요.`, "ok");
  }

  async function removeQueueItem(id) {
    const index = getItemIndexById(id);
    if (index < 0) {
      return;
    }
    queueState.items.splice(index, 1);
    if (selectedQueueId === id) {
      const next = queueState.items[index] || queueState.items[index - 1] || null;
      selectedQueueId = next ? next.id : null;
    }
    await persistQueueState();
  }

  async function moveQueueItem(id, direction) {
    const index = getItemIndexById(id);
    if (index < 0) {
      return;
    }
    const next = index + (direction < 0 ? -1 : 1);
    if (next < 0 || next >= queueState.items.length) {
      return;
    }
    const [moved] = queueState.items.splice(index, 1);
    queueState.items.splice(next, 0, moved);
    await persistQueueState();
  }

  async function reorderQueueItem(id, toIndex) {
    const from = getItemIndexById(id);
    if (from < 0) {
      return;
    }
    let dest = Math.max(0, Math.min(queueState.items.length - 1, toIndex));
    if (dest === from) {
      return;
    }
    const [moved] = queueState.items.splice(from, 1);
    queueState.items.splice(dest, 0, moved);
    await persistQueueState();
  }

  async function duplicateQueueItem(id) {
    const index = getItemIndexById(id);
    if (index < 0) {
      return;
    }
    const src = queueState.items[index];
    const copy = Store.createItem({
      title: nextDuplicateName(src.title),
      basePrompt: src.basePrompt,
      baseNegativePrompt: src.baseNegativePrompt,
      characterPrompt: src.characterPrompt,
      negativePrompt: src.negativePrompt,
      count: src.count,
      folderName: src.folderName,
      axes: src.axes,
    });
    queueState.items.splice(index + 1, 0, copy);
    selectedQueueId = copy.id;
    await persistQueueState();
    setStatus("항목을 복제했어요.", "ok");
  }

  // "name" -> "name (2)", "name (2)" -> "name (3)"
  function nextDuplicateName(title) {
    const base = (title || "").trim() || "무제";
    const match = base.match(/^(.*?)\s*\((\d+)\)$/);
    const stem = match ? match[1].trim() : base;
    let n = match ? Number.parseInt(match[2], 10) + 1 : 2;
    const existing = new Set(queueState.items.map((it) => (it.title || "").trim()));
    let candidate = `${stem} (${n})`;
    while (existing.has(candidate)) {
      n += 1;
      candidate = `${stem} (${n})`;
    }
    return candidate;
  }

  // Apply the naming pattern to every item in order.
  async function applyNamePatternToAll() {
    const pattern = queueState.options.namePattern || "";
    if (!pattern.trim()) {
      setStatus("먼저 이름 패턴을 입력하세요. (예: char_{n})", "warn");
      return;
    }
    queueState.items.forEach((item, index) => {
      item.title = Store.applyNamePattern(pattern, index);
      // A typed-in name wins over the generator's character folder.
      delete item.folderName;
    });
    await persistQueueState();
    setStatus(`${queueState.items.length}개 항목 이름을 패턴으로 채웠어요.`, "ok");
  }

  async function applyCountToAll(mode) {
    if (queueRun.active) {
      setStatus("대기열 실행 중에는 장수를 변경할 수 없어요.", "warn");
      return;
    }
    if (!queueState.items.length) {
      setStatus("먼저 대기열에 항목을 추가하세요.", "warn");
      return;
    }
    const raw = Number.parseInt(ui.bulkCountInput?.value, 10);
    if (!Number.isFinite(raw) || raw < 1) {
      setStatus("적용할 장수를 1 이상으로 입력하세요.", "warn");
      return;
    }
    queueState.items.forEach((item) => {
      const next = mode === "add" ? (item.count || 0) + raw : raw;
      item.count = Store.normalizeCount(next);
    });
    await persistQueueState();
    const total = queueState.items.reduce((sum, item) => sum + (item.count || 0), 0);
    const verb = mode === "add" ? `장수를 +${raw}장씩 추가` : `장수를 ${raw}장으로 설정`;
    setStatus(`${queueState.items.length}개 항목 ${verb}했어요. (총 ${total}장)`, "ok");
  }

  async function updateQueueItem(id, field, value) {
    const index = getItemIndexById(id);
    if (index < 0) {
      return;
    }
    if (field === "title") {
      queueState.items[index].title = Store.normalizeTitle(value);
    } else if (field === "basePrompt") {
      queueState.items[index].basePrompt = Store.normalizePrompt(value);
    } else if (field === "baseNegativePrompt") {
      queueState.items[index].baseNegativePrompt = Store.normalizePrompt(value);
    } else if (field === "characterPrompt") {
      queueState.items[index].characterPrompt = Store.normalizePrompt(value);
    } else if (field === "negativePrompt") {
      queueState.items[index].negativePrompt = Store.normalizePrompt(value);
    } else if (field === "count") {
      queueState.items[index].count = Store.normalizeCount(value);
    }
    await persistQueueState();
  }

  async function clearQueue() {
    if (queueRun.active) {
      setStatus("대기열 실행 중에는 비울 수 없어요.", "warn");
      return;
    }
    queueState.items = [];
    await persistQueueState();
    setStatus("대기열을 비웠어요.", "ok");
  }

  async function toggleQueueLoop() {
    await loadQueueState();
    queueState.options.loop = !queueState.options.loop;
    await persistQueueState();
  }

  function cancelQueueRun() {
    if (!queueRun.active) {
      return;
    }
    queueRun.active = false;
    syncBackgroundKeepAlive();
    queueRun.token += 1;
    autoRun.onComplete = null;
    const resolve = queueRun.resolveItem;
    queueRun.resolveItem = null;
    if (typeof resolve === "function") {
      resolve({ cancelled: true });
    }
  }

  function runQueueItemAt(index, runToken) {
    return new Promise((resolve) => {
      const item = queueRun.items[index];
      if (!item) {
        resolve({ ok: false, error: "잘못된 항목" });
        return;
      }
      let settled = false;
      const finish = (result) => {
        if (settled) {
          return;
        }
        settled = true;
        queueRun.resolveItem = null;
        resolve(result);
      };
      queueRun.resolveItem = (result) => finish(result);

      (async () => {
        if (!queueRun.active || runToken !== queueRun.token) {
          finish({ cancelled: true });
          return;
        }
        queueRun.advancing = true;
        // The Generate button becomes enabled slightly before NovelAI finishes
        // committing the previous character-card UI. One short settle turn is
        // enough now that cards are reused instead of deleted and recreated.
        // Do NOT blur here: in a background tab the blur dropped focus from the
        // editor the next write targets.
        if (index > 0) {
          await delay(120);
        }
        const itemBase = Store.effectiveBase(item, queueState.options);
        const resolvedBaseNeg = Store.effectiveBaseNegative(item, queueState.options);
        const itemBaseNeg = resolvedBaseNeg && resolvedBaseNeg.trim() ? resolvedBaseNeg : null;
        noteProgress(`대기열 ${index + 1}/${queueRun.items.length} · ${item.title} · 프롬프트 적용 중`);
        const applyStartedAt = Date.now();
        const startResult = await startAutoGenerate({
          shouldContinue: () => queueRun.active && runToken === queueRun.token,
          target: item.count,
          saveName: item.title,
          folderName: item.folderName || "",
          applyBasePrompt: itemBase && itemBase.trim() ? itemBase : null,
          applyCharacterPrompt: item.characterPrompt && item.characterPrompt.trim() ? item.characterPrompt : null,
          applyBaseNegative: itemBaseNeg,
          applyCharacterNegative: item.negativePrompt && item.negativePrompt.trim() ? item.negativePrompt : null,
        });
        queueRun.advancing = false;
        if (startResult.cancelled) {
          finish({ cancelled: true });
          return;
        }
        logEvent(startResult.ok ? "info" : "error",
          `대기열 항목 ${index + 1} 프롬프트 적용 ${startResult.ok ? "완료" : "실패"} · ${((Date.now() - applyStartedAt) / 1000).toFixed(1)}초`,
          startResult.ok ? undefined : startResult.error);
        if (!startResult.ok && !startResult.delayed) {
          finish({ ok: false, error: startResult.error });
          return;
        }
        if (!queueRun.active || runToken !== queueRun.token) {
          finish({ cancelled: true });
          return;
        }
        // Register completion hook only after generation has started, because
        // startAutoGenerate internally stops the previous run (clearing onComplete).
        autoRun.onComplete = () => finish({ ok: true });
      })().catch((error) => {
        queueRun.advancing = false;
        autoRun.onComplete = null;
        logEvent("error", `대기열 항목 ${index + 1} 처리 중 예외`, error);
        finish({ ok: false, error: String(error?.message || error) });
      });
    });
  }

  async function startQueueRun() {
    if (queueRun.active) {
      return { ok: false };
    }
    await loadQueueState();
    if (!queueState.items.length) {
      setStatus("대기열이 비어 있어요.", "warn");
      return { ok: false };
    }
    if (!runSafetyChecks({ alertUser: true })) {
      return { ok: false };
    }

    queueRun.active = true;
    syncBackgroundKeepAlive();
    queueRun.token += 1;
    const runToken = queueRun.token;
    queueRun.items = queueState.items.map((item) => Store.cloneJson(item));
    queueRun.loop = Boolean(queueState.options.loop);
    logEvent("info", `대기열 실행 시작 · ${queueRun.items.length}개 항목 · 반복 ${queueRun.loop ? "켜짐" : "꺼짐"}`,
      queueRun.items.map((item, i) => `${i + 1}. ${item.title} · ${item.count}장 · 캐릭터 ${splitCharacterBlocks(item.characterPrompt).length}명`).join("\n"));
    queueRun.index = 0;
    queueRun.totalGenerated = 0;
    resetEtaTracker();
    renderControls();
    renderQueue();
    // Keep the panel open during the run so the user can see the queue
    // and which item is currently generating (don't auto-collapse to the FAB).
    setActiveTab("queue");
    await playSound("start.mp3");

    let interrupted = false;
    let interruptionError = "";
    do {
      for (let i = 0; i < queueRun.items.length; i += 1) {
        if (!queueRun.active || runToken !== queueRun.token) {
          interrupted = true;
          break;
        }
        queueRun.index = i;
        renderQueue();
        renderControls();
        const item = queueRun.items[i];
        const totalAll = queueTotalImages();
        const overallAtStart = totalAll > 0
          ? Math.min(100, Math.round((queueRun.totalGenerated / totalAll) * 100))
          : 0;
        noteProgress(`대기열 ${i + 1}/${queueRun.items.length} · ${item.title} · 항목 0/${item.count || 0}장 (0%) · 전체 ${overallAtStart}%`);
        const result = await runQueueItemAt(i, runToken);
        if (result?.cancelled || !queueRun.active || runToken !== queueRun.token) {
          interrupted = true;
          break;
        }
        if (!result?.ok) {
          interrupted = true;
          interruptionError = result?.error || "원인이 보고되지 않은 오류 (직전 경고 문구를 확인하세요)";
          setStatus(`대기열 중단: ${interruptionError}`, "warn");
          break;
        }
        queueRun.totalGenerated += item.count;
      }
    } while (!interrupted && queueRun.active && runToken === queueRun.token && queueRun.loop);

    await finishQueueRun({ completedNormally: !interrupted, error: interruptionError });
    return { ok: true };
  }

  async function finishQueueRun({ completedNormally = false, error = "" } = {}) {
    const total = queueRun.totalGenerated;
    logEvent(error ? "error" : "info", `대기열 실행 종료 · ${completedNormally ? "정상 완료" : (error ? "오류로 중단" : "사용자 중지")} · 총 ${total}장`, error || undefined);
    queueRun.active = false;
    syncBackgroundKeepAlive();
    queueRun.resolveItem = null;
    autoRun.onComplete = null;
    queueRun.index = 0;
    queueRun.items = [];
    queueRun.totalGenerated = 0;
    renderQueue();
    renderControls();
    if (completedNormally) {
      await playSound("stop.mp3");
      chrome.runtime.sendMessage({ action: "showCompletionNotification", count: total }, () => {
        void chrome.runtime.lastError;
      });
      setStatus(`대기열 작업을 모두 완료했어요. (총 ${total}장)`, "ok");
    } else if (error) {
      setStatus(`대기열 중단: ${error}`, "warn");
    } else {
      setStatus("대기열 실행을 중지했어요.", "warn");
    }
  }

  async function stopQueueRun() {
    // 자동 생성을 먼저 멈추도록 지시합니다.
    const result = await stopAutoGenerate({ playAudio: false });
    
    if (result.pending) {
      // 마지막 이미지를 기다리는 중(정지 대기)이라면 대기열 루프만 끊습니다.
      // 큐 활성 상태를 유지해야 UI가 자동 생성 탭으로 튕기지 않습니다.
      queueRun.token += 1; 
    } else {
      // 즉시 정지된 상태라면 대기열을 완전히 끕니다.
      cancelQueueRun();
    }
  }

  function exportQueue() {
    const envelope = Store.createExportEnvelope(queueState, {});
    const blob = new Blob([`${JSON.stringify(envelope, null, 2)}\n`], { type: "application/json;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `nai-auto-saver-queue-${Date.now()}.json`;
    document.documentElement.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    setStatus("대기열 JSON을 내보냈어요.", "ok");
  }

  async function importQueueFromFile(file) {
    if (!file) {
      return;
    }
    try {
      const parsed = Store.parseExportEnvelope(await file.text());
      if (!parsed.ok) {
        setStatus(parsed.error, "warn");
        return;
      }
      queueState = parsed.queue;
      await persistQueueState();
      setStatus(`대기열을 가져왔어요. (${queueState.items.length}개)`, "ok");
    } catch (error) {
      setStatus("대기열 JSON을 가져오지 못했어요.", "warn");
    }
  }

  // ---------------------------------------------------------------------------
  // combination generator
  // ---------------------------------------------------------------------------
  let genSaveTimer = null;
  const GEN_AXIS_LABEL = { char: "캐릭터", bg: "배경", emo: "감정" };
  const GEN_SEP_LABEL = { "_": "_", "-": "-", " ": "띄어쓰기" };

  function downloadJson(obj, filename) {
    const blob = new Blob([`${JSON.stringify(obj, null, 2)}\n`], { type: "application/json;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.documentElement.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  // "1 hooded eyes" / "1. smiling" / "2) angry" / "3: ..." -> tag only.
  function stripLeadingNumber(line) {
    return String(line == null ? "" : line).replace(/^\s*\d+\s*[.)\]:．。、,-]?\s*/, "").trim();
  }

  // One entry per emotion line: "웃음 = smiling" -> { name: "웃음", tags: "smiling" }.
  function parseExpressionEntries(text) {
    return String(text == null ? "" : text)
      .split(/\r?\n/)
      .map((line) => stripLeadingNumber(line))
      .filter((line) => line.length > 0)
      .map((line) => Store.parseComboLine(line))
      .filter((entry) => entry.name || entry.tags);
  }

  function parseExpressionSet(text) {
    return parseExpressionEntries(text).map((entry) => entry.tags);
  }

  // Emotion names follow person 1's lines; an added person can name a line
  // that person 1 left unnamed.
  function genEmotionNames(ch) {
    const lists = [parseExpressionEntries(ch.expressions)];
    for (const extra of Array.isArray(ch.members) ? ch.members : []) {
      lists.push(parseExpressionEntries(extra.expressions));
    }
    const width = Math.max(0, ...lists.map((list) => list.length));
    const names = [];
    for (let i = 0; i < width; i += 1) {
      const found = lists.map((list) => list[i]?.name || "").find(Boolean) || "";
      names.push(Store.sanitizeFileName(found, "").trim());
    }
    return names;
  }

  // One combo "character" can hold several NovelAI characters: the main
  // fields are person 1, each added member is the next person. The old ";;"
  // habit also works inside the main fields.
  function genCharacterMembers(ch) {
    const splitSemi = (value) => String(value == null ? "" : value).split(/\s*(?:;;|；；)\s*/u);
    const members = [];
    const appearParts = splitSemi(ch.appearance);
    const negParts = splitSemi(ch.negative);
    const exprLines = parseExpressionSet(ch.expressions).map(splitSemi);
    const width = Math.max(appearParts.length, negParts.length, ...exprLines.map((parts) => parts.length), 1);
    for (let j = 0; j < width; j += 1) {
      members.push({
        appearance: (appearParts[j] || "").trim(),
        negative: (negParts[j] || "").trim(),
        expressions: exprLines.map((parts) => (parts[j] || "").trim()),
      });
    }
    for (const extra of Array.isArray(ch.members) ? ch.members : []) {
      const appearance = String(extra.appearance || "").trim();
      const expressions = parseExpressionSet(extra.expressions);
      const negative = String(extra.negative || "").trim();
      if (!appearance && !expressions.length && !negative) {
        continue;
      }
      members.push({ appearance, expressions, negative });
    }
    return members;
  }

  // Emotion numbers follow person 1's lines; if person 1 has none, the longest
  // member list decides.
  function genEmotionCount(members) {
    if (!members.length) return 0;
    if (members[0].expressions.length) return members[0].expressions.length;
    return Math.max(0, ...members.map((m) => m.expressions.length));
  }

  function genMemberExpression(member, index) {
    const list = member.expressions;
    if (!list.length) return "";
    if (list.length === 1) return list[0];
    return list[index] || "";
  }

  function joinCharacterColumn(values) {
    const list = values.map((value) => String(value || "").trim());
    while (list.length && !list[list.length - 1]) list.pop();
    return list.join(" ;; ");
  }

  function escapeHtml(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  function escapeAttr(value) {
    return escapeHtml(value).replace(/"/g, "&quot;");
  }

  // ---------------------------------------------------------------------------
  // Combination screen (design A): chips → result cards → inspector.
  // State lives in memory (genState) and is saved as the same JSON shape the
  // old editor used, plus `excluded` (combinations switched off).
  // ---------------------------------------------------------------------------
  const COMBO_KEY_SEP = "␟";
  const NAME_PRESETS = [
    { id: "ceb_", order: ["char", "emo", "bg"], on: { char: true, emo: true, bg: true }, sep: "_" },
    { id: "cbe_", order: ["char", "bg", "emo"], on: { char: true, emo: true, bg: true }, sep: "_" },
    { id: "ce_", order: ["char", "emo", "bg"], on: { char: true, emo: true, bg: false }, sep: "_" },
    { id: "ceb-", order: ["char", "emo", "bg"], on: { char: true, emo: true, bg: true }, sep: "-" },
    { id: "ceb ", order: ["char", "emo", "bg"], on: { char: true, emo: true, bg: true }, sep: " " },
  ];
  function presetNaming(preset) {
    return Store.normalizeComboNaming({ nameOrder: preset.order, nameOn: preset.on, nameSep: preset.sep, loopOrder: preset.order });
  }
  function namingMatchesPreset(naming, preset) {
    const want = presetNaming(preset);
    return JSON.stringify(Store.normalizeComboNaming(naming)) === JSON.stringify(want);
  }

  function emptyGenState() {
    return { base: "", baseNeg: "", count: "1", split: "0", chars: [], bgs: [], bgShared: true, emoShared: false, sharedExpressions: "", naming: presetNaming(NAME_PRESETS[0]), excluded: [] };
  }

  function normalizeGenState(stored) {
    const s = stored && typeof stored === "object" ? stored : {};
    const str = (value) => String(value == null ? "" : value);
    const bgList = (list) => (Array.isArray(list) ? list : [])
      .map((b) => ({ code: str(b && b.code), tags: str(b && b.tags), negative: str(b && b.negative) }))
      .filter((b) => b.code.trim() || b.tags.trim());
    const chars = (Array.isArray(s.chars) ? s.chars : [])
      .map((c) => ({
        code: str(c && c.code),
        bgs: bgList(c && c.bgs),
        appearance: str(c && c.appearance),
        expressions: str(c && c.expressions),
        negative: str(c && c.negative),
        members: (Array.isArray(c && c.members) ? c.members : []).map((m) => ({
          appearance: str(m && m.appearance),
          expressions: str(m && m.expressions),
          negative: str(m && m.negative),
        })),
      }))
      .filter((c) => c.code.trim() || c.appearance.trim() || c.expressions.trim());
    const bgs = bgList(s.bgs);
    const hadData = Array.isArray(s.chars) && s.chars.some((c) => c && String(c.code || "").trim());
    return {
      base: str(s.base),
      baseNeg: str(s.baseNeg),
      count: str(s.count || "1"),
      split: str(s.split || "0"),
      chars,
      bgs,
      // 배경 and 표정 can each be one list for every character, or one per character.
      bgShared: s.bgShared !== false,
      emoShared: Boolean(s.emoShared),
      sharedExpressions: str(s.sharedExpressions),
      // Old saves had no naming field and used character_background_emotion.
      naming: s.naming ? Store.normalizeComboNaming(s.naming) : (hadData ? Store.normalizeComboNaming() : presetNaming(NAME_PRESETS[0])),
      excluded: Array.isArray(s.excluded) ? s.excluded.map(String) : [],
    };
  }

  let genState = emptyGenState();
  let genTemplateEditing = false;
  let genActiveChar = 0;
  let genSelection = { type: null, index: -1 };

  function collectGenRaw() {
    return JSON.parse(JSON.stringify(genState));
  }

  function charEmotionEntries(ch) {
    return parseExpressionEntries(ch ? ch.expressions : "");
  }

  // Where the 표정 row reads and writes: the shared list, or the active character.
  const sharedEmoOwner = {
    get expressions() { return genState.sharedExpressions; },
    set expressions(value) { genState.sharedExpressions = value; },
  };
  // The 배경 row's list: the shared one, or the active character's own.
  function bgListFor(ch, raw = genState) {
    return raw.bgShared === false ? (ch ? ch.bgs || (ch.bgs = []) : []) : raw.bgs;
  }
  function bgOwnerList() {
    if (genState.bgShared !== false) return genState.bgs;
    const ch = genState.chars[genActiveChar];
    return ch ? bgListFor(ch) : null;
  }

  function setSharedBackgrounds(on) {
    on = Boolean(on);
    if (on === (genState.bgShared !== false)) return;
    const copy = (list) => list.map((b) => ({ ...b }));
    if (on && !genState.bgs.length) {
      const seed = genState.chars[genActiveChar]?.bgs?.length ? genState.chars[genActiveChar] : genState.chars.find((ch) => ch.bgs && ch.bgs.length);
      genState.bgs = seed ? copy(seed.bgs) : [];
    }
    if (!on) {
      // Start every character from the shared list, then let each one change.
      for (const ch of genState.chars) {
        if (!ch.bgs || !ch.bgs.length) ch.bgs = copy(genState.bgs);
      }
    }
    genState.bgShared = on;
    if (genSelection.type === "bg") genSelection = { type: null, index: -1 };
  }

  function emoOwner() {
    return genState.emoShared ? sharedEmoOwner : genState.chars[genActiveChar] || null;
  }

  // With shared 표정, every character's person 1 uses the shared list.
  function effectiveChars(raw) {
    return raw.emoShared ? raw.chars.map((ch) => ({ ...ch, expressions: raw.sharedExpressions || "" })) : raw.chars;
  }

  function setSharedEmotions(on) {
    on = Boolean(on);
    if (on === genState.emoShared) return;
    if (on && !genState.sharedExpressions.trim()) {
      const seed = genState.chars[genActiveChar]?.expressions.trim() ? genState.chars[genActiveChar] : genState.chars.find((ch) => ch.expressions.trim());
      genState.sharedExpressions = seed ? seed.expressions : "";
    }
    if (!on) {
      // Keep what was built: characters without their own list take the shared one.
      for (const ch of genState.chars) {
        if (!ch.expressions.trim()) ch.expressions = genState.sharedExpressions;
      }
    }
    genState.emoShared = on;
    if (genSelection.type === "emo") genSelection = { type: null, index: -1 };
  }

  function setCharEmotionEntries(ch, entries) {
    ch.expressions = entries.map((e, i) => {
      const name = String(e.name || "").trim();
      const tags = String(e.tags || "").replace(/\s*\n\s*/g, " ").trim();
      if (name && !/^\d+$/.test(name)) {
        return `${name} = ${tags}`;
      }
      return tags || `표정${i + 1} = `;
    }).join("\n");
  }
  function comboKey(entry) {
    return [entry.charName, entry.bgName, entry.emoName].join(COMBO_KEY_SEP);
  }

  // Every combination (with its file name) in generation order.
  function genPlan(raw = collectGenRaw()) {
    const chars = effectiveChars(raw).map((ch) => ({
      name: Store.sanitizeFileName(ch.code, "").trim(),
      emotionNames: genEmotionNames(ch),
      emotionCount: genEmotionCount(genCharacterMembers(ch)),
    }));
    const bgName = (bg) => ({ name: Store.sanitizeFileName(bg.code, "").trim() });
    const bgs = raw.bgs.map(bgName);
    if (raw.bgShared === false) {
      raw.chars.forEach((ch, i) => { chars[i].bgs = (ch.bgs || []).map(bgName); });
    }
    const excluded = new Set(raw.excluded || []);
    return Store.buildComboPlan(chars, bgs, raw.naming).map((entry) => ({
      ...entry,
      key: comboKey(entry),
      excluded: excluded.has(comboKey(entry)),
    }));
  }

  function genPreviewCount() {
    return genPlan().filter((entry) => !entry.excluded).length;
  }

  // NovelAI separates tags by comma; force one trailing comma per group.
  function ensureTrailingComma(value) {
    const t = String(value == null ? "" : value).trim();
    if (!t) {
      return "";
    }
    return /,\s*$/.test(t) ? t.replace(/\s*$/, "") : `${t},`;
  }

  // Expand into queue items (switched-off combinations are skipped).
  function buildGenItems() {
    const raw = collectGenRaw();
    const base = raw.base;
    const baseNeg = String(raw.baseNeg || "").trim();
    const count = Math.max(1, Number.parseInt(raw.count, 10) || 1);
    const membersByChar = effectiveChars(raw).map((ch) => genCharacterMembers(ch));
    const items = [];
    for (const entry of genPlan(raw)) {
      if (entry.excluded) {
        continue;
      }
      const members = membersByChar[entry.ci];
      const bg = bgListFor(raw.chars[entry.ci], raw)[entry.bi];
      const bgTags = String(bg.tags || "").trim();
      const bgNeg = String(bg.negative || "").trim();
      const index = entry.ei;
      // Background tags / negative go to person 1 only (it is one scene).
      const prompts = members.map((member, m) => [member.appearance, genMemberExpression(member, index), m === 0 ? bgTags : ""]
        .map(ensureTrailingComma)
        .filter(Boolean)
        .join("\n"));
      const negatives = members.map((member, m) => [member.negative, m === 0 ? bgNeg : ""].filter(Boolean).join(", "));
      items.push(Store.createItem({
        title: entry.title,
        folderName: entry.folderName,
        basePrompt: base,
        baseNegativePrompt: baseNeg,
        characterPrompt: joinCharacterColumn(prompts),
        negativePrompt: joinCharacterColumn(negatives),
        count,
        axes: { char: entry.charName, bg: entry.bgName, emo: entry.emoName },
      }));
    }
    return { items, base, baseNeg };
  }

  function genBaseOptions(base, baseNeg = "") {
    return { loop: false, useGlobalBase: Boolean(String(base || "").trim() || String(baseNeg || "").trim()), globalBase: base, globalBaseNegative: baseNeg, namePattern: "" };
  }

  const GEN_EMPTY_MESSAGE = "만들 조합이 없어요. 캐릭터·배경·표정을 하나씩 넣어 주세요.";

  async function genAppendToQueue() {
    const { items, base, baseNeg } = buildGenItems();
    if (!items.length) {
      setStatus(GEN_EMPTY_MESSAGE, "warn");
      return;
    }
    await loadQueueState();
    queueState.items.push(...items);
    if (!String(queueState.options.globalBase || "").trim()) {
      queueState.options.globalBase = base;
    }
    if (!String(queueState.options.globalBaseNegative || "").trim()) {
      queueState.options.globalBaseNegative = baseNeg;
    }
    selectedQueueId = items[0].id;
    await persistQueueState();
    setActiveTab("queue");
    setStatus(`조합 ${items.length}개를 대기열에 넣었어요. (전체 ${queueState.items.length}개)`, "ok");
    tourEvent("combo-queued");
  }

  async function genReplaceQueue() {
    const { items, base, baseNeg } = buildGenItems();
    if (!items.length) {
      setStatus(GEN_EMPTY_MESSAGE, "warn");
      return;
    }
    await loadQueueState();
    if (queueState.items.length && !(await iosAlert({
      title: "대기열을 바꿀까요?",
      message: `지금 대기열 ${queueState.items.length}개를 지우고 새 조합 ${items.length}개로 채워요.`,
      buttons: [{ label: "취소", value: false, cancel: true }, { label: "바꾸기", value: true, primary: true }],
    }))) {
      return;
    }
    queueState = Store.normalizeState({ items, options: genBaseOptions(base, baseNeg) });
    selectedQueueId = items[0].id;
    await persistQueueState();
    setActiveTab("queue");
    setStatus(`대기열을 이 조합 ${items.length}개로 새로 채웠어요.`, "ok");
    tourEvent("combo-queued");
  }

  function genExportJson() {
    const { items, base, baseNeg } = buildGenItems();
    if (!items.length) {
      setStatus(GEN_EMPTY_MESSAGE, "warn");
      return;
    }
    const splitValue = Number.parseInt(genState.split, 10);
    const perFile = Number.isFinite(splitValue) && splitValue > 0 ? splitValue : 0;
    const options = genBaseOptions(base, baseNeg);
    const chunks = [];
    if (perFile > 0) {
      for (let i = 0; i < items.length; i += perFile) {
        chunks.push(items.slice(i, i + perFile));
      }
    } else {
      chunks.push(items);
    }
    const stamp = Date.now();
    chunks.forEach((chunk, index) => {
      const envelope = Store.createExportEnvelope({ items: chunk, options }, {});
      const suffix = chunks.length > 1 ? `-${String(index + 1).padStart(2, "0")}` : "";
      downloadJson(envelope, `nai-queue-combo-${stamp}${suffix}.json`);
    });
    setStatus(`JSON ${chunks.length}개 파일로 내보냈어요. (전체 ${items.length}개)`, "ok");
  }

  function scheduleGenSave() {
    if (genSaveTimer) {
      clearTimeout(genSaveTimer);
    }
    genSaveTimer = setTimeout(() => {
      genSaveTimer = null;
      void storageSet("local", { [GENERATOR_STORAGE_KEY]: collectGenRaw() });
    }, 400);
  }

  async function loadGeneratorState() {
    let stored = null;
    try {
      const result = await storageGet("local", [GENERATOR_STORAGE_KEY]);
      stored = result[GENERATOR_STORAGE_KEY] || null;
    } catch (error) {
      void error;
    }
    genState = stored ? normalizeGenState(stored) : emptyGenState();
    genActiveChar = 0;
    genSelection = { type: null, index: -1 };
    renderCombo();
  }

  // ---- rendering ------------------------------------------------------------
  function charDisplayName(ch, index) {
    return (ch.code || "").trim() || `캐릭터 ${index + 1}`;
  }
  function bgDisplayName(bg, index) {
    return (bg.code || "").trim() || `배경 ${index + 1}`;
  }
  function emoDisplayName(entry, index) {
    return (entry.name || "").trim() || String(index + 1);
  }

  const CHECK_BADGE = '<svg class="ias-ccard-badge" width="17" height="17" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10" fill="var(--accent)"/><path d="M7.5 12.5l3 3 6-6.5" fill="none" stroke="#FFFFFF" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  const EMPTY_BADGE = '<svg class="ias-ccard-badge" width="17" height="17" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9.5" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>';
  const HELP_DOT = '<svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10" fill="var(--help-dot)"/><path d="M9.3 9.4a2.8 2.8 0 0 1 5.5.9c0 1.9-2.8 2.3-2.8 4" fill="none" stroke="#FFFFFF" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><circle cx="12" cy="17.4" r="1.15" fill="#FFFFFF"/></svg>';

  function isSelected(type, index) {
    return genSelection.type === type && genSelection.index === index;
  }

  function renderCombo({ inspector = true } = {}) {
    if (!ui.comboMain) {
      return;
    }
    if (genActiveChar >= genState.chars.length) {
      genActiveChar = Math.max(0, genState.chars.length - 1);
    }
    const plan = genPlan();
    const included = plan.filter((e) => !e.excluded);
    const perChar = genState.chars.map((_, ci) => included.filter((e) => e.ci === ci).length);

    const charChips = genState.chars.map((ch, i) => `<button type="button" class="ias-chip ias-chip-round" data-kind="char" data-index="${i}" data-active="${i === genActiveChar}" data-selected="${isSelected("char", i)}">${escapeHtml(charDisplayName(ch, i))}<span class="ias-chip-count">${perChar[i]}</span></button>`).join("");
    const bgOwner = bgOwnerList();
    const bgShared = genState.bgShared !== false;
    const bgChips = (bgOwner || []).map((bg, i) => `<button type="button" class="ias-chip ias-chip-round" data-kind="bg" data-index="${i}" data-selected="${isSelected("bg", i)}">${escapeHtml(bgDisplayName(bg, i))}</button>`).join("");
    const activeChar = genState.chars[genActiveChar];
    const owner = emoOwner();
    const emotions = owner ? charEmotionEntries(owner) : [];
    const emoChips = emotions.map((entry, i) => `<button type="button" class="ias-chip" data-kind="emo" data-index="${i}" data-selected="${isSelected("emo", i)}">${escapeHtml(emoDisplayName(entry, i))}</button>`).join("");

    ui.comboPickers.innerHTML = `
      <span class="ias-picker-label">캐릭터</span>
      <div class="ias-chips">${charChips}<button type="button" class="ias-chip-add ias-chip-round" data-add="char" data-tour="combo-add-char" aria-label="캐릭터 추가">+</button></div>
      <span class="ias-picker-label">배경</span>
      <div class="ias-chips">${bgOwner ? `${bgChips}<button type="button" class="ias-chip-add ias-chip-round" data-add="bg" data-tour="combo-add-bg" aria-label="배경 추가">+</button>` : '<span class="ias-picker-note">캐릭터를 먼저 넣어 주세요</span>'}<label class="ias-picker-check" title="켜면 배경 목록 하나를 모든 캐릭터가 같이 써요"><input type="checkbox" data-shared-bg ${bgShared ? "checked" : ""}>모든 캐릭터 공통</label></div>
      <span class="ias-picker-label">표정</span>
      <div class="ias-chips">${owner ? `${emoChips}<button type="button" class="ias-chip-add" data-add="emo" data-tour="combo-add-emo" aria-label="표정 추가">+</button>` : '<span class="ias-picker-note">캐릭터를 먼저 넣어 주세요</span>'}<label class="ias-picker-check" title="켜면 표정 목록 하나를 모든 캐릭터가 같이 써요"><input type="checkbox" data-shared-emo ${genState.emoShared ? "checked" : ""}>모든 캐릭터 공통</label></div>
    `;

    // Result cards for the active character.
    const name = activeChar ? charDisplayName(activeChar, genActiveChar) : "";
    const charBgs = activeChar ? bgListFor(activeChar) : [];
    ui.comboResultTitle.textContent = activeChar ? `만들어질 그림 · ${name} ${perChar[genActiveChar] || 0}장` : "만들어질 그림";
    if (!activeChar || !charBgs.length || !emotions.length) {
      ui.comboCards.style.gridTemplateColumns = "";
      ui.comboCards.innerHTML = `<div class="ias-combo-empty">${!genState.chars.length ? "＋를 눌러 캐릭터부터 넣어 보세요." : !charBgs.length ? "배경을 하나 넣으면 카드가 생겨요." : "이 캐릭터의 표정을 하나 넣으면 카드가 생겨요."}</div>`;
    } else {
      const charPlan = plan.filter((e) => e.ci === genActiveChar);
      const byCell = new Map(charPlan.map((e) => [`${e.ei}:${e.bi}`, e]));
      const cols = charBgs.length;
      ui.comboCards.style.gridTemplateColumns = `repeat(${cols}, minmax(92px, 1fr))`;
      const head = charBgs.map((bg, bi) => `<span class="ias-ccol">${escapeHtml(bgDisplayName(bg, bi))}</span>`).join("");
      const cells = [];
      emotions.forEach((entry, ei) => {
        charBgs.forEach((bg, bi) => {
          const e = byCell.get(`${ei}:${bi}`);
          if (!e) {
            cells.push('<span></span>');
            return;
          }
          cells.push(`<button type="button" class="ias-ccard" data-key="${escapeAttr(e.key)}" aria-pressed="${!e.excluded}" ${ei === 0 && bi === charBgs.length - 1 ? 'data-tour="combo-card"' : ""} title="${escapeAttr(e.title)} · ${e.excluded ? "눌러서 다시 넣기" : "눌러서 빼기"}"><span class="ias-ccard-name">${escapeHtml(emoDisplayName(entry, ei))}</span><span class="ias-ccard-file">${e.excluded ? "만들지 않음" : escapeHtml(e.title)}</span>${e.excluded ? EMPTY_BADGE : CHECK_BADGE}</button>`);
        });
      });
      ui.comboCards.innerHTML = head + cells.join("");
    }

    // Footer: name rule + totals.
    const sample = { char: name || "김춘자", emo: emotions[0] ? emoDisplayName(emotions[0], 0) : "웃음", bg: (bgOwner || [])[0] ? bgDisplayName(bgOwner[0], 0) : "교실" };
    const example = (preset) => preset.order.filter((axis) => preset.on[axis]).map((axis) => sample[axis]).join(preset.sep);
    const templateMode = Boolean(genState.naming.template) || genTemplateEditing;
    const current = templateMode ? null : NAME_PRESETS.find((preset) => namingMatchesPreset(genState.naming, preset));
    const customOption = current || templateMode ? "" : `<option value="custom" selected>${escapeHtml(Store.buildComboPlan([{ name: sample.char, emotionNames: [sample.emo], emotionCount: 1 }], [{ name: sample.bg }], genState.naming)[0]?.title || "직접 만든 규칙")}</option>`;
    ui.comboNameSelect.innerHTML = customOption + NAME_PRESETS.map((preset) => `<option value="${escapeAttr(preset.id)}" ${current === preset ? "selected" : ""}>${escapeHtml(example(preset))}</option>`).join("")
      + `<option value="template" ${templateMode ? "selected" : ""}>직접 쓰기…</option>`;
    if (ui.nameTemplateRow) {
      ui.nameTemplateRow.hidden = !templateMode;
      if (templateMode && ui.nameTemplateInput && panelShadow.activeElement !== ui.nameTemplateInput) {
        ui.nameTemplateInput.value = genState.naming.template || "";
      }
      if (ui.nameTemplatePreview) {
        const shown = genState.naming.template ? Store.renderNameTemplate(genState.naming.template, sample) : "";
        ui.nameTemplatePreview.textContent = shown ? `→ ${shown}` : "{캐릭터} {배경} {표정} 사이에 _ 나 띄어쓰기를 마음대로 넣어요";
      }
    }
    const parts = genState.chars.map((ch, i) => `${charDisplayName(ch, i)} ${perChar[i]}`).filter((_, i) => perChar[i] > 0);
    ui.comboSummary.textContent = included.length ? `전체 ${included.length}개${parts.length > 1 ? ` · ${parts.join(" + ")}` : ""}` : "아직 만들 조합이 없어요";
    ui.genAppendButton.querySelector("span").textContent = included.length ? `대기열에 ${included.length}개 넣기` : "대기열에 넣기";
    ui.genAppendButton.disabled = !included.length;
    ui.genReplaceButton.disabled = !included.length;
    if (ui.genPreview) {
      ui.genPreview.innerHTML = `총 <strong>${included.length}</strong>개`;
    }

    if (inspector) {
      renderComboInspector();
    }
  }

  function inspectorField(label, attrs, value, { rows = 0, placeholder = "" } = {}) {
    const id = `ias-insp-${Math.random().toString(36).slice(2, 8)}`;
    const control = rows
      ? `<textarea class="ias-input" id="${id}" rows="${rows}" ${attrs} placeholder="${escapeAttr(placeholder)}">${escapeHtml(value)}</textarea>`
      : `<input class="ias-input" id="${id}" type="text" ${attrs} value="${escapeAttr(value)}" placeholder="${escapeAttr(placeholder)}">`;
    return `<div class="ias-field"><label for="${id}">${escapeHtml(label)}</label>${control}</div>`;
  }

  function copyFromSelect(kind) {
    const others = genState.chars.map((ch, i) => ({ ch, i })).filter(({ i }) => i !== genActiveChar && charEmotionEntries(genState.chars[i]).length);
    if (!others.length) {
      return "";
    }
    return `<select class="ias-input ias-copy-emos" data-copy="${kind}" aria-label="다른 캐릭터에서 표정 복사"><option value="">다른 캐릭터에서 표정 복사…</option>${others.map(({ ch, i }) => `<option value="${i}">${escapeHtml(charDisplayName(ch, i))} (${charEmotionEntries(ch).length}개)</option>`).join("")}</select>`;
  }

  function renderComboInspector() {
    if (!ui.comboInspector) {
      return;
    }
    const { type, index } = genSelection;
    let html = "";
    if (type === "char" && genState.chars[index]) {
      const ch = genState.chars[index];
      const members = ch.members.map((m, mi) => `
        <div class="ias-insp-member">
          <div class="ias-insp-member-head"><span>인물 ${mi + 2}</span><button type="button" class="ias-icon-btn" data-remove-member="${mi}" aria-label="인물 ${mi + 2} 빼기">${icon("delete", 15)}</button></div>
          ${inspectorField("외형 태그", `data-mfield="appearance" data-mindex="${mi}"`, m.appearance, { rows: 2, placeholder: "예: boy, white hair" })}
          ${inspectorField("표정 (줄 순서가 맞춰져요 · 한 줄이면 고정)", `data-mfield="expressions" data-mindex="${mi}"`, m.expressions, { rows: 2 })}
          ${inspectorField("네거티브", `data-mfield="negative" data-mindex="${mi}"`, m.negative, { rows: 1 })}
        </div>`).join("");
      html = `
        <div class="ias-insp-head"><span class="ias-insp-kicker">캐릭터</span><span class="ias-insp-title">${escapeHtml(charDisplayName(ch, index))}</span></div>
        ${inspectorField("이름 (파일 이름 · 폴더에 들어가요)", 'data-cfield="code" data-autofocus="true"', ch.code, { placeholder: "예: 김춘자" })}
        ${inspectorField("외형 태그", 'data-cfield="appearance"', ch.appearance, { rows: 3, placeholder: "예: girl, black hair, long hair" })}
        ${inspectorField("캐릭터 네거티브", 'data-cfield="negative"', ch.negative, { rows: 2, placeholder: "비우면 없음" })}
        ${members}
        <button type="button" class="ias-btn secondary" data-add-member="1">${icon("add", 14)}<span>같은 그림에 인물 추가</span></button>
        ${copyFromSelect("char")}
        <div class="ias-insp-spacer"></div>
        <button type="button" class="ias-insp-delete" data-delete="char">이 캐릭터 지우기</button>`;
    } else if (type === "bg" && bgOwnerList()?.[index]) {
      const bg = bgOwnerList()[index];
      const bgKicker = genState.bgShared !== false ? "배경 · 모든 캐릭터 공통" : `${charDisplayName(genState.chars[genActiveChar], genActiveChar)} · 배경`;
      html = `
        <div class="ias-insp-head"><span class="ias-insp-kicker">${escapeHtml(bgKicker)}</span><span class="ias-insp-title">${escapeHtml(bgDisplayName(bg, index))}</span></div>
        ${inspectorField("이름", 'data-bfield="code" data-autofocus="true"', bg.code, { placeholder: "예: 교실" })}
        ${inspectorField("태그", 'data-bfield="tags"', bg.tags, { rows: 3, placeholder: "예: classroom, window" })}
        ${inspectorField("네거티브", 'data-bfield="negative"', bg.negative, { rows: 2, placeholder: "비우면 없음" })}
        <div class="ias-insp-spacer"></div>
        <button type="button" class="ias-insp-delete" data-delete="bg">이 배경 지우기</button>`;
    } else if (type === "emo" && emoOwner()) {
      const entries = charEmotionEntries(emoOwner());
      const entry = entries[index];
      if (entry) {
        const kicker = genState.emoShared ? "표정 · 모든 캐릭터 공통" : `${charDisplayName(genState.chars[genActiveChar], genActiveChar)} · 표정`;
        html = `
          <div class="ias-insp-head"><span class="ias-insp-kicker">${escapeHtml(kicker)}</span><span class="ias-insp-title">${escapeHtml(emoDisplayName(entry, index))}</span></div>
          ${inspectorField("이름 (파일 이름에 들어가요)", 'data-efield="name" data-autofocus="true"', entry.name, { placeholder: `비우면 ${index + 1}` })}
          ${inspectorField("태그", 'data-efield="tags"', entry.tags, { rows: 3, placeholder: "예: smiling, open mouth" })}
          ${genState.emoShared ? "" : copyFromSelect("emo")}
          <div class="ias-insp-spacer"></div>
          <button type="button" class="ias-insp-delete" data-delete="emo">이 표정 삭제</button>`;
      }
    }
    if (!html) {
      genSelection = { type: null, index: -1 };
      html = `
        <div class="ias-insp-head"><span class="ias-insp-kicker">조합 전체</span><span class="ias-insp-title">공통 설정</span></div>
        <p class="ias-hint" style="margin-bottom:12px;">칩을 누르면 여기서 태그를 고쳐요.</p>
        ${inspectorField("베이스 프롬프트", 'data-gfield="base"', genState.base, { rows: 3, placeholder: "모든 조합 공통" })}
        ${inspectorField("베이스 네거티브", 'data-gfield="baseNeg"', genState.baseNeg, { rows: 2, placeholder: "비우면 없음" })}
        <div class="ias-stack">
          ${inspectorField("조합 하나당 장수", 'data-gfield="count" inputmode="numeric"', genState.count)}
          ${inspectorField("내보낼 때 파일 하나에 최대 (0 = 제한 없음)", 'data-gfield="split" inputmode="numeric"', genState.split)}
        </div>`;
    }
    ui.comboInspector.innerHTML = html;
  }

  function focusInspector() {
    const target = ui.comboInspector?.querySelector('[data-autofocus="true"]');
    if (target) {
      target.focus();
      target.select?.();
    }
  }

  function comboChanged({ inspector = false } = {}) {
    renderCombo({ inspector });
    scheduleGenSave();
  }

  function handleComboClick(event) {
    const target = event.target instanceof Element ? event.target : null;
    if (!target) {
      return;
    }
    const token = target.closest("[data-token]");
    if (token && ui.nameTemplateInput) {
      const input = ui.nameTemplateInput;
      const text = `{${token.dataset.token}}`;
      const at = input.selectionStart ?? input.value.length;
      const end = input.selectionEnd ?? at;
      input.value = input.value.slice(0, at) + text + input.value.slice(end);
      input.focus();
      input.setSelectionRange(at + text.length, at + text.length);
      input.dispatchEvent(new Event("input", { bubbles: true }));
      return;
    }
    const chip = target.closest(".ias-chip[data-kind]");
    if (chip) {
      const kind = chip.dataset.kind;
      const index = Number(chip.dataset.index);
      if (kind === "char") {
        genActiveChar = index;
      }
      genSelection = isSelected(kind, index) && kind !== "char" ? { type: null, index: -1 } : { type: kind, index };
      renderCombo();
      return;
    }
    const add = target.closest("[data-add]");
    if (add) {
      const kind = add.dataset.add;
      if (kind === "char") {
        genState.chars.push({ code: "", appearance: "", expressions: "", negative: "", members: [], bgs: genState.bgShared !== false ? [] : genState.bgs.map((b) => ({ ...b })) });
        genActiveChar = genState.chars.length - 1;
        genSelection = { type: "char", index: genActiveChar };
      } else if (kind === "bg") {
        const list = bgOwnerList();
        if (!list) return;
        list.push({ code: "", tags: "", negative: "" });
        genSelection = { type: "bg", index: list.length - 1 };
      } else if (kind === "emo" && emoOwner()) {
        const ch = emoOwner();
        const entries = charEmotionEntries(ch);
        entries.push({ name: `표정${entries.length + 1}`, tags: "" });
        setCharEmotionEntries(ch, entries);
        genSelection = { type: "emo", index: entries.length - 1 };
      }
      comboChanged({ inspector: true });
      focusInspector();
      return;
    }
    const card = target.closest(".ias-ccard[data-key]");
    if (card) {
      const key = card.dataset.key;
      const set = new Set(genState.excluded);
      if (set.has(key)) {
        set.delete(key);
      } else {
        set.add(key);
        tourEvent("combo-excluded");
      }
      genState.excluded = Array.from(set);
      comboChanged();
      return;
    }
    const del = target.closest("[data-delete]");
    if (del) {
      const { type, index } = genSelection;
      if (type === "char") {
        genState.chars.splice(index, 1);
        genActiveChar = Math.max(0, Math.min(genActiveChar, genState.chars.length - 1));
      } else if (type === "bg") {
        bgOwnerList()?.splice(index, 1);
      } else if (type === "emo" && emoOwner()) {
        const ch = emoOwner();
        const entries = charEmotionEntries(ch);
        entries.splice(index, 1);
        setCharEmotionEntries(ch, entries);
      }
      genSelection = { type: null, index: -1 };
      comboChanged({ inspector: true });
      return;
    }
    if (target.closest("[data-add-member]")) {
      const ch = genState.chars[genSelection.index];
      if (ch) {
        ch.members.push({ appearance: "", expressions: "", negative: "" });
        comboChanged({ inspector: true });
      }
      return;
    }
    const removeMember = target.closest("[data-remove-member]");
    if (removeMember) {
      const ch = genState.chars[genSelection.index];
      if (ch) {
        ch.members.splice(Number(removeMember.dataset.removeMember), 1);
        comboChanged({ inspector: true });
      }
    }
  }

  function handleComboInput(event) {
    const el = event.target;
    if (!(el instanceof Element)) {
      return;
    }
    if (el === ui.nameTemplateInput) {
      genTemplateEditing = true;
      const naming = { ...genState.naming };
      if (el.value.trim()) naming.template = el.value; else delete naming.template;
      genState.naming = Store.normalizeComboNaming(naming);
      renderCombo({ inspector: false });
      scheduleGenSave();
      return;
    }
    const value = el.value ?? "";
    const { type, index } = genSelection;
    if (el.dataset.gfield) {
      genState[el.dataset.gfield] = value;
    } else if (el.dataset.cfield && genState.chars[index]) {
      genState.chars[index][el.dataset.cfield] = value;
      if (el.dataset.cfield === "code" && value.trim()) {
        tourEvent("combo-char-added");
      }
    } else if (el.dataset.mfield && genState.chars[index]) {
      const member = genState.chars[index].members[Number(el.dataset.mindex)];
      if (member) {
        member[el.dataset.mfield] = value;
      }
    } else if (el.dataset.bfield && bgOwnerList()?.[index]) {
      bgOwnerList()[index][el.dataset.bfield] = value;
      if (el.dataset.bfield === "code" && value.trim()) {
        tourEvent("combo-bg-added");
      }
    } else if (el.dataset.efield && type === "emo" && emoOwner()) {
      const ch = emoOwner();
      const entries = charEmotionEntries(ch);
      if (entries[index]) {
        entries[index][el.dataset.efield] = value.replace(/[=\n]/g, el.dataset.efield === "name" ? "" : " ");
        setCharEmotionEntries(ch, entries);
        if (el.dataset.efield === "tags" && value.trim()) {
          tourEvent("combo-emo-tagged");
        }
      }
    } else {
      return;
    }
    // Keep the inspector (and the caret) as is; refresh chips, cards, totals.
    renderCombo({ inspector: false });
    const title = ui.comboInspector?.querySelector(".ias-insp-title");
    if (title && (el.dataset.cfield === "code" || el.dataset.bfield === "code" || el.dataset.efield === "name")) {
      title.textContent = value.trim() || title.textContent;
    }
    scheduleGenSave();
  }

  function handleComboChange(event) {
    const el = event.target;
    if (!(el instanceof Element)) {
      return;
    }
    if (el === ui.comboNameSelect) {
      if (el.value === "template") {
        // Start from the rule in use, written out as a template.
        if (!genState.naming.template) {
          const n = Store.normalizeComboNaming(genState.naming);
          const word = { char: "{캐릭터}", bg: "{배경}", emo: "{표정}" };
          genState.naming = { ...n, template: n.nameOrder.filter((a) => n.nameOn[a]).map((a) => word[a]).join(n.nameSep) };
        }
        genTemplateEditing = true;
        comboChanged();
        ui.nameTemplateInput?.focus();
        return;
      }
      const preset = NAME_PRESETS.find((p) => p.id === el.value);
      if (preset) {
        genTemplateEditing = false;
        genState.naming = presetNaming(preset);
        comboChanged();
      }
      return;
    }
    if (el.matches("[data-shared-bg]")) {
      setSharedBackgrounds(el.checked);
      setStatus(el.checked ? "배경을 모든 캐릭터가 같이 써요." : "이제 캐릭터마다 배경을 따로 정해요.", "ok");
      comboChanged({ inspector: true });
      return;
    }
    if (el.matches("[data-shared-emo]")) {
      setSharedEmotions(el.checked);
      setStatus(el.checked ? "표정을 모든 캐릭터가 같이 써요." : "이제 캐릭터마다 표정을 따로 정해요.", "ok");
      comboChanged({ inspector: true });
      return;
    }
    if (el.classList.contains("ias-copy-emos") && el.value !== "") {
      const from = genState.chars[Number(el.value)];
      const to = genState.chars[genActiveChar];
      if (from && to) {
        const mine = charEmotionEntries(to);
        const names = new Set(mine.map((e) => e.name).filter(Boolean));
        const added = charEmotionEntries(from).filter((e) => !e.name || !names.has(e.name));
        setCharEmotionEntries(to, [...mine, ...added]);
        setStatus(`${charDisplayName(from, Number(el.value))}의 표정 ${added.length}개를 가져왔어요.`, "ok");
        comboChanged({ inspector: true });
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Guided tours ("안내"): a right-side checklist per screen + a coach bubble
  // that follows the real element. The highlight ring is measured from the
  // element's own box and border-radius every frame, so it always fits.
  // ---------------------------------------------------------------------------
  const TOUR_STORAGE_KEY = "naiAutoSaver.tours";
  const TOURS = {
    gen: {
      title: "조합 안내",
      steps: [
        { id: "char", title: "캐릭터 넣기", short: "+를 눌러 이름을 써요", body: "캐릭터 옆 <b>+</b>를 누르고, 오른쪽 칸에 이름을 써 보세요. 예: 김춘자", target: "combo-add-char", event: "combo-char-added" },
        { id: "bg", title: "배경 넣기", short: "모든 캐릭터가 같이 써요", body: "배경 옆 <b>+</b>를 누르고 배경 이름을 써요. 태그는 오른쪽 칸에 쓰면 돼요.", target: "combo-add-bg", event: "combo-bg-added" },
        { id: "emo", title: "표정 넣고 태그 쓰기", short: "칩을 누르면 오른쪽에서 고쳐요", body: "표정 옆 <b>+</b>를 누르고, 오른쪽에 이름과 태그를 써요. 예: 웃음 / smiling", target: "combo-add-emo", event: "combo-emo-tagged" },
        { id: "exclude", title: "필요 없는 조합 빼기", short: "카드를 누르면 빠져요", body: "카드를 한 번 눌러 보세요. 빈 동그라미가 되면 그 조합은 안 만들어요. 다시 누르면 돌아와요.", target: "combo-card", fallback: "combo-cards", event: "combo-excluded" },
        { id: "queue", title: "대기열에 넣기", short: "파란 버튼을 누르면 끝나요", body: "오른쪽 위 파란 버튼을 누르면 만들어질 그림이 전부 대기열에 들어가요.", target: "combo-queue", event: "combo-queued" },
      ],
    },
    auto: {
      title: "바로 생성 안내",
      steps: [
        { id: "name", title: "저장 이름 정하기", short: "_ 앞부분이 캐릭터 폴더가 돼요", body: "저장 이름을 <b>김춘자_교실</b>처럼 쓰면 김춘자 폴더에 저장돼요.", target: "auto-name", event: "auto-named" },
        { id: "prompt", title: "프롬프트 고르기", short: "보통은 NovelAI 그대로면 돼요", body: "보통은 <b>NovelAI 그대로</b>면 돼요. 여기서 따로 쓰고 싶을 때만 <b>직접 쓰기</b>를 눌러요.", target: "auto-prompt", event: "auto-prompt" },
        { id: "start", title: "생성 시작", short: "정한 장수만큼 생성하고 저장해요", body: "장수를 정하고 오른쪽 위 파란 버튼을 누르면 끝날 때까지 알아서 생성하고 저장해요.", target: "auto-start" },
      ],
    },
    queue: {
      title: "대기열 안내",
      steps: [
        { id: "list", title: "대기열 보기", short: "위에서부터 차례로 생성해요", body: "조합에서 넣은 항목이 여기 쌓여요. 항목을 누르면 오른쪽에서 고쳐요. 맨 위 <b>공통 베이스</b>는 모든 항목에 같이 들어가요.", target: "queue-list" },
        { id: "add", title: "지금 프롬프트 넣기", short: "＋를 누르면 한 줄 들어가요", body: "오른쪽 위 <b>＋</b>를 누르면 NovelAI에 지금 쓰여 있는 프롬프트가 한 줄 들어가요. 한꺼번에 바꾸기는 <b>⋯</b> 에 있어요.", target: "queue-add" },
        { id: "run", title: "생성 시작", short: "다른 탭에 가도 계속돼요", body: "누르면 위에서부터 차례로 생성해요. 진행 상황은 위쪽 막대와 접었을 때 알약에 보여요.", target: "queue-run" },
      ],
    },
    memo: {
      title: "메모 안내",
      steps: [
        { id: "new", title: "새 메모", short: "오른쪽 위 연필을 눌러요", body: "오른쪽 위 연필을 누르면 새 메모가 생겨요. ⋯ 에서 <b>지금 NovelAI 값으로</b> 바로 만들 수도 있어요.", target: "memo-new", event: "memo-new" },
        { id: "save", title: "쓰면 바로 저장", short: "저장 버튼 없이 바로 저장돼요", body: "이름과 프롬프트를 쓰면 바로 저장돼요. 쓴 칸만 메모에 들어가요.", target: "memo-editor", event: "memo-saved" },
        { id: "trash", title: "실수로 지웠다면", short: "30일 동안 되살릴 수 있어요", body: "지운 메모와 고치기 전 버전은 최근 삭제됨에 30일 동안 남아요.", target: "memo-trash" },
      ],
    },
    settings: {
      title: "설정 안내",
      steps: [
        { id: "appearance", title: "모양 고르기", short: "자동·라이트·다크 중에 골라요", body: "자동이면 컴퓨터 설정을 따라가요.", target: "settings-appearance" },
        { id: "folders", title: "폴더 정리", short: "날짜별·캐릭터별로 나눠요", body: "아래 경로처럼 저장돼요. 스위치로 날짜·캐릭터 폴더를 켜고 끌 수 있어요.", target: "settings-folders" },
        { id: "backup", title: "백업", short: "메모가 날아가지 않게 지켜요", body: "자동 백업을 켜 두면 메모·대기열·설정이 파일로 남아요.", target: "settings-backup" },
      ],
    },
  };

  let tourState = { done: {}, seen: {}, autoOpen: true };
  const tourRun = { tab: null, index: -1, raf: 0, successTimer: null, sheetOpen: false };

  function normalizeTourState(raw) {
    const s = raw && typeof raw === "object" ? raw : {};
    const done = {};
    for (const [tab, list] of Object.entries(s.done || {})) {
      if (TOURS[tab] && Array.isArray(list)) {
        done[tab] = list.filter((id) => TOURS[tab].steps.some((step) => step.id === id));
      }
    }
    return { done, seen: s.seen && typeof s.seen === "object" ? { ...s.seen } : {}, autoOpen: s.autoOpen !== false };
  }

  async function loadTourState() {
    try {
      const result = await storageGet("local", [TOUR_STORAGE_KEY]);
      tourState = normalizeTourState(result[TOUR_STORAGE_KEY]);
    } catch (error) {
      tourState = normalizeTourState(null);
    }
    renderHelpProgress();
  }

  function persistTourState() {
    void storageSet("local", { [TOUR_STORAGE_KEY]: tourState });
    renderHelpProgress();
  }

  function tourDone(tab) {
    return new Set(tourState.done[tab] || []);
  }

  function tourProgressText(tab) {
    const tour = TOURS[tab];
    if (!tour) {
      return "";
    }
    const done = tourDone(tab).size;
    return done >= tour.steps.length ? "✓" : `${done}/${tour.steps.length}`;
  }

  function renderHelpProgress() {
    if (ui.helpProgress) {
      // Progress lives in the 안내 sheet; a number here read like a badge.
      ui.helpProgress.textContent = "";
    }
  }

  // Called by setActiveTab and when the panel opens.
  function onTabShown(name) {
    renderHelpProgress();
    if (tourRun.index >= 0 && tourRun.tab !== name) {
      endTourRun({ keepSheet: false });
    }
    if (tourRun.sheetOpen) {
      openTourSheet(name);
      return;
    }
    if (!panelCollapsed && tourState.autoOpen && TOURS[name] && !tourState.seen[name] && tourLoaded) {
      tourState.seen[name] = true;
      persistTourState();
      openTourSheet(name);
    }
  }
  let tourLoaded = false;

  function tourEvent(name) {
    if (tourRun.index < 0) {
      // Even without a running tour, doing the thing counts as learning it.
      for (const [tab, tour] of Object.entries(TOURS)) {
        const step = tour.steps.find((s) => s.event === name);
        if (step && tab === activeTab && tourDone(tab).size > 0) {
          markStepDone(tab, step.id);
        }
      }
      return;
    }
    const step = TOURS[tourRun.tab]?.steps[tourRun.index];
    if (!step || step.event !== name || tourRun.successTimer) {
      return;
    }
    markStepDone(tourRun.tab, step.id);
    renderTourBubble({ success: true });
    tourRun.successTimer = setTimeout(() => {
      tourRun.successTimer = null;
      goToStep(tourRun.index + 1);
    }, 1100);
  }

  function markStepDone(tab, id) {
    const set = tourDone(tab);
    if (!set.has(id)) {
      set.add(id);
      tourState.done[tab] = Array.from(set);
      persistTourState();
    }
  }

  function tourTargetElement(step) {
    if (!panelShadow || !step) {
      return null;
    }
    const pick = (name) => (name ? panelShadow.querySelector(`[data-tour="${name}"]`) : null);
    const el = pick(step.target) || pick(step.fallback);
    return el && el.getClientRects().length ? el : null;
  }

  function ensureTourLayer() {
    if (ui.tourLayer || !ui.card) {
      return;
    }
    const layer = document.createElement("div");
    layer.className = "ias-tour-layer";
    layer.innerHTML = '<div class="ias-tour-hole" hidden></div><div class="ias-tour-bubble" role="dialog" aria-live="polite" hidden></div><aside class="ias-tour-sheet" role="dialog" aria-label="안내" hidden></aside>';
    ui.card.append(layer);
    ui.tourLayer = layer;
    ui.tourHole = layer.querySelector(".ias-tour-hole");
    ui.tourBubble = layer.querySelector(".ias-tour-bubble");
    ui.tourSheet = layer.querySelector(".ias-tour-sheet");
    layer.addEventListener("click", handleTourClick);
    layer.addEventListener("change", handleTourChange);
  }

  function openTourSheet(tab = activeTab) {
    ensureTourLayer();
    const tour = TOURS[tab];
    if (!tour || !ui.tourSheet) {
      return;
    }
    tourRun.sheetOpen = true;
    if (!tourState.seen[tab]) {
      tourState.seen[tab] = true;
      persistTourState();
    }
    const done = tourDone(tab);
    const firstTodo = tour.steps.findIndex((s) => !done.has(s.id));
    const steps = tour.steps.map((step, i) => {
      const state = done.has(step.id) ? "done" : i === firstTodo ? "current" : "todo";
      const marker = state === "done"
        ? '<svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10" fill="var(--success)"/><path d="M7.5 12.5l3 3 6-6.5" fill="none" stroke="#000" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>'
        : `<span class="ias-tstep-num">${i + 1}</span>`;
      return `<li class="ias-tstep" data-state="${state}"><button type="button" data-tour-go="${i}">${marker}<span class="ias-tstep-text"><span class="ias-tstep-title">${escapeHtml(step.title)}</span><span class="ias-tstep-short">${escapeHtml(step.short)}</span></span></button></li>`;
    }).join("");
    const pct = Math.round((done.size / tour.steps.length) * 100);
    const primaryLabel = done.size === 0 ? "따라 하기" : firstTodo < 0 ? "한 번 더 보기" : `${firstTodo + 1}단계부터 이어서`;
    const others = Object.entries(TOURS)
      .filter(([name]) => name !== tab)
      .map(([name, t]) => `<button type="button" class="ias-tother" data-tour-tab="${name}">${escapeHtml(TAB_TITLES[name] || t.title)}<span>${tourProgressText(name)}</span></button>`)
      .join("");
    ui.tourSheet.innerHTML = `
      <div class="ias-tsheet-head">
        <div><div class="ias-tsheet-title">${escapeHtml(tour.title)}</div><div class="ias-tsheet-sub">직접 따라 하면서 배워요 · 약 1분</div></div>
        <button type="button" class="ias-tsheet-close" data-tour-close aria-label="안내 닫기">${icon("close", 12)}</button>
      </div>
      <div class="ias-tsheet-progress"><div><span>진행</span><span><b>${done.size}</b> / ${tour.steps.length}</span></div><div class="ias-tbar"><span style="width:${pct}%"></span></div></div>
      <ol class="ias-tsteps">${steps}</ol>
      <div class="ias-tsheet-actions">
        <button type="button" class="ias-btn" data-tour-start="${firstTodo < 0 ? 0 : firstTodo}">${escapeHtml(primaryLabel)}</button>
        ${done.size ? '<button type="button" class="ias-btn secondary" data-tour-reset>처음부터</button>' : ""}
      </div>
      <div class="ias-tsheet-foot">
        <div class="ias-tsheet-label">다른 화면 안내</div>
        <div class="ias-tothers">${others}</div>
        <label class="ias-tsheet-auto"><span>처음 여는 화면은 자동 안내</span><span class="ias-switch"><input type="checkbox" data-tour-auto ${tourState.autoOpen ? "checked" : ""}><span class="ias-slider"></span></span></label>
      </div>`;
    ui.tourSheet.hidden = false;
    ui.helpButton?.setAttribute("aria-expanded", "true");
  }

  function closeTourSheet() {
    tourRun.sheetOpen = false;
    if (ui.tourSheet) {
      ui.tourSheet.hidden = true;
    }
    ui.helpButton?.setAttribute("aria-expanded", "false");
  }

  function startTour(tab, index = 0) {
    closeTourSheet();
    tourRun.tab = tab;
    if (tab !== activeTab) {
      setActiveTab(tab);
    }
    goToStep(index);
  }

  function goToStep(index) {
    const tour = TOURS[tourRun.tab];
    if (!tour || index >= tour.steps.length) {
      const tab = tourRun.tab;
      endTourRun();
      if (tab) {
        setStatus(`${tour ? tour.title.replace(" 안내", "") : ""} 안내를 다 봤어요. 왼쪽 아래 안내에서 언제든 다시 볼 수 있어요.`, "ok");
      }
      return;
    }
    tourRun.index = Math.max(0, index);
    ensureTourLayer();
    renderTourBubble();
    if (!tourRun.raf) {
      const tick = () => {
        tourRun.raf = 0;
        if (tourRun.index < 0) {
          return;
        }
        positionTour();
        tourRun.raf = requestAnimationFrame(tick);
      };
      tourRun.raf = requestAnimationFrame(tick);
    }
  }

  function endTourRun({ keepSheet = false } = {}) {
    tourRun.index = -1;
    tourRun.tab = null;
    if (tourRun.raf) {
      cancelAnimationFrame(tourRun.raf);
      tourRun.raf = 0;
    }
    if (tourRun.successTimer) {
      clearTimeout(tourRun.successTimer);
      tourRun.successTimer = null;
    }
    if (ui.tourHole) {
      ui.tourHole.hidden = true;
    }
    if (ui.tourBubble) {
      ui.tourBubble.hidden = true;
    }
    if (!keepSheet) {
      closeTourSheet();
    }
  }

  function renderTourBubble({ success = false } = {}) {
    const tour = TOURS[tourRun.tab];
    const step = tour?.steps[tourRun.index];
    if (!step || !ui.tourBubble) {
      return;
    }
    const segs = tour.steps.map((_, i) => `<span data-on="${i <= tourRun.index}"></span>`).join("");
    const last = tourRun.index === tour.steps.length - 1;
    ui.tourBubble.innerHTML = `
      <span class="ias-tbubble-arrow" aria-hidden="true"></span>
      <div class="ias-tbubble-top"><span class="ias-tbubble-count">${tourRun.index + 1} / ${tour.steps.length}</span><span class="ias-tbubble-segs" aria-hidden="true">${segs}</span></div>
      ${success
        ? `<div class="ias-tbubble-success"><svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10" fill="var(--success)"/><path d="M7.5 12.5l3 3 6-6.5" fill="none" stroke="#000" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg><b>잘했어요!</b></div>`
        : `<div class="ias-tbubble-title">${escapeHtml(step.title)}</div><div class="ias-tbubble-body">${step.body}</div>${step.event ? '<div class="ias-tbubble-hint">해보면 저절로 다음으로 넘어가요</div>' : ""}`}
      <div class="ias-tbubble-actions">
        <button type="button" class="ias-tbubble-skip" data-tour-skip>안내 건너뛰기</button>
        ${tourRun.index > 0 ? '<button type="button" class="ias-tbubble-prev" data-tour-prev>‹ 이전</button>' : ""}
        <button type="button" class="ias-btn ${step.event && !success ? "secondary" : ""}" data-tour-next>${last ? "끝내기" : "다음 ›"}</button>
      </div>`;
    ui.tourBubble.hidden = false;
    ui.tourBubble.dataset.success = String(success);
    positionTour();
  }

  function positionTour() {
    const step = TOURS[tourRun.tab]?.steps[tourRun.index];
    if (!step || !ui.card || !ui.tourBubble) {
      return;
    }
    const cardRect = ui.card.getBoundingClientRect();
    const target = tourTargetElement(step);
    const bubble = ui.tourBubble;
    const bw = bubble.offsetWidth || 300;
    const bh = bubble.offsetHeight || 160;
    if (!target) {
      ui.tourHole.hidden = true;
      bubble.style.left = `${Math.max(12, (cardRect.width - bw) / 2)}px`;
      bubble.style.top = `${Math.max(12, (cardRect.height - bh) / 2)}px`;
      bubble.dataset.place = "center";
      return;
    }
    const r = target.getBoundingClientRect();
    const radius = getComputedStyle(target).borderRadius || "8px";
    const hole = ui.tourHole;
    hole.hidden = false;
    hole.style.left = `${r.left - cardRect.left}px`;
    hole.style.top = `${r.top - cardRect.top}px`;
    hole.style.width = `${r.width}px`;
    hole.style.height = `${r.height}px`;
    hole.style.borderRadius = radius;
    hole.dataset.success = bubble.dataset.success;
    const gap = 14;
    const below = r.bottom - cardRect.top + gap;
    const above = r.top - cardRect.top - gap - bh;
    const place = below + bh <= cardRect.height - 8 || above < 8 ? "below" : "above";
    const top = place === "below" ? Math.min(below, cardRect.height - bh - 8) : above;
    const centerX = r.left - cardRect.left + r.width / 2;
    const left = Math.max(10, Math.min(cardRect.width - bw - 10, centerX - bw / 2));
    bubble.style.left = `${left}px`;
    bubble.style.top = `${Math.max(8, top)}px`;
    bubble.dataset.place = place;
    const arrow = bubble.querySelector(".ias-tbubble-arrow");
    if (arrow) {
      arrow.style.left = `${Math.max(14, Math.min(bw - 26, centerX - left - 6))}px`;
    }
  }

  function handleTourClick(event) {
    const t = event.target instanceof Element ? event.target : null;
    if (!t) {
      return;
    }
    if (t.closest("[data-tour-close]")) {
      closeTourSheet();
    } else if (t.closest("[data-tour-start]")) {
      startTour(activeTab, Number(t.closest("[data-tour-start]").dataset.tourStart) || 0);
    } else if (t.closest("[data-tour-go]")) {
      startTour(activeTab, Number(t.closest("[data-tour-go]").dataset.tourGo) || 0);
    } else if (t.closest("[data-tour-reset]")) {
      tourState.done[activeTab] = [];
      persistTourState();
      startTour(activeTab, 0);
    } else if (t.closest("[data-tour-tab]")) {
      const tab = t.closest("[data-tour-tab]").dataset.tourTab;
      setActiveTab(tab);
      openTourSheet(tab);
    } else if (t.closest("[data-tour-skip]")) {
      endTourRun();
    } else if (t.closest("[data-tour-prev]")) {
      goToStep(tourRun.index - 1);
    } else if (t.closest("[data-tour-next]")) {
      const step = TOURS[tourRun.tab]?.steps[tourRun.index];
      if (step && !step.event) {
        markStepDone(tourRun.tab, step.id);
      }
      goToStep(tourRun.index + 1);
    }
  }

  function handleTourChange(event) {
    const t = event.target;
    if (t instanceof Element && t.matches("[data-tour-auto]")) {
      tourState.autoOpen = Boolean(t.checked);
      persistTourState();
    }
  }

  function toggleTourSheet() {
    if (tourRun.index >= 0) {
      endTourRun();
      return;
    }
    if (tourRun.sheetOpen) {
      closeTourSheet();
    } else {
      openTourSheet(activeTab);
    }
  }

  // ---------------------------------------------------------------------------
  // prompt memos
  // ---------------------------------------------------------------------------
  const MEMO_FIELDS = [
    { key: "basePrompt", label: "베이스 프롬프트", input: "memoBaseInput", check: "memoBaseCheck", auto: "autoBaseInput" },
    { key: "baseNegativePrompt", label: "베이스 네거티브", input: "memoBaseNegInput", check: "memoBaseNegCheck", auto: "autoBaseNegInput" },
    { key: "characterPrompt", label: "캐릭터 태그", input: "memoCharInput", check: "memoCharCheck", auto: "autoCharInput" },
    { key: "characterNegativePrompt", label: "캐릭터 네거티브", input: "memoCharNegInput", check: "memoCharNegCheck", auto: "autoCharNegInput" },
  ];

  function createMemoId() {
    try {
      if (globalThis.crypto?.randomUUID) {
        return globalThis.crypto.randomUUID();
      }
    } catch (error) {
      void error;
    }
    return `memo-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  }

  function normalizeMemoItem(raw, index = 0) {
    const source = raw && typeof raw === "object" ? raw : {};
    const rawValues = source.values && typeof source.values === "object" ? source.values : {};
    const values = {};
    for (const field of MEMO_FIELDS) {
      if (Object.prototype.hasOwnProperty.call(rawValues, field.key)) {
        values[field.key] = String(rawValues[field.key] == null ? "" : rawValues[field.key]);
      }
    }
    return {
      id: String(source.id || createMemoId()),
      name: String(source.name || `메모 ${index + 1}`).trim().slice(0, 80) || `메모 ${index + 1}`,
      values,
      createdAt: Number(source.createdAt) || Date.now(),
      updatedAt: Number(source.updatedAt) || Number(source.createdAt) || Date.now(),
    };
  }

  function normalizeMemoState(raw) {
    const source = raw && typeof raw === "object" ? raw : {};
    const items = Array.isArray(source.items)
      ? source.items.map((item, index) => normalizeMemoItem(item, index)).filter((item) => Object.keys(item.values).length)
      : [];
    return { schemaVersion: 1, items };
  }

  async function loadMemoState() {
    try {
      const result = await storageGet("local", [MEMO_STORAGE_KEY, MEMO_TRASH_KEY]);
      memoState = normalizeMemoState(result[MEMO_STORAGE_KEY]);
      memoTrash = normalizeMemoTrash(result[MEMO_TRASH_KEY]);
      memoLoaded = true;
    } catch (error) {
      // Leave memoLoaded=false so a failed read can never be persisted back
      // over the real list as an empty one.
      memoState = { schemaVersion: 1, items: [] };
    }
    renderMemoList();
    renderMemoTrash();
    restoreMemoDraft();
  }

  // Reports failures instead of pretending the save worked.
  async function persistMemoState() {
    memoState = normalizeMemoState(memoState);
    if (!memoLoaded) {
      setStatus("메모 목록을 아직 못 읽어서 저장을 멈췄어요. 페이지를 새로고침해 주세요.", "warn");
      renderMemoList();
      return { ok: false, error: "not-loaded" };
    }
    const result = await storageSet("local", { [MEMO_STORAGE_KEY]: memoState });
    renderMemoList();
    if (result.ok) {
      scheduleAutoBackup(60000);
    }
    if (!result.ok) {
      setStatus(result.mirrored
        ? "확장 저장소에 저장하지 못해 임시 보관했어요. 페이지를 새로고침하면 자동으로 저장돼요."
        : "메모 저장에 실패했어요. 지금 내용을 복사해 두세요.", "warn");
    }
    return result;
  }

  function normalizeMemoTrash(raw) {
    const source = raw && typeof raw === "object" && Array.isArray(raw.items) ? raw.items : [];
    const cutoff = Date.now() - MEMO_TRASH_DAYS * 24 * 60 * 60 * 1000;
    const items = [];
    for (const entry of source) {
      if (!entry || typeof entry !== "object" || !entry.item) {
        continue;
      }
      const deletedAt = Number(entry.deletedAt) || 0;
      if (deletedAt < cutoff) {
        continue;
      }
      const item = normalizeMemoItem(entry.item);
      if (!Object.keys(item.values).length) {
        continue;
      }
      items.push({
        trashId: String(entry.trashId || `${item.id}-${deletedAt}`),
        kind: entry.kind === "edit" ? "edit" : "delete",
        deletedAt,
        item,
      });
    }
    items.sort((a, b) => b.deletedAt - a.deletedAt);
    return { items: items.slice(0, MEMO_TRASH_MAX) };
  }

  async function moveMemoToTrash(item, kind = "delete") {
    const deletedAt = Date.now();
    memoTrash = normalizeMemoTrash({
      items: [
        { trashId: `${item.id}-${deletedAt}-${kind}`, kind, deletedAt, item },
        ...memoTrash.items,
      ],
    });
    return storageSet("local", { [MEMO_TRASH_KEY]: memoTrash });
  }

  async function restoreMemoFromTrash(trashId) {
    const entry = memoTrash.items.find((e) => e.trashId === trashId);
    if (!entry) {
      return;
    }
    const exists = memoState.items.some((item) => item.id === entry.item.id);
    const now = Date.now();
    const restored = normalizeMemoItem(exists
      ? { ...entry.item, id: createMemoId(), name: `${entry.item.name} (이전 버전)`.slice(0, 80), createdAt: now, updatedAt: now }
      : { ...entry.item, updatedAt: now });
    memoState.items.unshift(restored);
    memoTrash = { items: memoTrash.items.filter((e) => e.trashId !== trashId) };
    const result = await persistMemoState();
    if (result.ok) {
      await storageSet("local", { [MEMO_TRASH_KEY]: memoTrash });
      setStatus(`“${restored.name}” 메모를 복원했어요.`, "ok");
    }
    renderMemoTrash();
  }

  async function purgeMemoFromTrash(trashId) {
    memoTrash = { items: memoTrash.items.filter((e) => e.trashId !== trashId) };
    await storageSet("local", { [MEMO_TRASH_KEY]: memoTrash });
    renderMemoTrash();
  }

  function formatShortDate(ts) {
    const d = new Date(ts);
    const pad = (n) => String(n).padStart(2, "0");
    return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }


  // --- memo editor draft (survives reloads / dead extension context) -------
  let memoDraftTimer = null;
  function readPageLocal(key) {
    try {
      const raw = window.localStorage.getItem(key);
      return raw ? JSON.parse(raw) : null;
    } catch (error) {
      return null;
    }
  }
  function writePageLocal(key, value) {
    try {
      if (value == null) {
        window.localStorage.removeItem(key);
      } else {
        window.localStorage.setItem(key, JSON.stringify(value));
      }
      return true;
    } catch (error) {
      return false;
    }
  }


  function scheduleMemoDraftSave() {
    if (memoDraftTimer) {
      clearTimeout(memoDraftTimer);
    }
    memoDraftTimer = setTimeout(() => {
      memoDraftTimer = null;
      writePageLocal(MEMO_DRAFT_LS_KEY, snapshotMemoDraft());
    }, 300);
  }

  function clearMemoDraft() {
    if (memoDraftTimer) {
      clearTimeout(memoDraftTimer);
      memoDraftTimer = null;
    }
    writePageLocal(MEMO_DRAFT_LS_KEY, null);
  }


  function createMemoExportEnvelope() {
    return {
      app: "NAI-Auto-Saver",
      memoSchemaVersion: 1,
      exportedAt: new Date().toISOString(),
      memos: normalizeMemoState(memoState),
    };
  }

  function parseMemoImportText(text) {
    let parsed;
    try {
      parsed = JSON.parse(String(text == null ? "" : text));
    } catch (error) {
      return { ok: false, error: "메모 JSON 형식이 올바르지 않아요." };
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { ok: false, error: "메모 파일 구조를 확인할 수 없어요." };
    }
    if (parsed.app && parsed.app !== "NAI-Auto-Saver") {
      return { ok: false, error: "NAI AutoSaver 메모 파일이 아니에요." };
    }
    const rawState = parsed.memos && typeof parsed.memos === "object"
      ? parsed.memos
      : parsed.memoState && typeof parsed.memoState === "object"
        ? parsed.memoState
        : parsed;
    if (!Array.isArray(rawState.items)) {
      return { ok: false, error: "파일에 메모 목록이 없어요." };
    }
    const state = normalizeMemoState(rawState);
    if (rawState.items.length > 0 && state.items.length === 0) {
      return { ok: false, error: "가져올 수 있는 메모가 없어요." };
    }
    return { ok: true, state };
  }

  function exportMemos() {
    if (!memoState.items.length) {
      setStatus("내보낼 메모가 없어요.", "warn");
      return;
    }
    downloadJson(createMemoExportEnvelope(), `nai-auto-saver-memos-${Date.now()}.json`);
    setStatus(`메모 ${memoState.items.length}개를 파일로 내보냈어요.`, "ok");
  }

  async function importMemosFromFile(file) {
    if (!file) {
      return;
    }
    try {
      const parsed = parseMemoImportText(await file.text());
      if (!parsed.ok) {
        setStatus(parsed.error, "warn");
        return;
      }
      const previousIds = new Set(memoState.items.map((item) => item.id));
      const importedIds = new Set(parsed.state.items.map((item) => item.id));
      const addedCount = parsed.state.items.filter((item) => !previousIds.has(item.id)).length;
      const updatedCount = parsed.state.items.length - addedCount;
      memoState = normalizeMemoState({
        schemaVersion: 1,
        items: [
          ...parsed.state.items,
          ...memoState.items.filter((item) => !importedIds.has(item.id)),
        ],
      });
      resetMemoDraft();
      await persistMemoState();
      const detail = [
        addedCount ? `추가 ${addedCount}개` : "",
        updatedCount ? `갱신 ${updatedCount}개` : "",
      ].filter(Boolean).join(", ");
      setStatus(`메모를 가져왔어요. (${detail || "변경 없음"}, 전체 ${memoState.items.length}개)`, "ok");
    } catch (error) {
      setStatus("메모 파일을 가져오지 못했어요.", "warn");
    }
  }

  function memoFieldNames(item) {
    return MEMO_FIELDS
      .filter((field) => Object.prototype.hasOwnProperty.call(item.values || {}, field.key))
      .map((field) => field.label);
  }

  function memoPreview(item) {
    for (const field of MEMO_FIELDS) {
      const value = item.values?.[field.key];
      if (typeof value === "string" && value.trim()) {
        return value.trim().replace(/\s+/g, " ").slice(0, 120);
      }
    }
    return "내용 없음";
  }

  // --- memo editor (list | detail, saves as you type) -------------------------
  let memoView = "edit"; // "edit" | "trash"
  let memoAutosaveTimer = null;
  let memoTrashTakenFor = null; // the memo id whose "before" version is already in the trash
  let memoLoadingEditor = false;
  let memoSearchQuery = "";

  function memoEditorValues() {
    const values = {};
    for (const field of MEMO_FIELDS) {
      const value = ui[field.input]?.value || "";
      if (value.trim()) {
        values[field.key] = value;
      }
    }
    return values;
  }

  function fillMemoEditor(name, values = {}) {
    memoLoadingEditor = true;
    if (ui.memoNameInput) {
      ui.memoNameInput.value = name || "";
    }
    for (const field of MEMO_FIELDS) {
      if (ui[field.input]) {
        ui[field.input].value = String(values[field.key] || "");
      }
    }
    memoLoadingEditor = false;
  }

  function resetMemoDraft({ keepValues = false } = {}) {
    flushMemoAutosave();
    selectedMemoId = null;
    memoTrashTakenFor = null;
    if (!keepValues) {
      clearMemoDraft();
      fillMemoEditor("", {});
    }
    memoView = "edit";
    renderMemoEditorState();
    renderMemoList();
  }

  function renderMemoEditorState() {
    const item = memoState.items.find((entry) => entry.id === selectedMemoId) || null;
    if (ui.memoEditorPanel) {
      ui.memoEditorPanel.hidden = memoView !== "edit";
    }
    if (ui.memoTrashPanel) {
      ui.memoTrashPanel.hidden = memoView !== "trash";
    }
    ui.memoTrashButton?.setAttribute("aria-pressed", String(memoView === "trash"));
    if (ui.memoMeta) {
      if (item) {
        const parts = memoFieldNames(item);
        ui.memoMeta.textContent = `${formatShortDate(item.updatedAt)} 수정 · ${parts.join(", ")}`;
      } else {
        ui.memoMeta.textContent = "쓰기 시작하면 바로 저장돼요";
      }
    }
    for (const button of [ui.memoDeleteButton, ui.memoToAutoButton, ui.memoToQueueButton, ui.memoApplyButton]) {
      if (button) {
        button.disabled = !item;
      }
    }
  }

  function collectMemoDraft() {
    const values = memoEditorValues();
    return {
      name: (ui.memoNameInput?.value || "").trim(),
      values,
      emptySelected: [],
      selectedCount: Object.keys(values).length,
    };
  }

  function scheduleMemoAutosave() {
    if (memoLoadingEditor) {
      return;
    }
    if (memoAutosaveTimer) {
      clearTimeout(memoAutosaveTimer);
    }
    memoAutosaveTimer = setTimeout(() => {
      memoAutosaveTimer = null;
      void savePromptMemo();
    }, 450);
  }

  function flushMemoAutosave() {
    if (memoAutosaveTimer) {
      clearTimeout(memoAutosaveTimer);
      memoAutosaveTimer = null;
      void savePromptMemo();
    }
  }

  // Kept for callers/tests that "press save": saves right away.
  async function handleMemoSavePress(event) {
    event?.preventDefault?.();
    if (memoAutosaveTimer) {
      clearTimeout(memoAutosaveTimer);
      memoAutosaveTimer = null;
    }
    await savePromptMemo();
  }

  let memoSaveChain = Promise.resolve();
  function savePromptMemo() {
    memoSaveChain = memoSaveChain.then(() => savePromptMemoNow()).catch(() => {});
    return memoSaveChain;
  }

  async function savePromptMemoNow() {
    const draft = collectMemoDraft();
    const now = Date.now();
    const existingIndex = memoState.items.findIndex((item) => item.id === selectedMemoId);
    if (existingIndex >= 0) {
      const existing = memoState.items[existingIndex];
      if (!draft.selectedCount) {
        // Never save a memo down to nothing; the last saved version stays.
        renderMemoEditorState();
        return;
      }
      const previous = normalizeMemoItem(existing, existingIndex);
      const next = normalizeMemoItem({
        ...existing,
        name: draft.name || existing.name,
        values: draft.values,
        updatedAt: now,
      }, existingIndex);
      if (JSON.stringify(previous.values) === JSON.stringify(next.values) && previous.name === next.name) {
        return;
      }
      memoState.items[existingIndex] = next;
      const result = await persistMemoState();
      if (!result.ok) {
        return;
      }
      if (memoTrashTakenFor !== existing.id) {
        memoTrashTakenFor = existing.id;
        await moveMemoToTrash(previous, "edit");
        renderMemoTrash();
      }
      clearMemoDraft();
      renderMemoEditorState();
      return;
    }
    if (!draft.selectedCount) {
      return;
    }
    const item = normalizeMemoItem({
      id: createMemoId(),
      name: draft.name || `메모 ${memoState.items.length + 1}`,
      values: draft.values,
      createdAt: now,
      updatedAt: now,
    }, memoState.items.length);
    memoState.items.unshift(item);
    // Even if this write fails (the warning banner says why), the memo stays in
    // the list and further typing updates it instead of creating duplicates. A
    // failed write is held in the page mirror and replayed after a reload.
    selectedMemoId = item.id;
    memoTrashTakenFor = item.id; // a brand-new memo has no "before" version
    const result = await persistMemoState();
    if (!result.ok) {
      renderMemoList();
      renderMemoEditorState();
      return;
    }
    clearMemoDraft();
    renderMemoList();
    renderMemoEditorState();
    setStatus(`메모 “${item.name}”을 저장했어요.`, "ok");
    tourEvent("memo-saved");
  }

  function selectMemo(id) {
    flushMemoAutosave();
    memoView = "edit";
    const item = id ? memoState.items.find((entry) => entry.id === id) : null;
    selectedMemoId = item ? item.id : null;
    memoTrashTakenFor = null;
    if (item) {
      fillMemoEditor(item.name, item.values);
    } else {
      fillMemoEditor("", {});
    }
    renderMemoEditorState();
    renderMemoList();
  }

  function editPromptMemo(id) {
    selectMemo(id);
    ui.memoNameInput?.focus();
  }

  function startNewMemo(values = null, name = "") {
    selectMemo(null);
    if (values) {
      fillMemoEditor(name, values);
      void savePromptMemo();
    }
    ui.memoNameInput?.focus();
  }

  async function deletePromptMemo(id) {
    const index = memoState.items.findIndex((entry) => entry.id === id);
    const item = memoState.items[index];
    if (!item) {
      return;
    }
    if (memoAutosaveTimer) {
      clearTimeout(memoAutosaveTimer);
      memoAutosaveTimer = null;
    }
    // No confirm dialog: the memo goes to the trash and can be restored.
    const trashResult = await moveMemoToTrash(item, "delete");
    if (!trashResult.ok && !trashResult.mirrored) {
      setStatus("휴지통에 옮기지 못해서 삭제를 취소했어요.", "warn");
      return;
    }
    memoState.items = memoState.items.filter((entry) => entry.id !== id);
    const result = await persistMemoState();
    renderMemoTrash();
    if (selectedMemoId === id) {
      const next = memoState.items[Math.min(index, memoState.items.length - 1)];
      selectMemo(next ? next.id : null);
    }
    if (result.ok) {
      setStatus(`“${item.name}” 메모를 최근 삭제됨으로 옮겼어요. ${MEMO_TRASH_DAYS}일 안에 되살릴 수 있어요.`, "ok");
    }
  }

  function copyAutoValuesToMemo() {
    const values = {};
    for (const field of MEMO_FIELDS) {
      const value = ui[field.auto]?.value || "";
      if (value.trim()) {
        values[field.key] = value;
      }
    }
    if (!Object.keys(values).length) {
      setStatus("바로 생성에 쓴 프롬프트가 없어요.", "warn");
      return;
    }
    startNewMemo(values, (ui.saveNameInput?.value || "").trim());
    setStatus("바로 생성 값으로 새 메모를 만들었어요.", "ok");
  }

  async function captureNovelAiValuesToMemo() {
    if (ui.memoCaptureButton) {
      ui.memoCaptureButton.disabled = true;
    }
    try {
      const values = {
        basePrompt: await readCurrentNaiPrompt(),
        baseNegativePrompt: await readCurrentNaiNegativePrompt(),
        characterPrompt: await readCurrentNaiCharacterPrompt(),
        characterNegativePrompt: await readCurrentNaiCharacterNegative(),
      };
      for (const key of Object.keys(values)) {
        if (!String(values[key] || "").trim()) {
          delete values[key];
        }
      }
      if (!Object.keys(values).length) {
        setStatus("NovelAI 입력칸이 비어 있어요.", "warn");
        return;
      }
      startNewMemo(values);
      setStatus("지금 NovelAI 값으로 새 메모를 만들었어요.", "ok");
    } catch (error) {
      setStatus("NovelAI의 현재 프롬프트를 읽지 못했어요.", "warn");
    } finally {
      if (ui.memoCaptureButton) {
        ui.memoCaptureButton.disabled = false;
      }
    }
  }

  function applyMemoToAuto(id) {
    const item = memoState.items.find((entry) => entry.id === id);
    if (!item) {
      return;
    }
    for (const field of MEMO_FIELDS) {
      if (!Object.prototype.hasOwnProperty.call(item.values, field.key)) {
        continue;
      }
      const target = ui[field.auto];
      if (target) {
        target.value = item.values[field.key];
      }
    }
    setAutoPromptMode("own");
    saveSingleSettings();
    setActiveTab("auto");
    setStatus(`“${item.name}” 메모를 바로 생성에 넣었어요.`, "ok");
  }

  function memoMatchesSearch(item) {
    const query = memoSearchQuery.trim().toLowerCase();
    if (!query) {
      return true;
    }
    const haystack = [item.name, ...Object.values(item.values || {})].join(" ").toLowerCase();
    return query.split(/\s+/).every((word) => haystack.includes(word));
  }

  function renderMemoList() {
    renderBadges();
    if (!ui.memoList) {
      return;
    }
    ui.memoList.innerHTML = "";
    const addRow = (id, title, sub, selected) => {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "ias-row ias-row-plain ias-memo-card";
      if (id) {
        row.dataset.id = id;
      } else {
        row.dataset.draft = "true";
      }
      row.setAttribute("role", "option");
      row.setAttribute("aria-selected", String(selected));
      const text = document.createElement("span");
      text.className = "ias-row-text";
      const t = document.createElement("span");
      t.className = "ias-row-title ias-memo-title";
      t.textContent = title;
      const s = document.createElement("span");
      s.className = "ias-row-sub ias-memo-preview";
      s.textContent = sub;
      text.append(t, s);
      row.append(text);
      ui.memoList.append(row);
    };
    if (memoView === "edit" && !selectedMemoId) {
      addRow(null, (ui.memoNameInput?.value || "").trim() || "새 메모", "쓰는 중", true);
    }
    const shown = memoState.items.filter(memoMatchesSearch);
    for (const item of shown) {
      addRow(item.id, item.name, `${formatShortDate(item.updatedAt).split(" ")[0]} · ${memoPreview(item)}`, memoView === "edit" && item.id === selectedMemoId);
    }
    if (!memoState.items.length && selectedMemoId) {
      selectedMemoId = null;
    }
    if (memoState.items.length && !shown.length) {
      const empty = document.createElement("div");
      empty.className = "ias-list-empty";
      empty.textContent = "찾는 메모가 없어요.";
      ui.memoList.append(empty);
    }
  }

  function runMemoAction(id, action) {
    if (action === "queue") {
      void addMemoToQueue(id);
    } else if (action === "export") {
      exportMemos();
    } else if (action === "import") {
      ui.memoImportFile?.click();
    } else if (action === "load") {
      applyMemoToAuto(id);
    } else if (action === "apply") {
      void applyMemoDirectly(id);
    } else if (action === "edit") {
      editPromptMemo(id);
    } else if (action === "delete") {
      void deletePromptMemo(id);
    }
  }

  function closeMemoMenus() {
    closeAllMenus();
  }

  function handleMemoListClick(event) {
    const row = event.target.closest(".ias-row");
    if (!row) {
      return;
    }
    if (row.dataset.draft) {
      memoView = "edit";
      renderMemoEditorState();
      return;
    }
    if (row.dataset.id) {
      selectMemo(row.dataset.id);
    }
  }





  let memoSaveInFlight = false;








  async function addMemoToQueue(id) {
    const item = memoState.items.find((entry) => entry.id === id);
    if (!item) {
      return;
    }
    if (queueRun.active) {
      setStatus("대기열 실행 중에는 메모를 추가할 수 없어요.", "warn");
      return;
    }
    await loadQueueState();
    const values = item.values || {};
    const count = Math.max(1, Number.parseInt(ui.countInput?.value, 10) || 1);
    const newItem = Store.createItem({
      title: item.name,
      basePrompt: Object.prototype.hasOwnProperty.call(values, "basePrompt") ? values.basePrompt : "",
      baseNegativePrompt: Object.prototype.hasOwnProperty.call(values, "baseNegativePrompt") ? values.baseNegativePrompt : "",
      characterPrompt: Object.prototype.hasOwnProperty.call(values, "characterPrompt") ? values.characterPrompt : "",
      negativePrompt: Object.prototype.hasOwnProperty.call(values, "characterNegativePrompt") ? values.characterNegativePrompt : "",
      count,
    });
    queueState.items.push(newItem);
    selectedQueueId = newItem.id;
    await persistQueueState();
    setStatus(`메모 “${item.name}”을 대기열에 넣었어요. (${queueState.items.length}개)`, "ok");
  }

  async function applyMemoDirectly(id) {
    const item = memoState.items.find((entry) => entry.id === id);
    if (!item) {
      return;
    }
    const values = item.values || {};
    const promptResult = await applyStructuredPrompt(
      Object.prototype.hasOwnProperty.call(values, "basePrompt") ? values.basePrompt : null,
      Object.prototype.hasOwnProperty.call(values, "characterPrompt") ? values.characterPrompt : null
    );
    if (!promptResult.ok) {
      setStatus(promptResult.error || "메모 프롬프트를 NovelAI에 적용하지 못했어요.", "warn");
      return;
    }
    if (Object.prototype.hasOwnProperty.call(values, "baseNegativePrompt")) {
      const result = await applyBaseNegativeToNovelAi(values.baseNegativePrompt);
      if (!result.ok) {
        return;
      }
    }
    // Same rule as a queue item: any character this memo defines owns its card,
    // so a character with no negative has its Undesired Content cleared instead
    // of inheriting whatever the previous memo left there.
    const memoCharacterSlots = values.characterPrompt != null
      ? splitCharacterBlocks(values.characterPrompt).length
      : 0;
    if (Object.prototype.hasOwnProperty.call(values, "characterNegativePrompt") || memoCharacterSlots > 0) {
      const result = await applyCharacterNegativesToNovelAi(
        values.characterNegativePrompt,
        { slots: memoCharacterSlots },
      );
      if (!result.ok) {
        return;
      }
    }
    setStatus(`“${item.name}” 메모를 NovelAI에 직접 적용했어요.`, "ok");
  }






  // ---------------------------------------------------------------------------
  // settings
  // ---------------------------------------------------------------------------
  async function loadSettings() {
    const settings = await storageGet("sync", SYNC_KEYS);
    const {
      intervalTime = 3,
      gcount = "",
      singleSaveName = "",
      saveFolder = "NovelAI",
      autoBase = "",
      autoBaseNeg = "",
      autoChar = "",
      autoCharNeg = "",
      autoSaveEnabled = true,
      autoCompletionNotificationEnabled = true,
      backgroundKeepAliveEnabled: keepAliveSetting = true,
      folderByDate = true,
      folderByCharacter = true,
      saveFormat: savedFormat = "auto",
      autoBackupEnabled = true,
      appearance: savedAppearance = "auto",
      autoPromptMode: savedPromptMode,
      tagHover = true,
      tagHoverMachine = true,
    } = settings;
    if (ui.tagHoverToggle) {
      ui.tagHoverToggle.checked = tagHover !== false;
    }
    if (ui.tagMachineToggle) {
      ui.tagMachineToggle.checked = tagHoverMachine !== false;
    }
    globalThis.TagKo?.setOptions({ enabled: tagHover !== false, machine: tagHoverMachine !== false });
    appearance = normalizeAppearance(savedAppearance);
    applyAppearance();
    if (ui.folderByDateToggle) {
      ui.folderByDateToggle.checked = folderByDate !== false;
    }
    await loadNaiFormat();
    setSaveFormat(savedFormat, { save: false });
    if (ui.folderByCharToggle) {
      ui.folderByCharToggle.checked = folderByCharacter !== false;
    }
    if (ui.autoBackupToggle) {
      ui.autoBackupToggle.checked = autoBackupEnabled !== false;
    }
    backgroundKeepAliveEnabled = keepAliveSetting !== false;
    if (ui.intervalInput) {
      ui.intervalInput.value = String(intervalTime);
    }
    if (ui.countInput) {
      ui.countInput.value = gcount === 0 || gcount === "" ? "" : String(gcount);
      syncCountMode();
    }
    if (ui.saveNameInput) {
      ui.saveNameInput.value = singleSaveName;
    }
    if (ui.autoBaseInput) {
      ui.autoBaseInput.value = autoBase;
    }
    if (ui.autoBaseNegInput) {
      ui.autoBaseNegInput.value = autoBaseNeg;
    }
    if (ui.autoCharInput) {
      ui.autoCharInput.value = autoChar;
    }
    if (ui.autoCharNegInput) {
      ui.autoCharNegInput.value = autoCharNeg;
    }
    if (ui.folderInput) {
      ui.folderInput.value = normalizeFolderInput(saveFolder);
    }
    if (ui.autoSaveToggle) {
      ui.autoSaveToggle.checked = autoSaveEnabled !== false;
    }
    if (ui.notifyToggle) {
      ui.notifyToggle.checked = autoCompletionNotificationEnabled !== false;
    }
    if (ui.bgKeepAliveToggle) {
      ui.bgKeepAliveToggle.checked = backgroundKeepAliveEnabled;
    }
    // Older versions had no switch: if prompts were typed in, keep using them.
    const hadOwnPrompts = [autoBase, autoBaseNeg, autoChar, autoCharNeg].some((value) => String(value || "").trim());
    setAutoPromptMode(savedPromptMode === "own" || savedPromptMode === "nai" ? savedPromptMode : (hadOwnPrompts ? "own" : "nai"), { save: false });
    renderFolderPreview();
    // ensure default ON is persisted the first time
    if (settings.autoSaveEnabled === undefined) {
      await storageSet("sync", { autoSaveEnabled: true });
    }
  }

  function saveSingleSettings() {
    const intervalTime = Math.max(0.1, Number.parseFloat(ui.intervalInput?.value) || 3);
    const gcountRaw = Number.parseInt(ui.countInput?.value, 10);
    const gcount = Number.isFinite(gcountRaw) && gcountRaw > 0 ? gcountRaw : "";
    void storageSet("sync", {
      intervalTime,
      gcount: gcount === "" ? "" : gcount,
      singleSaveName: (ui.saveNameInput?.value || "").trim(),
      saveFolder: (ui.folderInput?.value || "").trim(),
      autoBase: ui.autoBaseInput?.value || "",
      autoBaseNeg: ui.autoBaseNegInput?.value || "",
      autoChar: ui.autoCharInput?.value || "",
      autoCharNeg: ui.autoCharNegInput?.value || "",
    });
  }

  // The character block editor writes back into the ";;" carriers on every
  // keystroke, so this must be debounced: chrome.storage.sync allows only ~120
  // writes per minute and silently starts failing past that.
  let singleSettingsSaveTimer = null;
  function scheduleSingleSettingsSave() {
    if (singleSettingsSaveTimer) {
      clearTimeout(singleSettingsSaveTimer);
    }
    singleSettingsSaveTimer = setTimeout(() => {
      singleSettingsSaveTimer = null;
      saveSingleSettings();
    }, 400);
  }

  function savePreferences() {
    void storageSet("sync", {
      autoSaveEnabled: Boolean(ui.autoSaveToggle?.checked),
      autoCompletionNotificationEnabled: Boolean(ui.notifyToggle?.checked),
      backgroundKeepAliveEnabled: Boolean(ui.bgKeepAliveToggle?.checked),
      folderByDate: ui.folderByDateToggle ? Boolean(ui.folderByDateToggle.checked) : true,
      folderByCharacter: ui.folderByCharToggle ? Boolean(ui.folderByCharToggle.checked) : true,
      autoBackupEnabled: ui.autoBackupToggle ? Boolean(ui.autoBackupToggle.checked) : true,
      tagHover: ui.tagHoverToggle ? Boolean(ui.tagHoverToggle.checked) : true,
      tagHoverMachine: ui.tagMachineToggle ? Boolean(ui.tagMachineToggle.checked) : true,
    });
  }

  // ---------------------------------------------------------------------------
  // full backup (memos + queue + generator + settings in one file)
  // ---------------------------------------------------------------------------
  const BACKUP_KIND = "full-backup";
  const AUTO_BACKUP_META_KEY = "naiAutoSaver.autoBackupMeta";
  const AUTO_BACKUP_MIN_GAP_MS = 3 * 60 * 60 * 1000;
  const BACKUP_SKIP_LOCAL_KEYS = new Set([AUTO_BACKUP_META_KEY, "naiAutoSaver.avgImageMs", UI_STORAGE_KEY]);

  async function collectBackupData() {
    const local = await storageGet("local", null);
    const sync = await storageGet("sync", null);
    const outLocal = {};
    for (const [key, value] of Object.entries(local || {})) {
      if (String(key).startsWith("naiAutoSaver.") && !BACKUP_SKIP_LOCAL_KEYS.has(key)) {
        outLocal[key] = value;
      }
    }
    const outSync = {};
    for (const [key, value] of Object.entries(sync || {})) {
      outSync[key] = value;
    }
    return { local: outLocal, sync: outSync };
  }

  function extensionVersion() {
    try {
      return chrome.runtime.getManifest().version;
    } catch (error) {
      return "";
    }
  }

  function createBackupEnvelope(data) {
    return {
      app: "NAI-Auto-Saver",
      kind: BACKUP_KIND,
      backupVersion: 1,
      extensionVersion: extensionVersion(),
      exportedAt: new Date().toISOString(),
      local: data.local,
      sync: data.sync,
    };
  }

  function parseBackupText(text) {
    let parsed;
    try {
      parsed = JSON.parse(String(text == null ? "" : text));
    } catch (error) {
      return { ok: false, error: "백업 파일을 읽지 못했어요 (JSON 형식이 아니에요)." };
    }
    if (!parsed || typeof parsed !== "object" || parsed.app !== "NAI-Auto-Saver") {
      return { ok: false, error: "NAI 자동저장 백업 파일이 아니에요." };
    }
    if (parsed.kind !== BACKUP_KIND) {
      if (parsed.memos) {
        return { ok: false, error: "메모만 담긴 파일이에요. 메모 탭의 ⋯ → 가져오기로 불러와 주세요." };
      }
      if (parsed.queue) {
        return { ok: false, error: "대기열만 담긴 파일이에요. 설정 → 대기열 관리 → 가져오기로 불러와 주세요." };
      }
      return { ok: false, error: "전체 백업 파일이 아니에요." };
    }
    const local = parsed.local && typeof parsed.local === "object" ? parsed.local : {};
    const sync = parsed.sync && typeof parsed.sync === "object" ? parsed.sync : {};
    return { ok: true, local, sync, exportedAt: parsed.exportedAt || "" };
  }

  async function exportFullBackup() {
    const data = await collectBackupData();
    const stamp = Store.formatDateFolder(new Date());
    downloadJson(createBackupEnvelope(data), `NAI자동저장-전체백업-${stamp}.json`);
    const memoCount = data.local[MEMO_STORAGE_KEY]?.items?.length || 0;
    const queueCount = data.local[QUEUE_STORAGE_KEY]?.items?.length || 0;
    setStatus(`전체 백업을 내보냈어요. (메모 ${memoCount}개 · 대기열 ${queueCount}개 · 설정)`, "ok");
  }

  async function importFullBackupFromFile(file) {
    if (!file) {
      return;
    }
    const parsed = parseBackupText(await file.text());
    if (!parsed.ok) {
      setStatus(parsed.error, "warn");
      return;
    }
    const incomingMemos = parsed.local[MEMO_STORAGE_KEY];
    const memoCount = incomingMemos?.items?.length || 0;
    const queueCount = parsed.local[QUEUE_STORAGE_KEY]?.items?.length || 0;
    if (!(await iosAlert({
      title: "백업을 가져올까요?",
      message: `메모 ${memoCount}개는 지금 메모와 합쳐지고, 대기열(${queueCount}개)과 설정은 백업 내용으로 바뀌어요. 끝나면 페이지를 새로고침해요.`,
      buttons: [{ label: "취소", value: false, cancel: true }, { label: "가져오기", value: true, primary: true }],
    }))) {
      return;
    }
    const local = { ...parsed.local };
    delete local[AUTO_BACKUP_META_KEY];
    const current = await storageGet("local", [MEMO_STORAGE_KEY, MEMO_TRASH_KEY]);
    if (incomingMemos) {
      local[MEMO_STORAGE_KEY] = normalizeMemoState(SafeStoreLib.mergeMemoStates(current[MEMO_STORAGE_KEY], incomingMemos));
    }
    if (parsed.local[MEMO_TRASH_KEY]) {
      const mine = normalizeMemoTrash(current[MEMO_TRASH_KEY]);
      const theirs = normalizeMemoTrash(parsed.local[MEMO_TRASH_KEY]);
      const seen = new Set(mine.items.map((e) => e.trashId));
      local[MEMO_TRASH_KEY] = normalizeMemoTrash({ items: [...mine.items, ...theirs.items.filter((e) => !seen.has(e.trashId))] });
    }
    const localResult = await storageSet("local", local);
    const syncResult = Object.keys(parsed.sync).length ? await storageSet("sync", parsed.sync) : { ok: true };
    if (!localResult.ok || !syncResult.ok) {
      setStatus("백업을 다 쓰지 못했어요. 페이지를 새로고침한 뒤 다시 시도해 주세요.", "warn");
      return;
    }
    setStatus("백업을 가져왔어요. 새로고침해요…", "ok");
    setTimeout(() => location.reload(), 600);
  }

  // Small, stable string hash (to skip unchanged daily backups).
  function hashString(text) {
    let h = 5381;
    for (let i = 0; i < text.length; i += 1) {
      h = ((h << 5) + h + text.charCodeAt(i)) | 0;
    }
    return (h >>> 0).toString(36);
  }

  let autoBackupTimer = null;
  function scheduleAutoBackup(delayMs = 5000) {
    if (autoBackupTimer) {
      clearTimeout(autoBackupTimer);
    }
    autoBackupTimer = setTimeout(() => {
      autoBackupTimer = null;
      void maybeAutoBackup();
    }, delayMs);
  }

  async function maybeAutoBackup({ force = false } = {}) {
    if (!force && ui.autoBackupToggle && !ui.autoBackupToggle.checked) {
      return { skipped: "off" };
    }
    if (!safeStore.contextAlive()) {
      return { skipped: "context" };
    }
    const data = await collectBackupData();
    const hasMemos = (data.local[MEMO_STORAGE_KEY]?.items?.length || 0) > 0;
    const hasQueue = (data.local[QUEUE_STORAGE_KEY]?.items?.length || 0) > 0;
    if (!hasMemos && !hasQueue) {
      return { skipped: "empty" };
    }
    const hash = hashString(JSON.stringify(data));
    const today = Store.formatDateFolder(new Date());
    const metaResult = await storageGet("local", [AUTO_BACKUP_META_KEY]);
    const meta = metaResult[AUTO_BACKUP_META_KEY] || {};
    if (!force && meta.hash === hash) {
      return { skipped: "unchanged" };
    }
    // One file per day (overwritten), refreshed at most every 3 hours.
    if (!force && meta.date === today && Date.now() - (Number(meta.at) || 0) < AUTO_BACKUP_MIN_GAP_MS) {
      return { skipped: "recent" };
    }
    const folder = `${normalizeFolderInput((ui.folderInput?.value || "").trim()) || "NovelAI"}/_백업`;
    const filename = `NAI자동저장-백업-${today}.json`;
    const json = `${JSON.stringify(createBackupEnvelope(data), null, 2)}\n`;
    const response = await new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage({ action: "downloadBackup", json, folder, fileName: filename }, (res) => {
          void chrome.runtime.lastError;
          resolve(res || { ok: false });
        });
      } catch (error) {
        resolve({ ok: false });
      }
    });
    if (response.ok) {
      await storageSet("local", { [AUTO_BACKUP_META_KEY]: { date: today, hash, at: Date.now() } });
      logEvent("info", `자동 백업 저장: ${folder}/${filename}`);
      return { saved: true };
    }
    logEvent("warn", "자동 백업 실패", response.error || "");
    return { saved: false };
  }

  // ---------------------------------------------------------------------------
  // UI
  // ---------------------------------------------------------------------------
  // ---------------------------------------------------------------------------
  // ETA (estimated time)
  // ---------------------------------------------------------------------------
  function formatEta(ms) {
    if (!Number.isFinite(ms) || ms <= 0) {
      return "";
    }
    const totalSec = Math.round(ms / 1000);
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = totalSec % 60;
    if (h > 0) {
      return m > 0 ? `${h}시간 ${m}분` : `${h}시간`;
    }
    if (m > 0) {
      return s > 0 ? `${m}분 ${s}초` : `${m}분`;
    }
    return `${s}초`;
  }

  // Estimated wall-clock finish time, e.g. "오후 3:42". Formatted manually so
  // it doesn't depend on the JS engine's locale (ICU) data.
  function formatClock(targetMs) {
    const date = new Date(targetMs);
    if (Number.isNaN(date.getTime())) {
      return "";
    }
    let hour = date.getHours();
    const minute = String(date.getMinutes()).padStart(2, "0");
    const period = hour < 12 ? "오전" : "오후";
    hour %= 12;
    if (hour === 0) {
      hour = 12;
    }
    return `${period} ${hour}:${minute}`;
  }

  function avgImageMs() {
    if (!etaTracker.samples.length) {
      return null;
    }
    const sum = etaTracker.samples.reduce((a, b) => a + b, 0);
    return sum / etaTracker.samples.length;
  }

  function resetEtaTracker() {
    etaTracker.samples = [];
    etaTracker.lastCompleteTs = 0;
  }

  // Call once per completed image. The gap between consecutive completions is
  // the true per-image wall time (generation + interval), so the first
  // completion only seeds lastCompleteTs and yields no sample.
  function recordImageCompletion() {
    const now = Date.now();
    if (etaTracker.lastCompleteTs) {
      const d = now - etaTracker.lastCompleteTs;
      // Ignore implausible gaps (paused tab, manual stall): 0 < d < 10 min.
      if (d > 0 && d < 10 * 60 * 1000) {
        etaTracker.samples.push(d);
        if (etaTracker.samples.length > etaTracker.maxSamples) {
          etaTracker.samples.shift();
        }
        seedImageMs = avgImageMs();
        void storageSet("local", { [ETA_SEED_KEY]: seedImageMs });
      }
    }
    etaTracker.lastCompleteTs = now;
  }

  // Images still to generate in the current run. null = unlimited (no ETA).
  function remainingImages() {
    if (queueRun.active) {
      const items = queueRun.items;
      let remain = 0;
      for (let i = queueRun.index + 1; i < items.length; i += 1) {
        remain += items[i]?.count || 0;
      }
      const current = items[queueRun.index];
      const currentTarget = current ? current.count || 0 : 0;
      remain += Math.max(0, currentTarget - autoRun.count);
      return remain;
    }
    if (autoRun.active && autoRun.target > 0) {
      return Math.max(0, autoRun.target - autoRun.count);
    }
    return null;
  }

  function progressLine() {
    if (queueRun.active) {
      const item = queueRun.items[queueRun.index];
      const title = item ? item.title : "";
      const target = item ? item.count || 0 : 0;
      const itemPct = currentItemPercent();
      const overall = overallPercent();
      const itemPart = target > 0
        ? `항목 ${autoRun.count}/${target}장 (${itemPct}%)`
        : `항목 ${autoRun.count}장`;
      const overallPart = overall != null ? ` · 전체 ${overall}%` : "";
      return `대기열 ${queueRun.index + 1}/${queueRun.items.length} · ${title} · ${itemPart}${overallPart}`;
    }
    const target = autoRun.target || 0;
    if (target > 0) {
      return `생성 중: ${autoRun.count}/${target}장 (${currentItemPercent()}%)`;
    }
    return `생성 중: ${autoRun.count}장`;
  }

  function queueTotalImages() {
    return queueRun.items.reduce((sum, item) => sum + (item.count || 0), 0);
  }

  // Whole-queue progress for the current pass (loop resets each cycle).
  function overallPercent() {
    if (!queueRun.active) {
      return null;
    }
    const total = queueTotalImages();
    if (total <= 0) {
      return null;
    }
    const done = queueRun.totalGenerated + autoRun.count;
    return Math.min(100, Math.round((done / total) * 100));
  }

  // Progress within the item currently generating.
  function currentItemPercent() {
    let target = 0;
    if (queueRun.active) {
      const item = queueRun.items[queueRun.index];
      target = item ? item.count || 0 : 0;
    } else if (autoRun.active) {
      target = autoRun.target || 0;
    }
    if (target <= 0) {
      return null;
    }
    return Math.min(100, Math.round((autoRun.count / target) * 100));
  }

  function liveEtaSuffix() {
    const remain = remainingImages();
    if (remain == null) {
      return "";
    }
    const per = avgImageMs() || seedImageMs;
    if (!per) {
      return ` · 남은 ${remain}장 · 남은 시간 측정 중…`;
    }
    const remainMs = remain * per;
    const eta = formatEta(remainMs);
    const finish = formatClock(Date.now() + remainMs);
    const loopNote = queueRun.active && queueRun.loop ? " (이번 회차)" : "";
    const finishNote = finish ? ` · 완료 예정 ${finish}` : "";
    return ` · 남은 ${remain}장 · 남은 시간 약 ${eta}${finishNote}${loopNote}`;
  }

  // Pre-run text for the queue bar, including a measured-speed estimate.
  function queueCountText() {
    const n = queueState.items.length;
    if (!n) {
      return "";
    }
    const total = queueState.items.reduce((sum, item) => sum + (item.count || 0), 0);
    let text = `${n}개 · 총 ${total}장`;
    if (seedImageMs && total > 0) {
      text += ` · 예상 소요 ${formatEta(total * seedImageMs)}`;
      if (queueState.options.loop) {
        text += "/회";
      }
    }
    return text;
  }

  async function loadEtaSeed() {
    try {
      const stored = await storageGet("local", [ETA_SEED_KEY]);
      const value = Number.parseFloat(stored?.[ETA_SEED_KEY]);
      if (Number.isFinite(value) && value > 0) {
        seedImageMs = value;
      }
    } catch (error) {
      void error;
    }
  }

  function renderStorageAlert() {
    if (!ui.storageAlert) {
      return;
    }
    if (storageHealth.ok) {
      ui.storageAlert.hidden = true;
      return;
    }
    let text;
    let showReload = false;
    if (!storageHealth.contextAlive) {
      text = "확장 프로그램이 업데이트되거나 다시 켜졌어요. 지금부터 쓰는 내용은 이 페이지에 임시 보관되고, 새로고침하면 확장 저장소로 옮겨져요.";
      showReload = true;
    } else if (storageHealth.reason === "quota") {
      text = "확장 저장 공간이 가득 찼어요. 오래된 대기열·메모를 내보낸 뒤 정리해 주세요. (지금 내용은 임시 보관 중)";
    } else {
      text = `저장 중 오류가 났어요 (${storageHealth.reason}). 지금 내용은 임시 보관 중이에요.`;
      showReload = true;
    }
    ui.storageAlertText.textContent = text;
    ui.storageAlertAction.hidden = !showReload;
    ui.storageAlert.hidden = false;
  }

  let contextWatchTimer = null;
  function startContextWatch() {
    if (contextWatchTimer) {
      return;
    }
    contextWatchTimer = setInterval(() => {
      if (!safeStore.checkContext()) {
        clearInterval(contextWatchTimer);
        contextWatchTimer = null;
      }
    }, 4000);
  }

  function describeRecovery(report) {
    const restoredMemo = report.restored.includes(`local:${MEMO_STORAGE_KEY}`);
    const restoredQueue = report.restored.includes(`local:${QUEUE_STORAGE_KEY}`);
    const parts = [];
    if (restoredMemo) parts.push("메모");
    if (restoredQueue) parts.push("대기열");
    if (report.restored.some((k) => k.startsWith("sync:"))) parts.push("설정");
    if (parts.length) {
      return `이전 설치에서 자동으로 가져왔어요: ${parts.join(" · ")}`;
    }
    if (report.pendingApplied.length) {
      return "새로고침 전에 임시 보관했던 내용을 저장했어요.";
    }
    return "";
  }

  function snapshotMemoDraft() {
    const values = {};
    let hasText = Boolean((ui.memoNameInput?.value || "").trim());
    for (const field of MEMO_FIELDS) {
      const value = ui[field.input]?.value || "";
      values[field.key] = value;
      if (value.trim()) {
        hasText = true;
      }
    }
    if (!hasText) {
      return null;
    }
    return {
      name: ui.memoNameInput?.value || "",
      editingId: selectedMemoId,
      values,
      savedAt: Date.now(),
    };
  }

  function restoreMemoDraft() {
    const draft = readPageLocal(MEMO_DRAFT_LS_KEY);
    if (!draft || typeof draft !== "object" || !draft.values) {
      selectMemo(memoState.items[0]?.id || null);
      return false;
    }
    const editing = draft.editingId && memoState.items.some((item) => item.id === draft.editingId)
      ? draft.editingId
      : null;
    selectMemo(editing);
    const values = {};
    for (const field of MEMO_FIELDS) {
      // Old drafts carried checkboxes; an unticked field was not part of the memo.
      if (draft.checks && draft.checks[field.key] === false) {
        continue;
      }
      values[field.key] = String(draft.values[field.key] || "");
    }
    fillMemoEditor(String(draft.name || ""), values);
    renderMemoList();
    void savePromptMemo();
    setStatus("쓰다 만 메모를 되살렸어요.", "ok");
    return true;
  }

  function renderMemoTrash() {
    if (ui.memoTrashCount) {
      ui.memoTrashCount.textContent = String(memoTrash.items.length);
    }
    if (!ui.memoTrashList) {
      return;
    }
    ui.memoTrashList.innerHTML = "";
    if (!memoTrash.items.length) {
      const empty = document.createElement("div");
      empty.className = "ias-list-empty";
      empty.textContent = "비어 있어요.";
      ui.memoTrashList.append(empty);
      return;
    }
    for (const entry of memoTrash.items) {
      const row = document.createElement("div");
      row.className = "ias-trash-row";
      row.dataset.trashId = entry.trashId;
      const text = document.createElement("div");
      text.className = "ias-trash-text";
      const title = document.createElement("strong");
      title.textContent = entry.item.name;
      const meta = document.createElement("small");
      meta.textContent = `${entry.kind === "edit" ? "고치기 전" : "지움"} · ${formatShortDate(entry.deletedAt)} · ${memoPreview(entry.item)}`;
      text.append(title, meta);
      const restore = document.createElement("button");
      restore.type = "button";
      restore.className = "ias-btn secondary small ias-trash-restore";
      restore.dataset.action = "restore";
      restore.textContent = "되살리기";
      const purge = document.createElement("button");
      purge.type = "button";
      purge.className = "ias-icon-btn ias-trash-purge";
      purge.dataset.action = "purge";
      purge.title = "완전히 지우기";
      purge.setAttribute("aria-label", "완전히 지우기");
      purge.innerHTML = icon("delete", 15);
      row.append(text, restore, purge);
      ui.memoTrashList.append(row);
    }
  }

  // --- status ----------------------------------------------------------------
  // One-off messages are toasts at the bottom of the window (full text, never
  // cut off). Live progress belongs to the toolbar's centre box, so progress
  // lines go through noteProgress(), which only logs.
  let lastStatus = null;
  function setStatus(message, tone = "neutral") {
    if (message) {
      logEvent(tone === "warn" ? "warn" : "info", message);
    }
    if (!ui.status) {
      return;
    }
    ui.status.textContent = message || "";
    ui.status.dataset.tone = tone;
    lastStatus = message ? { message, tone, at: Date.now() } : null;
    if (message) {
      showToast(message, tone);
    }
  }

  function noteProgress(message) {
    logEvent("info", message);
    if (ui.status) {
      ui.status.textContent = message;
    }
  }

  const TOAST_ICONS = {
    ok: '<svg width="15" height="15" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10" fill="currentColor"/><path d="M7.5 12.5l3 3 6-6.5" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    warn: '<svg width="15" height="15" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3L2 20.5h20z" fill="currentColor" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><path d="M12 9.5v5" stroke="#fff" stroke-width="2.2" stroke-linecap="round"/><circle cx="12" cy="17.6" r="1.25" fill="#fff"/></svg>',
    neutral: '<svg width="15" height="15" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10" fill="currentColor"/><path d="M12 11v6" stroke="#fff" stroke-width="2.2" stroke-linecap="round"/><circle cx="12" cy="7.6" r="1.3" fill="#fff"/></svg>',
  };

  function showToast(message, tone = "neutral") {
    const host = ui.toasts;
    if (!host) {
      return;
    }
    // The same message again (e.g. a retried warning) refreshes the existing toast.
    let toast = Array.from(host.children).find((el) => el.dataset.message === message && el.dataset.leaving !== "true");
    if (!toast) {
      toast = document.createElement("div");
      toast.className = "ias-toast";
      toast.setAttribute("role", tone === "warn" ? "alert" : "status");
      toast.dataset.message = message;
      toast.innerHTML = `<span class="ias-toast-ic">${TOAST_ICONS[tone] || TOAST_ICONS.neutral}</span><span class="ias-toast-text"></span><button class="ias-toast-close" type="button" aria-label="닫기" title="닫기">${icon("close", 12)}</button>`;
      toast.querySelector(".ias-toast-text").textContent = message;
      toast.querySelector(".ias-toast-close").addEventListener("click", () => dismissToast(toast));
      toast.addEventListener("mouseenter", () => clearTimeout(toast._timer));
      toast.addEventListener("mouseleave", () => armToast(toast));
      // Only the latest confirmation stays; warnings wait until read or closed.
      for (const old of Array.from(host.children)) {
        if (old.dataset.tone !== "warn" || host.children.length > 2) dismissToast(old);
      }
      host.append(toast);
    }
    toast.dataset.tone = tone;
    armToast(toast);
  }

  function armToast(toast) {
    clearTimeout(toast._timer);
    const ms = toast.dataset.tone === "warn" ? 9000 : 3600;
    toast._timer = setTimeout(() => dismissToast(toast), ms);
  }

  function dismissToast(toast) {
    clearTimeout(toast._timer);
    toast.dataset.leaving = "true";
    setTimeout(() => toast.remove(), 200);
  }

  function renderActivity(state) {
    const info = activitySummary(state);
    if (ui.activityBox) {
      ui.activityBox.dataset.running = info.running ? "true" : "false";
      let text = "";
      let tone = "neutral";
      if (info.running) {
        text = `<b>${escapeHtml(info.title)}</b> ${escapeHtml(info.sub)}`;
        tone = "ok";
      } else if (todaySavedCount) {
        text = `오늘 ${todaySavedCount}장 저장`;
      }
      ui.activityText.innerHTML = text;
      ui.activityBox.dataset.tone = tone;
      ui.activityBox.dataset.empty = text ? "false" : "true";
      ui.activityBox.title = "";
      if (ui.activityBar) {
        ui.activityBar.style.width = `${info.percent == null ? 0 : info.percent}%`;
      }
    }
    if (ui.fab) {
      ui.fab.dataset.running = info.running ? "true" : "false";
      ui.fab.dataset.alert = storageHealth.ok ? "false" : "true";
      if (info.running) {
        ui.fab.innerHTML = `${progressRingSvg(info.percent)}<span class="ias-pill-text"><span class="ias-pill-title">${escapeHtml(info.title)}</span><span class="ias-pill-sub">${escapeHtml(info.sub)}</span></span>`;
        ui.fab.title = `${info.title} · ${info.sub} · 눌러서 열기`;
      } else {
        ui.fab.innerHTML = icon("sparkle", 24);
        ui.fab.title = "NAI 자동저장 · 눌러서 열기";
      }
    }
  }

  // --- toolbar menus -----------------------------------------------------------
  function closeAllMenus(except = null) {
    if (!panelShadow) {
      return;
    }
    panelShadow.querySelectorAll(".ias-menu").forEach((menu) => {
      if (menu !== except) {
        menu.hidden = true;
      }
    });
    panelShadow.querySelectorAll("[data-menu-toggle]").forEach((toggle) => {
      if (!except || toggle.dataset.menuToggle !== except.dataset.menu) {
        toggle.setAttribute("aria-expanded", "false");
      }
    });
  }

  function bindMenus() {
    panelShadow.querySelectorAll("[data-menu-toggle]").forEach((toggle) => {
      const menu = panelShadow.querySelector(`.ias-menu[data-menu="${toggle.dataset.menuToggle}"]`);
      toggle.addEventListener("click", (event) => {
        event.stopPropagation();
        const open = menu.hidden;
        closeAllMenus(open ? menu : null);
        menu.hidden = !open;
        toggle.setAttribute("aria-expanded", String(open));
        if (open) {
          menu.querySelector(".ias-menu-item:not(:disabled)")?.focus();
        }
      });
      menu.addEventListener("click", (event) => {
        const item = event.target.closest(".ias-menu-item");
        if (item && !item.classList.contains("ias-menu-check")) {
          closeAllMenus();
        }
      });
    });
    panelShadow.addEventListener("click", (event) => {
      if (!event.target.closest(".ias-menu-wrap")) {
        closeAllMenus();
      }
    });
  }

  // --- 바로 생성: "NovelAI 그대로" or "직접 쓰기" --------------------------------
  let autoPromptMode = "nai";
  function setAutoPromptMode(mode, { save = true } = {}) {
    autoPromptMode = mode === "own" ? "own" : "nai";
    for (const button of ui.promptModeButtons || []) {
      button.setAttribute("aria-checked", String(button.dataset.promptMode === autoPromptMode));
    }
    if (ui.autoEditorHost) {
      ui.autoEditorHost.hidden = autoPromptMode !== "own";
    }
    if (ui.promptNaiNote) {
      ui.promptNaiNote.hidden = autoPromptMode === "own";
    }
    if (save) {
      void storageSet("sync", { autoPromptMode });
    }
  }

  // "auto" = whatever NovelAI's own download gives (learned by the background
  // from the user's NovelAI downloads, or read from NovelAI's saved settings).
  let saveFormat = "auto";
  let naiFormat = "webp";
  const NAI_FORMAT_KEY = "naiAutoSaver.naiDownloadFormat";
  function effectiveFormat() {
    return saveFormat === "auto" ? naiFormat : saveFormat;
  }
  // NovelAI keeps its own settings in this page's storage; look for a
  // download-format value there as a first guess.
  function guessNaiFormatFromPage() {
    try {
      for (let i = 0; i < localStorage.length; i += 1) {
        const key = localStorage.key(i) || "";
        const value = localStorage.getItem(key) || "";
        if (value.length > 400000) continue;
        const m = value.match(/"[^"]*(?:download|save|export|image)[^"]*format[^"]*"\s*:\s*"?(png|webp)/i)
          || (/(?:download|image).*format/i.test(key) ? value.match(/^"?(png|webp)"?$/i) : null);
        if (m) return m[1].toLowerCase();
      }
    } catch (error) {
      void error;
    }
    return null;
  }

  async function loadNaiFormat() {
    const stored = (await storageGet("local", [NAI_FORMAT_KEY]))[NAI_FORMAT_KEY];
    if (stored?.how === "download" && (stored.format === "png" || stored.format === "webp")) {
      naiFormat = stored.format;
      return;
    }
    naiFormat = guessNaiFormatFromPage() || stored?.format || "webp";
  }

  function setSaveFormat(value, { save = true } = {}) {
    saveFormat = value === "png" || value === "webp" ? value : "auto";
    for (const button of ui.saveFormatButtons || []) {
      button.setAttribute("aria-checked", String(button.dataset.saveFormat === saveFormat));
    }
    const note = panelShadow?.querySelector(".ias-format-note");
    if (note) {
      note.textContent = saveFormat === "auto"
        ? `NovelAI에서 받는 형식을 따라가요 · 지금 ${naiFormat === "png" ? "PNG" : "WebP"}`
        : "NovelAI 설정과 상관없이 이 형식으로 저장해요";
    }
    renderFolderPreview();
    if (save) {
      void storageSet("sync", { saveFormat });
    }
  }

  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === "local" && changes[NAI_FORMAT_KEY]?.newValue?.format) {
        naiFormat = changes[NAI_FORMAT_KEY].newValue.format === "png" ? "png" : "webp";
        setSaveFormat(saveFormat, { save: false });
      }
    });
  } catch (error) {
    void error;
  }

  let lastCountValue = 20;
  function syncCountMode() {
    const forever = !ui.countInput || !ui.countInput.value || Number(ui.countInput.value) <= 0;
    if (ui.countInput && forever) ui.countInput.value = "";
    for (const button of ui.countModeButtons || []) {
      button.setAttribute("aria-checked", String((button.dataset.countMode === "forever") === forever));
    }
    if (ui.countWrap) ui.countWrap.hidden = forever;
  }

  function renderFolderPreview() {
    const sample = (ui.saveNameInput?.value || "").trim() || "김춘자_교실";
    const folder = currentSaveFolder(sample);
    const text = `다운로드/${folder}/${Store.sanitizeFileName(sample)} (1).${effectiveFormat()}`;
    if (ui.folderPreview) {
      ui.folderPreview.textContent = `→ ${text}`;
    }
    if (ui.autoPath) {
      ui.autoPath.textContent = `→ ${text}`;
      ui.autoPath.title = text;
    }
    if (ui.folderPreview) {
      ui.folderPreview.title = text;
    }
  }

  async function startSingleAuto() {
    saveSingleSettings();
    const target = Math.max(0, Number.parseInt(ui.countInput?.value, 10) || 0);
    const saveName = (ui.saveNameInput?.value || "").trim();
    const own = autoPromptMode === "own";
    const pick = (el) => (own ? (el?.value || "").trim() || null : null);
    await startAutoGenerate({
      target,
      saveName,
      applyBasePrompt: pick(ui.autoBaseInput),
      applyBaseNegative: pick(ui.autoBaseNegInput),
      applyCharacterPrompt: pick(ui.autoCharInput),
      applyCharacterNegative: pick(ui.autoCharNegInput),
    });
  }

  function setActiveTab(name) {
    if (name !== activeTab) {
      // A confirmation belongs to the screen it happened on; warnings stay.
      for (const toast of Array.from(ui.toasts?.children || [])) {
        if (toast.dataset.tone !== "warn") dismissToast(toast);
      }
    }
    activeTab = name;
    closeAllMenus();
    if (ui.shell) {
      ui.shell.dataset.tab = name;
    }
    for (const tab of ui.tabs) {
      tab.dataset.active = tab.dataset.tab === name ? "true" : "false";
    }
    for (const pane of ui.panes) {
      pane.dataset.active = pane.dataset.pane === name ? "true" : "false";
    }
    if (ui.toolbarTitle) {
      ui.toolbarTitle.textContent = TAB_TITLES[name] || "";
    }
    if (typeof onTabShown === "function") {
      onTabShown(name);
    }
  }

  function swapButtonIcon(button, name) {
    if (button.dataset.icon === name) {
      return;
    }
    button.dataset.icon = name;
    const old = button.querySelector(".ias-ic");
    if (old) {
      old.outerHTML = icon(name, 14);
    }
  }

  function renderControls() {
    const running = autoRun.active || queueRun.active;
    const completed = Math.max(0, Number.parseInt(autoRun.completedCount, 10) || 0);
    const targetLabel = autoRun.target > 0 ? String(autoRun.target) : "∞";

    if (ui.autoButton) {
      const label = ui.autoButton.querySelector("span");
      if (label) {
        label.textContent = autoRun.active && !queueRun.active ? "멈추기" : "생성 시작";
      }
      ui.autoButton.dataset.active = autoRun.active && !queueRun.active ? "true" : "false";
      swapButtonIcon(ui.autoButton, autoRun.active && !queueRun.active ? "stop" : "play_arrow");
      ui.autoButton.disabled = queueRun.active;
    }
    if (ui.queueRunButton) {
      const label = ui.queueRunButton.querySelector("span");
      if (label) {
        label.textContent = queueRun.active ? "멈추기" : "생성 시작";
      }
      ui.queueRunButton.dataset.active = queueRun.active ? "true" : "false";
      swapButtonIcon(ui.queueRunButton, queueRun.active ? "stop" : "play_arrow");
      ui.queueRunButton.disabled = !queueRun.active && queueState.items.length === 0;
    }
    if (ui.queueAddButton) {
      ui.queueAddButton.disabled = running;
    }
    if (ui.queueClearButton) {
      ui.queueClearButton.disabled = running || queueState.items.length === 0;
    }
    renderActivity({ running, completed, targetLabel });
    renderBadges();
  }

  // --- toolbar activity view + collapsed pill -------------------------------
  function activitySummary({ running, completed, targetLabel }) {
    if (!running) {
      return { running: false, title: "준비됨", sub: "", percent: null };
    }
    const perImage = avgImageMs() || seedImageMs;
    const remaining = remainingImages();
    const eta = remaining != null && perImage ? formatEta(remaining * perImage) : "";
    if (queueRun.active) {
      const item = queueRun.items[queueRun.index];
      return {
        running: true,
        title: item ? item.title : "대기열",
        sub: [`${completed}/${targetLabel}장`, `대기열 ${queueRun.index + 1}/${queueRun.items.length}`, eta ? `약 ${eta}` : ""].filter(Boolean).join(" · "),
        percent: overallPercent(),
      };
    }
    return {
      running: true,
      title: (saveContext.baseName || "").trim() || "바로 생성",
      sub: [`${completed}/${targetLabel}장`, eta ? `약 ${eta}` : ""].filter(Boolean).join(" · "),
      percent: currentItemPercent(),
    };
  }

  function progressRingSvg(percent, size = 30) {
    const r = size / 2 - 3;
    const c = 2 * Math.PI * r;
    const pct = percent == null ? 0.12 : Math.max(0.02, Math.min(1, percent / 100));
    return `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" aria-hidden="true" style="flex:0 0 auto;transform:rotate(-90deg)"><circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke="currentColor" stroke-opacity="0.16" stroke-width="3.5"/><circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke="var(--accent)" stroke-width="3.5" stroke-linecap="round" stroke-dasharray="${(c * pct).toFixed(1)} ${c.toFixed(1)}"/></svg>`;
  }


  function renderBadges() {
    if (ui.badgeQueue) {
      ui.badgeQueue.textContent = queueState.items.length ? String(queueState.items.length) : "";
    }
    if (ui.badgeMemo) {
      ui.badgeMemo.textContent = memoState.items.length ? String(memoState.items.length) : "";
    }
  }

  // --- appearance (auto / light / dark) --------------------------------------
  let appearance = "auto";
  const darkQuery = (() => {
    try {
      return window.matchMedia("(prefers-color-scheme: dark)");
    } catch (error) {
      return null;
    }
  })();
  function normalizeAppearance(value) {
    return value === "light" || value === "dark" ? value : "auto";
  }
  function resolvedTheme() {
    if (appearance === "light" || appearance === "dark") {
      return appearance;
    }
    return darkQuery && !darkQuery.matches ? "light" : "dark";
  }
  // The floating button sits on NovelAI's page, so its glass is tinted for
  // what is behind it (NovelAI's own theme), not for the panel's theme.
  function pageSurface() {
    const parse = (value) => (String(value).match(/[\d.]+/g) || []).map(Number);
    for (const node of [document.body, document.documentElement]) {
      if (!node) continue;
      const [r, g, b, a = 1] = parse(getComputedStyle(node).backgroundColor);
      if (r == null || a < 0.5) continue;
      return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255 > 0.6 ? "light" : "dark";
    }
    return "dark";
  }

  function applyAppearance() {
    if (ui.shell) {
      ui.shell.dataset.theme = resolvedTheme();
      ui.shell.dataset.surface = pageSurface();
    }
    for (const button of ui.appearanceButtons || []) {
      button.dataset.active = String(button.dataset.appearance === appearance);
    }
  }
  try {
    darkQuery?.addEventListener("change", () => applyAppearance());
  } catch (error) {
    void error;
  }

  function getSelectedQueueItem() {
    return queueState.items.find((item) => item.id === selectedQueueId) || null;
  }

  // Special right-hand views that are not queue items.
  const QUEUE_VIEWS = new Set(["common", "bulk", "order", "select"]);

  // ---- 선택 mode: check items, then delete them together ----------------------
  const queueSelect = { on: false, ids: new Set(), anchor: null, back: null };

  function setQueueSelectMode(on) {
    queueSelect.on = Boolean(on);
    queueSelect.ids.clear();
    queueSelect.anchor = null;
    if (ui.queueSelectButton) {
      ui.queueSelectButton.textContent = queueSelect.on ? "완료" : "선택";
      ui.queueSelectButton.setAttribute("aria-pressed", String(queueSelect.on));
    }
    if (queueSelect.on) {
      queueSelect.back = selectedQueueId;
      selectedQueueId = "select";
    } else if (selectedQueueId === "select") {
      selectedQueueId = queueSelect.back && queueSelect.back !== "select" ? queueSelect.back : null;
    }
    renderQueue();
  }

  function toggleQueueChecked(id, { range = false } = {}) {
    const ids = queueState.items.map((it) => it.id);
    if (range && queueSelect.anchor && ids.includes(queueSelect.anchor)) {
      const a = ids.indexOf(queueSelect.anchor);
      const b = ids.indexOf(id);
      for (const x of ids.slice(Math.min(a, b), Math.max(a, b) + 1)) queueSelect.ids.add(x);
    } else if (queueSelect.ids.has(id)) {
      queueSelect.ids.delete(id);
    } else {
      queueSelect.ids.add(id);
    }
    queueSelect.anchor = id;
    renderQueueList();
    renderQueueEditor();
  }

  async function deleteCheckedQueueItems() {
    const n = queueSelect.ids.size;
    if (!n || queueRun.active) return;
    const ok = await iosAlert({
      title: `${n}개를 지울까요?`,
      message: "대기열에서만 빠지고, 이미 저장한 그림은 그대로예요.",
      buttons: [{ label: "취소", value: false, cancel: true }, { label: "지우기", value: true, primary: true, destructive: true }],
    });
    if (!ok) return;
    queueState.items = queueState.items.filter((it) => !queueSelect.ids.has(it.id));
    queueSelect.ids.clear();
    await persistQueueState();
    setStatus(`대기열에서 ${n}개를 지웠어요.`, "ok");
  }

  // ---- grouping: which character / background an item belongs to -------------
  function knownBackgroundNames() {
    const names = new Set();
    for (const bg of genState.bgs || []) if (bg.code.trim()) names.add(bg.code.trim());
    for (const ch of genState.chars || []) for (const bg of ch.bgs || []) if (bg.code.trim()) names.add(bg.code.trim());
    return names;
  }
  function itemAxes(item, bgNames = knownBackgroundNames()) {
    if (item.axes) return { char: item.axes.char || item.folderName || "", bg: item.axes.bg || "" };
    // Older items: the character is the folder (or the name before "_"); the
    // background is guessed from the combination screen's background names.
    // Names are compared word by word, so "눈 오는 거리" also matches, and the
    // longest name wins ("밤 거리" before "밤").
    const words = (text) => ` ${String(text || "").replace(/[_\s-]+/g, " ").trim()} `;
    const parts = String(item.title || "").split(/[_\s-]+/).filter(Boolean);
    const char = item.folderName || parts[0] || "";
    const rest = words(String(item.title || "").replace(char, " "));
    const bg = [...bgNames].sort((a, b) => b.length - a.length).find((name) => rest.includes(words(name))) || "";
    return { char, bg };
  }
  function queueGroups(axis) {
    const bgNames = knownBackgroundNames();
    const map = new Map();
    for (const item of queueState.items) {
      const key = itemAxes(item, bgNames)[axis] || "";
      map.set(key, (map.get(key) || 0) + 1);
    }
    return [...map.entries()].map(([name, count]) => ({ name, count }));
  }

  // Regroup the whole queue: by the chosen order of characters (or backgrounds)
  // first, then the other axis, keeping the original order inside a group.
  async function applyQueueGrouping(axis, order) {
    if (queueRun.active) return;
    const first = queueState.options.groupFirst === "bg" ? "bg" : "char";
    const second = first === "char" ? "bg" : "char";
    const orders = { char: queueGroups("char").map((g) => g.name), bg: queueGroups("bg").map((g) => g.name) };
    orders[axis] = order;
    const bgNames = knownBackgroundNames();
    const rank = (list, key) => { const i = list.indexOf(key); return i < 0 ? list.length : i; };
    const keyed = queueState.items.map((item, i) => {
      const ax = itemAxes(item, bgNames);
      return { item, i, a: rank(orders[first], ax[first] || ""), b: rank(orders[second], ax[second] || "") };
    });
    keyed.sort((x, y) => x.a - y.a || x.b - y.b || x.i - y.i);
    queueState.items = keyed.map((k) => k.item);
    await persistQueueState();
  }

  function ensureSelection() {
    if (QUEUE_VIEWS.has(selectedQueueId)) {
      return;
    }
    if (!queueState.items.length) {
      selectedQueueId = null;
      return;
    }
    if (!queueState.items.some((item) => item.id === selectedQueueId)) {
      selectedQueueId = queueState.items[0].id;
    }
  }

  function renderQueue() {
    if (ui.loopToggle) {
      ui.loopToggle.checked = Boolean(queueState.options.loop);
    }
    if (ui.queueCount) {
      ui.queueCount.textContent = queueCountText();
    }
    ensureSelection();
    renderQueueList();
    renderQueueEditor();
  }

  function queueItemStatus(index) {
    if (queueRun.active && index === queueRun.index) {
      return "running";
    }
    if (queueRun.active && index < queueRun.index) {
      return "done";
    }
    return "wait";
  }

  function queueRowSub(item, index) {
    const status = queueItemStatus(index);
    if (status === "running") {
      const done = Math.max(0, Number.parseInt(autoRun.completedCount, 10) || 0);
      return `만드는 중 · ${done}/${item.count}장`;
    }
    if (status === "done") {
      return `${item.count}장 끝남`;
    }
    return `${item.count}장 · ${String(buildPreview(item)).replace(/[\s,]+$/, "")}`;
  }

  function commonBaseSub() {
    const on = Boolean(queueState.options.useGlobalBase);
    const text = String(queueState.options.globalBase || "").trim().replace(/\s+/g, " ");
    if (!on) {
      return "끔 · 항목마다 자기 베이스";
    }
    return text ? `켬 · ${text}` : "켬 · 아직 비어 있음";
  }

  function renderQueueList() {
    if (!ui.queueList) {
      return;
    }
    ui.queueList.innerHTML = "";
    const common = document.createElement("button");
    common.type = "button";
    common.className = "ias-row ias-qcommon";
    common.dataset.view = "common";
    common.setAttribute("role", "option");
    common.setAttribute("aria-selected", String(selectedQueueId === "common"));
    common.innerHTML = `<span class="ias-row-mark" aria-hidden="true">≡</span><span class="ias-row-text"><span class="ias-row-title">공통 베이스</span><span class="ias-row-sub" data-role="common-sub"></span></span>`;
    common.querySelector('[data-role="common-sub"]').textContent = commonBaseSub();
    ui.queueList.append(common);
    if (queueState.items.length > 1 && !queueSelect.on) {
      const order = document.createElement("button");
      order.type = "button";
      order.className = "ias-row ias-qcommon";
      order.dataset.view = "order";
      order.setAttribute("role", "option");
      order.setAttribute("aria-selected", String(selectedQueueId === "order"));
      order.innerHTML = '<span class="ias-row-mark" aria-hidden="true">⇅</span><span class="ias-row-text"><span class="ias-row-title">캐릭터별 순서</span><span class="ias-row-sub">캐릭터 · 배경 묶어서 바꾸기</span></span>';
      ui.queueList.append(order);
    }
    const sep = document.createElement("div");
    sep.className = "ias-row-sep";
    ui.queueList.append(sep);

    if (!queueState.items.length) {
      // the editor side explains what to do; the list stays quiet
      return;
    }
    queueState.items.forEach((item, index) => {
      const status = queueItemStatus(index);
      const row = document.createElement("button");
      row.type = "button";
      row.className = "ias-row ias-qcard";
      row.dataset.id = item.id;
      row.draggable = !queueRun.active && !queueSelect.on;
      row.setAttribute("role", "option");
      row.setAttribute("aria-selected", String(queueSelect.on ? queueSelect.ids.has(item.id) : item.id === selectedQueueId));
      if (status === "running") {
        row.dataset.running = "true";
      } else if (status === "done") {
        row.dataset.done = "true";
      }
      const mark = document.createElement("span");
      mark.className = "ias-row-mark";
      mark.dataset.kind = status;
      mark.textContent = status === "done" ? "✓" : status === "running" ? "●" : String(index + 1);
      if (queueSelect.on) {
        mark.dataset.kind = "check";
        mark.dataset.checked = String(queueSelect.ids.has(item.id));
        mark.textContent = "";
        mark.innerHTML = queueSelect.ids.has(item.id) ? icon("check_circle", 18) : '<span class="ias-check-ring"></span>';
      }
      const text = document.createElement("span");
      text.className = "ias-row-text";
      const title = document.createElement("span");
      title.className = "ias-row-title";
      title.dataset.role = "name";
      title.textContent = (item.title || "").trim() || "(이름 없음)";
      const sub = document.createElement("span");
      sub.className = "ias-row-sub";
      sub.dataset.role = "meta";
      sub.textContent = queueRowSub(item, index);
      text.append(title, sub);
      row.append(mark, text);
      ui.queueList.append(row);
    });

    if (queueRun.active) {
      const runningRow = ui.queueList.querySelector('.ias-qcard[data-running="true"]');
      runningRow?.scrollIntoView?.({ behavior: "smooth", block: "nearest", inline: "nearest" });
    }
  }

  function buildPreview(item) {
    const base = (item.basePrompt || "").trim();
    const chars = (item.characterPrompt || "").trim();
    const combined = chars || base;
    return combined ? combined.replace(/\s*;;\s*/g, " | ").replace(/\s+/g, " ").slice(0, 70) : "NovelAI 값 그대로";
  }

  function queueTextarea(field, value) {
    const el = document.createElement("textarea");
    el.className = "ias-input";
    el.dataset.field = field;
    el.value = value || "";
    return el;
  }

  function renderQueueEditor() {
    if (!ui.queueEditor) {
      return;
    }
    ui.queueEditor.innerHTML = "";
    const view = selectedQueueId;
    const wrap = document.createElement("div");
    const body = document.createElement("div");
    body.className = "ias-detail-body";
    wrap.append(body);
    ui.queueEditor.append(wrap);

    if (view === "common") {
      const head = document.createElement("div");
      head.className = "ias-detail-head";
      head.innerHTML = `<span class="ias-detail-title ias-grow">공통 베이스</span><label class="ias-switch-row">모든 항목에 쓰기<span class="ias-switch"><input class="ias-global-base-toggle" type="checkbox"${queueState.options.useGlobalBase ? " checked" : ""}><span class="ias-slider"></span></span></label>`;
      const meta = document.createElement("span");
      meta.className = "ias-detail-meta";
      meta.textContent = "켜 두면 모든 항목의 베이스 대신 이게 들어가요. 비워 두면 각 항목의 베이스를 써요.";
      const host = document.createElement("div");
      host.className = "ias-pe-host";
      const baseEl = queueTextarea("globalBase", queueState.options.globalBase);
      const baseNegEl = queueTextarea("globalBaseNegative", queueState.options.globalBaseNegative);
      const charEl = queueTextarea("_none", "");
      const charNegEl = queueTextarea("_none", "");
      host.append(baseEl, baseNegEl, charEl, charNegEl);
      body.append(head, meta, host);
      attachPromptEditor({ base: baseEl, baseNeg: baseNegEl, char: charEl, charNeg: charNegEl }, {
        showChars: false,
        basePlaceholder: "모든 항목에 들어갈 베이스 · 예: masterpiece, best quality",
      })?.setDisabled(queueRun.active);
      head.querySelector("input").disabled = queueRun.active;
      return;
    }

    if (view === "select") {
      const n = queueSelect.ids.size;
      const all = queueState.items.length && n === queueState.items.length;
      const chips = queueGroups("char").filter((g) => g.name).map((g) => {
        const ids = queueState.items.filter((it) => itemAxes(it).char === g.name).map((it) => it.id);
        const on = ids.length && ids.every((id) => queueSelect.ids.has(id));
        return `<button type="button" class="ias-chip ias-chip-round" data-pick-char="${escapeAttr(g.name)}" data-selected="${on}">${escapeHtml(g.name)}<span class="ias-chip-count">${g.count}</span></button>`;
      }).join("");
      body.innerHTML = `
        <span class="ias-detail-title">${n ? `${n}개 골랐어요` : "지울 항목을 골라요"}</span>
        <span class="ias-detail-meta">왼쪽 목록에서 눌러서 골라요. <b>Shift</b>를 누른 채 누르면 사이에 있는 항목이 다 골라져요.</span>
        ${chips ? `<span class="ias-field-label">캐릭터로 한꺼번에 고르기</span><div class="ias-chips ias-order-chips">${chips}</div>` : ""}
        <div class="ias-bulk-row ias-select-actions">
          <button class="ias-btn secondary" type="button" data-select-all>${all ? "모두 해제" : "모두 고르기"}</button>
          <button class="ias-btn danger" type="button" data-select-delete ${n && !queueRun.active ? "" : "disabled"}>${icon("delete", 14)}<span>${n ? `${n}개 지우기` : "지우기"}</span></button>
        </div>
        ${queueRun.active ? '<span class="ias-detail-meta">생성 중에는 지울 수 없어요. 멈춘 다음 지워 주세요.</span>' : ""}`;
      return;
    }

    if (view === "order") {
      const first = queueState.options.groupFirst === "bg" ? "bg" : "char";
      const chipRow = (axis) => queueGroups(axis).map((g, i) => `<button type="button" class="ias-chip ias-chip-round ias-order-chip" draggable="${!queueRun.active}" data-axis="${axis}" data-name="${escapeAttr(g.name)}" data-index="${i}" title="끌어서 순서 바꾸기 · 누르면 맨 앞으로">${escapeHtml(g.name || (axis === "bg" ? "배경 모름" : "이름 없음"))}<span class="ias-chip-count">${g.count}</span></button>`).join("");
      const bgGroups = queueGroups("bg");
      const hasBg = bgGroups.some((g) => g.name);
      body.innerHTML = `
        <span class="ias-detail-title">캐릭터별 순서</span>
        <span class="ias-detail-meta">칩을 <b>끌어서</b> 순서를 바꾸거나, <b>누르면 맨 앞으로</b> 와요. 대기열 전체가 그 순서로 묶여요. 묶음 안의 순서는 그대로예요.</span>
        <span class="ias-field-label">캐릭터</span>
        <div class="ias-chips ias-order-chips" data-axis="char">${chipRow("char")}</div>
        <span class="ias-field-label">배경</span>
        ${hasBg ? `<div class="ias-chips ias-order-chips" data-axis="bg">${chipRow("bg")}</div>` : '<span class="ias-detail-meta">조합에서 넣은 항목이면 배경으로도 묶을 수 있어요.</span>'}
        ${hasBg ? `<span class="ias-field-label">먼저 묶을 것</span>
        <div class="ias-seg" role="radiogroup" aria-label="먼저 묶을 것"><button type="button" class="ias-seg-btn" data-group-first="char" aria-selected="${first === "char"}">캐릭터별로</button><button type="button" class="ias-seg-btn" data-group-first="bg" aria-selected="${first === "bg"}">배경별로</button></div>
        <span class="ias-detail-meta">예: 김윤자를 누르고 밤을 누르면, 김윤자 밤 → 김윤자 나머지 → 다른 캐릭터 순서가 돼요.</span>` : ""}
        ${queueRun.active ? '<span class="ias-detail-meta">생성 중에는 순서를 바꿀 수 없어요.</span>' : ""}`;
      if (queueRun.active) body.querySelectorAll("button").forEach((b) => { b.disabled = true; });
      return;
    }

    if (view === "bulk") {
      body.innerHTML = `
        <span class="ias-detail-title">한꺼번에 바꾸기</span>
        <span class="ias-detail-meta">대기열 ${queueState.items.length}개 항목 전부에 적용돼요.</span>
        <label class="ias-field-label" for="ias-name-pattern">저장 이름</label>
        <div class="ias-bulk-row"><input class="ias-input ias-name-pattern" id="ias-name-pattern" type="text" placeholder="예: 김춘자_{n} → 김춘자_1, 김춘자_2…"><button class="ias-btn secondary small ias-name-pattern-apply" type="button">적용</button></div>
        <label class="ias-field-label" for="ias-bulk-count">장수</label>
        <div class="ias-bulk-row"><input class="ias-input ias-bulk-count" id="ias-bulk-count" type="number" min="1" step="1" placeholder="예: 30"><button class="ias-btn secondary small ias-bulk-count-set" type="button">모두 이 값</button><button class="ias-btn secondary small ias-bulk-count-add" type="button">더하기</button></div>
      `;
      ui.namePatternInput = body.querySelector(".ias-name-pattern");
      ui.bulkCountInput = body.querySelector(".ias-bulk-count");
      ui.namePatternInput.value = queueState.options.namePattern || "";
      for (const el of body.querySelectorAll("input, button")) {
        el.disabled = queueRun.active;
      }
      return;
    }

    const item = getSelectedQueueItem();
    if (!item) {
      body.innerHTML = '<div class="ias-list-empty">대기열이 비어 있어요.<br>위의 ＋를 누르면 지금 NovelAI 프롬프트가 한 줄 들어가요.<br>조합에서 한꺼번에 만들 수도 있어요.</div>';
      return;
    }
    const disabled = queueRun.active;
    const index = queueState.items.findIndex((entry) => entry.id === item.id);
    const status = queueItemStatus(index);

    const head = document.createElement("div");
    head.className = "ias-detail-head";
    const nameInput = document.createElement("input");
    nameInput.type = "text";
    nameInput.className = "ias-title-input";
    nameInput.value = item.title || "";
    nameInput.placeholder = "저장 이름";
    nameInput.maxLength = 80;
    nameInput.dataset.field = "title";
    nameInput.setAttribute("aria-label", "저장 이름");
    nameInput.disabled = disabled;
    const stepper = document.createElement("div");
    stepper.className = "ias-stepper";
    stepper.setAttribute("role", "group");
    stepper.setAttribute("aria-label", "장수");
    stepper.innerHTML = `<button type="button" data-step="-1" aria-label="한 장 빼기">−</button><input type="number" min="1" max="9999" inputmode="numeric" data-field="count" aria-label="장수"><button type="button" data-step="1" aria-label="한 장 더하기">+</button>`;
    stepper.querySelector("input").value = String(item.count);
    stepper.querySelectorAll("button, input").forEach((el) => {
      el.disabled = disabled;
    });
    head.append(nameInput, stepper);

    const meta = document.createElement("span");
    meta.className = "ias-detail-meta";
    meta.dataset.role = "item-meta";
    if (status === "running") {
      meta.dataset.tone = "running";
      meta.textContent = `${index + 1}번째 · 지금 만드는 중 · 멈추면 고칠 수 있어요`;
    } else {
      meta.textContent = disabled ? `${index + 1}번째 · 실행 중엔 고칠 수 없어요` : `${index + 1}번째 · ${item.count}장`;
    }

    const host = document.createElement("div");
    host.className = "ias-pe-host";
    const baseEl = queueTextarea("basePrompt", item.basePrompt);
    const baseNegEl = queueTextarea("baseNegativePrompt", item.baseNegativePrompt);
    const charEl = queueTextarea("characterPrompt", item.characterPrompt);
    const charNegEl = queueTextarea("negativePrompt", item.negativePrompt);
    host.append(baseEl, baseNegEl, charEl, charNegEl);
    body.append(head, meta, host);
    const commonActive = Boolean(queueState.options.useGlobalBase) && String(queueState.options.globalBase || "").trim();
    const editor = attachPromptEditor({ base: baseEl, baseNeg: baseNegEl, char: charEl, charNeg: charNegEl }, {
      basePlaceholder: commonActive ? "공통 베이스를 쓰는 중이라 이 칸은 안 들어가요" : "비우면 NovelAI에 있는 값을 그대로 써요",
      baseNote: () => (commonActive ? "공통 베이스 사용 중" : ""),
    });
    editor?.setDisabled(disabled);
    ui.queuePromptEditor = editor;

    const foot = document.createElement("div");
    foot.className = "ias-detail-foot";
    foot.innerHTML = `
      <button type="button" class="ias-text-btn danger" data-action="remove">삭제</button>
      <button type="button" class="ias-text-btn" data-action="duplicate">복제</button>
      <span class="ias-grow"></span>
      <button type="button" class="ias-icon-btn" data-action="up" aria-label="위로" title="위로">${icon("keyboard_arrow_up", 16)}</button>
      <button type="button" class="ias-icon-btn" data-action="down" aria-label="아래로" title="아래로">${icon("keyboard_arrow_down", 16)}</button>
    `;
    foot.querySelector('[data-action="remove"]').disabled = disabled;
    foot.querySelector('[data-action="duplicate"]').disabled = disabled;
    foot.querySelector('[data-action="up"]').disabled = disabled || index === 0;
    foot.querySelector('[data-action="down"]').disabled = disabled || index === queueState.items.length - 1;
    wrap.append(foot);
  }
  let queueEditorTab = "";

  function updateRowDisplay(item) {
    if (!ui.queueList) {
      return;
    }
    const row = ui.queueList.querySelector(`.ias-qcard[data-id="${item.id}"]`);
    if (!row) {
      return;
    }
    const index = queueState.items.findIndex((entry) => entry.id === item.id);
    const name = row.querySelector('[data-role="name"]');
    const meta = row.querySelector('[data-role="meta"]');
    if (name) {
      name.textContent = (item.title || "").trim() || "(이름 없음)";
    }
    if (meta) {
      meta.textContent = queueRowSub(item, index);
    }
  }

  function selectQueueView(id) {
    if (selectedQueueId === id) {
      return;
    }
    if (ui.queuePromptEditor && !QUEUE_VIEWS.has(selectedQueueId)) {
      queueEditorTab = ui.queuePromptEditor.active();
    }
    selectedQueueId = id;
    renderQueueList();
    renderQueueEditor();
  }

  function handleQueueListClick(event) {
    const row = event.target.closest(".ias-row");
    if (!row) {
      return;
    }
    if (row.dataset.view) {
      selectQueueView(row.dataset.view);
      return;
    }
    if (row.dataset.id) {
      if (queueSelect.on) {
        toggleQueueChecked(row.dataset.id, { range: event.shiftKey });
        return;
      }
      selectQueueView(row.dataset.id);
    }
  }

  function handleEditorClick(event) {
    const target = event.target instanceof Element ? event.target : null;
    if (!target) {
      return;
    }
    if (target.closest("[data-select-all]")) {
      const all = queueSelect.ids.size === queueState.items.length;
      queueSelect.ids = all ? new Set() : new Set(queueState.items.map((it) => it.id));
      renderQueueList();
      renderQueueEditor();
      return;
    }
    if (target.closest("[data-select-delete]")) {
      void deleteCheckedQueueItems();
      return;
    }
    const pick = target.closest("[data-pick-char]");
    if (pick) {
      const name = pick.dataset.pickChar;
      const ids = queueState.items.filter((it) => itemAxes(it).char === name).map((it) => it.id);
      const on = ids.every((id) => queueSelect.ids.has(id));
      for (const id of ids) on ? queueSelect.ids.delete(id) : queueSelect.ids.add(id);
      renderQueueList();
      renderQueueEditor();
      return;
    }
    const groupFirst = target.closest("[data-group-first]");
    if (groupFirst) {
      queueState.options.groupFirst = groupFirst.dataset.groupFirst;
      const axis = groupFirst.dataset.groupFirst;
      void applyQueueGrouping(axis, queueGroups(axis).map((g) => g.name));
      return;
    }
    const orderChip = target.closest(".ias-order-chip");
    if (orderChip && !queueRun.active) {
      const axis = orderChip.dataset.axis;
      const names = queueGroups(axis).map((g) => g.name);
      const name = orderChip.dataset.name;
      void applyQueueGrouping(axis, [name, ...names.filter((n) => n !== name)]);
      return;
    }
    const step = target.closest("button[data-step]");
    if (step) {
      const item = getSelectedQueueItem();
      if (!item || queueRun.active) {
        return;
      }
      item.count = Store.normalizeCount((item.count || 1) + Number(step.dataset.step));
      const input = ui.queueEditor.querySelector('input[data-field="count"]');
      if (input) {
        input.value = String(item.count);
      }
      afterQueueItemEdit(item);
      return;
    }
    const action = target.closest("button[data-action]")?.dataset.action;
    const id = selectedQueueId;
    if (action === "remove") {
      void removeQueueItem(id);
    } else if (action === "duplicate") {
      void duplicateQueueItem(id);
    } else if (action === "up") {
      void moveQueueItem(id, -1);
    } else if (action === "down") {
      void moveQueueItem(id, 1);
    } else if (target.closest(".ias-name-pattern-apply")) {
      void applyNamePatternToAll();
    } else if (target.closest(".ias-bulk-count-set")) {
      void applyCountToAll("set");
    } else if (target.closest(".ias-bulk-count-add")) {
      void applyCountToAll("add");
    }
  }

  function afterQueueItemEdit(item) {
    updateRowDisplay(item);
    const meta = ui.queueEditor?.querySelector('[data-role="item-meta"]');
    const index = queueState.items.findIndex((entry) => entry.id === item.id);
    if (meta && !queueRun.active) {
      meta.textContent = `${index + 1}번째 · ${item.count}장`;
    }
    if (ui.queueCount) {
      ui.queueCount.textContent = queueCountText();
    }
    renderControls();
    scheduleQueueSave();
  }

  function handleEditorInput(event) {
    const target = event.target;
    if (target.classList?.contains("ias-global-base-toggle")) {
      queueState.options.useGlobalBase = target.checked;
      void persistQueueState();
      return;
    }
    if (target.classList?.contains("ias-name-pattern")) {
      queueState.options.namePattern = target.value;
      scheduleQueueSave();
      return;
    }
    const field = target.dataset?.field;
    if (!field || field === "_none") {
      return;
    }
    if (field === "globalBase" || field === "globalBaseNegative") {
      queueState.options[field] = target.value;
      const sub = ui.queueList?.querySelector('[data-role="common-sub"]');
      if (sub) {
        sub.textContent = commonBaseSub();
      }
      scheduleQueueSave();
      return;
    }
    const item = getSelectedQueueItem();
    if (!item) {
      return;
    }
    if (field === "title") {
      item.title = target.value;
      delete item.folderName;
    } else if (field === "basePrompt") {
      item.basePrompt = target.value;
    } else if (field === "baseNegativePrompt") {
      item.baseNegativePrompt = target.value;
    } else if (field === "characterPrompt") {
      item.characterPrompt = target.value;
    } else if (field === "negativePrompt") {
      item.negativePrompt = target.value;
    } else if (field === "count") {
      const numeric = Number.parseInt(target.value, 10);
      if (event.type === "input" && !Number.isFinite(numeric)) {
        return;
      }
      item.count = Number.isFinite(numeric) && numeric > 0 ? Math.min(9999, numeric) : 1;
      if (event.type === "change") {
        target.value = String(item.count);
      }
    }
    afterQueueItemEdit(item);
  }


  function scheduleQueueSave() {
    if (queueSaveTimer) {
      clearTimeout(queueSaveTimer);
    }
    queueSaveTimer = setTimeout(() => {
      queueSaveTimer = null;
      void storageSet("local", { [QUEUE_STORAGE_KEY]: Store.normalizeState(queueState) });
    }, 300);
  }








  // Order view: drag a character/background chip before another one.
  function enableOrderChipDrag() {
    const host = ui.queueEditor;
    if (!host) return;
    let drag = null;
    host.addEventListener("dragstart", (event) => {
      const chip = event.target.closest?.(".ias-order-chip");
      if (!chip || queueRun.active) return;
      drag = { axis: chip.dataset.axis, name: chip.dataset.name };
      chip.dataset.dragging = "true";
      try {
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("text/plain", drag.name);
      } catch (error) {
        void error;
      }
    });
    host.addEventListener("dragover", (event) => {
      if (!drag) return;
      const chip = event.target.closest?.(".ias-order-chip");
      host.querySelectorAll('.ias-order-chip[data-dropbefore="true"]').forEach((el) => delete el.dataset.dropbefore);
      if (chip && chip.dataset.axis === drag.axis) {
        event.preventDefault();
        if (chip.dataset.name !== drag.name) chip.dataset.dropbefore = "true";
      } else if (event.target.closest?.(`.ias-order-chips[data-axis="${drag.axis}"]`)) {
        event.preventDefault();
      }
    });
    host.addEventListener("drop", (event) => {
      if (!drag) return;
      event.preventDefault();
      const chip = event.target.closest?.(".ias-order-chip");
      const names = queueGroups(drag.axis).map((g) => g.name).filter((n) => n !== drag.name);
      const at = chip && chip.dataset.axis === drag.axis ? names.indexOf(chip.dataset.name) : names.length;
      names.splice(at < 0 ? names.length : at, 0, drag.name);
      const axis = drag.axis;
      drag = null;
      void applyQueueGrouping(axis, names);
    });
    host.addEventListener("dragend", () => {
      drag = null;
      host.querySelectorAll(".ias-order-chip[data-dragging], .ias-order-chip[data-dropbefore]").forEach((el) => {
        delete el.dataset.dragging;
        delete el.dataset.dropbefore;
      });
    });
  }

  function enableQueueDragSort() {
    const list = ui.queueList;
    if (!list) {
      return;
    }
    let dragId = null;

    list.addEventListener("dragstart", (event) => {
      const card = event.target.closest(".ias-qcard");
      if (!card || queueRun.active) {
        return;
      }
      dragId = card.dataset.id;
      card.dataset.dragging = "true";
      try {
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("text/plain", dragId);
      } catch (error) {
        void error;
      }
    });
    list.addEventListener("dragend", () => {
      const dragged = list.querySelector('.ias-qcard[data-dragging="true"]');
      if (dragged) {
        delete dragged.dataset.dragging;
      }
      list.querySelectorAll('.ias-qcard[data-dropbefore="true"]').forEach((el) => delete el.dataset.dropbefore);
      dragId = null;
    });
    list.addEventListener("dragover", (event) => {
      if (!dragId) {
        return;
      }
      event.preventDefault();
      const over = event.target.closest(".ias-qcard");
      list.querySelectorAll('.ias-qcard[data-dropbefore="true"]').forEach((el) => delete el.dataset.dropbefore);
      if (over && over.dataset.id !== dragId) {
        over.dataset.dropbefore = "true";
      }
    });
    list.addEventListener("drop", (event) => {
      if (!dragId) {
        return;
      }
      event.preventDefault();
      const over = event.target.closest(".ias-qcard");
      const ids = queueState.items.map((it) => it.id);
      let toIndex = over ? ids.indexOf(over.dataset.id) : ids.length - 1;
      const fromIndex = ids.indexOf(dragId);
      if (toIndex > fromIndex) {
        toIndex -= 1;
      }
      void reorderQueueItem(dragId, toIndex);
      dragId = null;
    });
  }

  // Drag-to-scroll: grab empty space in a scroll container and pan it.
  // Skips interactive elements and draggable cards so reordering/typing still work.
  function enableGrabScroll(el) {
    if (!el || el.dataset.grabScroll === "on") {
      return;
    }
    el.dataset.grabScroll = "on";
    let active = false;
    let startY = 0;
    let startTop = 0;
    let moved = false;
    let pointerId = null;
    const isInteractive = (target) =>
      target.closest(
        "button, input, textarea, select, label, a, .ias-switch, .ias-qcard, [contenteditable]"
      );
    el.addEventListener("pointerdown", (event) => {
      if (event.button !== 0 || isInteractive(event.target)) {
        return;
      }
      active = true;
      moved = false;
      startY = event.clientY;
      startTop = el.scrollTop;
      pointerId = event.pointerId;
    });
    el.addEventListener("pointermove", (event) => {
      if (!active) {
        return;
      }
      const dy = event.clientY - startY;
      if (!moved && Math.abs(dy) < 3) {
        return;
      }
      moved = true;
      el.dataset.grabbing = "true";
      try {
        el.setPointerCapture(pointerId);
      } catch (error) {
        void error;
      }
      el.scrollTop = startTop - dy;
      event.preventDefault();
    });
    const end = () => {
      if (!active) {
        return;
      }
      active = false;
      delete el.dataset.grabbing;
      try {
        if (pointerId != null && el.hasPointerCapture(pointerId)) {
          el.releasePointerCapture(pointerId);
        }
      } catch (error) {
        void error;
      }
      pointerId = null;
    };
    el.addEventListener("pointerup", end);
    el.addEventListener("pointercancel", end);
    el.addEventListener("pointerleave", end);
  }


  function setPanelCollapsed(collapsed) {
    panelCollapsed = Boolean(collapsed);
    // An open panel owns every key pressed inside it; a collapsed one only
    // shields its own text fields.
    keyShield?.setPanelOpen(!panelCollapsed);
    if (ui.shell) {
      ui.shell.dataset.collapsed = panelCollapsed ? "true" : "false";
      ui.shell.dataset.surface = pageSurface();
    }
    // Collapsing while fullscreen would leave the shell stretched to inset:0,
    // an invisible full-screen overlay that swallows every click (the X then
    // "does nothing"). Drop fullscreen on collapse so the FAB returns to its
    // small corner footprint.
    if (panelCollapsed && panelFullscreen) {
      panelFullscreen = false;
      applyFullscreen();
    }
    if (!panelCollapsed) {
      // The expanded card is far larger than the fab; pull it back on-screen.
      requestAnimationFrame(clampPanelIntoView);
      onTabShown(activeTab);
    } else {
      endTourRun();
    }
    persistUiState();
  }

  function toggleCompact() {
    panelCompact = !panelCompact;
    if (panelCompact && panelFullscreen) {
      panelFullscreen = false;
      applyFullscreen();
    }
    if (panelCollapsed) {
      setPanelCollapsed(false);
    }
    applyCompact();
    persistUiState();
  }

  function applyCompact() {
    if (!ui.shell) {
      return;
    }
    ui.shell.dataset.compact = panelCompact ? "true" : "false";
    if (ui.sideMin) {
      ui.sideMin.title = panelCompact ? "원래 크기로" : "작게";
      ui.sideMin.setAttribute("aria-label", ui.sideMin.title);
    }
    requestAnimationFrame(clampPanelIntoView);
  }

  function toggleFullscreen() {
    panelFullscreen = !panelFullscreen;
    if (panelFullscreen && panelCompact) {
      panelCompact = false;
      applyCompact();
    }
    if (panelFullscreen && panelCollapsed) {
      setPanelCollapsed(false);
    }
    applyFullscreen();
    persistUiState();
  }

  function applyFullscreen() {
    if (!ui.shell) {
      return;
    }
    ui.shell.dataset.fullscreen = panelFullscreen ? "true" : "false";
    if (ui.sideFs) {
      ui.sideFs.setAttribute("aria-label", panelFullscreen ? "전체화면 해제" : "전체화면");
      ui.sideFs.title = panelFullscreen ? "전체화면 해제" : "전체화면";
    }
    if (panelFullscreen) {
      // Let the fullscreen CSS drive the size; drop any manual width/height.
      if (ui.card) {
        ui.card.style.width = "";
        ui.card.style.height = "";
      }
    } else {
      applyPanelSize();
    }
    requestAnimationFrame(clampPanelIntoView);
  }

  function persistUiState() {
    void storageSet("local", {
      [UI_STORAGE_KEY]: { collapsed: panelCollapsed, position: panelPosition, size: panelSize, fullscreen: panelFullscreen, compact: panelCompact },
    });
  }

  function applyPanelPosition() {
    if (!ui.shell || !panelPosition) {
      return;
    }
    ui.shell.style.left = `${panelPosition.left}px`;
    ui.shell.style.top = `${panelPosition.top}px`;
    ui.shell.style.right = "auto";
    ui.shell.style.bottom = "auto";
  }

  function applyPanelSize() {
    if (!ui.card || !panelSize) {
      return;
    }
    ui.card.style.width = `${panelSize.width}px`;
    ui.card.style.height = `${panelSize.height}px`;
  }

  function enableDrag(handle, options = {}) {
    if (!handle) {
      return;
    }
    const tapToOpen = Boolean(options.tapToOpen);
    let startX = 0;
    let startY = 0;
    let originLeft = 0;
    let originTop = 0;
    let dragging = false;
    let moved = false;

    handle.addEventListener("pointerdown", (event) => {
      // On non-fab handles, ignore drags that start on interactive controls.
      if (!tapToOpen && event.target.closest("button, input, textarea, label, .ias-list, .ias-scroll")) {
        return;
      }
      dragging = true;
      moved = false;
      const rect = ui.shell.getBoundingClientRect();
      originLeft = rect.left;
      originTop = rect.top;
      startX = event.clientX;
      startY = event.clientY;
      try {
        handle.setPointerCapture(event.pointerId);
      } catch (error) {
        void error;
      }
    });
    handle.addEventListener("pointermove", (event) => {
      if (!dragging) {
        return;
      }
      const dx = event.clientX - startX;
      const dy = event.clientY - startY;
      if (!moved && Math.hypot(dx, dy) > 5) {
        moved = true;
        if (tapToOpen) {
          handle.dataset.dragging = "true";
        }
      }
      if (!moved) {
        return;
      }
      const rect = ui.shell.getBoundingClientRect();
      const maxLeft = Math.max(4, window.innerWidth - rect.width - 4);
      const maxTop = Math.max(4, window.innerHeight - rect.height - 4);
      const left = Math.max(4, Math.min(maxLeft, originLeft + dx));
      const top = Math.max(4, Math.min(maxTop, originTop + dy));
      panelPosition = { left, top };
      applyPanelPosition();
    });
    const endDrag = (event) => {
      if (!dragging) {
        return;
      }
      dragging = false;
      delete handle.dataset.dragging;
      try {
        handle.releasePointerCapture(event.pointerId);
      } catch (error) {
        void error;
      }
      if (moved) {
        clampPanelIntoView();
        persistUiState();
      } else if (tapToOpen) {
        setPanelCollapsed(false);
      }
    };
    handle.addEventListener("pointerup", endDrag);
    handle.addEventListener("pointercancel", endDrag);
  }

  // Desktop-window resizing: every edge and corner of the card is a handle.
  // Dragging the left/top edges moves the window so the opposite edge stays put.
  const PANEL_MIN_W = 380;
  const PANEL_MIN_H = 320;
  function enableEdgeResize(handles) {
    for (const handle of handles || []) {
      const dir = handle.dataset.edge || "";
      let start = null;
      handle.addEventListener("pointerdown", (event) => {
        if (panelFullscreen || event.button !== 0) {
          return;
        }
        const rect = ui.card.getBoundingClientRect();
        panelPosition = { left: rect.left, top: rect.top };
        applyPanelPosition();
        start = { x: event.clientX, y: event.clientY, left: rect.left, top: rect.top, w: rect.width, h: rect.height };
        ui.shell.dataset.resizing = "true";
        try {
          handle.setPointerCapture(event.pointerId);
        } catch (error) {
          void error;
        }
        event.preventDefault();
        event.stopPropagation();
      });
      handle.addEventListener("pointermove", (event) => {
        if (!start) {
          return;
        }
        const dx = event.clientX - start.x;
        const dy = event.clientY - start.y;
        let { left, top, w, h } = start;
        if (dir.includes("e")) {
          w = Math.max(PANEL_MIN_W, Math.min(window.innerWidth - start.left - 4, start.w + dx));
        }
        if (dir.includes("w")) {
          w = Math.max(PANEL_MIN_W, Math.min(start.left + start.w - 4, start.w - dx));
          left = start.left + start.w - w;
        }
        if (dir.includes("s")) {
          h = Math.max(PANEL_MIN_H, Math.min(window.innerHeight - start.top - 4, start.h + dy));
        }
        if (dir.includes("n")) {
          h = Math.max(PANEL_MIN_H, Math.min(start.top + start.h - 4, start.h - dy));
          top = start.top + start.h - h;
        }
        panelSize = { width: Math.round(w), height: Math.round(h) };
        panelPosition = { left: Math.round(left), top: Math.round(top) };
        applyPanelSize();
        applyPanelPosition();
      });
      const end = (event) => {
        if (!start) {
          return;
        }
        start = null;
        delete ui.shell.dataset.resizing;
        try {
          handle.releasePointerCapture(event.pointerId);
        } catch (error) {
          void error;
        }
        persistUiState();
      };
      handle.addEventListener("pointerup", end);
      handle.addEventListener("pointercancel", end);
      // Double-click a corner or edge: back to the default size.
      handle.addEventListener("dblclick", () => {
        panelSize = null;
        ui.card.style.width = "";
        ui.card.style.height = "";
        requestAnimationFrame(clampPanelIntoView);
        persistUiState();
      });
    }
  }

  function clampPanelIntoView() {
    if (!ui.shell || !panelPosition || panelFullscreen) {
      return;
    }
    const rect = ui.shell.getBoundingClientRect();
    const maxLeft = Math.max(4, window.innerWidth - rect.width - 4);
    const maxTop = Math.max(4, window.innerHeight - rect.height - 4);
    panelPosition = {
      left: Math.max(4, Math.min(maxLeft, panelPosition.left)),
      top: Math.max(4, Math.min(maxTop, panelPosition.top)),
    };
    applyPanelPosition();
  }

  function getStyles() {
    return `
      :host { all: initial; }
      *, *::before, *::after { box-sizing: border-box; }

      /* ======================================================================
         Theme tokens (macOS-like). data-theme is "dark" or "light"; "auto"
         is resolved in JS from prefers-color-scheme.
         ====================================================================== */
      .ias-shell {
        --bg: #1E1E1E; --side: #2A2A2C; --elev: #2C2C2E; --elev2: #3A3A3C; --group: #262628;
        --border: rgba(255,255,255,0.09); --field-border: rgba(255,255,255,0.14); --hair: rgba(255,255,255,0.07);
        --text: #F2F2F2; --text2: #A1A1A6; --text3: #98989D;
        --accent: #0A84FF; --accent-text: #4DA3FF; --accent-fill: #0071E3; --accent-soft: rgba(10,132,255,0.16); --accent-ring: rgba(10,132,255,0.45);
        --danger: #FF6961; --danger-soft: rgba(255,69,58,0.16); --success: #30D158; --success-text: #4ADE80; --warn: #FF9F0A;
        --sel: rgba(255,255,255,0.12); --hover: rgba(255,255,255,0.06); --switch-off: #39393D; --scroll: rgba(255,255,255,0.2);
        --pill-bg: rgba(58,58,64,0.42); --pill-ring: rgba(255,255,255,0.22); --pill-text: #FFFFFF; --pill-sub: rgba(235,235,245,0.62); --pill-shine: rgba(255,255,255,0.16);
        --shadow: 0 24px 64px rgba(0,0,0,0.55), 0 0 0 0.5px rgba(255,255,255,0.14);
        --menu-bg: #2C2C2E; --menu-shadow: 0 0 0 0.5px rgba(255,255,255,0.16), 0 18px 44px rgba(0,0,0,0.6);
        --inspector: #232325; --card: #2C2C2E; --help-dot: #636366;
        --glass: rgba(72,72,76,0.66); --glass-border: rgba(255,255,255,0.16); --warn-icon: #FF9F0A;
        color-scheme: dark;
      }
      .ias-shell[data-theme="light"] {
        --bg: #FFFFFF; --side: #EDEDEF; --elev: #FFFFFF; --elev2: #E8E8ED; --group: #F5F5F7;
        --border: rgba(0,0,0,0.1); --field-border: rgba(0,0,0,0.18); --hair: rgba(0,0,0,0.08);
        --text: #1D1D1F; --text2: #6E6E73; --text3: #6E6E73;
        --accent: #007AFF; --accent-text: #0066CC; --accent-fill: #0064D2; --accent-soft: rgba(0,122,255,0.12); --accent-ring: rgba(0,122,255,0.35);
        --danger: #D70015; --danger-soft: rgba(255,59,48,0.10); --success: #34C759; --success-text: #1A7F37; --warn: #C93400;
        --sel: rgba(0,0,0,0.08); --hover: rgba(0,0,0,0.04); --switch-off: #E3E3E8; --scroll: rgba(0,0,0,0.22);
        --pill-bg: rgba(255,255,255,0.52); --pill-ring: rgba(255,255,255,0.7); --pill-text: #1D1D1F; --pill-sub: rgba(60,60,67,0.65); --pill-shine: rgba(255,255,255,0.6);
        --shadow: 0 24px 64px rgba(0,0,0,0.22), 0 0 0 0.5px rgba(0,0,0,0.14);
        --menu-bg: #FFFFFF; --menu-shadow: 0 0 0 0.5px rgba(0,0,0,0.14), 0 18px 44px rgba(0,0,0,0.18);
        --inspector: #FAFAFA; --card: #F2F2F7; --help-dot: #8E8E93;
        --glass: rgba(246,246,248,0.72); --glass-border: rgba(0,0,0,0.06); --warn-icon: #FF9500;
        color-scheme: light;
      }

      .ias-shell {
        position: fixed; right: 20px; bottom: 20px; z-index: 2147483600;
        font-family: "NAS Pretendard", -apple-system, BlinkMacSystemFont, "Apple SD Gothic Neo", "Malgun Gothic", "Segoe UI", sans-serif;
        font-size: 13px; letter-spacing: -0.005em; color: var(--text);
        -webkit-font-smoothing: antialiased; text-rendering: optimizeLegibility;
      }
      .ias-ic { display: block; flex: 0 0 auto; }
      button, input, textarea, select { font-family: inherit; }

      /* ---- collapsed pill ---- */
      .ias-fab {
        display: flex; align-items: center; gap: 10px;
        min-width: 52px; height: 52px; padding: 0 14px 0 14px; border-radius: 26px;
        /* frosted glass: blur what is behind, thin bright rim, soft drop shadow */
        background: var(--pill-bg); color: var(--pill-text); cursor: grab;
        -webkit-backdrop-filter: blur(22px) saturate(180%); backdrop-filter: blur(22px) saturate(180%);
        border: 1px solid var(--pill-ring); box-shadow: 0 6px 20px rgba(0,0,0,0.18);
        touch-action: none; user-select: none; font-size: 13px;
        transition: transform 0.12s ease;
      }
      .ias-fab[data-running="false"] { width: 52px; padding: 0; justify-content: center; }
      .ias-fab:active { cursor: grabbing; transform: scale(0.97); }
      .ias-fab[data-dragging="true"] { transform: scale(1.04); }
      .ias-fab[data-alert="true"] { border-color: rgba(255,159,10,0.8); }
      .ias-fab .ias-ic { color: #FFFFFF; }
      /* white glyph everywhere: frosted light on dark pages, frosted dark on light ones */
      .ias-shell[data-surface="dark"] { --pill-bg: rgba(255,255,255,0.14); --pill-ring: rgba(255,255,255,0.22); --pill-text: #FFFFFF; --pill-sub: rgba(235,235,245,0.66); }
      .ias-shell[data-surface="light"] { --pill-bg: rgba(40,40,48,0.38); --pill-ring: rgba(255,255,255,0.35); --pill-text: #FFFFFF; --pill-sub: rgba(255,255,255,0.75); }
      .ias-pill-text { display: flex; flex-direction: column; gap: 1px; min-width: 0; max-width: 240px; text-align: left; }
      .ias-pill-title { font-weight: 650; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .ias-pill-sub { font-size: 12px; color: var(--pill-sub); white-space: nowrap; }
      .ias-shell[data-collapsed="true"] .ias-card { display: none; }
      .ias-shell[data-collapsed="false"] .ias-fab { display: none; }

      /* ---- fullscreen ---- */
      .ias-shell[data-fullscreen="true"] { inset: 0 !important; right: auto; bottom: auto; }
      .ias-shell[data-fullscreen="true"] .ias-card { width: calc(100vw - 24px) !important; height: calc(100vh - 24px) !important; margin: 12px; }
      .ias-shell[data-fullscreen="true"] .ias-edge { display: none; }

      /* ---- compact ---- */
      .ias-shell[data-compact="true"] .ias-card { width: min(470px, calc(100vw - 32px)) !important; height: min(430px, calc(100vh - 40px)) !important; }
      .ias-shell[data-compact="true"] .ias-edge { display: none; }
      .ias-shell[data-collapsed="true"][data-fullscreen="true"] { inset: auto !important; right: 20px !important; bottom: 20px !important; }


      /* ---- window ---- */
      .ias-card {
        position: relative; display: grid; grid-template-columns: 200px minmax(0, 1fr);
        width: min(760px, calc(100vw - 32px)); height: min(600px, calc(100vh - 40px));
        min-width: 380px; min-height: 320px;
        background: var(--bg); border-radius: 12px; box-shadow: var(--shadow); overflow: hidden;
        container-type: inline-size; container-name: iaswin;
      }
      /* window edges: drag any side or corner to resize, like a desktop window */
      .ias-edge { position: absolute; z-index: 6; touch-action: none; }
      .ias-edge[data-edge="n"], .ias-edge[data-edge="s"] { left: 10px; right: 10px; height: 6px; cursor: ns-resize; }
      .ias-edge[data-edge="e"], .ias-edge[data-edge="w"] { top: 10px; bottom: 10px; width: 6px; cursor: ew-resize; }
      .ias-edge[data-edge="n"] { top: 0; } .ias-edge[data-edge="s"] { bottom: 0; }
      .ias-edge[data-edge="e"] { right: 0; } .ias-edge[data-edge="w"] { left: 0; }
      .ias-edge[data-edge$="e"][data-edge^="n"], .ias-edge[data-edge$="e"][data-edge^="s"],
      .ias-edge[data-edge$="w"][data-edge^="n"], .ias-edge[data-edge$="w"][data-edge^="s"] { width: 14px; height: 14px; }
      .ias-edge[data-edge="ne"] { top: 0; right: 0; cursor: nesw-resize; }
      .ias-edge[data-edge="sw"] { bottom: 0; left: 0; cursor: nesw-resize; }
      .ias-edge[data-edge="nw"] { top: 0; left: 0; cursor: nwse-resize; }
      .ias-edge[data-edge="se"] { bottom: 0; right: 0; cursor: nwse-resize; }
      .ias-shell[data-resizing="true"] { user-select: none; }

      /* ---- sidebar ---- */
      .ias-side {
        display: flex; flex-direction: column; min-height: 0;
        padding: 16px 10px 12px; background: var(--side); border-right: 0.5px solid var(--border);
        cursor: grab; touch-action: none; user-select: none; overflow: hidden;
      }
      .ias-side:active { cursor: grabbing; }
      /* macOS window buttons: plain coloured dots, no glyphs */
      .ias-lights { display: flex; gap: 8px; padding: 0 8px 20px; }
      .ias-light { width: 12px; height: 12px; border-radius: 6px; border: none; padding: 0; cursor: pointer; }
      .ias-light:hover { filter: brightness(0.92); }
      .ias-light[data-c="red"] { background: #FF5F57; }
      .ias-light[data-c="yellow"] { background: #FEBC2E; }
      .ias-light[data-c="green"] { background: #28C840; }
      .ias-shell[data-theme="light"] .ias-light { box-shadow: inset 0 0 0 0.5px rgba(0,0,0,0.15); }
      .ias-tabs { display: flex; flex-direction: column; gap: 1px; }
      .ias-tab, .ias-side-btn {
        width: 100%; height: 28px; display: flex; align-items: center; gap: 8px; padding: 0 10px;
        border: none; border-radius: 6px; background: transparent; color: var(--text);
        font-size: 13px; text-align: left; cursor: pointer; white-space: nowrap;
      }
      .ias-tab:hover, .ias-side-btn:hover { background: var(--hover); }
      .ias-tab[data-active="true"] { background: var(--sel); font-weight: 600; }
      .ias-tab .ias-tab-ic { color: var(--accent); flex: 0 0 auto; }
      .ias-side-btn .ias-tab-ic { color: var(--accent); flex: 0 0 auto; }
      .ias-tab-label { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
      .ias-tab-badge { font-size: 11.5px; color: var(--text3); font-variant-numeric: tabular-nums; }
      .ias-tab-badge:empty { display: none; }
      .ias-side-foot { margin-top: auto; display: flex; flex-direction: column; gap: 1px; }
      @container iaswin (max-width: 600px) {
        .ias-side.ias-side { width: 56px; padding-left: 8px; padding-right: 8px; }
        .ias-lights { gap: 5px; justify-content: center; padding: 0 0 16px; }
        .ias-side-label { display: none; }
        .ias-tab, .ias-side-btn { justify-content: center; padding: 0; height: 34px; }
        .ias-tab-label, .ias-tab-badge { display: none; }
      }

      /* ---- main column ---- */
      .ias-main { display: flex; flex-direction: column; min-width: 0; min-height: 0; background: var(--bg); }
      .ias-toolbar {
        height: 52px; flex: 0 0 52px; display: flex; align-items: center; gap: 12px; padding: 0 16px 0 20px;
        border-bottom: 0.5px solid var(--border); cursor: grab; touch-action: none; user-select: none;
      }
      .ias-toolbar:active { cursor: grabbing; }

      .ias-toolbar-title { font-size: 15px; font-weight: 700; white-space: nowrap; }
      .ias-activity {
        flex: 1; display: flex; justify-content: center; min-width: 0;
      }
      .ias-activity-box {
        width: min(280px, 100%); height: 28px; border-radius: 7px; background: var(--elev); border: 0.5px solid var(--border);
        display: flex; flex-direction: column; overflow: hidden;
      }
      .ias-activity-line { flex: 1; display: flex; align-items: center; justify-content: center; gap: 6px; padding: 0 8px; font-size: 12px; color: var(--text2); min-width: 0; }
      .ias-activity-line b { color: var(--text); font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .ias-activity-dot { width: 7px; height: 7px; border-radius: 4px; background: var(--success); flex: 0 0 auto; }
      .ias-activity-bar { height: 2px; background: var(--hair); }
      .ias-activity-bar > span { display: block; height: 2px; width: 0; background: var(--accent); transition: width 0.4s ease; }
      .ias-activity-box[data-running="false"] .ias-activity-bar { display: none; }
      .ias-activity-box[data-running="false"] { background: transparent; border-color: transparent; }
      .ias-activity-box[data-running="false"] .ias-activity-dot { display: none; }
      .ias-activity-box[data-running="false"] .ias-activity-line { color: var(--text3); }

      /* ---- toasts: one-off messages, never truncated ---- */
      .ias-main { position: relative; }
      /* iOS alert: frosted card, centred text, hairline button bar */
      .ias-ios-layer { position: fixed; inset: 0; z-index: 50; display: flex; align-items: center; justify-content: center; background: rgba(0,0,0,0.22); animation: ias-fade 0.14s ease-out; }
      .ias-ios-alert {
        width: 280px; border-radius: 14px; overflow: hidden; text-align: center; color: var(--text);
        background: var(--glass); border: 0.5px solid var(--glass-border);
        -webkit-backdrop-filter: blur(30px) saturate(180%); backdrop-filter: blur(30px) saturate(180%);
        box-shadow: 0 20px 60px rgba(0,0,0,0.3); animation: ias-pop 0.18s cubic-bezier(0.2,0.9,0.3,1.2);
      }
      .ias-ios-body { padding: 19px 16px 15px; display: flex; flex-direction: column; gap: 5px; }
      .ias-ios-body strong { font-size: 15px; font-weight: 650; line-height: 1.3; }
      .ias-ios-body p { margin: 0; font-size: 12.5px; line-height: 1.45; white-space: pre-line; word-break: keep-all; }
      .ias-ios-buttons { display: grid; grid-auto-flow: column; grid-auto-columns: 1fr; border-top: 0.5px solid var(--border); }
      .ias-ios-buttons[data-count="3"] { grid-auto-flow: row; }
      .ias-ios-buttons button { height: 44px; border: none; background: transparent; color: var(--accent-text); font: inherit; font-size: 15px; cursor: pointer; }
      .ias-ios-buttons button + button { border-left: 0.5px solid var(--border); }
      .ias-ios-buttons[data-count="3"] button + button { border-left: none; border-top: 0.5px solid var(--border); }
      .ias-ios-buttons button[data-primary="true"] { font-weight: 650; }
      .ias-ios-buttons button[data-destructive="true"] { color: var(--danger); }
      .ias-ios-buttons button:hover, .ias-ios-buttons button:focus-visible { background: var(--hover); outline: none; }
      .ias-card > .ias-ios-layer { position: absolute; }
      @keyframes ias-fade { from { opacity: 0; } }
      @keyframes ias-pop { from { opacity: 0; transform: scale(1.08); } }
      .ias-toasts { position: absolute; left: 50%; bottom: 62px; transform: translateX(-50%); z-index: 30; display: flex; flex-direction: column-reverse; align-items: center; gap: 6px; width: min(420px, calc(100% - 32px)); pointer-events: none; }
      .ias-toast {
        pointer-events: auto; display: flex; align-items: flex-start; gap: 8px; max-width: 100%;
        padding: 10px 10px 10px 14px; border-radius: 16px; color: var(--text);
        background: var(--glass); border: 0.5px solid var(--glass-border);
        -webkit-backdrop-filter: blur(24px) saturate(180%); backdrop-filter: blur(24px) saturate(180%);
        box-shadow: 0 12px 40px rgba(0,0,0,0.22), 0 1px 3px rgba(0,0,0,0.08); font-size: 12.5px; line-height: 1.45;
        animation: ias-toast-in 0.16s ease-out;
      }
      .ias-toast[data-leaving="true"] { opacity: 0; transform: translateY(4px); transition: opacity 0.18s, transform 0.18s; }
      .ias-toast-ic { flex: 0 0 auto; margin-top: 1px; display: flex; }
      .ias-toast[data-tone="ok"] .ias-toast-ic { color: var(--success); }
      .ias-toast[data-tone="warn"] .ias-toast-ic { color: var(--warn-icon); }
      .ias-toast[data-tone="neutral"] .ias-toast-ic { color: var(--text3); }
      .ias-toast-text { flex: 1; min-width: 0; }
      .ias-toast-close { flex: 0 0 auto; width: 18px; height: 18px; margin: 0 0 0 2px; border: none; border-radius: 9px; background: transparent; color: var(--text3); display: flex; align-items: center; justify-content: center; padding: 0; cursor: pointer; }
      .ias-toast-close:hover { background: var(--hover); color: var(--text); }
      @keyframes ias-toast-in { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }
      

      .ias-pane { display: none; flex-direction: column; min-height: 0; flex: 1 1 auto; padding: 16px 20px 0; }
      .ias-pane[data-active="true"] { display: flex; }
      .ias-scroll { overflow-y: auto; overflow-x: hidden; flex: 1 1 auto; padding-right: 6px; margin-right: -6px; padding-bottom: 14px; }
      .ias-scroll::-webkit-scrollbar, .ias-list::-webkit-scrollbar { width: 8px; }
      .ias-scroll::-webkit-scrollbar-thumb, .ias-list::-webkit-scrollbar-thumb { background: var(--scroll); border-radius: 999px; border: 2px solid transparent; background-clip: padding-box; }
      .ias-scroll[data-grab-scroll="on"], .ias-list[data-grab-scroll="on"] { cursor: grab; }
      .ias-scroll[data-grabbing="true"], .ias-list[data-grabbing="true"] { cursor: grabbing; user-select: none; }

      .ias-status {
        flex: 0 0 auto; min-height: 26px; padding: 5px 20px; border-top: 0.5px solid var(--border);
        font-size: 12px; color: var(--text2); line-height: 1.4; text-align: left;
      }
      .ias-status:empty { display: none; }
      .ias-status[data-tone="ok"] { color: var(--success-text); }
      .ias-status[data-tone="warn"] { color: var(--warn); }

      /* ---- forms ---- */
      .ias-field { display: flex; flex-direction: column; gap: 5px; margin-bottom: 14px; }
      .ias-field label, .ias-label { font-size: 12px; font-weight: 600; color: var(--text2); padding-left: 1px; }
      .ias-hint { font-size: 11.5px; color: var(--text3); line-height: 1.5; margin: 0; }
      .ias-row { display: flex; gap: 10px; }
      .ias-row .ias-field { flex: 1; }
      .ias-input, textarea.ias-input {
        width: 100%; background: var(--elev); border: 0.5px solid var(--field-border); border-radius: 6px;
        color: var(--text); padding: 6px 8px; font-size: 13px; line-height: 1.5;
        transition: box-shadow 0.12s ease;
      }
      input.ias-input { height: 28px; padding: 0 8px; }
      .ias-input:focus, textarea.ias-input:focus { outline: none; box-shadow: 0 0 0 3px var(--accent-ring); }
      .ias-input::placeholder { color: var(--text3); opacity: 0.8; }
      textarea.ias-input { resize: vertical; }
      .ias-input:disabled { opacity: 0.45; }

      /* ---- buttons ---- */
      .ias-btn {
        display: inline-flex; align-items: center; justify-content: center; gap: 6px;
        height: 28px; padding: 0 14px; border: none; border-radius: 6px; cursor: pointer;
        background: var(--accent-fill); color: #FFFFFF; font-size: 13px; font-weight: 600; white-space: nowrap;
        transition: filter 0.12s ease, transform 0.08s ease;
      }
      .ias-btn .ias-ic { width: 15px; height: 15px; }
      .ias-btn:not(:disabled):hover { filter: brightness(1.08); }
      .ias-btn:not(:disabled):active { transform: scale(0.98); }
      .ias-btn:disabled { opacity: 0.4; cursor: not-allowed; }
      /* a disabled primary is plainly grey, not a dim blue */
      .ias-btn.ias-tb-primary:disabled, .ias-btn:not(.secondary):not(.plain):disabled { background: var(--elev2); color: var(--text3); opacity: 1; }
      /* Korean: break between words, not inside them */
      .ias-shell { word-break: keep-all; overflow-wrap: anywhere; }
      .ias-path-line { word-break: normal; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      /* number fields: no browser spinner arrows, same look as other fields */
      .ias-shell input[type="number"]::-webkit-outer-spin-button, .ias-shell input[type="number"]::-webkit-inner-spin-button { -webkit-appearance: none; margin: 0; }
      .ias-shell input[type="number"] { -moz-appearance: textfield; text-align: right; }
      .ias-stack { display: flex; flex-direction: column; gap: 0; }
      .ias-combo-inspector textarea { resize: none; }
      .ias-btn[data-active="true"] { background: #D70015; }
      .ias-btn.secondary { background: var(--elev2); color: var(--text); font-weight: 500; }
      .ias-btn.danger { background: var(--danger-soft); color: var(--danger); font-weight: 600; }
      .ias-btn.wide { width: 100%; height: 32px; }
      .ias-btn[hidden] { display: none; }
      
      
      .ias-icon-btn {
        display: inline-flex; align-items: center; justify-content: center; width: 26px; height: 26px; flex: 0 0 auto;
        border: none; border-radius: 6px; cursor: pointer; background: transparent; color: var(--text3);
      }
      .ias-icon-btn:hover { background: var(--danger-soft); color: var(--danger); }

      /* ---- grouped boxes (settings, lists) ---- */
      
      
      
      
      
      
      
      
      

      .ias-switch { position: relative; width: 32px; height: 19px; flex: 0 0 auto; }
      .ias-switch input { opacity: 0; width: 0; height: 0; position: absolute; }
      .ias-switch .ias-slider { position: absolute; inset: 0; cursor: pointer; background: var(--switch-off); border-radius: 999px; transition: background 0.2s ease; }
      .ias-switch .ias-slider::before {
        content: ""; position: absolute; width: 15px; height: 15px; left: 2px; top: 2px; border-radius: 50%;
        background: #FFFFFF; box-shadow: 0 1px 2px rgba(0,0,0,0.3); transition: transform 0.2s ease;
      }
      .ias-switch input:checked + .ias-slider { background: var(--accent); }
      .ias-switch input:checked + .ias-slider::before { transform: translateX(13px); }
      .ias-switch input:focus-visible + .ias-slider { box-shadow: 0 0 0 3px var(--accent-ring); }

      .ias-seg { display: inline-flex; padding: 2px; border-radius: 7px; background: var(--elev2); gap: 2px; }
      .ias-seg button { border: none; background: transparent; cursor: pointer; font-size: 12.5px; height: 22px; padding: 0 11px; border-radius: 5px; color: var(--text); }
      .ias-seg button[data-active="true"] { background: var(--bg); box-shadow: 0 1px 2px rgba(0,0,0,0.2); font-weight: 600; }
      .ias-shell:not([data-theme="light"]) .ias-seg button[data-active="true"] { background: #636366; }

      /* appearance picker */
      .ias-appearance { display: flex; gap: 14px; }
      .ias-appearance button { border: none; background: transparent; color: var(--text2); font-size: 12px; padding: 0; display: flex; flex-direction: column; align-items: center; gap: 5px; cursor: pointer; }
      .ias-appearance button[data-active="true"] { color: var(--text); font-weight: 650; }
      .ias-appearance .ias-swatch { width: 58px; height: 38px; border-radius: 7px; box-shadow: 0 0 0 1px var(--field-border); overflow: hidden; display: grid; grid-template-columns: 1fr 1fr; }
      .ias-appearance button[data-active="true"] .ias-swatch { box-shadow: 0 0 0 3px var(--accent); }

      .ias-path-preview {
        padding: 7px 10px; border-radius: 6px; background: var(--group); border: 0.5px solid var(--hair);
        font: 12px/1.45 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; color: var(--text2); word-break: break-all;
      }

      /* ---- character blocks ---- */
      
      
      
      
      
      
      
      
      
      
      
      
      
      
      
      
      
      
      
      
      
      
      

      
      
      

      /* ---- queue ---- */
      
      .ias-queue-count { font-size: 12px; color: var(--text2); }
      
      
      
      
      .ias-list { flex: 1 1 50%; min-width: 0; display: flex; flex-direction: column; gap: 6px; overflow-y: auto; overflow-x: hidden; padding: 2px 4px 6px 2px; }
      
      
      .ias-qcard {
        flex: 0 0 auto; width: 100%; min-width: 0; display: flex; flex-direction: column; gap: 5px;
        padding: 9px 10px; border-radius: 8px; cursor: pointer; background: var(--group); border: 0.5px solid var(--border);
      }
      .ias-qcard:hover { background: var(--hover); }
      .ias-qcard[data-selected="true"] { background: var(--accent-soft); border-color: var(--accent-ring); }
      .ias-qcard[data-running="true"] { box-shadow: inset 3px 0 0 var(--success); }
      .ias-qcard[data-dragging="true"] { opacity: 0.45; }
      .ias-qcard[data-dropbefore="true"] { box-shadow: 0 -2px 0 0 var(--accent); }
      
      
      
      
      
      
      
      
      
      
      
      .ias-qeditor { margin-top: 2px; }
      .ias-qeditor:empty { display: none; }
      
      
      
      
      
      
      
      
      
      

      /* ---- prompt memos ---- */
      
      
      
      
      
      
      
      
      
      
      .ias-memo-list { display: flex; flex-direction: column; gap: 6px; padding: 1px 0 10px; }
      .ias-memo-card { position: relative; display: flex; flex-direction: column; gap: 7px; padding: 10px 12px; border-radius: 9px; background: var(--group); border: 0.5px solid var(--border); }
      .ias-memo-card:hover { background: var(--hover); }
      .ias-memo-card[data-menu-open="true"] { z-index: 20; }
      
      
      .ias-memo-title { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13px; font-weight: 700; color: var(--text); }
      
      .ias-memo-preview { font-size: 12px; line-height: 1.45; color: var(--text2); max-height: 35px; overflow: hidden; overflow-wrap: anywhere; }
      
      
      
      
      
      
      
      
      
      
      
      
      
      
      
      
      
      
      
      
      
      
      .ias-memo-trash { margin: 0 0 12px; padding: 8px; border-radius: 9px; background: var(--group); border: 0.5px solid var(--border); }
      .ias-memo-trash[hidden] { display: none; }
      .ias-memo-trash-list { display: flex; flex-direction: column; gap: 4px; }
      .ias-trash-row { display: flex; align-items: center; gap: 8px; padding: 7px 8px; border-radius: 6px; background: var(--elev); }
      .ias-trash-text { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
      .ias-trash-text strong { font-size: 12.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .ias-trash-text small { font-size: 11.5px; color: var(--text3); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .ias-trash-restore { border: none; border-radius: 6px; height: 24px; padding: 0 10px; cursor: pointer; background: var(--accent-soft); color: var(--accent-text); font-weight: 600; font-size: 12px; }
      .ias-trash-purge { border: none; border-radius: 6px; width: 24px; height: 24px; cursor: pointer; background: transparent; color: var(--text3); display: flex; align-items: center; justify-content: center; padding: 0; }
      .ias-trash-purge .ias-ic { width: 15px; height: 15px; }
      .ias-trash-purge:hover { background: var(--danger-soft); color: var(--danger); }

      /* ---- combination screen (design A) ---- */
      .ias-pane-combo { padding: 0; }
      .ias-combo { flex: 1 1 auto; min-height: 0; display: grid; grid-template-columns: minmax(0, 1fr) 220px; }
      .ias-combo-main { min-width: 0; min-height: 0; overflow-y: auto; padding: 14px 18px 16px 20px; display: flex; flex-direction: column; gap: 12px; }
      .ias-combo-inspector { min-height: 0; border-left: 0.5px solid var(--border); background: var(--inspector); padding: 16px 14px; overflow-y: auto; display: flex; flex-direction: column; }
      .ias-combo-inspector .ias-field { margin-bottom: 10px; }
      .ias-combo-inspector .ias-row { gap: 8px; }
      @container iaswin (max-width: 720px) {
        .ias-combo { grid-template-columns: minmax(0, 1fr); overflow-y: auto; }
        .ias-combo-main { overflow: visible; }
        .ias-combo-inspector { overflow: visible; border-left: none; border-top: 0.5px solid var(--border); }
      }
      .ias-combo-pickers { display: grid; grid-template-columns: 48px minmax(0, 1fr); gap: 8px 10px; align-items: center; }
      .ias-picker-label { color: var(--text2); font-weight: 600; }
      .ias-chips { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; min-height: 26px; }
      .ias-chip {
        height: 26px; border: none; border-radius: 7px; background: var(--elev2); color: var(--text);
        padding: 0 10px; font-size: 13px; cursor: pointer; display: inline-flex; align-items: center; gap: 6px; white-space: nowrap;
      }
      .ias-chip-round { border-radius: 13px; padding: 0 12px; }
      .ias-chip[data-active="true"] { background: var(--accent-soft); color: var(--accent-text); font-weight: 650; box-shadow: inset 0 0 0 1px var(--accent-ring); }
      .ias-chip-count { font-size: 11.5px; opacity: 0.8; font-variant-numeric: tabular-nums; }
      .ias-chip[data-selected="true"] { box-shadow: 0 0 0 2px var(--accent); font-weight: 650; }
      .ias-chip[data-active="true"][data-selected="true"] { box-shadow: 0 0 0 2px var(--bg), 0 0 0 4px var(--accent); }
      .ias-chip-add {
        width: 26px; height: 26px; border: 1px dashed var(--field-border); border-radius: 7px; background: transparent;
        color: var(--text2); font-size: 15px; line-height: 1; padding: 0; cursor: pointer; flex: 0 0 auto;
      }
      .ias-chip-add.ias-chip-round { border-radius: 13px; }
      .ias-chip-add:hover { color: var(--accent-text); border-color: var(--accent); }
      .ias-picker-note { font-size: 11.5px; color: var(--text3); }
      .ias-picker-check { display: inline-flex; align-items: center; gap: 5px; margin-left: 4px; font-size: 12px; color: var(--text2); cursor: pointer; white-space: nowrap; user-select: none; }
      .ias-picker-check input { margin: 0; width: 14px; height: 14px; accent-color: var(--accent); cursor: pointer; }
      .ias-combo-divider { height: 0.5px; background: var(--border); flex: 0 0 auto; }
      .ias-combo-result-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
      .ias-combo-result-title { font-weight: 700; }
      .ias-help-tip { position: relative; display: inline-flex; }
      .ias-help-dot { width: 22px; height: 22px; border: none; background: transparent; padding: 0; cursor: help; display: flex; align-items: center; justify-content: center; border-radius: 11px; }
      .ias-help-dot:focus-visible { outline: none; box-shadow: 0 0 0 3px var(--accent-ring); }
      .ias-tip {
        position: absolute; right: -6px; bottom: calc(100% + 8px); width: 230px; background: var(--menu-bg); color: var(--text);
        border-radius: 8px; padding: 8px 10px; font-size: 12px; line-height: 1.5; box-shadow: var(--menu-shadow); z-index: 20;
        opacity: 0; pointer-events: none; transform: translateY(3px); transition: opacity 0.12s ease, transform 0.12s ease;
      }
      .ias-help-tip:hover .ias-tip, .ias-help-tip:focus-within .ias-tip { opacity: 1; transform: none; }
      .ias-combo-cards { display: grid; gap: 7px; overflow-x: auto; align-content: start; padding-bottom: 4px; }
      .ias-combo-cards::-webkit-scrollbar { height: 8px; }
      .ias-combo-cards::-webkit-scrollbar-thumb { background: var(--scroll); border-radius: 999px; border: 2px solid transparent; background-clip: padding-box; }
      .ias-ccol { text-align: center; font-size: 12px; font-weight: 650; color: var(--text2); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .ias-ccard {
        position: relative; height: 46px; min-width: 0; border: none; border-radius: 10px; background: var(--card); color: var(--text);
        text-align: left; padding: 6px 30px 6px 11px; display: flex; flex-direction: column; justify-content: center; gap: 1px; cursor: pointer;
      }
      .ias-ccard:hover { filter: brightness(1.06); }
      .ias-ccard-name { font-weight: 700; font-size: 13px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .ias-ccard-file { font: 11px/1.3 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; color: var(--text2); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .ias-ccard-badge { position: absolute; top: 7px; right: 7px; }
      .ias-ccard[aria-pressed="false"] { background: transparent; box-shadow: inset 0 0 0 1px var(--border); color: var(--text3); }
      .ias-ccard[aria-pressed="false"] .ias-ccard-file { font-family: inherit; color: var(--text3); }
      .ias-combo-empty { grid-column: 1 / -1; border: 1px dashed var(--field-border); border-radius: 10px; padding: 18px; text-align: center; color: var(--text3); font-size: 12.5px; }
      .ias-insp-head { display: flex; flex-direction: column; gap: 2px; margin-bottom: 10px; min-width: 0; }
      .ias-insp-kicker { font-size: 11.5px; color: var(--text3); }
      .ias-insp-title { font-size: 16px; font-weight: 750; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .ias-insp-member { border-radius: 8px; background: var(--group); border: 0.5px solid var(--border); padding: 8px; margin-bottom: 10px; }
      .ias-insp-member-head { display: flex; justify-content: space-between; align-items: center; font-size: 12px; font-weight: 700; color: var(--text2); margin-bottom: 6px; }
      .ias-insp-spacer { flex: 1; min-height: 12px; }
      .ias-insp-delete { align-self: flex-start; border: none; background: transparent; color: var(--danger); font-size: 12.5px; padding: 4px 0; cursor: pointer; }
      .ias-copy-emos { margin-top: 8px; height: 26px; padding: 0 6px; }
      .ias-combo-foot { flex: 0 0 auto; display: flex; align-items: center; gap: 8px; padding: 10px 16px 10px 20px; border-top: 0.5px solid var(--border); flex-wrap: wrap; }
      .ias-select {
        height: 24px; border-radius: 5px; border: 0.5px solid var(--field-border); background: var(--elev); color: var(--text);
        font: 12px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; padding: 0 6px; max-width: 200px;
      }
      .ias-name-template-row { flex: 0 0 auto; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; padding: 10px 16px 0 20px; border-top: 0.5px solid var(--border); }
      .ias-name-template-row[hidden] { display: none; }
      .ias-name-template-row .ias-name-template { flex: 1 1 200px; min-width: 160px; font-family: inherit; }
      .ias-template-tokens { display: flex; gap: 4px; }
      .ias-template-tokens .ias-chip { height: 26px; font-size: 12px; }
      .ias-template-preview { flex: 1 0 100%; font-size: 11.5px; color: var(--text3); padding-bottom: 2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .ias-combo-summary { flex: 1; font-size: 12px; color: var(--text2); min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .ias-combo-foot .ias-btn { white-space: nowrap; flex: 0 0 auto; }
      .ias-combo-foot .ias-name-select { min-width: 0; flex: 0 1 auto; max-width: 150px; }
      
      

      /* ---- guided tours ---- */
      .ias-tour-layer { position: absolute; inset: 0; pointer-events: none; z-index: 40; }
      .ias-tour-hole {
        position: absolute; pointer-events: none;
        box-shadow: 0 0 0 2px var(--bg), 0 0 0 4px var(--accent), 0 0 0 4000px rgba(0,0,0,0.45);
        transition: left 0.18s ease, top 0.18s ease, width 0.18s ease, height 0.18s ease;
      }
      .ias-tour-hole[data-success="true"] { box-shadow: 0 0 0 2px var(--bg), 0 0 0 4px var(--success), 0 0 0 4000px rgba(0,0,0,0.45); }
      .ias-tour-hole[hidden], .ias-tour-bubble[hidden], .ias-tour-sheet[hidden] { display: none; }
      .ias-tour-bubble {
        position: absolute; width: 300px; pointer-events: auto; border-radius: 12px; background: var(--menu-bg); color: var(--text);
        box-shadow: var(--menu-shadow); padding: 14px 16px 12px; display: flex; flex-direction: column; gap: 9px;
      }
      .ias-tbubble-arrow { position: absolute; width: 12px; height: 12px; background: var(--menu-bg); transform: rotate(45deg); }
      .ias-tour-bubble[data-place="below"] .ias-tbubble-arrow { top: -6px; box-shadow: -0.5px -0.5px 0 var(--field-border); }
      .ias-tour-bubble[data-place="above"] .ias-tbubble-arrow { bottom: -6px; box-shadow: 0.5px 0.5px 0 var(--field-border); }
      .ias-tour-bubble[data-place="center"] .ias-tbubble-arrow { display: none; }
      .ias-tbubble-top { display: flex; align-items: center; gap: 8px; }
      .ias-tbubble-count { font-size: 12px; font-weight: 700; color: var(--accent-text); }
      .ias-tbubble-segs { display: flex; gap: 4px; }
      .ias-tbubble-segs span { width: 18px; height: 4px; border-radius: 2px; background: var(--elev2); }
      .ias-tbubble-segs span[data-on="true"] { background: var(--accent); }
      .ias-tbubble-title { font-size: 15px; font-weight: 750; }
      .ias-tbubble-body { color: var(--text2); line-height: 1.55; }
      .ias-tbubble-body b { color: var(--text); }
      .ias-tbubble-hint { font-size: 12px; color: var(--text3); }
      .ias-tbubble-success { display: flex; align-items: center; gap: 9px; padding: 8px 10px; border-radius: 9px; background: rgba(48,209,88,0.14); color: var(--success-text); }
      .ias-tbubble-actions { display: flex; align-items: center; gap: 10px; padding-top: 2px; }
      .ias-tbubble-skip { flex: 1; text-align: left; border: none; background: transparent; color: var(--text3); font-size: 12.5px; padding: 0; cursor: pointer; }
      .ias-tbubble-prev { border: none; background: transparent; color: var(--text2); font-size: 12.5px; padding: 0; cursor: pointer; }
      .ias-tour-sheet {
        position: absolute; top: 0; right: 0; bottom: 0; width: min(320px, 100%); pointer-events: auto;
        background: var(--bg); border-left: 0.5px solid var(--border); box-shadow: -18px 0 40px rgba(0,0,0,0.18);
        display: flex; flex-direction: column; overflow-y: auto;
      }
      .ias-tsheet-head { display: flex; align-items: flex-start; gap: 10px; padding: 18px 16px 14px 18px; border-bottom: 0.5px solid var(--border); }
      .ias-tsheet-head > div { flex: 1; }
      .ias-tsheet-title { font-size: 17px; font-weight: 750; }
      .ias-tsheet-sub { font-size: 12px; color: var(--text3); margin-top: 3px; }
      .ias-tsheet-close { width: 24px; height: 24px; border: none; border-radius: 12px; background: var(--elev2); color: var(--text2); display: flex; align-items: center; justify-content: center; padding: 0; cursor: pointer; }
      .ias-tsheet-progress { padding: 14px 18px 6px; display: flex; flex-direction: column; gap: 6px; }
      .ias-tsheet-progress > div:first-child { display: flex; justify-content: space-between; font-size: 12px; color: var(--text3); }
      .ias-tsheet-progress b { color: var(--text); }
      .ias-tbar { height: 5px; border-radius: 3px; background: var(--elev2); overflow: hidden; }
      .ias-tbar span { display: block; height: 5px; background: var(--success); }
      .ias-tsteps { list-style: none; margin: 0; padding: 4px 10px; display: flex; flex-direction: column; gap: 2px; }
      .ias-tstep button { width: 100%; display: flex; gap: 11px; align-items: flex-start; padding: 9px 8px; border: none; border-radius: 9px; background: transparent; color: var(--text); text-align: left; cursor: pointer; }
      .ias-tstep button:hover { background: var(--hover); }
      .ias-tstep[data-state="current"] button { background: var(--accent-soft); box-shadow: inset 0 0 0 1px var(--accent-ring); }
      .ias-tstep-num { flex: 0 0 22px; height: 22px; border-radius: 11px; background: var(--elev2); color: var(--text2); font-size: 11.5px; font-weight: 700; display: flex; align-items: center; justify-content: center; }
      .ias-tstep[data-state="current"] .ias-tstep-num { background: transparent; box-shadow: inset 0 0 0 2px var(--accent); color: var(--accent-text); }
      .ias-tstep svg { flex: 0 0 22px; }
      .ias-tstep-text { display: flex; flex-direction: column; gap: 2px; }
      .ias-tstep-title { font-weight: 650; }
      .ias-tstep[data-state="done"] .ias-tstep-title { color: var(--text2); }
      .ias-tstep-short { font-size: 12px; color: var(--text3); }
      .ias-tsheet-actions { display: flex; gap: 8px; padding: 10px 18px 4px; }
      .ias-tsheet-actions .ias-btn { height: 32px; }
      .ias-tsheet-actions .ias-btn:first-child { flex: 1; }
      .ias-tsheet-foot { margin-top: auto; border-top: 0.5px solid var(--border); padding: 12px 18px 14px; display: flex; flex-direction: column; gap: 8px; }
      .ias-tsheet-label { font-size: 11.5px; font-weight: 700; color: var(--text3); }
      .ias-tothers { display: flex; flex-wrap: wrap; gap: 6px; }
      .ias-tother { height: 26px; border: none; border-radius: 13px; background: var(--elev2); color: var(--text); padding: 0 10px; font-size: 12px; display: inline-flex; align-items: center; gap: 6px; cursor: pointer; }
      .ias-tother span { color: var(--text3); font-size: 11px; }
      .ias-tsheet-auto { display: flex; align-items: center; justify-content: space-between; gap: 10px; font-size: 12.5px; color: var(--text2); padding-top: 4px; cursor: pointer; }

      /* ---- storage health banner ---- */
      .ias-alert { display: flex; align-items: center; gap: 10px; margin: 10px 16px 0; padding: 9px 10px 9px 12px; border-radius: 12px; background: var(--card); color: var(--text); font-size: 12.5px; line-height: 1.45; box-shadow: inset 0 0 0 0.5px var(--border); }
      .ias-alert > .ias-ic { color: var(--warn-icon); }
      .ias-alert[hidden] { display: none; }
      .ias-alert-text { flex: 1; }
      .ias-alert-action { flex: 0 0 auto; border: none; border-radius: 6px; height: 26px; padding: 0 12px; cursor: pointer; background: var(--accent-fill); color: #FFFFFF; font-weight: 600; font-size: 12.5px; }
      .ias-alert-action[hidden] { display: none; }
      /* ======================================================================
         v1.3 layout: list | detail, toolbar actions, one prompt editor
         ====================================================================== */
      .ias-shell { --row-sel: rgba(10,132,255,0.22); --seg-bg: #1E1E1E; --seg-on: #636366; --seg-on-text: #FFFFFF; }
      .ias-shell[data-theme="light"] { --row-sel: rgba(0,122,255,0.11); --seg-bg: #E8E8ED; --seg-on: #FFFFFF; --seg-on-text: #1D1D1F; }
      .ias-sr, .ias-status { position: absolute !important; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; padding: 0; margin: -1px; }
      .ias-grow { flex: 1 1 auto; min-width: 0; }
      .ias-card { grid-template-columns: auto minmax(0, 1fr); }
      .ias-side { width: 168px; }
      .ias-side { padding: 16px 8px 12px; }
      .ias-side .ias-tabs { gap: 1px; }
      .ias-tab, .ias-side-btn { padding: 0 9px; }

      /* toolbar */
      .ias-toolbar { gap: 8px; padding: 0 12px 0 20px; }
      .ias-activity-box[data-empty="true"] { visibility: hidden; }
      .ias-activity-box[data-tone="ok"] .ias-activity-dot { background: var(--success); }
      .ias-activity-box[data-tone="warn"] .ias-activity-dot { background: var(--warn); }
      .ias-activity-box[data-tone="warn"] .ias-activity-text { color: var(--warn); }
      .ias-activity-box[data-tone="neutral"][data-running="false"] .ias-activity-dot { background: var(--text3); }
      .ias-activity-text { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
      .ias-tb-actions { display: none; align-items: center; gap: 2px; flex: 0 0 auto; }
      .ias-shell[data-tab="auto"] .ias-tb-actions[data-for="auto"],
      .ias-shell[data-tab="gen"] .ias-tb-actions[data-for="gen"],
      .ias-shell[data-tab="queue"] .ias-tb-actions[data-for="queue"],
      .ias-shell[data-tab="memo"] .ias-tb-actions[data-for="memo"] { display: flex; }
      .ias-tb-icon {
        width: 30px; height: 28px; border: none; border-radius: 6px; background: transparent; color: var(--text2);
        display: flex; align-items: center; justify-content: center; padding: 0; cursor: pointer;
      }
      .ias-tb-icon:hover:not(:disabled), .ias-tb-icon[aria-expanded="true"] { background: var(--hover); color: var(--text); }
      .ias-tb-icon:disabled { opacity: 0.35; cursor: default; }
      .ias-btn.ias-tb-primary { height: 28px; padding: 0 12px 0 10px; margin-left: 4px; font-size: 13px; font-weight: 600; gap: 5px; white-space: nowrap; }
      .ias-btn.ias-tb-primary .ias-ic { width: 13px; height: 13px; }
      .ias-search {
        width: 150px; height: 26px; border-radius: 6px; background: var(--elev); border: 0.5px solid var(--field-border);
        display: flex; align-items: center; gap: 6px; padding: 0 8px; color: var(--text3); margin-right: 2px;
      }
      .ias-search input { flex: 1; min-width: 0; border: none; outline: none; background: transparent; color: var(--text); font-size: 12.5px; }
      .ias-search:focus-within { box-shadow: 0 0 0 3px var(--accent-ring); }

      /* menus */
      .ias-menu-wrap { position: relative; }
      .ias-menu {
        position: absolute; right: 0; top: 32px; z-index: 30; min-width: 230px; padding: 5px;
        background: var(--menu-bg); border-radius: 9px; box-shadow: var(--menu-shadow); cursor: default;
        display: flex; flex-direction: column;
      }
      .ias-menu[hidden] { display: none; }
      .ias-menu-item {
        display: flex; align-items: center; gap: 8px; width: 100%; height: 26px; padding: 0 10px; border: none; border-radius: 5px;
        background: transparent; color: var(--text); font-size: 13px; text-align: left; cursor: pointer; white-space: nowrap;
      }
      .ias-menu-item:hover:not(:disabled), .ias-menu-item:focus-visible { background: var(--accent-fill); color: #FFFFFF; outline: none; }
      .ias-menu-item[data-danger="true"] { color: var(--danger); }
      .ias-menu-item[data-danger="true"]:hover:not(:disabled) { background: var(--danger); color: #FFFFFF; }
      .ias-menu-item:disabled { opacity: 0.4; cursor: default; }
      .ias-menu-check input { width: 14px; height: 14px; margin: 0; accent-color: var(--accent); }
      .ias-menu-sep { height: 0.5px; background: var(--border); margin: 4px 8px; }

      /* split panes: list | detail */
      .ias-pane.ias-pane-split { padding: 0; display: none; }
      .ias-pane.ias-pane-split[data-active="true"] { display: grid; grid-template-columns: 214px minmax(0, 1fr); }
      @container iaswin (max-width: 560px) {
        .ias-pane.ias-pane-split[data-active="true"] { grid-template-columns: 150px minmax(0, 1fr); }
        .ias-toolbar { gap: 8px; padding: 0 10px 0 14px; }
        .ias-detail-body { padding: 12px 12px 10px; }
        .ias-detail-head { flex-wrap: wrap; row-gap: 6px; }
        .ias-detail-head .ias-title-input, .ias-detail-head .ias-detail-title { flex-basis: 100%; }
        .ias-detail-foot { padding: 0 8px; gap: 2px; }
        .ias-detail-foot .ias-btn, .ias-detail-foot button { white-space: nowrap; }
      }
      .ias-split-list { min-height: 0; display: flex; flex-direction: column; border-right: 0.5px solid var(--border); }
      .ias-split-list .ias-list { flex: 1 1 auto; min-height: 0; overflow-y: auto; padding: 8px; display: flex; flex-direction: column; gap: 1px; }
      .ias-list-foot {
        height: 32px; flex: 0 0 32px; display: flex; align-items: center; gap: 8px; padding: 0 14px;
        border: none; border-top: 0.5px solid var(--border); background: transparent; font-size: 11.5px; color: var(--text3); text-align: left;
        white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      }
      .ias-list-foot-btn { font-size: 12.5px; color: var(--text2); cursor: pointer; }
      .ias-list-foot-btn .ias-ic { color: var(--text3); }
      .ias-list-foot-btn:hover, .ias-list-foot-btn[aria-pressed="true"] { background: var(--hover); color: var(--text); }
      .ias-row {
        width: 100%; border: none; border-radius: 7px; background: transparent; color: var(--text); text-align: left;
        padding: 7px 8px; display: grid; grid-template-columns: 18px minmax(0, 1fr); column-gap: 8px; align-items: center; cursor: pointer;
        font-size: 13px; flex: 0 0 auto;
      }
      .ias-row.ias-row-plain { grid-template-columns: minmax(0, 1fr); padding: 7px 10px; }
      .ias-row:hover { background: var(--hover); }
      .ias-row[aria-selected="true"] { background: var(--row-sel); color: var(--text); }
      .ias-row[aria-selected="true"]:hover { background: var(--row-sel); }
      .ias-row-mark { display: flex; justify-content: center; font-size: 11.5px; color: var(--text3); font-variant-numeric: tabular-nums; }
      .ias-row-mark[data-kind="done"] { color: var(--success); font-weight: 800; }
      .ias-row-mark[data-kind="running"] { color: var(--accent); }
      .ias-row-mark[data-kind="check"] { color: var(--accent); align-items: center; }
      .ias-check-ring { width: 16px; height: 16px; border-radius: 8px; box-shadow: inset 0 0 0 1.5px var(--text3); display: block; }
      .ias-order-chips { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 4px; }
      .ias-order-chip { cursor: grab; }
      .ias-order-chip[data-dragging="true"] { opacity: 0.45; }
      .ias-order-chip[data-dropbefore="true"] { box-shadow: -3px 0 0 0 var(--accent); }
      .ias-select-actions { margin-top: 10px; }
      .ias-tb-text { height: 28px; padding: 0 10px; border: none; border-radius: 7px; background: transparent; color: var(--accent-text); font: inherit; font-size: 13px; cursor: pointer; white-space: nowrap; }
      .ias-tb-text:hover { background: var(--hover); }
      .ias-tb-text[aria-pressed="true"] { font-weight: 650; }
      .ias-tb-text:disabled { color: var(--text3); cursor: default; }
      .ias-row-text { min-width: 0; display: flex; flex-direction: column; gap: 1px; }
      .ias-row-title { font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .ias-row-sub { font-size: 11.5px; color: var(--text3); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .ias-row[data-running="true"] .ias-row-sub { color: var(--accent-text); }
      .ias-row[data-done="true"] { color: var(--text2); }
      .ias-row[aria-selected="true"] .ias-row-sub { color: var(--text2); }
      .ias-row[aria-selected="true"] .ias-row-mark { color: var(--accent-text); font-weight: 700; }
      .ias-row-sep { height: 0.5px; background: var(--border); margin: 5px 8px; flex: 0 0 auto; }
      .ias-qcard.ias-row[data-dropbefore="true"] { box-shadow: inset 0 2px 0 var(--accent); }
      .ias-qcard.ias-row[data-dragging="true"] { opacity: 0.45; }
      .ias-list-empty { padding: 18px 10px; font-size: 12.5px; color: var(--text3); text-align: center; line-height: 1.5; }

      .ias-detail { min-width: 0; min-height: 0; background: var(--inspector); display: flex; flex-direction: column; }
      .ias-detail > div:not([hidden]) { display: flex; flex-direction: column; min-height: 0; flex: 1 1 auto; }
      .ias-detail-body { flex: 1 1 auto; min-height: 0; overflow-y: auto; padding: 16px 18px 12px; display: flex; flex-direction: column; gap: 10px; }
      .ias-detail-foot {
        height: 44px; flex: 0 0 44px; display: flex; align-items: center; gap: 6px; padding: 0 18px 0 10px;
        border-top: 0.5px solid var(--border);
      }
      .ias-detail-title { font-size: 17px; font-weight: 700; }
      .ias-detail-body > .ias-title-input { flex: 0 0 auto; }
      .ias-path-line.ias-path-preview { background: none; border: none; margin: 0; }
      .ias-detail-head { display: flex; align-items: center; gap: 10px; }
      .ias-detail-meta { font-size: 12px; color: var(--text3); margin-top: -6px; }
      .ias-detail-meta[data-tone="running"] { color: var(--accent-text); }
      .ias-title-input {
        flex: 1 1 auto; min-width: 0; height: 30px; border-radius: 6px; border: 0.5px solid transparent; background: transparent;
        color: var(--text); font-size: 17px; font-weight: 700; padding: 0 6px; margin-left: -6px;
      }
      .ias-title-input:hover:not(:disabled) { border-color: var(--field-border); }
      .ias-title-input:focus { outline: none; border-color: var(--field-border); background: var(--elev); box-shadow: 0 0 0 3px var(--accent-ring); }
      .ias-title-input::placeholder { color: var(--text3); }
      .ias-stepper { display: flex; align-items: center; border-radius: 6px; background: var(--elev); border: 0.5px solid var(--field-border); flex: 0 0 auto; }
      .ias-stepper button { width: 24px; height: 26px; border: none; background: transparent; color: var(--text2); font-size: 14px; padding: 0; cursor: pointer; }
      .ias-stepper button:disabled { opacity: 0.35; cursor: default; }
      .ias-stepper input { width: 42px; height: 26px; border: none; background: transparent; color: var(--text); text-align: center; font-size: 13px; font-variant-numeric: tabular-nums; padding: 0; -moz-appearance: textfield; }
      .ias-stepper input::-webkit-outer-spin-button, .ias-stepper input::-webkit-inner-spin-button { -webkit-appearance: none; margin: 0; }
      .ias-stepper input:focus { outline: none; }
      .ias-stepper:focus-within { box-shadow: 0 0 0 3px var(--accent-ring); }
      .ias-text-btn { height: 26px; border: none; border-radius: 6px; background: transparent; color: var(--text); font-size: 12.5px; padding: 0 8px; cursor: pointer; }
      .ias-text-btn:hover:not(:disabled) { background: var(--hover); color: var(--text); }
      .ias-text-btn.danger { color: var(--danger); }
      .ias-text-btn:disabled { opacity: 0.35; cursor: default; }
      .ias-icon-btn { width: 26px; height: 26px; border: none; border-radius: 6px; background: transparent; color: var(--text2); display: flex; align-items: center; justify-content: center; padding: 0; cursor: pointer; }
      .ias-icon-btn:hover:not(:disabled) { background: var(--hover); color: var(--text); }
      .ias-icon-btn:disabled { opacity: 0.3; cursor: default; }
      .ias-btn.small { height: 26px; padding: 0 10px; font-size: 12.5px; white-space: nowrap; }
      .ias-switch-row { display: flex; align-items: center; gap: 8px; font-size: 12.5px; color: var(--text2); white-space: nowrap; }

      /* prompt editor */
      .ias-pe { display: flex; flex-direction: column; gap: 8px; flex: 1 1 auto; min-height: 0; }
      .ias-pe-bar { display: flex; align-items: center; gap: 4px 8px; min-width: 0; flex-wrap: wrap; }
      .ias-seg { display: inline-flex; flex-wrap: wrap; gap: 2px; border-radius: 7px; background: var(--seg-bg); padding: 2px; flex: 0 1 auto; min-width: 0; }
      .ias-seg::-webkit-scrollbar { display: none; }
      .ias-seg-btn {
        height: 22px; border: none; border-radius: 5px; background: transparent; color: var(--text2);
        font-size: 12.5px; padding: 0 10px; cursor: pointer; white-space: nowrap; flex: 0 0 auto;
      }
      .ias-seg-btn:hover { color: var(--text); }
      .ias-seg-btn[aria-selected="true"], .ias-seg-btn[aria-checked="true"] { background: var(--seg-on); color: var(--seg-on-text); font-weight: 600; box-shadow: 0 1px 2px rgba(0,0,0,0.25); }
      .ias-seg-btn.ias-pe-add { width: 26px; padding: 0; font-size: 14px; }
      .ias-pe-note { flex: 1 1 auto; min-width: 0; font-size: 11.5px; color: var(--text3); text-align: right; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .ias-pe-tools { margin-left: auto; display: inline-flex; align-items: center; gap: 6px; min-width: 0; }
      .ias-pe-move { display: inline-flex; gap: 0; flex: 0 0 auto; }
      .ias-pe-move[hidden] { display: none; }
      .ias-pe-move .ias-icon-btn { width: 22px; height: 22px; font-size: 15px; line-height: 1; }
      .ias-seg-btn[draggable="true"] { cursor: grab; }
      .ias-seg-btn[data-dragging="true"] { opacity: 0.45; }
      .ias-seg-btn[data-drop="before"] { box-shadow: inset 2px 0 0 var(--accent); }
      .ias-seg-btn[data-drop="after"] { box-shadow: inset -2px 0 0 var(--accent); }
      .ias-pe-remove { border: none; background: transparent; color: var(--text3); font-size: 11.5px; padding: 2px 4px; cursor: pointer; white-space: nowrap; }
      .ias-pe-remove:hover { color: var(--danger); }
      .ias-pe-remove[hidden] { display: none; }
      textarea.ias-input.ias-pe-text { flex: 1 1 auto; min-height: 96px; resize: none; line-height: 1.55; }
      textarea.ias-input.ias-pe-neg { flex: 0 0 auto; resize: none; line-height: 1.5; }
      .ias-pe-neg[hidden] { display: none; }
      .ias-pe-neg-toggle { align-self: flex-start; border: none; background: transparent; color: var(--text2); font-size: 12.5px; padding: 2px 0; display: flex; align-items: center; gap: 6px; cursor: pointer; }
      .ias-pe-neg-toggle:hover { color: var(--text); }
      .ias-pe-chev { width: 0; height: 0; border-left: 5px solid currentColor; border-top: 4px solid transparent; border-bottom: 4px solid transparent; transition: transform 0.12s ease; }
      .ias-pe-neg-toggle[aria-expanded="true"] .ias-pe-chev { transform: rotate(90deg); }

      /* form screens (바로 생성, 설정): System Settings style rows */
      .ias-pane.ias-pane-form { padding: 0; }
      .ias-pane-form .ias-scroll { padding: 18px 22px 20px; margin: 0; }
      .ias-form-group { border-radius: 10px; background: var(--group); border: 0.5px solid var(--hair); }
      .ias-form-row { min-height: 44px; display: flex; align-items: center; gap: 12px; padding: 6px 12px; }
      .ias-form-row + .ias-form-row { border-top: 0.5px solid var(--hair); }
      .ias-form-row[hidden] { display: none; }
      .ias-form-row > label:first-child, .ias-form-row > span:first-child { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; gap: 1px; font-size: 13px; color: var(--text); }
      .ias-form-row small { font-size: 11.5px; color: var(--text3); }
      .ias-form-row > input.ias-input { width: min(240px, 55%); flex: 0 1 auto; }
      .ias-form-row input.ias-num { width: 76px; text-align: right; }
      .ias-inline { display: flex; align-items: center; gap: 6px; flex: 0 0 auto; }
      .ias-count-wrap { display: inline-flex; align-items: center; gap: 5px; margin-left: 4px; }
      .ias-count-wrap[hidden] { display: none; }
      .ias-count-wrap .ias-count { width: 64px; }
      .ias-unit { color: var(--text2); font-size: 12.5px; }
      .ias-unit { font-size: 12.5px; color: var(--text2); }
      .ias-form-row .ias-select { height: 28px; font-family: inherit; font-size: 12.5px; max-width: 140px; }
      .ias-form-title { font-size: 13px; font-weight: 650; color: var(--text2); margin: 20px 4px 6px; }
      .ias-path-line { font: 11.5px/1.4 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; color: var(--text3); padding: 7px 12px 4px; word-break: break-all; }
      .ias-path-line:empty { display: none; }
      .ias-auto-path { margin-bottom: 14px; }
      .ias-form-note { margin: 0; padding: 0 12px 12px; font-size: 12.5px; color: var(--text2); }
      .ias-form-note[hidden] { display: none; }
      .ias-form-editor { padding: 2px 12px 12px; height: 270px; display: flex; flex-direction: column; }
      .ias-form-editor[hidden] { display: none; }
      .ias-version-line { margin: 16px 4px 0; font-size: 11.5px; color: var(--text3); }
      .ias-appearance button { font-size: 12px; }

      /* combo foot is just name rule + count now */
      .ias-combo-foot { height: 44px; padding: 0 16px 0 20px; flex-wrap: nowrap; }

      /* queue bulk view */
      .ias-bulk-row { display: flex; gap: 6px; align-items: center; }
      .ias-bulk-row .ias-input { flex: 1 1 auto; min-width: 0; }
      .ias-field-label { font-size: 12px; color: var(--text2); }
      .ias-trash-row { display: flex; align-items: center; gap: 8px; padding: 8px 10px; border-radius: 8px; background: var(--card); }
      .ias-memo-trash-list { display: flex; flex-direction: column; gap: 6px; }
    `;
  }

  // Sidebar icons: filled glyphs, tinted with the accent like a macOS sidebar.
  const SIDE_ICONS = { auto: "sparkle", gen: "grid", queue: "list", memo: "bookmark", library: "photos", help: "help", settings: "settings" };
  function sideIcon(name, size = 17) {
    return globalThis.NAIIcons ? NAIIcons.svg(SIDE_ICONS[name] || name, size, "ias-tab-ic") : "";
  }

  const TAB_TITLES = { auto: "바로 생성", gen: "조합", queue: "대기열", memo: "메모", settings: "설정" };

  function sideTab(name, { active = false, badge = "" } = {}) {
    return `<button class="ias-tab" type="button" data-tab="${name}" data-active="${active}">${sideIcon(name)}<span class="ias-tab-label">${TAB_TITLES[name]}</span><span class="ias-tab-badge" data-badge="${name}">${badge}</span></button>`;
  }

  const MORE_ICON = icon("more", 18);
  const PLUS_ICON = icon("add", 18);
  const NEW_ICON = icon("compose", 17);
  const SEARCH_ICON = icon("search", 14);


  function getTemplate() {
    return `
      <style>${getStyles()}</style>
      <div class="ias-shell" data-collapsed="true" data-theme="dark">
        <button class="ias-fab" type="button" data-running="false" title="NAI 자동저장"></button>
        <div class="ias-card">
          <aside class="ias-side" title="빈 곳이나 위쪽 막대를 잡고 끌면 창을 옮길 수 있어요">
            <div class="ias-lights">
              <button class="ias-light ias-side-close" data-c="red" type="button" aria-label="접기" title="접기"></button>
              <button class="ias-light ias-side-min" data-c="yellow" type="button" aria-label="작게" title="작게"></button>
              <button class="ias-light ias-side-fs" data-c="green" type="button" aria-label="전체화면" title="전체화면"></button>
            </div>
            <div class="ias-tabs">
              ${sideTab("auto", { active: true })}
              ${sideTab("gen")}
              ${sideTab("queue")}
              ${sideTab("memo")}
            </div>
            <div class="ias-side-foot">
              <button class="ias-side-btn ias-library-btn" type="button" title="새 탭에서 보관함 열기">${sideIcon("library")}<span class="ias-tab-label">보관함</span><span class="ias-tab-badge" aria-hidden="true">↗</span></button>
              <button class="ias-side-btn ias-help-btn" type="button" title="지금 화면 사용법">${sideIcon("help")}<span class="ias-tab-label">안내</span><span class="ias-tab-badge ias-help-progress"></span></button>
              ${sideTab("settings")}
            </div>
          </aside>
          <div class="ias-main">
            <div class="ias-toolbar">
              <span class="ias-toolbar-title">바로 생성</span>
              <div class="ias-activity">
                <div class="ias-activity-box" data-running="false" data-idle="true">
                  <div class="ias-activity-line"><span class="ias-activity-dot"></span><span class="ias-activity-text"></span></div>
                  <div class="ias-activity-bar"><span></span></div>
                </div>
              </div>

              <div class="ias-tb-actions" data-for="auto">
                <button class="ias-btn ias-tb-primary ias-auto" type="button" data-tour="auto-start">${icon("play_arrow", 14)}<span>생성 시작</span></button>
              </div>

              <div class="ias-tb-actions" data-for="gen">
                <div class="ias-menu-wrap">
                  <button class="ias-tb-icon" type="button" data-menu-toggle="gen" aria-haspopup="menu" aria-expanded="false" aria-label="조합 메뉴" title="더 보기">${MORE_ICON}</button>
                  <div class="ias-menu" role="menu" data-menu="gen" hidden>
                    <button class="ias-menu-item ias-gen-replace" type="button" role="menuitem">새 대기열로 바꾸기</button>
                    <button class="ias-menu-item ias-gen-export" type="button" role="menuitem">파일로 내보내기…</button>
                  </div>
                </div>
                <button class="ias-btn ias-tb-primary ias-gen-append" type="button" data-tour="combo-queue"><span>대기열에 넣기</span></button>
              </div>

              <div class="ias-tb-actions" data-for="queue">
                <button class="ias-tb-text ias-queue-select" type="button" aria-pressed="false" title="여러 항목을 골라서 한꺼번에 지워요">선택</button>
                <button class="ias-tb-icon ias-queue-add" type="button" data-tour="queue-add" aria-label="지금 NovelAI 프롬프트로 항목 추가" title="지금 NovelAI 프롬프트로 항목 추가">${PLUS_ICON}</button>
                <div class="ias-menu-wrap">
                  <button class="ias-tb-icon" type="button" data-menu-toggle="queue" aria-haspopup="menu" aria-expanded="false" aria-label="대기열 메뉴" title="더 보기">${MORE_ICON}</button>
                  <div class="ias-menu" role="menu" data-menu="queue" hidden>
                    <button class="ias-menu-item" type="button" role="menuitem" data-queue-view="bulk">이름 · 장수 한꺼번에 바꾸기…</button>
                    <label class="ias-menu-item ias-menu-check" role="menuitemcheckbox"><input class="ias-loop" type="checkbox"><span>끝나면 처음부터 반복</span></label>
                    <div class="ias-menu-sep" role="separator"></div>
                    <button class="ias-menu-item ias-queue-import" type="button" role="menuitem">가져오기…</button>
                    <button class="ias-menu-item ias-queue-export" type="button" role="menuitem">내보내기…</button>
                    <div class="ias-menu-sep" role="separator"></div>
                    <button class="ias-menu-item ias-queue-clear" type="button" role="menuitem" data-danger="true" disabled>대기열 비우기</button>
                  </div>
                  <input class="ias-queue-import-file" type="file" accept="application/json,.json" hidden>
                </div>
                <button class="ias-btn ias-tb-primary ias-queue-run" type="button" disabled data-tour="queue-run">${icon("play_arrow", 14)}<span>생성 시작</span></button>
              </div>

              <div class="ias-tb-actions" data-for="memo">
                <label class="ias-search">${SEARCH_ICON}<span class="ias-sr">메모 검색</span><input class="ias-memo-search" type="search" placeholder="검색"></label>
                <button class="ias-tb-icon ias-memo-new" type="button" data-tour="memo-new" aria-label="새 메모" title="새 메모">${NEW_ICON}</button>
                <div class="ias-menu-wrap">
                  <button class="ias-tb-icon" type="button" data-menu-toggle="memo" aria-haspopup="menu" aria-expanded="false" aria-label="메모 메뉴" title="더 보기">${MORE_ICON}</button>
                  <div class="ias-menu" role="menu" data-menu="memo" hidden>
                    <button class="ias-menu-item ias-memo-capture" type="button" role="menuitem">지금 NovelAI 값으로 새 메모</button>
                    <button class="ias-menu-item ias-memo-copy-auto" type="button" role="menuitem">바로 생성 값으로 새 메모</button>
                    <div class="ias-menu-sep" role="separator"></div>
                    <button class="ias-menu-item ias-memo-import" type="button" role="menuitem">가져오기…</button>
                    <button class="ias-menu-item ias-memo-export" type="button" role="menuitem">내보내기…</button>
                  </div>
                  <input class="ias-memo-import-file" type="file" accept="application/json,.json" hidden>
                </div>
              </div>
            </div>
            <div class="ias-alert" role="alert" hidden>
              ${icon("warning", 17)}
              <div class="ias-alert-text"></div>
              <button class="ias-alert-action" type="button">새로고침</button>
            </div>

            <!-- AUTO -->
            <div class="ias-pane ias-pane-form" data-pane="auto" data-active="true">
              <div class="ias-scroll">
                <div class="ias-form-group">
                  <div class="ias-form-row">
                    <label for="ias-save-name">저장 이름</label>
                    <input class="ias-input ias-save-name" id="ias-save-name" type="text" placeholder="예: 김춘자_교실" data-tour="auto-name">
                  </div>
                  <div class="ias-form-row">
                    <label for="ias-count">장수</label>
                    <div class="ias-inline">
                      <div class="ias-seg ias-count-mode" role="radiogroup" aria-label="몇 장 생성할지">
                        <button class="ias-seg-btn" type="button" role="radio" data-count-mode="forever" aria-checked="true">멈출 때까지</button>
                        <button class="ias-seg-btn" type="button" role="radio" data-count-mode="count" aria-checked="false">장수 정하기</button>
                      </div>
                      <span class="ias-count-wrap"><input class="ias-input ias-count ias-num" id="ias-count" type="number" min="1" step="1" placeholder="20"><span class="ias-unit">장</span></span>
                    </div>
                  </div>
                  <div class="ias-form-row">
                    <label for="ias-interval">간격</label>
                    <div class="ias-inline"><input class="ias-input ias-interval ias-num" id="ias-interval" type="number" min="0.1" step="0.1" placeholder="3"><span class="ias-unit">초</span></div>
                  </div>
                </div>
                <div class="ias-path-line ias-auto-path" title="이렇게 저장돼요"></div>

                <div class="ias-form-group">
                  <div class="ias-form-row">
                    <span id="ias-prompt-mode-label">프롬프트</span>
                    <div class="ias-seg ias-prompt-mode" role="radiogroup" aria-labelledby="ias-prompt-mode-label" data-tour="auto-prompt">
                      <button class="ias-seg-btn" type="button" role="radio" data-prompt-mode="nai" aria-checked="true">NovelAI 그대로</button>
                      <button class="ias-seg-btn" type="button" role="radio" data-prompt-mode="own" aria-checked="false">직접 쓰기</button>
                    </div>
                  </div>
                  <p class="ias-form-note ias-prompt-nai-note">NovelAI 화면에 지금 쓰여 있는 프롬프트로 생성해요.</p>
                  <div class="ias-form-editor ias-auto-editor" hidden>
                    <textarea class="ias-input ias-auto-base"></textarea>
                    <textarea class="ias-input ias-auto-base-neg"></textarea>
                    <textarea class="ias-input ias-auto-char"></textarea>
                    <textarea class="ias-input ias-auto-char-neg"></textarea>
                  </div>
                </div>
              </div>
            </div>

            <!-- QUEUE -->
            <div class="ias-pane ias-pane-split" data-pane="queue">
              <div class="ias-split-list">
                <div class="ias-list ias-queue-list" data-tour="queue-list" role="listbox" aria-label="대기열"></div>
                <div class="ias-list-foot ias-queue-count"></div>
              </div>
              <section class="ias-detail ias-qeditor" aria-label="항목 편집"></section>
            </div>

            <!-- PROMPT MEMOS -->
            <div class="ias-pane ias-pane-split" data-pane="memo">
              <div class="ias-split-list">
                <div class="ias-list ias-memo-list" role="listbox" aria-label="메모"></div>
                <button class="ias-list-foot ias-list-foot-btn ias-memo-trash-toggle" type="button" aria-pressed="false" data-tour="memo-trash">${icon("delete", 14)}<span class="ias-grow">최근 삭제됨</span><span class="ias-memo-trash-count">0</span></button>
              </div>
              <section class="ias-detail ias-memo-detail" aria-label="메모 편집">
                <div class="ias-memo-editor">
                  <div class="ias-detail-body">
                    <label class="ias-sr" for="ias-memo-name">메모 이름</label>
                    <input class="ias-title-input ias-memo-name" id="ias-memo-name" type="text" maxlength="80" placeholder="새 메모 이름" data-tour="memo-name">
                    <span class="ias-detail-meta ias-memo-meta"></span>
                    <div class="ias-memo-editor-host" data-tour="memo-editor">
                      <textarea class="ias-input ias-memo-base"></textarea>
                      <textarea class="ias-input ias-memo-base-neg"></textarea>
                      <textarea class="ias-input ias-memo-char"></textarea>
                      <textarea class="ias-input ias-memo-char-neg"></textarea>
                    </div>
                  </div>
                  <div class="ias-detail-foot">
                    <button class="ias-text-btn danger ias-memo-delete" type="button">삭제</button>
                    <span class="ias-grow"></span>
                    <button class="ias-btn secondary small ias-memo-to-auto" type="button" title="바로 생성 입력칸에 넣어요">바로 생성에 넣기</button>
                    <button class="ias-btn secondary small ias-memo-to-queue" type="button">대기열에 넣기</button>
                    <button class="ias-btn small ias-memo-apply" type="button" title="NovelAI 입력칸에 바로 넣어요">NovelAI에 넣기</button>
                  </div>
                </div>
                <div class="ias-memo-trash" hidden>
                  <div class="ias-detail-body">
                    <div class="ias-detail-title">최근 삭제됨</div>
                    <span class="ias-detail-meta">지운 메모와 고치기 전 버전을 ${MEMO_TRASH_DAYS}일 동안 보관해요.</span>
                    <div class="ias-memo-trash-list"></div>
                  </div>
                </div>
              </section>
            </div>

            <!-- COMBINATION (design A) -->
            <div class="ias-pane ias-pane-combo" data-pane="gen">
              <div class="ias-combo">
                <div class="ias-combo-main">
                  <div class="ias-combo-pickers"></div>
                  <div class="ias-combo-divider"></div>
                  <div class="ias-combo-result-head">
                    <span class="ias-combo-result-title">만들어질 그림</span>
                    <span class="ias-help-tip">
                      <button type="button" class="ias-help-dot" aria-label="결과 카드 도움말" aria-describedby="ias-cards-tip">${HELP_DOT}</button>
                      <span role="tooltip" id="ias-cards-tip" class="ias-tip">카드를 누르면 그 조합을 빼거나 다시 넣어요. 빈 동그라미 카드는 대기열에 안 들어가요.</span>
                    </span>
                  </div>
                  <div class="ias-combo-cards" data-tour="combo-cards"></div>
                </div>
                <aside class="ias-combo-inspector" aria-label="자세히"></aside>
              </div>
              <div class="ias-name-template-row" hidden>
                <input class="ias-input ias-name-template" type="text" maxlength="120" spellcheck="false" placeholder="예: {캐릭터}_{배경} {표정}" aria-label="저장 이름 규칙">
                <div class="ias-template-tokens" aria-label="넣기">
                  <button type="button" class="ias-chip ias-chip-round" data-token="캐릭터">+ 캐릭터</button>
                  <button type="button" class="ias-chip ias-chip-round" data-token="배경">+ 배경</button>
                  <button type="button" class="ias-chip ias-chip-round" data-token="표정">+ 표정</button>
                </div>
                <span class="ias-template-preview"></span>
              </div>
              <div class="ias-combo-foot">
                <label class="ias-label" for="ias-name-select" title="만들어질 그림의 저장 이름 순서">저장 이름</label>
                <select class="ias-select ias-name-select" id="ias-name-select"></select>
                <span class="ias-combo-summary"></span>
              </div>
            </div>

            <!-- SETTINGS -->
            <div class="ias-pane ias-pane-form" data-pane="settings">
              <div class="ias-scroll">
                <div class="ias-form-group">
                  <div class="ias-form-row">
                    <span>모양</span>
                    <div class="ias-appearance" role="group" aria-label="모양" data-tour="settings-appearance">
                      <button type="button" data-appearance="auto"><span class="ias-swatch"><span style="background:#ECECEE"></span><span style="background:#2A2A2C"></span></span>자동</button>
                      <button type="button" data-appearance="light"><span class="ias-swatch" style="background:#ECECEE"></span>라이트</button>
                      <button type="button" data-appearance="dark"><span class="ias-swatch" style="background:#2A2A2C"></span>다크</button>
                    </div>
                  </div>
                </div>

                <div class="ias-form-title">저장</div>
                <div class="ias-form-group" data-tour="settings-folders">
                  <div class="ias-form-row">
                    <label for="ias-folder">저장 폴더</label>
                    <input class="ias-input ias-folder" id="ias-folder" type="text" placeholder="NovelAI" title="다운로드 폴더 안에 만들어져요">
                  </div>
                  <div class="ias-form-row">
                    <span id="ias-format-label">파일 형식<small class="ias-format-note">NovelAI에서 받는 형식을 따라가요</small></span>
                    <div class="ias-seg ias-save-format" role="radiogroup" aria-labelledby="ias-format-label">
                      <button class="ias-seg-btn" type="button" role="radio" data-save-format="auto" aria-checked="true">자동</button>
                      <button class="ias-seg-btn" type="button" role="radio" data-save-format="webp" aria-checked="false">WebP</button>
                      <button class="ias-seg-btn" type="button" role="radio" data-save-format="png" aria-checked="false">PNG</button>
                    </div>
                  </div>
                  <div class="ias-form-row">
                    <label for="ias-folder-by-date">날짜별 폴더</label>
                    <label class="ias-switch"><input class="ias-folder-by-date" id="ias-folder-by-date" type="checkbox"><span class="ias-slider"></span></label>
                  </div>
                  <div class="ias-form-row">
                    <label for="ias-folder-by-char">캐릭터별 폴더<small>저장 이름에서 _ 앞부분으로 나눠요 (예: 김춘자)</small></label>
                    <label class="ias-switch"><input class="ias-folder-by-char" id="ias-folder-by-char" type="checkbox"><span class="ias-slider"></span></label>
                  </div>
                  <div class="ias-form-row">
                    <label for="ias-auto-save">다 된 그림 자동 저장</label>
                    <label class="ias-switch"><input class="ias-auto-save" id="ias-auto-save" type="checkbox"><span class="ias-slider"></span></label>
                  </div>
                </div>
                <div class="ias-path-line ias-path-preview" title="이렇게 저장돼요"></div>

                <div class="ias-form-title">생성</div>
                <div class="ias-form-group">
                  <div class="ias-form-row">
                    <label for="ias-notify">끝나면 알림음</label>
                    <label class="ias-switch"><input class="ias-notify" id="ias-notify" type="checkbox"><span class="ias-slider"></span></label>
                  </div>
                  <div class="ias-form-row">
                    <label for="ias-bg-keepalive">다른 탭에 있어도 계속<small>탭에 스피커 표시가 떠요</small></label>
                    <label class="ias-switch"><input class="ias-bg-keepalive" id="ias-bg-keepalive" type="checkbox"><span class="ias-slider"></span></label>
                  </div>
                </div>

                <div class="ias-form-title">태그 뜻</div>
                <div class="ias-form-group" data-tour="settings-tags">
                  <div class="ias-form-row">
                    <label for="ias-tag-hover">태그에 마우스 올리면 한국어 뜻<small>NovelAI 입력칸 · 패널 · 보관함</small></label>
                    <label class="ias-switch"><input class="ias-tag-hover" id="ias-tag-hover" type="checkbox"><span class="ias-slider"></span></label>
                  </div>
                  <div class="ias-form-row">
                    <label for="ias-tag-machine">사전에 없는 태그는 자동 번역<small>크롬 내장 번역기 · 처음 한 번 내려받기</small></label>
                    <label class="ias-switch"><input class="ias-tag-machine" id="ias-tag-machine" type="checkbox"><span class="ias-slider"></span></label>
                  </div>
                </div>

                <div class="ias-form-title">데이터</div>
                <div class="ias-form-group" data-tour="settings-backup">
                  <div class="ias-form-row">
                    <label for="ias-auto-backup">자동 백업 파일<small>저장 폴더 안 _백업 폴더에 날짜별로</small></label>
                    <label class="ias-switch"><input class="ias-auto-backup" id="ias-auto-backup" type="checkbox"><span class="ias-slider"></span></label>
                  </div>
                  <div class="ias-form-row">
                    <span>전체 백업<small>메모 · 대기열 · 조합 · 설정</small></span>
                    <div class="ias-inline">
                      <button class="ias-btn secondary small ias-backup-import" type="button" title="메모는 합쳐지고, 대기열과 설정은 백업 내용으로 바뀌어요"><span>가져오기…</span></button>
                      <button class="ias-btn secondary small ias-backup-export" type="button"><span>내보내기…</span></button>
                    </div>
                  </div>
                  <div class="ias-form-row">
                    <span>노션 연결<small>그림·프롬프트를 노션 데이터베이스로</small></span>
                    <button class="ias-btn secondary small ias-notion-open" type="button"><span>보관함에서 설정 ↗</span></button>
                  </div>
                  <div class="ias-form-row ias-update-row" hidden>
                    <span>업데이트<small class="ias-update-sub">확인하는 중…</small></span>
                    <button class="ias-btn secondary small ias-update-open" type="button"><span>확인</span></button>
                  </div>
                  <div class="ias-form-row">
                    <span>오류 로그<small>문제가 생기면 내보내서 보내 주세요</small></span>
                    <div class="ias-inline">
                      <button class="ias-btn secondary small ias-diag-clear" type="button"><span>지우기</span></button>
                      <button class="ias-btn secondary small ias-diag-export" type="button"><span>내보내기…</span></button>
                    </div>
                  </div>
                </div>
                <input class="ias-backup-import-file" type="file" accept="application/json,.json" hidden>
                <p class="ias-version-line"></p>
              </div>
            </div>

            <div class="ias-status" data-tone="neutral"></div>
            <div class="ias-toasts" aria-live="polite"></div>
          </div>
          ${["n", "s", "e", "w", "ne", "nw", "se", "sw"].map((d) => `<div class="ias-edge" data-edge="${d}" aria-hidden="true"></div>`).join("")}
        </div>
      </div>
    `;
  }

  function bindEvents() {
    ui.sideClose.addEventListener("click", () => setPanelCollapsed(true));
    ui.sideMin?.addEventListener("click", toggleCompact);
    ui.sideFs?.addEventListener("click", toggleFullscreen);
    for (const button of ui.appearanceButtons || []) {
      button.addEventListener("click", () => {
        appearance = normalizeAppearance(button.dataset.appearance);
        applyAppearance();
        void storageSet("sync", { appearance });
      });
    }

    for (const tab of ui.tabs) {
      tab.addEventListener("click", () => setActiveTab(tab.dataset.tab));
    }

    bindMenus();
    ui.memoCaptureButton?.addEventListener("click", () => void captureNovelAiValuesToMemo());
    ui.memoCopyAutoButton?.addEventListener("click", copyAutoValuesToMemo);
    ui.memoNewButton?.addEventListener("click", () => {
      tourEvent("memo-new");
      startNewMemo();
    });
    ui.memoExportButton?.addEventListener("click", exportMemos);
    ui.memoImportButton?.addEventListener("click", () => ui.memoImportFile?.click());
    ui.memoSearchInput?.addEventListener("input", () => {
      memoSearchQuery = ui.memoSearchInput.value || "";
      renderMemoList();
    });
    ui.memoList?.addEventListener("click", handleMemoListClick);
    ui.memoDeleteButton?.addEventListener("click", () => selectedMemoId && void deletePromptMemo(selectedMemoId));
    ui.memoToAutoButton?.addEventListener("click", () => selectedMemoId && applyMemoToAuto(selectedMemoId));
    ui.memoToQueueButton?.addEventListener("click", () => selectedMemoId && void addMemoToQueue(selectedMemoId));
    ui.memoApplyButton?.addEventListener("click", () => selectedMemoId && void applyMemoDirectly(selectedMemoId));
    ui.memoTrashButton?.addEventListener("click", () => {
      flushMemoAutosave();
      memoView = memoView === "trash" ? "edit" : "trash";
      if (memoView === "trash") {
        renderMemoTrash();
      }
      renderMemoEditorState();
      renderMemoList();
    });
    ui.memoTrashList?.addEventListener("click", (event) => {
      const button = event.target instanceof Element ? event.target.closest("button[data-action]") : null;
      const row = button?.closest(".ias-trash-row");
      if (!button || !row) {
        return;
      }
      if (button.dataset.action === "restore") {
        void restoreMemoFromTrash(row.dataset.trashId);
      } else if (button.dataset.action === "purge") {
        void purgeMemoFromTrash(row.dataset.trashId);
      }
    });
    // Typing in the memo editor saves the memo (debounced) and keeps a draft in
    // the page's localStorage until it is saved.
    if (ui.memoEditorPanel) {
      const onEditorChange = (event) => {
        if (memoLoadingEditor || !(event.target instanceof Element)) {
          return;
        }
        scheduleMemoDraftSave();
        scheduleMemoAutosave();
        if (event.target === ui.memoNameInput && !selectedMemoId) {
          const draftRow = ui.memoList?.querySelector('[data-draft="true"] .ias-row-title');
          if (draftRow) {
            draftRow.textContent = ui.memoNameInput.value.trim() || "새 메모";
          }
        }
      };
      ui.memoEditorPanel.addEventListener("input", onEditorChange);
      ui.memoNameInput?.addEventListener("blur", flushMemoAutosave);
    }
    ui.storageAlertAction?.addEventListener("click", () => {
      // Flush the draft synchronously before reloading.
      writePageLocal(MEMO_DRAFT_LS_KEY, snapshotMemoDraft());
      location.reload();
    });
    window.addEventListener("pagehide", () => {
      if (memoDraftTimer) {
        writePageLocal(MEMO_DRAFT_LS_KEY, snapshotMemoDraft());
      }
    });
    ui.memoImportFile?.addEventListener("change", () => {
      const file = ui.memoImportFile.files?.[0] || null;
      ui.memoImportFile.value = "";
      void importMemosFromFile(file);
    });
    // Fallback path: only reached when the shield did not swallow the event.
    panelShadow.addEventListener("keydown", (event) => {
      if (keyShield?.wasHandled(event)) {
        return;
      }
      keyShield?.markHandled(event);
      handlePanelKeydown(event, event.target);
    });

    ui.autoButton.addEventListener("click", () => {
      if (autoRun.active && !queueRun.active) {
        void stopAutoGenerate({ playAudio: true });
      } else {
        void startSingleAuto();
      }
    });
    ui.queueRunButton.addEventListener("click", () => {
      if (queueRun.active) {
        void stopQueueRun();
      } else {
        void startQueueRun();
      }
    });
    ui.queueAddButton.addEventListener("click", () => void addQueueItem());
    ui.queueSelectButton?.addEventListener("click", () => setQueueSelectMode(!queueSelect.on));
    ui.queueClearButton.addEventListener("click", () => void clearQueue());
    ui.loopToggle.addEventListener("change", () => void toggleQueueLoop());
    ui.queueExportButton.addEventListener("click", exportQueue);
    ui.queueImportButton.addEventListener("click", () => ui.queueImportFile?.click());
    ui.queueImportFile.addEventListener("change", () => {
      const file = ui.queueImportFile.files?.[0] || null;
      ui.queueImportFile.value = "";
      void importQueueFromFile(file);
    });

    ui.queueList.addEventListener("click", handleQueueListClick);
    enableQueueDragSort();
    enableOrderChipDrag();
    enableGrabScroll(ui.queueList);
    panelShadow.querySelectorAll(".ias-scroll").forEach((el) => enableGrabScroll(el));
    ui.queueEditor.addEventListener("click", handleEditorClick);
    ui.queueEditor.addEventListener("input", handleEditorInput);
    ui.queueEditor.addEventListener("change", handleEditorInput);

    ui.queueBulkButton?.addEventListener("click", () => selectQueueView("bulk"));
    if (ui.genPane) {
      ui.genPane.addEventListener("click", handleComboClick);
      ui.genPane.addEventListener("input", handleComboInput);
      ui.genPane.addEventListener("change", handleComboChange);
    }
    if (ui.genAppendButton) {
      ui.genAppendButton.addEventListener("click", () => void genAppendToQueue());
    }
    if (ui.genReplaceButton) {
      ui.genReplaceButton.addEventListener("click", () => void genReplaceQueue());
    }
    if (ui.genExportButton) {
      ui.genExportButton.addEventListener("click", genExportJson);
    }
    ui.helpButton?.addEventListener("click", toggleTourSheet);
    panelShadow.querySelector(".ias-notion-open")?.addEventListener("click", () => {
      try {
        chrome.runtime.sendMessage({ action: "openLibrary", hash: "notion" }, () => void chrome.runtime.lastError);
      } catch (error) {
        setStatus("확장 프로그램이 업데이트됐어요. 페이지를 새로고침해 주세요.", "warn");
      }
    });
    panelShadow.querySelector(".ias-library-btn")?.addEventListener("click", () => {
      try {
        chrome.runtime.sendMessage({ action: "openLibrary" }, () => void chrome.runtime.lastError);
      } catch (error) {
        setStatus("확장 프로그램이 업데이트됐어요. 페이지를 새로고침해 주세요.", "warn");
      }
    });
    ui.saveNameInput?.addEventListener("input", () => {
      if ((ui.saveNameInput.value || "").includes("_")) {
        tourEvent("auto-named");
      }
    });

    ui.autoSaveToggle.addEventListener("change", savePreferences);
    ui.notifyToggle.addEventListener("change", savePreferences);
    ui.diagExportButton?.addEventListener("click", exportDiagLog);
    ui.diagClearButton?.addEventListener("click", () => {
      clearDiagLog();
      setStatus("진단 로그를 지웠어요.", "ok");
    });
    ui.bgKeepAliveToggle?.addEventListener("change", () => {
      backgroundKeepAliveEnabled = Boolean(ui.bgKeepAliveToggle.checked);
      syncBackgroundKeepAlive();
      savePreferences();
    });
    for (const button of ui.saveFormatButtons || []) {
      button.addEventListener("click", () => setSaveFormat(button.dataset.saveFormat));
    }
    for (const toggle of [ui.folderByDateToggle, ui.folderByCharToggle]) {
      toggle?.addEventListener("change", () => {
        savePreferences();
        renderFolderPreview();
      });
    }
    ui.folderInput?.addEventListener("input", renderFolderPreview);
    ui.saveNameInput?.addEventListener("input", renderFolderPreview);
    for (const toggle of [ui.tagHoverToggle, ui.tagMachineToggle]) {
      toggle?.addEventListener("change", () => {
        globalThis.TagKo?.setOptions({ enabled: ui.tagHoverToggle.checked, machine: ui.tagMachineToggle.checked });
        if (toggle === ui.tagMachineToggle && toggle.checked) {
          void globalThis.TagKo?.ensureTranslator(true);
        }
        savePreferences();
      });
    }
    ui.autoBackupToggle?.addEventListener("change", () => {
      savePreferences();
      if (ui.autoBackupToggle.checked) {
        scheduleAutoBackup(1000);
      }
    });
    ui.backupExportButton?.addEventListener("click", () => void exportFullBackup());
    ui.backupImportButton?.addEventListener("click", () => ui.backupImportFile?.click());
    ui.backupImportFile?.addEventListener("change", () => {
      const file = ui.backupImportFile.files?.[0] || null;
      ui.backupImportFile.value = "";
      void importFullBackupFromFile(file);
    });

    ui.intervalInput.addEventListener("change", saveSingleSettings);
    ui.countInput.addEventListener("change", saveSingleSettings);
    ui.saveNameInput.addEventListener("change", saveSingleSettings);
    [ui.autoBaseInput, ui.autoBaseNegInput, ui.autoCharInput, ui.autoCharNegInput].forEach((el) => {
      if (el) {
        el.addEventListener("change", scheduleSingleSettingsSave);
        el.addEventListener("input", scheduleSingleSettingsSave);
      }
    });
    if (ui.folderInput) {
      ui.folderInput.addEventListener("change", () => {
        const raw = ui.folderInput.value || "";
        const fixed = normalizeFolderInput(raw);
        if (fixed !== raw.trim().replace(/\\/g, "/")) {
          ui.folderInput.value = fixed;
          setStatus("저장 폴더는 다운로드 폴더 안의 하위 경로만 가능해요. 절대경로(C:\\...)는 쓸 수 없어 폴더명만 남겼어요. 부모 위치는 Chrome 다운로드 설정에서 바꿔주세요.", "warn");
        }
        saveSingleSettings();
      });
    }

    // 장수: "멈출 때까지" (empty count) or a number. The field shows only
    // when a number is chosen, so there's no mystery "empty means forever".
    for (const button of ui.countModeButtons || []) {
      button.addEventListener("click", () => {
        if (button.dataset.countMode === "forever") {
          ui.countInput.value = "";
        } else if (!ui.countInput.value) {
          ui.countInput.value = String(lastCountValue || 20);
          requestAnimationFrame(() => ui.countInput.select());
        }
        syncCountMode();
        saveSingleSettings();
      });
    }
    ui.countInput?.addEventListener("input", () => {
      if (ui.countInput.value) lastCountValue = Number(ui.countInput.value) || lastCountValue;
    });
    ui.countInput?.addEventListener("change", syncCountMode);
    for (const button of ui.promptModeButtons || []) {
      button.addEventListener("click", () => {
        setAutoPromptMode(button.dataset.promptMode);
        tourEvent("auto-prompt");
        if (autoPromptMode === "own") {
          ui.autoPromptEditor?.focus();
        }
      });
    }

    enableDrag(ui.sidebar);
    enableDrag(ui.toolbar);
    enableEdgeResize(ui.edges);
    // macOS: double-clicking the title bar zooms the window to fill the screen and back.
    ui.toolbar?.addEventListener("dblclick", (event) => {
      if (event.target.closest("button, input, textarea, label, select, .ias-menu")) {
        return;
      }
      toggleFullscreen();
    });
    enableDrag(ui.fab, { tapToOpen: true });
  }



  // The shield swallows key events at window-capture, before they can reach the
  // panel by bubbling, so every shortcut the panel owns is handled here. Called
  // once per event: either by the shield, or by the fallback listener on the
  // shadow root when the shield never installed.
  function handlePanelKeydown(event, target) {
    if (!event || event.type !== "keydown") {
      return;
    }
    // An open alert owns Esc / Enter (the key shield routes panel keys here).
    if (iosAlertKeyHandler) {
      iosAlertKeyHandler(event);
      return;
    }
    if (event.key === "Escape") {
      closeMemoMenus();
      if (tourRun.index >= 0 || tourRun.sheetOpen) {
        endTourRun();
      }
      return;
    }
    if (event.key === "Enter" && target && target === ui.bulkCountInput) {
      event.preventDefault();
      void applyCountToAll("set");
    }
  }

  async function createPanel() {
    if (panelHost) {
      return;
    }
    panelHost = document.createElement("div");
    panelHost.id = HOST_ID;
    try {
      panelHost.dataset.ext = chrome.runtime.id;
    } catch (error) {
      void error;
    }
    panelShadow = panelHost.attachShadow({ mode: "open" });
    panelShadow.innerHTML = getTemplate();
    document.documentElement.append(panelHost);

    if (keyShield) {
      keyShield.registerHost(panelHost);
      keyShield.setHook(handlePanelKeydown);
    } else {
      // No shield (stale content script). Stopping propagation as the event
      // leaves the host still blocks NovelAI's bubble-phase shortcut handlers,
      // which is the common case.
      for (const type of ["keydown", "keypress", "keyup"]) {
        panelHost.addEventListener(type, (event) => event.stopPropagation());
      }
    }

    ui = {
      shell: panelShadow.querySelector(".ias-shell"),
      fab: panelShadow.querySelector(".ias-fab"),
      sidebar: panelShadow.querySelector(".ias-side"),
      tabs: Array.from(panelShadow.querySelectorAll(".ias-tab")),
      panes: Array.from(panelShadow.querySelectorAll(".ias-pane")),
      sideClose: panelShadow.querySelector(".ias-side-close"),
      sideMin: panelShadow.querySelector(".ias-side-min"),
      sideFs: panelShadow.querySelector(".ias-side-fs"),
      card: panelShadow.querySelector(".ias-card"),
      edges: Array.from(panelShadow.querySelectorAll(".ias-edge")),
      toolbar: panelShadow.querySelector(".ias-toolbar"),
      toolbarTitle: panelShadow.querySelector(".ias-toolbar-title"),
      activityBox: panelShadow.querySelector(".ias-activity-box"),
      activityText: panelShadow.querySelector(".ias-activity-text"),
      activityBar: panelShadow.querySelector(".ias-activity-bar > span"),
      helpButton: panelShadow.querySelector(".ias-help-btn"),
      helpProgress: panelShadow.querySelector(".ias-help-progress"),
      appearanceButtons: Array.from(panelShadow.querySelectorAll("[data-appearance]")),
      versionLine: panelShadow.querySelector(".ias-version-line"),
      updateRow: panelShadow.querySelector(".ias-update-row"),
      updateSub: panelShadow.querySelector(".ias-update-sub"),
      updateButton: panelShadow.querySelector(".ias-update-open"),
      badgeQueue: panelShadow.querySelector('[data-badge="queue"]'),
      badgeMemo: panelShadow.querySelector('[data-badge="memo"]'),
      saveNameInput: panelShadow.querySelector(".ias-save-name"),
      autoBaseInput: panelShadow.querySelector(".ias-auto-base"),
      autoBaseNegInput: panelShadow.querySelector(".ias-auto-base-neg"),
      autoCharInput: panelShadow.querySelector(".ias-auto-char"),
      autoCharNegInput: panelShadow.querySelector(".ias-auto-char-neg"),
      memoNameInput: panelShadow.querySelector(".ias-memo-name"),
      memoBaseInput: panelShadow.querySelector(".ias-memo-base"),
      memoBaseNegInput: panelShadow.querySelector(".ias-memo-base-neg"),
      memoCharInput: panelShadow.querySelector(".ias-memo-char"),
      memoCharNegInput: panelShadow.querySelector(".ias-memo-char-neg"),
      memoCaptureButton: panelShadow.querySelector(".ias-memo-capture"),
      memoCopyAutoButton: panelShadow.querySelector(".ias-memo-copy-auto"),
      memoNewButton: panelShadow.querySelector(".ias-memo-new"),
      memoSearchInput: panelShadow.querySelector(".ias-memo-search"),
      memoExportButton: panelShadow.querySelector(".ias-memo-export"),
      memoImportButton: panelShadow.querySelector(".ias-memo-import"),
      memoEditorPanel: panelShadow.querySelector(".ias-memo-editor"),
      memoEditorHost: panelShadow.querySelector(".ias-memo-editor-host"),
      memoMeta: panelShadow.querySelector(".ias-memo-meta"),
      memoDeleteButton: panelShadow.querySelector(".ias-memo-delete"),
      memoToAutoButton: panelShadow.querySelector(".ias-memo-to-auto"),
      memoToQueueButton: panelShadow.querySelector(".ias-memo-to-queue"),
      memoApplyButton: panelShadow.querySelector(".ias-memo-apply"),
      memoTrashCount: panelShadow.querySelector(".ias-memo-trash-count"),
      memoImportFile: panelShadow.querySelector(".ias-memo-import-file"),
      memoList: panelShadow.querySelector(".ias-memo-list"),
      folderInput: panelShadow.querySelector(".ias-folder"),
      countInput: panelShadow.querySelector(".ias-count"),
      intervalInput: panelShadow.querySelector(".ias-interval"),
      countModeButtons: Array.from(panelShadow.querySelectorAll("[data-count-mode]")),
      countWrap: panelShadow.querySelector(".ias-count-wrap"),
      promptModeButtons: Array.from(panelShadow.querySelectorAll("[data-prompt-mode]")),
      saveFormatButtons: Array.from(panelShadow.querySelectorAll("[data-save-format]")),
      promptNaiNote: panelShadow.querySelector(".ias-prompt-nai-note"),
      autoEditorHost: panelShadow.querySelector(".ias-auto-editor"),
      autoPath: panelShadow.querySelector(".ias-auto-path"),
      autoButton: panelShadow.querySelector(".ias-auto"),
      queueCount: panelShadow.querySelector(".ias-queue-count"),
      queueAddButton: panelShadow.querySelector(".ias-queue-add"),
      queueSelectButton: panelShadow.querySelector(".ias-queue-select"),
      queueList: panelShadow.querySelector(".ias-queue-list"),
      queueEditor: panelShadow.querySelector(".ias-qeditor"),
      queueRunButton: panelShadow.querySelector(".ias-queue-run"),
      queueBulkButton: panelShadow.querySelector('[data-queue-view="bulk"]'),
      loopToggle: panelShadow.querySelector(".ias-loop"),
      queueExportButton: panelShadow.querySelector(".ias-queue-export"),
      queueImportButton: panelShadow.querySelector(".ias-queue-import"),
      queueImportFile: panelShadow.querySelector(".ias-queue-import-file"),
      queueClearButton: panelShadow.querySelector(".ias-queue-clear"),
      genPane: panelShadow.querySelector('.ias-pane[data-pane="gen"]'),
      comboMain: panelShadow.querySelector(".ias-combo-main"),
      comboPickers: panelShadow.querySelector(".ias-combo-pickers"),
      comboResultTitle: panelShadow.querySelector(".ias-combo-result-title"),
      comboCards: panelShadow.querySelector(".ias-combo-cards"),
      comboInspector: panelShadow.querySelector(".ias-combo-inspector"),
      comboNameSelect: panelShadow.querySelector(".ias-name-select"),
      nameTemplateRow: panelShadow.querySelector(".ias-name-template-row"),
      nameTemplateInput: panelShadow.querySelector(".ias-name-template"),
      nameTemplatePreview: panelShadow.querySelector(".ias-template-preview"),
      comboSummary: panelShadow.querySelector(".ias-combo-summary"),
      genCount: panelShadow.querySelector(".ias-gen-count"),
      genSplit: panelShadow.querySelector(".ias-gen-split"),
      genPreview: panelShadow.querySelector(".ias-gen-preview"),
      genAddCharButton: panelShadow.querySelector(".ias-gen-add-char"),
      genAddBgButton: panelShadow.querySelector(".ias-gen-add-bg"),
      genAppendButton: panelShadow.querySelector(".ias-gen-append"),
      genReplaceButton: panelShadow.querySelector(".ias-gen-replace"),
      genExportButton: panelShadow.querySelector(".ias-gen-export"),
      autoSaveToggle: panelShadow.querySelector(".ias-auto-save"),
      notifyToggle: panelShadow.querySelector(".ias-notify"),
      bgKeepAliveToggle: panelShadow.querySelector(".ias-bg-keepalive"),
      diagExportButton: panelShadow.querySelector(".ias-diag-export"),
      diagClearButton: panelShadow.querySelector(".ias-diag-clear"),
      status: panelShadow.querySelector(".ias-status"),
      toasts: panelShadow.querySelector(".ias-toasts"),
      storageAlert: panelShadow.querySelector(".ias-alert"),
      folderByDateToggle: panelShadow.querySelector(".ias-folder-by-date"),
      folderByCharToggle: panelShadow.querySelector(".ias-folder-by-char"),
      folderPreview: panelShadow.querySelector(".ias-path-preview"),
      autoBackupToggle: panelShadow.querySelector(".ias-auto-backup"),
      tagHoverToggle: panelShadow.querySelector(".ias-tag-hover"),
      tagMachineToggle: panelShadow.querySelector(".ias-tag-machine"),
      backupExportButton: panelShadow.querySelector(".ias-backup-export"),
      backupImportButton: panelShadow.querySelector(".ias-backup-import"),
      backupImportFile: panelShadow.querySelector(".ias-backup-import-file"),
      storageAlertText: panelShadow.querySelector(".ias-alert-text"),
      storageAlertAction: panelShadow.querySelector(".ias-alert-action"),
      memoTrashButton: panelShadow.querySelector(".ias-memo-trash-toggle"),
      memoTrashPanel: panelShadow.querySelector(".ias-memo-trash"),
      memoTrashList: panelShadow.querySelector(".ias-memo-trash-list"),
      memoPane: panelShadow.querySelector('[data-pane="memo"]'),
    };
    applyAppearance();
    if (ui.versionLine) {
      ui.versionLine.textContent = `NAI 자동저장 ${extensionVersion() || ""}`.trim();
    }
    initUpdateRow();

    ui.autoPromptEditor = attachPromptEditor({
      base: ui.autoBaseInput, baseNeg: ui.autoBaseNegInput, char: ui.autoCharInput, charNeg: ui.autoCharNegInput,
    }, { basePlaceholder: "비우면 NovelAI에 있는 값을 그대로 써요" });
    ui.memoPromptEditor = attachPromptEditor({
      base: ui.memoBaseInput, baseNeg: ui.memoBaseNegInput, char: ui.memoCharInput, charNeg: ui.memoCharNegInput,
    }, { basePlaceholder: "이 메모에 넣을 베이스 · 비우면 메모에 안 들어가요", charPlaceholder: "예: girl, black hair, long hair" });

    bindEvents();

    const uiState = await storageGet("local", [UI_STORAGE_KEY]);
    const stored = uiState[UI_STORAGE_KEY] || {};
    panelPosition = stored.position || null;
    applyPanelPosition();
    panelSize = stored.size && stored.size.width && stored.size.height ? stored.size : null;
    applyPanelSize();
    const startCollapsed = stored.collapsed !== false;
    // Collapsed + fullscreen is the click-swallowing combo; never restore into it.
    panelFullscreen = Boolean(stored.fullscreen) && !startCollapsed;
    panelCompact = Boolean(stored.compact) && !panelFullscreen;
    setPanelCollapsed(startCollapsed);
    applyFullscreen();
    applyCompact();

    let recoveryMessage = "";
    try {
      recoveryMessage = describeRecovery(await safeStore.recover());
    } catch (error) {
      void error;
    }
    startContextWatch();
    if (recoveryMessage) {
      setStatus(recoveryMessage, "ok");
    }

    await loadSettings();
    await loadEtaSeed();
    await loadQueueState();
    await loadGeneratorState();
    await loadMemoState();
    renderMemoEditorState();
    renderQueue();
    renderControls();
    await loadTourState();
    tourLoaded = true;
    if (!panelCollapsed) {
      onTabShown(activeTab);
    }
    scheduleAutoBackup(20000);
  }

  // ---------------------------------------------------------------------------
  // messaging
  // ---------------------------------------------------------------------------
  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    const action = request?.action;
    if (action === "ping") {
      sendResponse({
        ok: true,
        autoActive: autoRun.active || queueRun.active,
        hasGenerateButton: Boolean(findGenerateButton()),
        promptEditorCount: findPromptEditors().length,
      });
      return false;
    }
    if (action === "openPanel" || action === "togglePanel") {
      void createPanel().then(() => {
        setPanelCollapsed(action === "togglePanel" ? !panelCollapsed : false);
      });
      sendResponse({ ok: true });
      return false;
    }
    if (action === "libraryAddMemos" || action === "libraryAddQueue") {
      void handleLibraryAdd(action, request.items).then(sendResponse, (error) => sendResponse({ ok: false, error: String(error?.message || error) }));
      return true;
    }
    if (action === "getContentStatus") {
      sendResponse({ ok: true, autoActive: autoRun.active || queueRun.active });
      return false;
    }
    if (action === "startAutoGenerate") {
      void createPanel().then(() => startSingleAuto());
      sendResponse({ ok: true });
      return false;
    }
    if (action === "cancelAutoGenerate") {
      void (queueRun.active ? stopQueueRun() : stopAutoGenerate({ playAudio: true }));
      sendResponse({ ok: true });
      return false;
    }
    return false;
  });

  // 보관함 → memo / queue. Goes through this tab so the lists it holds in
  // memory stay the source of truth.
  async function handleLibraryAdd(action, items) {
    const list = (Array.isArray(items) ? items : []).filter((item) => item && item.values);
    if (!list.length) {
      return { ok: false, error: "넣을 프롬프트가 없어요." };
    }
    await createPanel();
    if (action === "libraryAddMemos") {
      if (!memoLoaded) {
        await loadMemoState();
      }
      const now = Date.now();
      const created = list.map((item, i) => normalizeMemoItem({
        id: createMemoId(), name: String(item.name || `메모 ${memoState.items.length + i + 1}`), values: item.values, createdAt: now, updatedAt: now,
      }, memoState.items.length + i)).filter((item) => Object.keys(item.values).length);
      memoState.items.unshift(...created);
      const result = await persistMemoState();
      if (!result.ok && !result.mirrored) {
        return { ok: false, error: "메모를 저장하지 못했어요. NovelAI 페이지를 새로고침해 주세요." };
      }
      const editorEmpty = !Object.keys(memoEditorValues()).length && !(ui.memoNameInput?.value || "").trim();
      if (!selectedMemoId && editorEmpty && created[0]) {
        selectMemo(created[0].id);
      } else {
        renderMemoList();
      }
      setStatus(`보관함에서 메모 ${created.length}개를 가져왔어요.`, "ok");
      return { ok: true, count: created.length };
    }
    if (queueRun.active) {
      return { ok: false, error: "대기열이 돌아가는 중이에요. 멈춘 뒤 넣어 주세요." };
    }
    await loadQueueState();
    for (const item of list) {
      const v = item.values;
      queueState.items.push(Store.createItem({
        title: String(item.name || ""),
        basePrompt: v.basePrompt || "",
        baseNegativePrompt: v.baseNegativePrompt || "",
        characterPrompt: v.characterPrompt || "",
        negativePrompt: v.characterNegativePrompt || "",
        count: 1,
      }));
    }
    await persistQueueState();
    setStatus(`보관함에서 대기열에 ${list.length}개를 넣었어요.`, "ok");
    return { ok: true, count: list.length };
  }

  // Pretendard ships with the extension. @font-face must live in the page
  // document (shadow roots can't declare fonts) under a unique family name.
  function injectFontFace() {
    try {
      if (document.getElementById("nas-font-face")) {
        return;
      }
      const style = document.createElement("style");
      style.id = "nas-font-face";
      style.textContent = `@font-face{font-family:"NAS Pretendard";src:url("${chrome.runtime.getURL("fonts/PretendardVariable.woff2")}") format("woff2");font-weight:45 920;font-display:swap;}`;
      (document.head || document.documentElement).append(style);
    } catch (error) {
      void error;
    }
  }

  // ---------------------------------------------------------------------------
  // GitHub copies don't update by themselves: settings shows a row, and a new
  // version gets one toast. Web Store copies never see any of this.
  // ---------------------------------------------------------------------------
  const UPDATE_TOAST_KEY = "naiAutoSaver.updateToasted";
  function applyUpdateInfo(info) {
    if (!ui.updateRow || !info?.eligible) return;
    ui.updateRow.hidden = false;
    ui.updateRow.dataset.available = info.available ? "true" : "false";
    const label = ui.updateButton.querySelector("span");
    if (info.available) {
      ui.updateSub.textContent = `새 버전 ${info.latest} · 지금 ${info.current}`;
      label.textContent = "업데이트…";
      ui.updateButton.classList.remove("secondary");
    } else {
      ui.updateSub.textContent = info.error ? "확인하지 못했어요 · 인터넷을 확인해 주세요" : `최신 버전이에요 · ${info.current}`;
      label.textContent = "확인";
      ui.updateButton.classList.add("secondary");
    }
  }
  function initUpdateRow() {
    if (!ui.updateButton) return;
    ui.updateButton.addEventListener("click", () => {
      if (ui.updateRow.dataset.available === "true") {
        chrome.runtime.sendMessage({ action: "openUpdatePage" }, () => void chrome.runtime.lastError);
        return;
      }
      ui.updateSub.textContent = "확인하는 중…";
      chrome.runtime.sendMessage({ action: "updateStatus", force: true }, (info) => {
        void chrome.runtime.lastError;
        applyUpdateInfo(info);
      });
    });
    chrome.runtime.sendMessage({ action: "updateStatus" }, (info) => {
      void chrome.runtime.lastError;
      applyUpdateInfo(info);
      if (!info?.available) return;
      chrome.storage.local.get(UPDATE_TOAST_KEY, (r) => {
        if (chrome.runtime.lastError || r?.[UPDATE_TOAST_KEY] === info.latest) return;
        chrome.storage.local.set({ [UPDATE_TOAST_KEY]: info.latest });
        showToast(`새 버전 ${info.latest} · 설정 맨 아래에서 업데이트해요`);
      });
    });
  }

  // ---------------------------------------------------------------------------
  // Hand-off to the Web Store copy. A copy loaded with "압축해제된 확장 프로그램
  // 로드" (installType "development") steps aside by itself once another copy
  // of this panel is on the page: it removes its panel, the background stops
  // its saving, and a page offers to remove it. The store copy never steps
  // aside. Memos/queue/settings move over through the page mirror (SafeStore).
  // ---------------------------------------------------------------------------
  let retired = false;
  function otherCopyPresent() {
    return Array.from(document.querySelectorAll(`[id="${HOST_ID}"]`)).some((el) => el !== panelHost && el.dataset.ext !== chrome.runtime.id);
  }
  function retireIfReplaced() {
    if (retired || !otherCopyPresent()) {
      return;
    }
    chrome.runtime.sendMessage({ action: "retireIfDevCopy" }, (response) => {
      void chrome.runtime.lastError;
      if (!response?.retired) {
        return;
      }
      retired = true;
      try {
        void stopAutoGenerate({ quiet: true });
      } catch (error) {
        void error;
      }
      panelHost?.remove();
      panelHost = null;
    });
  }
  function watchForStoreCopy() {
    retireIfReplaced();
    new MutationObserver(() => retireIfReplaced()).observe(document.documentElement, { childList: true });
  }

  async function init() {
    if (!location.href.startsWith("https://novelai.net/image")) {
      return;
    }
    const state = await new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage({ action: "devCopyState" }, (response) => {
          void chrome.runtime.lastError;
          resolve(response || {});
        });
      } catch (error) {
        resolve({});
      }
    });
    if (state.retired) {
      // Handed over earlier. Stay out while the store copy is here; if it has
      // been removed since, come back.
      await new Promise((resolve) => setTimeout(resolve, 3000));
      if (otherCopyPresent()) {
        retired = true;
        return;
      }
      chrome.runtime.sendMessage({ action: "unretireDevCopy" }, () => void chrome.runtime.lastError);
    }
    injectFontFace();
    void loadDiagLog();
    void createPanel();
    // Korean meaning of the tag under the mouse: NovelAI's own prompt boxes
    // and this panel's text boxes.
    globalThis.TagKo?.attachHover({
      roots: [document],
      scope: (block) => Boolean(block.closest(".ProseMirror")),
      textareas: (area) => Boolean(panelShadow) && area.getRootNode() === panelShadow && !area.closest(".ias-tour-layer"),
    });
    setTimeout(watchForStoreCopy, 1500);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => void init(), { once: true });
  } else {
    void init();
  }
})(typeof globalThis !== "undefined" ? globalThis : window);
