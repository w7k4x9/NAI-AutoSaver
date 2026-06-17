"use strict";

const assert = require("node:assert/strict");
const Store = require("../queue-store");

// --- createItem with separate base / character prompts ---
const item = Store.createItem({
  title: "  1_b_c  ",
  basePrompt: "masterpiece, best quality",
  characterPrompt: "girl, black hair, long hair",
  count: "88",
});
assert.equal(item.title, "1_b_c");
assert.equal(item.count, 88);
assert.equal(item.basePrompt, "masterpiece, best quality");
assert.equal(item.characterPrompt, "girl, black hair, long hair");
assert.ok(item.id);

// --- normalizeCount / normalizeTitle ---
assert.equal(Store.normalizeCount(0), 1);
assert.equal(Store.normalizeCount("5"), 5);
assert.equal(Store.normalizeCount(99999), 9999);
assert.equal(Store.normalizeTitle("   "), "무제");

// --- buildCombinedPrompt: NovelAI "|" routing ---
assert.equal(
  Store.buildCombinedPrompt("2girls, outdoors", "girl, black hair"),
  "2girls, outdoors | girl, black hair"
);
assert.equal(Store.buildCombinedPrompt("scene only", ""), "scene only");
assert.equal(Store.buildCombinedPrompt("", "girl, black hair"), "| girl, black hair");
assert.equal(
  Store.buildCombinedPrompt("base", "girl, red hair | boy, blue hair"),
  "base | girl, red hair | boy, blue hair"
);

// --- v2 -> v3 migration: legacy `prompt` becomes basePrompt ---
const migrated = Store.normalizeItem({ title: "old", prompt: "1girl", count: 3 });
assert.equal(migrated.basePrompt, "1girl");
assert.equal(migrated.characterPrompt, "");
assert.equal(migrated.count, 3);

// --- normalizeState filters junk, keeps character-only items ---
const state = Store.normalizeState({
  items: [
    item,
    { junk: true },
    { title: "B", count: 2, basePrompt: "", characterPrompt: "" },
    { characterPrompt: "boy, pink hair, short hair", count: 1 },
  ],
  options: { loop: 1 },
});
assert.equal(state.items.length, 3);
assert.equal(state.schemaVersion, 3);
assert.equal(state.items[1].title, "B");
assert.equal(state.items[2].characterPrompt, "boy, pink hair, short hair");
assert.equal(state.options.loop, true);

// --- export / import round trip ---
const env = Store.createExportEnvelope(state);
const parsed = Store.parseExportEnvelope(JSON.stringify(env));
assert.equal(parsed.ok, true);
assert.equal(parsed.queue.items.length, 3);
assert.equal(parsed.queue.items[0].characterPrompt, "girl, black hair, long hair");
assert.equal(Store.parseExportEnvelope("{}").ok, false);
assert.equal(Store.parseExportEnvelope('{"app":"other"}').ok, false);

// --- filename sanitisation ---
assert.equal(Store.sanitizeFileName('1_b_c (3)'), "1_b_c (3)");
assert.equal(Store.sanitizeFileName('a/b:c*?'), "a_b_c__");
assert.equal(Store.sanitizeFileName(""), "image");

// --- applyNamePattern ---
assert.equal(Store.applyNamePattern("char_{n}", 0), "char_1");
assert.equal(Store.applyNamePattern("char_{nn}", 4), "char_05");
assert.equal(Store.applyNamePattern("v{nnn}_pose", 9), "v010_pose");
assert.equal(Store.applyNamePattern("", 3), "");
assert.equal(Store.applyNamePattern("{n}_{nn}", 0), "1_01");

// --- effectiveBase: global base overrides item base when enabled ---
assert.equal(
  Store.effectiveBase({ basePrompt: "item base" }, { useGlobalBase: true, globalBase: "shared base" }),
  "shared base"
);
assert.equal(
  Store.effectiveBase({ basePrompt: "item base" }, { useGlobalBase: false, globalBase: "shared base" }),
  "item base"
);
assert.equal(
  Store.effectiveBase({ basePrompt: "item base" }, { useGlobalBase: true, globalBase: "   " }),
  "item base"
);

// --- options normalization round trip ---
const optState = Store.normalizeState({
  items: [{ title: "a", basePrompt: "x", count: 1 }],
  options: { loop: true, useGlobalBase: 1, globalBase: "g", namePattern: "p_{n}" },
});
assert.equal(optState.options.loop, true);
assert.equal(optState.options.useGlobalBase, true);
assert.equal(optState.options.globalBase, "g");
assert.equal(optState.options.namePattern, "p_{n}");

console.log("queue-store tests passed");
