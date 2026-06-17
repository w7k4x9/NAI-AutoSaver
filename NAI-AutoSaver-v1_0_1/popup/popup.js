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
  const ping = await runtimeSend({ action: "ping" });
  if (!ping?.ok) {
    setStatus("NovelAI 이미지 페이지에서만 사용 가능합니다.", "warn");
    $("openPanelBtn").disabled = true;
  } else {
    setStatus("NovelAI 페이지와 연결되었습니다.", "ok");
  }

  const { autoSaveEnabled = true } = await storageGet(["autoSaveEnabled"]);
  $("autoSaveCheckbox").checked = autoSaveEnabled !== false;

  $("openPanelBtn").addEventListener("click", async () => {
    await runtimeSend({ action: "openPanel" });
    window.close();
  });

  $("autoSaveCheckbox").addEventListener("change", (event) => {
    void storageSet({ autoSaveEnabled: event.target.checked });
  });
}

document.addEventListener("DOMContentLoaded", init);
