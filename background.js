"use strict";

// 보관함: metadata reader + library database (classic worker scripts).
try {
  importScripts("nai-meta.js", "lib-db.js", "notion.js", "update-check.js");
} catch (error) {
  console.warn("library scripts failed to load", error);
}

const TAB_ACTIONS = new Set([
  "ping",
  "togglePanel",
  "openPanel",
  "generateOnce",
  "startAutoGenerate",
  "cancelAutoGenerate",
  "getContentStatus",
]);

const OFFSCREEN_AUDIO_PATH = "offscreen.html";
let creatingOffscreenDocument = null;

async function ensureOffscreenAudioDocument() {
  const offscreenUrl = chrome.runtime.getURL(OFFSCREEN_AUDIO_PATH);
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
    documentUrls: [offscreenUrl],
  });
  if (contexts.length > 0) {
    return;
  }

  if (!creatingOffscreenDocument) {
    creatingOffscreenDocument = chrome.offscreen.createDocument({
      url: OFFSCREEN_AUDIO_PATH,
      reasons: ["AUDIO_PLAYBACK"],
      justification: "Play automatic generation start and completion sounds.",
    }).finally(() => {
      creatingOffscreenDocument = null;
    });
  }
  await creatingOffscreenDocument;
}

async function playExtensionSound(filename, volume) {
  await ensureOffscreenAudioDocument();
  return chrome.runtime.sendMessage({
    target: "nai-offscreen-audio",
    action: "playSound",
    filename,
    volume,
  });
}

function sanitizeFilenamePart(value) {
  return String(value || "prompt")
    .replace(/[\\/:*?"<>|]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120) || "prompt";
}

// A download subfolder may contain nested paths ("Proj/CharA"), but each
// segment must be a safe filename. Empty/invalid input falls back to "NovelAI".
function sanitizeDownloadFolder(value) {
  let raw = String(value == null ? "" : value).replace(/\\/g, "/");
  if (/^[a-zA-Z]:/.test(raw)) {
    const segs = raw.split("/").map((s) => s.trim()).filter(Boolean);
    raw = segs.length ? segs[segs.length - 1] : "NovelAI";
  }
  raw = raw.replace(/^\/+/, "");
  const cleaned = raw
    .split("/")
    .map((segment) => segment.replace(/[:*?"<>|]/g, "_").replace(/\s+/g, " ").trim())
    .filter((segment) => segment && segment !== "." && segment !== "..")
    .map((segment) => segment.slice(0, 80));
  return cleaned.length ? cleaned.join("/") : "NovelAI";
}

function sendMessageToActiveNovelAiTab(request, sendResponse) {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const tab = tabs?.[0];
    if (!tab?.id || !tab.url?.startsWith("https://novelai.net/image")) {
      sendResponse({ ok: false, error: "NovelAI image page is not active." });
      return;
    }

    chrome.tabs.sendMessage(tab.id, request, (response) => {
      if (!chrome.runtime.lastError) {
        sendResponse(response);
        return;
      }

      chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["queue-store.js", "safe-store.js", "content.js"] }, () => {
        if (chrome.runtime.lastError) {
          sendResponse({ ok: false, error: chrome.runtime.lastError.message });
          return;
        }
        chrome.tabs.sendMessage(tab.id, request, (retryResponse) => {
          if (chrome.runtime.lastError) {
            sendResponse({ ok: false, error: chrome.runtime.lastError.message });
            return;
          }
          sendResponse(retryResponse);
        });
      });
    });
  });
}

function createCompletionNotification(count) {
  const message = count && count > 0
    ? `총 ${count}장의 이미지 생성이 완료되었어요.`
    : "설정된 자동 생성 작업이 완료되었어요.";

  chrome.storage.sync.get(["autoCompletionNotificationEnabled"], (result = {}) => {
    if (result.autoCompletionNotificationEnabled !== false) {
      chrome.notifications.create(`nai-auto-saver-complete-${Date.now()}`, {
        type: "basic",
        iconUrl: chrome.runtime.getURL("icons/icon48.png"),
        title: "자동 생성 완료",
        message,
        priority: 0,
        requireInteraction: false,
      });
    }

    resetPopupButtons();
  });
}

function resetPopupButtons() {
  chrome.runtime.sendMessage({ action: "resetPopupButtons" }, () => {
    void chrome.runtime.lastError;
  });
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request?.action === "playExtensionSound") {
    void playExtensionSound(request.filename, request.volume)
      .then((response) => sendResponse(response || { ok: true }))
      .catch((error) => sendResponse({ ok: false, error: String(error?.message || error) }));
    return true;
  }

  if (TAB_ACTIONS.has(request?.action)) {
    sendMessageToActiveNovelAiTab(request, sendResponse);
    return true;
  }

  if (request?.action === "showCompletionNotification") {
    createCompletionNotification(request.count);
    sendResponse({ ok: true });
    return false;
  }

  if (request?.action === "resetPopupButtons") {
    resetPopupButtons();
    sendResponse({ ok: true });
    return false;
  }

  if (request?.action === "updateStatus") {
    const run = globalThis.NAIUpdate ? NAIUpdate.check({ force: Boolean(request.force) }) : Promise.resolve({ eligible: false });
    void run.then(sendResponse, (error) => sendResponse({ eligible: false, error: String(error?.message || error) }));
    return true;
  }

  if (request?.action === "openUpdatePage") {
    void openUpdatePage().then(() => sendResponse({ ok: true }));
    return true;
  }

  if (request?.action === "devCopyState") {
    void chrome.storage.local.get(RETIRED_KEY).then((r) => sendResponse({ retired: Boolean(r[RETIRED_KEY]) }));
    return true;
  }

  if (request?.action === "unretireDevCopy") {
    void chrome.storage.local.remove(RETIRED_KEY).then(() => sendResponse({ ok: true }));
    return true;
  }

  if (request?.action === "retireIfDevCopy") {
    void retireIfDevCopy().then((retired) => sendResponse({ retired }));
    return true;
  }

  if (request?.action === "downloadImage" && request.imageUrl) {
    void saveGeneratedImage(request).then(sendResponse, (error) => sendResponse({ ok: false, error: String(error?.message || error) }));
    return true;
  }

  if (request?.action === "openLibrary") {
    void openLibraryTab(request.query || "", request.hash || "").then(() => sendResponse({ ok: true }), (error) => sendResponse({ ok: false, error: String(error) }));
    return true;
  }

  // Daily safety backup (memos / queue / settings) written next to the images.
  if (request?.action === "downloadBackup" && typeof request.json === "string") {
    const folder = sanitizeDownloadFolder(request.folder);
    const filename = `${folder}/${sanitizeFilenamePart(String(request.fileName || "backup.json").replace(/\.json$/i, ""))}.json`;
    const url = `data:application/json;charset=utf-8,${encodeURIComponent(request.json)}`;
    chrome.downloads.download({ url, filename, saveAs: false, conflictAction: "overwrite" }, (downloadId) => {
      if (chrome.runtime.lastError) {
        sendResponse({ ok: false, error: chrome.runtime.lastError.message });
        return;
      }
      sendResponse({ ok: true, downloadId });
    });
    return true;
  }

  if (request?.action === "closePopup") {
    chrome.runtime.sendMessage({ action: "closePopup" }, () => {
      void chrome.runtime.lastError;
    });
    sendResponse({ ok: true });
    return false;
  }

  return false;
});


