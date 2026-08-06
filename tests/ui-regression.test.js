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

assert.match(source, /moreButton\.className = "ias-memo-more"/);
assert.match(source, /menu\.className = "ias-memo-menu"/);
assert.match(source, /-webkit-backdrop-filter: blur\(26px\) saturate\(185%\)/);
assert.match(source, /menuButton\.dataset\.action = config\.action/);
assert.doesNotMatch(source, /actionSelect\.dataset\.role = "memo-actions"/);
assert.ok(source.includes(`querySelectorAll('.character-prompt-input,[class*="character-prompt-input-"]')`));
assert.ok(source.includes("child.matches?.('.sc-7d0727b8-33')"), 'trash must use the user-confirmed direct-child -33 icon');
assert.ok(source.includes('width >= 15 && width <= 17.5'), 'trash selector must reject nested 14px Position icons');
assert.ok(source.includes('clickControlLikeUser(button);'));
assert.ok(source.includes('currentCount !== targetCount'), 'count changes must rebuild all Character cards');
assert.ok(source.includes('await resetCharacterBoxes(surface);'), 'rebuild must clear all Character cards first');
assert.ok(source.includes('handleMemoSavePress'), 'memo save must handle the first physical press');
assert.ok(source.includes('대기열 중단: ${error}'));

assert.ok(source.includes('surfaceIsOnscreen ? 1e15 : 0'), "visible Character surface must outrank stale off-screen copies");
assert.ok(source.includes('findCharacterGenderOption("female")'), "new Character may use any visible gender seed option");
assert.doesNotMatch(source, /firstCharacterGenderMismatch\(segments, containers\)\s*>=\s*0/, "gender seed mismatch must not force a destructive reset");

console.log("ui regression tests passed");
