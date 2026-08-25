"use strict";

// Boots key-shield.js + the content script in a fake NovelAI page that installs
// NovelAI-style global shortcut handlers, then proves:
//   1. keys typed inside the panel never reach those handlers,
//   2. the shield never cancels the keystroke (typing still works),
//   3. keys pressed on the page still reach NovelAI,
//   4. the queue's shared Base negative exists and round-trips.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { JSDOM } = require("jsdom");

const root = path.join(__dirname, "..");
const shieldSrc = fs.readFileSync(path.join(root, "key-shield.js"), "utf8");
const storeSrc = fs.readFileSync(path.join(root, "queue-store.js"), "utf8");
const contentSrc = fs.readFileSync(path.join(root, "content.js"), "utf8");

const dom = new JSDOM("<!doctype html><html><body><div id=\"nai-canvas\"></div></body></html>", {
  url: "https://novelai.net/image",
  runScripts: "outside-only",
  pretendToBeVisual: true,
});
const { window } = dom;

const errors = [];
window.addEventListener("error", (event) => errors.push(event.error || event.message));

const storage = { sync: {}, local: {} };
const makeArea = (name) => ({
  get(keys, cb) {
    const out = {};
    const list = Array.isArray(keys) ? keys : (keys == null ? Object.keys(storage[name]) : [keys]);
    for (const key of list) {
      if (key in storage[name]) out[key] = storage[name][key];
    }
    cb(out);
  },
  set(values, cb) {
    Object.assign(storage[name], values);
    if (cb) cb();
  },
  remove(keys, cb) {
    for (const key of [].concat(keys)) delete storage[name][key];
    if (cb) cb();
  },
});
window.chrome = {
  runtime: {
    lastError: null,
    id: "test",
    getURL: (p) => `chrome-extension://test/${p}`,
    sendMessage: (_msg, cb) => { if (cb) cb({ ok: true }); },
    onMessage: { addListener: () => {} },
  },
  storage: { sync: makeArea("sync"), local: makeArea("local"), onChanged: { addListener: () => {} } },
};
window.AudioContext = class {
  createOscillator() {
    return { type: "", frequency: { value: 0 }, connect() {}, start() {}, stop() {}, disconnect() {} };
  }
  createGain() { return { gain: { value: 0 }, connect() {}, disconnect() {} }; }
  resume() { return Promise.resolve(); }
  close() { return Promise.resolve(); }
};

// document_start: the shield goes in before any page script.
window.eval(shieldSrc);

// NovelAI's shortcut handlers, in the two shapes a SPA usually registers them.
// Both guard on event.target, which shadow-DOM retargeting turns into the panel
// host element -- the exact reason typing used to pan the canvas.
const naiHits = [];
function naiShortcut(source) {
  return (event) => {
    const tag = event.target && event.target.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA") {
      return;
    }
    if (["w", "a", "s", "d", "ArrowUp", "ArrowDown", "-", "_"].includes(event.key)) {
      naiHits.push(`${source}:${event.key}`);
      event.preventDefault();
    }
  };
}
window.addEventListener("keydown", naiShortcut("window-capture"), true);
window.addEventListener("keydown", naiShortcut("window-bubble"), false);
window.document.addEventListener("keydown", naiShortcut("document-bubble"), false);

window.eval(storeSrc);
window.eval(contentSrc);

const wait = () => new Promise((resolve) => setTimeout(resolve, 30));

function press(target, key) {
  const event = new window.KeyboardEvent("keydown", {
    key,
    bubbles: true,
    cancelable: true,
    composed: true,
  });
  target.dispatchEvent(event);
  return event;
}

(async () => {
  await wait();
  await wait();
  await wait();

  assert.deepEqual(errors, [], "content script must boot without throwing");

  const host = window.document.getElementById("nai-auto-saver-host");
  assert.ok(host && host.shadowRoot, "panel host should be attached");
  const shadow = host.shadowRoot;

  // --- 1. panel keys are invisible to NovelAI -------------------------------
  const saveName = shadow.querySelector(".ias-save-name");
  assert.ok(saveName, "save-name field should exist");

  for (const key of ["a", "s", "d", "w", "_", "-", "ArrowUp", "ArrowDown"]) {
    const event = press(saveName, key);
    assert.equal(
      event.defaultPrevented,
      false,
      `"${key}" typed in the panel must not be cancelled, or the character never appears`,
    );
  }
  assert.deepEqual(naiHits, [], "no key typed inside the panel may reach NovelAI's shortcuts");

  // A COLLAPSED panel shields only its own text fields, so tapping the floating
  // button never swallows NovelAI's canvas shortcuts afterwards.
  press(shadow.querySelector(".ias-fab"), "w");
  assert.ok(naiHits.length > 0, "a collapsed panel must not swallow page shortcuts");
  naiHits.length = 0;

  // An OPEN panel owns every key pressed inside it: clicking a panel button and
  // then pressing W must not pan the canvas.
  window.__NAI_AUTOSAVER_KEY_SHIELD__.setPanelOpen(true);
  press(shadow.querySelector(".ias-queue-add"), "w");
  assert.deepEqual(naiHits, [], "an open panel owns every key pressed inside it");

  // --- 2. the page itself keeps its shortcuts -------------------------------
  press(window.document.getElementById("nai-canvas"), "w");
  assert.ok(naiHits.length > 0, "keys pressed outside the panel must still reach NovelAI");

  // --- 3. panel-owned shortcuts still fire ----------------------------------
  const bulk = shadow.querySelector(".ias-bulk-count");
  assert.ok(bulk, "bulk count field should exist");
  bulk.value = "7";
  const enter = press(bulk, "Enter");
  assert.equal(enter.defaultPrevented, true, "Enter in the bulk-count field is handled by the panel");

  // --- 4. shared Base negative ---------------------------------------------
  const globalNeg = shadow.querySelector(".ias-global-base-neg");
  assert.ok(globalNeg, "the shared Base section must have a negative field");
  const toggle = shadow.querySelector(".ias-global-base-toggle");
  toggle.checked = true;
  toggle.dispatchEvent(new window.Event("change", { bubbles: true }));
  globalNeg.value = "lowres, bad anatomy";
  globalNeg.dispatchEvent(new window.Event("input", { bubbles: true }));
  await new Promise((resolve) => setTimeout(resolve, 600));

  const stored = storage.local["naiAutoSaver.queue"];
  assert.ok(stored, "queue state should persist");
  assert.equal(
    stored.options.globalBaseNegative,
    "lowres, bad anatomy",
    "the shared Base negative must survive normalization and persistence",
  );

  const Store = window.NAIQueueStore;
  assert.equal(
    Store.effectiveBaseNegative({ baseNegativePrompt: "item neg" }, stored.options),
    "lowres, bad anatomy",
    "the shared negative wins while the shared-Base switch is on",
  );
  assert.equal(
    Store.effectiveBaseNegative({ baseNegativePrompt: "item neg" }, { useGlobalBase: true, globalBaseNegative: "  " }),
    "item neg",
    "an empty shared negative must fall back to the item's own value",
  );

  assert.deepEqual(errors, [], "no errors should be raised");
  console.log("key shield tests passed");
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