// ---------------------------------------------------------------------------
// Saving a generated picture in the chosen format. NovelAI hands the page a
// PNG; "webp" turns it into the same lossless WebP NovelAI's own download
// makes (EXIF text + stealth bits kept), "png" keeps the bytes as they are.
// ---------------------------------------------------------------------------
function bytesToDataUrl(bytes, type) {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return `data:${type};base64,${btoa(binary)}`;
}

async function convertForSave(dataUrl, format) {
  if (!String(dataUrl).startsWith("data:image/")) return { url: dataUrl, bytes: null, ext: "png" };
  const bytes = dataUrlToBytes(dataUrl);
  const kind = NAIMeta.imageType(bytes);
  const want = format === "png" ? "png" : "webp";
  if (!kind) return { url: dataUrl, bytes, ext: "png" };
  if (kind === want) return { url: dataUrl, bytes, ext: want };
  try {
    const out = want === "webp" ? await NAIMeta.pngToWebp(bytes) : await NAIMeta.webpToPng(bytes);
    return { url: bytesToDataUrl(out, `image/${want}`), bytes: out, ext: want };
  } catch (error) {
    console.warn("format conversion failed, keeping the original", error);
    return { url: dataUrl, bytes, ext: kind, warning: String(error?.message || error) };
  }
}

// "auto" follows the format of the user's own NovelAI downloads (NovelAI's
// "download format" setting), learned when they press NovelAI's own download
// button; WebP until then.
const NAI_FORMAT_KEY = "naiAutoSaver.naiDownloadFormat";
async function resolveSaveFormat(requested) {
  if (requested === "png" || requested === "webp") return requested;
  const sync = await chrome.storage.sync.get("saveFormat");
  if (sync.saveFormat === "png" || sync.saveFormat === "webp") return sync.saveFormat;
  const local = await chrome.storage.local.get(NAI_FORMAT_KEY);
  return local[NAI_FORMAT_KEY]?.format === "png" ? "png" : "webp";
}

function rememberNaiFormat(format, how) {
  if (format !== "png" && format !== "webp") return;
  void chrome.storage.local.set({ [NAI_FORMAT_KEY]: { format, how, at: Date.now() } });
}

