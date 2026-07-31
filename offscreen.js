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

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request?.target !== "nai-offscreen-audio" || request?.action !== "playSound") {
    return false;
  }

  void playSound(request.filename, request.volume).then(sendResponse);
  return true;
});
