"use strict";

// Exercises the block editor against a real DOM to prove that the ";;" value
// carriers stay in sync in both directions.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { JSDOM } = require("jsdom");

const source = fs.readFileSync(path.join(__dirname, "..", "content.js"), "utf8");

function extractFunction(name) {
  const marker = `function ${name}(`;
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `${name} function should exist`);
  // Skip the parameter list first — default values like `options = {}` would
  // otherwise be mistaken for the function body.
  let parenDepth = 0;
  let cursor = source.indexOf("(", start);
  for (; cursor < source.length; cursor += 1) {
    if (source[cursor] === "(") parenDepth += 1;
    if (source[cursor] === ")") {
      parenDepth -= 1;
      if (parenDepth === 0) break;
    }
  }
  const braceStart = source.indexOf("{", cursor);
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

const dom = new JSDOM(`<!doctype html><html><body>
  <div id="host">
    <textarea class="p"></textarea>
    <textarea class="n"></textarea>
  </div>
</body></html>`);

const { window } = dom;
const context = {
  window,
  document: window.document,
  HTMLTextAreaElement: window.HTMLTextAreaElement,
  HTMLInputElement: window.HTMLInputElement,
  Event: window.Event,
  Element: window.Element,
  Object,
  String,
  Array,
  Math,
  Number,
  Boolean,
  console,
  icon: () => "",
};
vm.createContext(context);
vm.runInContext(
  `${extractFunction("splitCharacterBlocks")}
   ${extractFunction("charBlocksFromStrings")}
   ${extractFunction("charBlocksToStrings")}
   ${extractFunction("attachCharacterBlocks")}
   this.attachCharacterBlocks = attachCharacterBlocks;`,
  context,
);

const promptField = window.document.querySelector(".p");
const negField = window.document.querySelector(".n");

// Pre-existing legacy data must show up as blocks.
promptField.value = "1girl ;; 1boy";
negField.value = "bad hands ;; blurry";

let promptInputEvents = 0;
promptField.addEventListener("input", () => { promptInputEvents += 1; });

const api = context.attachCharacterBlocks(promptField, negField, { title: "캐릭터" });
assert.ok(api, "editor should attach");

const cards = () => Array.from(window.document.querySelectorAll(".ias-cb"));
const areas = (card) => Array.from(card.querySelectorAll("textarea"));

assert.equal(cards().length, 2, "legacy ';;' data should load as two blocks");
assert.equal(areas(cards()[0])[0].value, "1girl");
assert.equal(areas(cards()[0])[1].value, "bad hands");
assert.equal(areas(cards()[1])[0].value, "1boy");
assert.equal(areas(cards()[1])[1].value, "blurry");
assert.equal(promptField.hidden, true, "the ';;' carrier must be hidden");

// Typing in a block writes straight back into the carriers.
const secondPrompt = areas(cards()[1])[0];
secondPrompt.value = "1boy, blonde";
secondPrompt.dispatchEvent(new window.Event("input", { bubbles: true }));
assert.equal(promptField.value, "1girl ;; 1boy, blonde");
assert.ok(promptInputEvents > 0, "carrier must emit input so settings/queue persistence still fires");

// The + button adds one [prompt, negative] pair.
const addButton = window.document.querySelector(".ias-cb-add");
addButton.dispatchEvent(new window.Event("click", { bubbles: true }));
assert.equal(cards().length, 3);
assert.equal(promptField.value, "1girl ;; 1boy, blonde", "an empty trailing block must not add a separator");

areas(cards()[2])[0].value = "1other";
areas(cards()[2])[0].dispatchEvent(new window.Event("input", { bubbles: true }));
assert.equal(promptField.value, "1girl ;; 1boy, blonde ;; 1other");
assert.equal(negField.value, "bad hands ;; blurry");

// Reordering moves the prompt and its negative together.
cards()[2].querySelector('button[data-act="up"]').dispatchEvent(new window.Event("click", { bubbles: true }));
assert.equal(promptField.value, "1girl ;; 1other ;; 1boy, blonde");
assert.equal(negField.value, "bad hands ;;  ;; blurry");

// Removing a block removes both halves.
cards()[1].querySelector('button[data-act="remove"]').dispatchEvent(new window.Event("click", { bubbles: true }));
assert.equal(cards().length, 2);
assert.equal(promptField.value, "1girl ;; 1boy, blonde");
assert.equal(negField.value, "bad hands ;; blurry");

// Loading a memo / queue item assigns to the carrier: blocks must redraw.
promptField.value = "solo";
negField.value = "";
assert.equal(cards().length, 1, "assigning to the carrier must redraw the blocks");
assert.equal(areas(cards()[0])[0].value, "solo");
assert.equal(areas(cards()[0])[1].value, "");

// Clearing everything leaves no blocks and no stray separators.
promptField.value = "";
assert.equal(cards().length, 0);
assert.ok(window.document.querySelector(".ias-cb-empty"), "empty state should be shown");
assert.equal(promptField.value, "");
assert.equal(negField.value, "");

// A trailing block that only has a negative is dropped: NovelAI never creates a
// character with no prompt, so showing it would lie about what will run.
promptField.value = "A";
negField.value = "na";
assert.equal(cards().length, 1);
addButton.dispatchEvent(new window.Event("click", { bubbles: true }));
const orphan = areas(cards()[1])[1];
orphan.value = "nb";
orphan.dispatchEvent(new window.Event("input", { bubbles: true }));
assert.equal(promptField.value, "A");
assert.equal(negField.value, "na", "a negative with no prompt must not be stored as a phantom character");

// Negatives-only (no prompts at all) still means "use the current NovelAI
// characters, but replace their negatives".
promptField.value = "";
negField.value = "n1 ;; n2";
assert.equal(cards().length, 2);
assert.equal(promptField.value, "");
assert.equal(negField.value, "n1 ;; n2");

// Disabling propagates to the visible fields.
promptField.value = "1girl";
api.setDisabled(true);
assert.equal(areas(cards()[0])[0].disabled, true);
assert.equal(window.document.querySelector(".ias-cb-add").disabled, true);
api.setDisabled(false);
assert.equal(areas(cards()[0])[0].disabled, false);

console.log("character block tests passed");