const naiDownloads = new Set();
function isNovelAiDownload(item) {
  if (!item || item.byExtensionId) return false;
  const from = `${item.url || ""} ${item.finalUrl || ""} ${item.referrer || ""}`;
  return /novelai\.net/i.test(from);
}
function formatFromName(name, mime) {
  if (/\.webp$/i.test(name || "") || mime === "image/webp") return "webp";
  if (/\.png$/i.test(name || "") || mime === "image/png") return "png";
  return null;
}
chrome.downloads.onCreated.addListener((item) => {
  if (!isNovelAiDownload(item)) return;
  naiDownloads.add(item.id);
  const format = formatFromName(item.filename, item.mime);
  if (format) rememberNaiFormat(format, "download");
});
chrome.downloads.onChanged.addListener((delta) => {
  if (!naiDownloads.has(delta.id) || !delta.filename?.current) return;
  const format = formatFromName(delta.filename.current, null);
  if (format) rememberNaiFormat(format, "download");
  naiDownloads.delete(delta.id);
});

// GitHub copies: check for a new version now and then (see update-check.js),
// and after an in-place update (update.html) say that it worked.
const UPDATE_APPLIED_KEY = "naiAutoSaver.updateApplied";
async function openUpdatePage(hash = "") {
  const url = chrome.runtime.getURL("update.html");
  const [open] = await chrome.tabs.query({ url }).catch(() => []);
  if (open) {
    await chrome.tabs.update(open.id, { active: true, url: url + hash });
  } else {
    await chrome.tabs.create({ url: url + hash });
  }
}
chrome.runtime.onStartup?.addListener(() => {
  void globalThis.NAIUpdate?.check().catch(() => {});
});
chrome.runtime.onInstalled?.addListener(async (details) => {
  if (details.reason !== "update") return;
  try {
    const applied = (await chrome.storage.local.get(UPDATE_APPLIED_KEY))[UPDATE_APPLIED_KEY];
    if (applied && Date.now() - (applied.at || 0) < 10 * 60 * 1000) {
      await openUpdatePage("#done");
    }
  } catch (error) {
    void error;
  }
});

// A copy loaded unpacked hands over to the Web Store copy (see content.js).
const RETIRED_KEY = "naiAutoSaver.retiredForStore";
async function retireIfDevCopy() {
  try {
    const self = await chrome.management.getSelf();
    if (self.installType !== "development") return false;
    const already = (await chrome.storage.local.get(RETIRED_KEY))[RETIRED_KEY];
    await chrome.storage.local.set({ [RETIRED_KEY]: { at: Date.now() } });
    if (!already) await chrome.tabs.create({ url: chrome.runtime.getURL("handoff.html") });
    return true;
  } catch (error) {
    return false;
  }
}

// The panel numbers a run from (1) again. If "이름 (1)" is already in that
// folder, keep counting after the highest number there ("이름 (6)") instead of
// letting Chrome make "이름 (1) (1)". Looks only at files Chrome still knows
// about; if it misses one, Chrome's own renaming is the fallback.
async function freeCounterName(folder, base) {
  const m = String(base).match(/^(.*?) \((\d+)\)$/);
  if (!m) return base;
  const stem = m[1];
  try {
    const items = await chrome.downloads.search({ query: [stem], exists: true, limit: 1000 });
    const tail = `/${folder}/`.replace(/\/+/g, "/");
    const used = new Set();
    for (const item of items) {
      const path = String(item.filename || "").replace(/\\/g, "/");
      const at = path.lastIndexOf("/");
      if (at < 0 || !path.slice(0, at + 1).endsWith(tail)) continue;
      const name = path.slice(at + 1).replace(/\.(png|webp)$/i, "");
      const hit = name.match(/^(.*?) \((\d+)\)(?: \(\d+\))*$/);
      if (hit && hit[1] === stem) used.add(Number(hit[2]));
    }
    if (!used.has(Number(m[2]))) return base;
    return `${stem} (${Math.max(...used) + 1})`;
  } catch (error) {
    return base;
  }
}

