"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const contentPath = path.join(__dirname, "..", "content.js");
const source = fs.readFileSync(contentPath, "utf8");

function extractFunction(name) {
  const marker = `function ${name}(`;
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `${name} function should exist`);
  const braceStart = source.indexOf("{", start);
  let depth = 0;
  for (let i = braceStart; i < source.length; i += 1) {
    if (source[i] === "{") depth += 1;
    if (source[i] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`Could not extract ${name}`);
}

const item = {
  title: "대기열 1",
  basePrompt: "base",
  baseNegativePrompt: "old base negative",
  characterPrompt: "char",
  negativePrompt: "old character negative",
  count: 1,
};
let saveScheduled = 0;
const context = {
  getSelectedQueueItem: () => item,
  updateRowDisplay: () => {},
  ui: { queueCount: { textContent: "" } },
  queueCountText: () => "1개",
  renderControls: () => {},
  scheduleQueueSave: () => { saveScheduled += 1; },
  Number,
  Math,
};
vm.createContext(context);
vm.runInContext(`${extractFunction("handleEditorInput")}; this.handleEditorInput = handleEditorInput;`, context);

context.handleEditorInput({ target: { dataset: { field: "baseNegativePrompt" }, value: "saved base negative" } });
assert.equal(item.baseNegativePrompt, "saved base negative");
context.handleEditorInput({ target: { dataset: { field: "negativePrompt" }, value: "saved character negative" } });
assert.equal(item.negativePrompt, "saved character negative");
assert.equal(saveScheduled, 2, "both negative edits should schedule persistence");

assert.match(source, /actionSelect\.dataset\.role = "memo-actions"/);
assert.match(source, /loadGroup\.label = "불러오기"/);
assert.match(source, /manageGroup\.label = "관리"/);
assert.doesNotMatch(source, /actions\.className = "ias-memo-actions"/);

console.log("ui regression tests passed");
