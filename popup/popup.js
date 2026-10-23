"use strict";

function $(id) {
  return document.getElementById(id);
}

function runtimeSend(message) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(message, (response) => {
      void chrome.runtime.lastError;
      resolve(response || { ok: false });
    });
  });
}

function storageGet(keys) {
  return new Promise((resolve) => {
    chrome.storage.sync.get(keys, (result) => resolve(result || {}));
  });
}

function storageSet(values) {
  return new Promise((resolve) => {
    chrome.storage.sync.set(values, () => resolve());
  });
}

function setStatus(message, tone = "neutral") {
  const el = $("pageStatus");
  el.textContent = message || "";
  el.dataset.tone = tone;
}

async function init() {
  globalThis.NAIIcons?.hydrate();
  $("openLibraryBtn")?.addEventListener("click", async () => {
    await runtimeSend({ action: "openLibrary" });
    window.close();
  });
  const { appearance = "auto" } = await storageGet(["appearance"]);
  const dark = appearance === "dark" || (appearance !== "light" && window.matchMedia("(prefers-color-scheme: dark)").matches);
  document.body.dataset.theme = dark ? "dark" : "light";
  void showUpdate();
  const ping = await runtimeSend({ action: "ping" });
  const onNai = Boolean(ping?.ok);
  if (!onNai) {
    // Not on NovelAI: the main button takes you there instead of sitting disabled.
    setStatus("지금 탭은 NovelAI 이미지 페이지가 아니에요.");
    $("openPanelBtn").querySelector(".row-label").textContent = "NovelAI 열기";
  } else {
    setStatus("NovelAI 페이지와 연결됐어요.", "ok");
  }

  const { autoSaveEnabled = true } = await storageGet(["autoSaveEnabled"]);
  $("autoSaveCheckbox").checked = autoSaveEnabled !== false;

  $("openPanelBtn").addEventListener("click", async () => {
    if (onNai) await runtimeSend({ action: "openPanel" });
    else await chrome.tabs.create({ url: "https://novelai.net/image" });
    window.close();
  });

  $("autoSaveCheckbox").addEventListener("change", (event) => {
    void storageSet({ autoSaveEnabled: event.target.checked });
  });
}

// GitHub copies only: Chrome doesn't update those, so say when a new one is out.
async function showUpdate() {
  const info = await runtimeSend({ action: "updateStatus" });
  if (info?.store) {
    // The store copy updates by itself: offer that instead of GitHub updates.
    $("storeGroup").hidden = false;
    $("storeBtn").addEventListener("click", async () => {
      await runtimeSend({ action: "openUpdatePage" });
      window.close();
    });
    return;
  }
  if (!info?.available) return;
  $("updateTitle").textContent = `새 버전 ${info.latest}`;
  $("updateSub").textContent = `지금 ${info.current} · 눌러서 업데이트`;
  $("updateGroup").hidden = false;
  $("updateBtn").addEventListener("click", async () => {
    await runtimeSend({ action: "openUpdatePage" });
    window.close();
  });
}

document.addEventListener("DOMContentLoaded", init);
