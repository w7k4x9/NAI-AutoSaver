// 내 점수 학습: runs taste.js off the page's main thread (it takes a while).
/* global Taste */
"use strict";
importScripts("taste.js");
self.onmessage = ({ data }) => {
  try {
    const result = Taste.train(data.groups, { onProgress: (p) => self.postMessage({ type: "progress", p }) });
    self.postMessage({ type: "done", result });
  } catch (error) {
    self.postMessage({ type: "error", error: String(error?.message || error) });
  }
};
