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

const context = {
  MEMO_FIELDS: [
    { key: "basePrompt" },
    { key: "baseNegativePrompt" },
    { key: "characterPrompt" },
    { key: "characterNegativePrompt" },
  ],
  crypto: { randomUUID: () => "generated-id" },
  Date,
  Math,
  JSON,
  String,
  Number,
  Array,
  Object,
  memoState: {
    schemaVersion: 1,
    items: [{
      id: "memo-a",
      name: "세트 A",
      values: { basePrompt: "base", characterPrompt: "char" },
      createdAt: 1,
      updatedAt: 2,
    }],
  },
};
vm.createContext(context);
for (const name of [
  "createMemoId",
  "normalizeMemoItem",
  "normalizeMemoState",
  "createMemoExportEnvelope",
  "parseMemoImportText",
]) {
  vm.runInContext(`${extractFunction(name)}; this.${name} = ${name};`, context);
}

const envelope = context.createMemoExportEnvelope();
assert.equal(envelope.app, "NAI-Auto-Saver");
assert.equal(envelope.memoSchemaVersion, 1);
assert.equal(envelope.memos.items.length, 1);
assert.equal(envelope.memos.items[0].values.characterPrompt, "char");

const parsedEnvelope = context.parseMemoImportText(JSON.stringify(envelope));
assert.equal(parsedEnvelope.ok, true);
assert.equal(parsedEnvelope.state.items[0].name, "세트 A");

const parsedRaw = context.parseMemoImportText(JSON.stringify({
  schemaVersion: 1,
  items: [{ id: "memo-b", name: "B", values: { baseNegativePrompt: "bad" } }],
}));
assert.equal(parsedRaw.ok, true);
assert.equal(parsedRaw.state.items[0].values.baseNegativePrompt, "bad");

assert.equal(context.parseMemoImportText("not json").ok, false);
assert.equal(context.parseMemoImportText('{"app":"other","memos":{"items":[]}}').ok, false);
assert.equal(context.parseMemoImportText('{"app":"NAI-Auto-Saver"}').ok, false);

assert.doesNotMatch(source, /ias-memo-file-btn/);
assert.match(source, /action: "export", label: "내보내기"/);
assert.match(source, /action: "import", label: "가져오기"/);
assert.match(source, /class="ias-memo-import-file" type="file"/);
assert.match(source, /ui\.memoImportFile\?\.click\(\)/);
assert.match(source, /items: \[\s*\.\.\.parsed\.state\.items,\s*\.\.\.memoState\.items\.filter/);

console.log("memo transfer tests passed");
