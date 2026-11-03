"use strict";

const activeAudio = new Set();

function playSound(filename, volume) {
  return new Promise((resolve) => {
    const allowedFiles = new Set(["start.mp3", "stop.mp3"]);
    if (!allowedFiles.has(filename)) {
      resolve({ ok: false, error: "Unsupported sound file." });
      return;
    }

    const numericVolume = Number(volume);
    const safeVolume = Number.isFinite(numericVolume)
      ? Math.max(0, Math.min(1, numericVolume))
      : 0.5;
    const audio = new Audio(chrome.runtime.getURL(`assets/${filename}`));
    audio.volume = safeVolume;
    activeAudio.add(audio);

    const cleanup = () => {
      activeAudio.delete(audio);
      audio.removeEventListener("ended", cleanup);
      audio.removeEventListener("error", cleanup);
    };

    audio.addEventListener("ended", cleanup, { once: true });
    audio.addEventListener("error", cleanup, { once: true });

    audio.play().then(
      () => resolve({ ok: true }),
      (error) => {
        cleanup();
        resolve({ ok: false, error: String(error?.message || error) });
      },
    );
  });
}

// Saved pictures: a short blob: URL for chrome.downloads instead of a data:
// URL. Chrome keeps every download's URL in its download list (and history),
// so multi-MB data: URLs made Chrome slow and then freeze after many saves.
const blobUrls = new Map(); // url → time made
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request?.target !== "nai-offscreen-blob") return false;
  if (request.action === "makeBlobUrl") {
    fetch(request.dataUrl).then((r) => r.blob()).then((blob) => {
      const url = URL.createObjectURL(blob);
      blobUrls.set(url, Date.now());
      sendResponse({ ok: true, url });
    }, (error) => sendResponse({ ok: false, error: String(error?.message || error) }));
    return true;
  }
  if (request.action === "revokeBlobUrl") {
    if (blobUrls.has(request.url)) {
      URL.revokeObjectURL(request.url);
      blobUrls.delete(request.url);
    }
    sendResponse({ ok: true });
    return false;
  }
  return false;
});
// anything left over (a download that never finished) goes after 10 minutes
setInterval(() => {
  const old = Date.now() - 600000;
  for (const [url, at] of blobUrls) if (at < old) { URL.revokeObjectURL(url); blobUrls.delete(url); }
}, 60000);

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request?.target !== "nai-offscreen-audio" || request?.action !== "playSound") {
    return false;
  }

  void playSound(request.filename, request.volume).then(sendResponse);
  return true;
});