async function saveGeneratedImage(request) {
  if ((await chrome.storage.local.get(RETIRED_KEY))[RETIRED_KEY]) {
    return { ok: false, error: "스토어 버전으로 옮겨서 이 버전은 저장하지 않아요." };
  }
  const folder = sanitizeDownloadFolder(request.folder);
  const format = await resolveSaveFormat(request.format);
  const converted = await convertForSave(request.imageUrl, format);
  let base;
  if (request.fileName) {
    base = sanitizeFilenamePart(request.fileName);
  } else {
    const now = new Date();
    const stamp = [
      now.getFullYear(),
      String(now.getMonth() + 1).padStart(2, "0"),
      String(now.getDate()).padStart(2, "0"),
      String(now.getHours()).padStart(2, "0"),
      String(now.getMinutes()).padStart(2, "0"),
      String(now.getSeconds()).padStart(2, "0"),
    ].join("");
    base = `${stamp}_${sanitizeFilenamePart(request.promptText)}`;
  }
  base = await freeCounterName(folder, base);
  const filename = `${folder}/${base}.${converted.ext}`;
  const downloadId = await new Promise((resolve, reject) => {
    chrome.downloads.download({ url: converted.url, filename, saveAs: false }, (id) => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(id);
    });
  });
  if (converted.bytes) void indexSavedImage(converted.bytes, filename, downloadId);
  return { ok: true, downloadId, filename, format: converted.ext, warning: converted.warning || null };
}

// ---------------------------------------------------------------------------
// 보관함: every saved picture is indexed (metadata + thumbnail + real path)
// ---------------------------------------------------------------------------
function dataUrlToBytes(dataUrl) {
  const comma = dataUrl.indexOf(",");
  const binary = atob(dataUrl.slice(comma + 1));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// Chrome may rename the file ("a (1).png" -> "a (1) (1).png"); read back the
// real name and keep the part from the save folder on, e.g.
// "NovelAI/2026-10-22/김춘자/김춘자_교실 (3).png".
async function finalDownloadPath(downloadId, requested) {
  for (let i = 0; i < 120; i += 1) {
    const [item] = await chrome.downloads.search({ id: downloadId });
    if (!item) break;
    if (item.state === "complete" && item.filename) {
      const abs = item.filename.replace(/\\/g, "/");
      const first = requested.split("/")[0];
      const at = abs.lastIndexOf(`/${first}/`);
      return at >= 0 ? abs.slice(at + 1) : requested;
    }
    if (item.state === "interrupted") return null;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return requested;
}

async function indexSavedImage(bytes, requested, downloadId) {
  try {
    if (!globalThis.LibDB || !NAIMeta.imageType(bytes)) return;
    const savedAt = Date.now();
    const [path, meta] = await Promise.all([
      finalDownloadPath(downloadId, requested),
      NAIMeta.readFast(bytes),
    ]);
    if (!path) return;
    const entry = await LibDB.buildEntry({ path, bytes, meta, savedAt, downloadId, source: "saved" });
    await LibDB.put(entry);
    await autoSendToNotion(entry, bytes);
    chrome.runtime.sendMessage({ action: "libraryChanged", id: entry.id }).catch?.(() => {});
  } catch (error) {
    console.warn("library index failed", error);
  }
}

// 노션: send each newly saved picture when the user turned that on.
async function autoSendToNotion(entry, bytes) {
  try {
    if (!globalThis.NotionSync) return;
    const cfg = await NotionSync.getConfig();
    if (!cfg.autoSend || !cfg.token || !cfg.dataSourceId) return;
    if (!(await NotionSync.hasPermission())) {
      // used to stop here without a word
      await LibDB.setKv("notionLastError", { at: Date.now(), name: entry.name, message: "확장 프로그램의 노션 접속 허락이 꺼져 있어요. 보관함 → 노션 설정 → 「연결 확인」을 누르면 다시 허락할 수 있어요." });
      return;
    }
    let upload = bytes;
    let stripped = false;
    if (cfg.upload !== "original" && entry.hasMeta) {
      const result = await NAIMeta.strip(bytes);
      if (result.bytes) {
        upload = result.bytes;
        stripped = true;
      }
    }
    const page = await NotionSync.sendEntry(cfg, entry, upload, { metaStripped: stripped });
    // skipped: the same prompt is already in Notion; link to that page.
    entry.notion = { id: page.id, url: page.url, at: Date.now(), ...(page.skipped ? { samePrompt: true } : {}) };
    await LibDB.put(entry);
    await LibDB.setKv("notionLastOk", { at: Date.now(), name: entry.name, same: Boolean(page.skipped) });
  } catch (error) {
    console.warn("notion auto send failed", error);
    try {
      await LibDB.setKv("notionLastError", { at: Date.now(), message: String(error?.message || error), name: entry.name });
    } catch (e) {
      void e;
    }
  }
}

async function openLibraryTab(query, hash = "") {
  const url = chrome.runtime.getURL("library.html");
  const tabs = await chrome.tabs.query({ url });
  const target = hash ? `${url}#${hash}` : (query ? `${url}#q=${encodeURIComponent(query)}` : url);
  if (tabs[0]) {
    await chrome.tabs.update(tabs[0].id, { active: true, ...(query || hash ? { url: target } : {}) });
    await chrome.windows.update(tabs[0].windowId, { focused: true });
    return;
  }
  await chrome.tabs.create({ url: target });
}
