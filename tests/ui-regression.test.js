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
// Character cards are REUSED, not nuked and recreated. Deleting every card on
// every queue item is what forced a full retype of every character prompt.
assert.ok(source.includes('await trimCharacterBoxesTo(targetCount, surface)'), 'surplus Character cards must be trimmed, not all of them');
assert.doesNotMatch(source, /const cleared = await resetCharacterBoxes\(surface\);/, 'a count change must not clear every Character card');
assert.ok(source.includes('await addMissingCharacterBoxes(segments, surface)'), 'only the shortfall may be added');
assert.ok(source.includes('handleMemoSavePress'), 'memo save must handle the first physical press');
assert.ok(source.includes('대기열 중단: ${error}'));

assert.ok(source.includes('surfaceIsOnscreen ? 1e15 : 0'), "rendered Character surface must outrank stale detached copies");
assert.ok(source.includes('findCharacterGenderOption("female")'), "new Character may use any visible gender seed option");
assert.doesNotMatch(source, /firstCharacterGenderMismatch\(segments, containers\)\s*>=\s*0/, "gender seed mismatch must not force a destructive reset");

// --- background tab must keep working ---------------------------------------
assert.doesNotMatch(
  source,
  /Math\.min\(rect\.right,\s*window\.innerWidth\)/,
  "surface scoring must not depend on the viewport (breaks scrolled/background tabs)",
);
assert.doesNotMatch(source, /document\.elementFromPoint\(/, "elementFromPoint returns null outside the viewport");
assert.ok(source.includes('startBackgroundKeepAlive()'), "runs must defeat Chrome background-tab timer throttling");
assert.ok(
  /await Promise\.race\(\[\s*new Promise\(\(resolve\) => requestAnimationFrame/.test(source),
  "awaited requestAnimationFrame must be raced with a timer (rAF never fires in a hidden tab)",
);
// A transient mismatch must be retried once before the run is stopped.
assert.ok(
  /setStatus\("캐릭터 카드를 다시 맞추는 중입니다…", "warn"\);\s*await delay\(700\);\s*layoutReady = await ensureCharacterCardLayout\(segments\);/.test(source),
  "a card-count mismatch must be retried before giving up",
);
assert.ok(
  source.includes("잘못된 캐릭터 구성으로는 생성하지 않습니다"),
  "after the retry, a real mismatch must still stop instead of generating wrong images",
);
// Character negatives must be cleared on cards this run owns, now that cards
// are reused between queue items instead of being recreated.
assert.ok(source.includes("const ownedCharacterSlots = applyCharacterPrompt != null"));
assert.ok(source.includes("async function applyCharacterNegativesToNovelAi(text, { slots = 0 } = {})"));
// Settings writes must be debounced: the block editor types into the carriers.
assert.ok(source.includes('el.addEventListener("change", scheduleSingleSettingsSave);'));
// The keep-alive tone must be derived from run state, not ref counted.
assert.ok(source.includes("function syncBackgroundKeepAlive()"));
assert.doesNotMatch(source, /keepAlive\.refs/, "ref counting never returned to zero across nested queue runs");

// --- one-shot prompt write ---------------------------------------------------
assert.ok(source.includes('execInsertText(tags.join(", "))'), "the prompt must be inserted in a single paste-like operation");

// --- character blocks <-> ';;' storage ---------------------------------------
const blocksContext = {
  console,
  String,
  Array,
  Math,
  Number,
};
vm.createContext(blocksContext);
vm.runInContext(
  `${extractFunction("splitCharacterBlocks")}
   ${extractFunction("charBlocksFromStrings")}
   ${extractFunction("charBlocksToStrings")}
   this.splitCharacterBlocks = splitCharacterBlocks;
   this.charBlocksFromStrings = charBlocksFromStrings;
   this.charBlocksToStrings = charBlocksToStrings;`,
  blocksContext,
);
const { charBlocksFromStrings, charBlocksToStrings, splitCharacterBlocks } = blocksContext;
// Values come back from the vm realm, so compare structurally.
const same = (actual, expected, message) => assert.equal(JSON.stringify(actual), JSON.stringify(expected), message);

// Legacy ";;" data must load into blocks unchanged and round-trip byte-identically.
const legacyPrompt = "1girl, black hair ;; 1boy, blonde";
const legacyNegative = "bad hands ;; blurry";
const loaded = charBlocksFromStrings(legacyPrompt, legacyNegative);
same(loaded, [
  { prompt: "1girl, black hair", negative: "bad hands" },
  { prompt: "1boy, blonde", negative: "blurry" },
]);
same(charBlocksToStrings(loaded), { prompt: legacyPrompt, negative: legacyNegative });

// A single character still stores as a plain string with no separator.
same(
  charBlocksToStrings([{ prompt: "1girl", negative: "bad hands" }]),
  { prompt: "1girl", negative: "bad hands" },
);

// Only the SECOND character has a negative: the empty leading slot must survive
// so the negative still lands on character 2 (this used to silently shift up).
const shifted = charBlocksToStrings([
  { prompt: "1girl", negative: "" },
  { prompt: "1boy", negative: "blurry" },
]);
same(shifted, { prompt: "1girl ;; 1boy", negative: " ;; blurry" });
same(splitCharacterBlocks(shifted.negative), ["", "blurry"]);

// No characters at all stores as empty strings, not as separators.
same(charBlocksToStrings([]), { prompt: "", negative: "" });
same(charBlocksToStrings([{ prompt: "", negative: "" }]), { prompt: "", negative: "" });

// Full-width separators from older data still parse.
same(splitCharacterBlocks("a ；； b"), ["a", "b"]);

// The block UI is wired into all three editors.
assert.ok(source.includes("ui.autoCharBlocks = attachCharacterBlocks(ui.autoCharInput, ui.autoCharNegInput"));
assert.ok(source.includes("ui.memoCharBlocks = attachCharacterBlocks(ui.memoCharInput, ui.memoCharNegInput"));
assert.ok(source.includes("attachCharacterBlocks(charInput, negInput"));

console.log("ui regression tests passed");
