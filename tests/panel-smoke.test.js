"use strict";

// Boots the whole content script inside a fake NovelAI page and asserts the
// panel builds without throwing and that all three character block editors are
// wired up and round-trip through the ";;" carriers.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { JSDOM } = require("jsdom");

const root = path.join(__dirname, "..");
const storeSrc = fs.readFileSync(path.join(root, "queue-store.js"), "utf8");
const contentSrc = fs.readFileSync(path.join(root, "content.js"), "utf8");

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
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

window.eval(storeSrc);
window.eval(contentSrc);

const wait = () => new Promise((resolve) => setTimeout(resolve, 30));

(async () => {
  await wait();
  await wait();
  await wait();

  assert.deepEqual(errors, [], "content script must boot without throwing");

  const host = window.document.getElementById("nai-auto-saver-root")
    || Array.from(window.document.documentElement.children).find((el) => el.shadowRoot);
  assert.ok(host, "panel host should be attached");
  const shadow = host.shadowRoot;
  assert.ok(shadow, "panel should use a shadow root");

  // --- auto generate pane ---------------------------------------------------
  const autoPrompt = shadow.querySelector(".ias-auto-char");
  const autoNegative = shadow.querySelector(".ias-auto-char-neg");
  assert.ok(autoPrompt && autoNegative, "auto pane carriers should exist");
  assert.equal(autoPrompt.dataset.iasBlocks, "on", "auto pane should use the block editor");

  const autoBlocks = autoPrompt.parentElement.querySelector(".ias-charblocks");
  assert.ok(autoBlocks, "auto pane block editor should be rendered");
  assert.ok(autoBlocks.querySelector(".ias-cb-add"), "auto pane should have a + button");
  assert.equal(autoBlocks.querySelectorAll(".ias-cb").length, 0, "no characters by default");

  autoBlocks.querySelector(".ias-cb-add").dispatchEvent(new window.Event("click", { bubbles: true }));
  autoBlocks.querySelector(".ias-cb-add").dispatchEvent(new window.Event("click", { bubbles: true }));
  assert.equal(autoBlocks.querySelectorAll(".ias-cb").length, 2, "+ should add character blocks");

  const [first, second] = Array.from(autoBlocks.querySelectorAll(".ias-cb"));
  const type = (card, index, value) => {
    const area = card.querySelectorAll("textarea")[index];
    area.value = value;
    area.dispatchEvent(new window.Event("input", { bubbles: true }));
  };
  type(first, 0, "1girl, black hair");
  type(first, 1, "bad hands");
  type(second, 0, "1boy, blonde");
  type(second, 1, "blurry");

  assert.equal(autoPrompt.value, "1girl, black hair ;; 1boy, blonde");
  assert.equal(autoNegative.value, "bad hands ;; blurry");
  await new Promise((resolve) => setTimeout(resolve, 700)); // settings saves are debounced
  assert.equal(storage.sync.autoChar, "1girl, black hair ;; 1boy, blonde", "blocks must persist to settings");
  assert.equal(storage.sync.autoCharNeg, "bad hands ;; blurry");

  // --- memo pane ------------------------------------------------------------
  const memoPrompt = shadow.querySelector(".ias-memo-char");
  const memoNegative = shadow.querySelector(".ias-memo-char-neg");
  assert.equal(memoPrompt.dataset.iasBlocks, "on", "memo pane should use the block editor");
  const memoBlocks = memoPrompt.parentElement.querySelector(".ias-charblocks");
  assert.ok(memoBlocks, "memo block editor should be rendered");

  // "자동생성 값 가져오기" assigns to the carriers; the blocks must redraw.
  shadow.querySelector(".ias-memo-copy-auto").dispatchEvent(new window.Event("click", { bubbles: true }));
  await wait();
  assert.equal(memoPrompt.value, "1girl, black hair ;; 1boy, blonde");
  assert.equal(
    memoBlocks.querySelectorAll(".ias-cb").length,
    2,
    "copying auto values into the memo must redraw the memo blocks",
  );

  // --- queue item editor ----------------------------------------------------
  shadow.querySelector(".ias-queue-add").dispatchEvent(new window.Event("click", { bubbles: true }));
  await wait();
  await wait();
  const queuePrompt = shadow.querySelector('.ias-qeditor textarea[data-field="characterPrompt"]')
    || shadow.querySelector('textarea[data-field="characterPrompt"]');
  assert.ok(queuePrompt, "queue editor should render a characterPrompt carrier");
  assert.equal(queuePrompt.dataset.iasBlocks, "on", "queue editor should use the block editor");
  const queueBlocks = queuePrompt.parentElement.querySelector(".ias-charblocks");
  assert.ok(queueBlocks, "queue block editor should be rendered");
  // The fake page has no NovelAI character cards, so the new item starts empty.
  assert.equal(queueBlocks.querySelectorAll(".ias-cb").length, 0);

  // Editing queue blocks must reach the stored queue item.
  queueBlocks.querySelector(".ias-cb-add").dispatchEvent(new window.Event("click", { bubbles: true }));
  queueBlocks.querySelector(".ias-cb-add").dispatchEvent(new window.Event("click", { bubbles: true }));
  const queueCards = Array.from(queueBlocks.querySelectorAll(".ias-cb"));
  assert.equal(queueCards.length, 2, "+ should add character blocks in the queue editor");
  type(queueCards[0], 0, "1girl, black hair");
  type(queueCards[0], 1, "bad hands");
  type(queueCards[1], 0, "1boy, red hair");
  type(queueCards[1], 1, "blurry");
  await wait();
  await wait();
  await wait();
  const stored = storage.local["naiAutoSaver.queue"];
  assert.ok(stored, "queue should persist");
  assert.equal(stored.items[0].characterPrompt, "1girl, black hair ;; 1boy, red hair");
  assert.equal(stored.items[0].negativePrompt, "bad hands ;; blurry");

  assert.deepEqual(errors, [], "no errors should be raised while editing");

  // --- background keep-alive toggle ----------------------------------------
  const keepAlive = shadow.querySelector(".ias-bg-keepalive");
  assert.ok(keepAlive, "background keep-alive toggle should exist");
  assert.equal(keepAlive.checked, true, "background keep-alive should default to on");

  console.log("panel smoke tests passed");
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
