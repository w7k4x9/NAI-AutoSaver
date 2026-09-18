"use strict";

// 1) ";;" typed inside a block splits it into characters; text mode edits the
//    raw ";;" carriers. 2) Add-Character / trash lookup against the current
//    NovelAI markup (build abddd3b: icon-only "+", sc-e95dc911-33 14px trash).

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { JSDOM } = require("jsdom");

const source = fs.readFileSync(path.join(__dirname, "..", "content.js"), "utf8");

function extractFunction(name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} should exist`);
  let paren = 0;
  let cursor = source.indexOf("(", start);
  for (; cursor < source.length; cursor += 1) {
    if (source[cursor] === "(") paren += 1;
    if (source[cursor] === ")" && --paren === 0) break;
  }
  const braceStart = source.indexOf("{", cursor);
  let depth = 0;
  for (let i = braceStart; i < source.length; i += 1) {
    if (source[i] === "{") depth += 1;
    if (source[i] === "}" && --depth === 0) return source.slice(start, i + 1);
  }
  throw new Error(name);
}

// ---------------------------------------------------------------- blocks ---
{
  const dom = new JSDOM(`<!doctype html><body><div id="h"><textarea class="p"></textarea><textarea class="n"></textarea></div></body>`);
  const { window } = dom;
  const ctx = {
    window, document: window.document, HTMLTextAreaElement: window.HTMLTextAreaElement,
    HTMLInputElement: window.HTMLInputElement, Event: window.Event, Element: window.Element,
    Object, String, Array, Math, Number, Boolean, console, icon: () => "",
  };
  vm.createContext(ctx);
  vm.runInContext(`${extractFunction("splitCharacterBlocks")}
    ${extractFunction("charBlocksFromStrings")}
    ${extractFunction("charBlocksToStrings")}
    ${extractFunction("attachCharacterBlocks")}
    this.attach = attachCharacterBlocks;`, ctx);
  const p = window.document.querySelector(".p");
  const n = window.document.querySelector(".n");
  let modeSeen = null;
  const api = ctx.attach(p, n, { onModeChange: (m) => { modeSeen = m; } });
  const root = api.root;
  root.querySelector(".ias-cb-add").dispatchEvent(new window.Event("click", { bubbles: true }));
  const area = root.querySelector(".ias-cb textarea");
  area.value = "1girl, black hair ;; 1boy ;; ";
  area.dispatchEvent(new window.Event("input", { bubbles: true }));
  assert.equal(root.querySelectorAll(".ias-cb").length, 3, ";; inside a block must split it");
  assert.equal(p.value, "1girl, black hair ;; 1boy");

  // Switch to text mode: carriers become visible and editable directly.
  assert.ok(root.querySelector(".ias-cb-group .ias-cb-add"), "+ lives INSIDE the character block");
  assert.equal(root.querySelectorAll(".ias-cb-group").length, 1, "one block holds every character of the picture");
  api.setMode("text");
  void modeSeen;
  assert.equal(api.getMode(), "text");
  assert.equal(p.hidden, false);
  assert.equal(root.querySelector(".ias-cb-group").style.display, "none");
  // User types directly (no value setter involved in a real browser).
  Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set.call(p, "a ;; b ;; c ;; d");
  api.setMode("blocks");
  assert.equal(root.querySelectorAll(".ias-cb").length, 4, "text typed in ;; mode must show up as blocks");
  assert.equal(p.hidden, true);
}

// ------------------------------------------------------------ NovelAI DOM ---
{
  const card = (i) => `
    <div class="character-prompt-input character-prompt-input-${i}">
      <div class="sc-66af9d76-0"><div><div class="sc-e95dc911-1 sc-e95dc911-164"></div><input placeholder="Character ${i}"></div>
        <div class="sc-e5d0ae9d-0">
          <button disabled><div class="sc-e95dc911-1 sc-e95dc911-9"></div></button>
          <button disabled><div class="sc-e95dc911-1 sc-e95dc911-8"></div></button>
          <button id="c${i}-17"><div class="sc-e95dc911-1 sc-e95dc911-17" style="height:14px;width:14px"></div></button>
          <button id="c${i}-33"><div class="sc-e95dc911-1 sc-e95dc911-33" style="height:14px;width:14px"></div></button>
          <button id="c${i}-132"><div class="sc-e95dc911-1 sc-e95dc911-132" style="height:14px;width:14px"></div></button>
        </div></div>
      <div><div><button>Prompt</button><button>Undesired Content</button></div>
        <div class="prompt-input-box-character-prompts-${i}"><div contenteditable="true" class="ProseMirror"><p>x</p></div></div></div>
    </div>`;
  const section = (extra = "") => `
    <div class="image-gen-character-prompts ${extra}">
      <div class="image-gen-character-prompts-header">
        <div class="row1"><div class="t"><div style="min-width:0"><div>Character Prompts</div><div>Create a separate prompt for characters in your scene.</div></div></div>
          <span style="display:flex"><div><button id="plus${extra}"><div class="sc-e95dc911-1 sc-e95dc911-31" style="height:16px;width:16px"></div></button></div></span></div>
        <div class="row2"><span>Position</span><div><button>AI’s Choice</button></div><div><button>Custom</button><button id="pos${extra}"><div class="sc-e95dc911-1 sc-e95dc911-123"></div></button></div></div>
      </div>
      ${card(1)}${card(2)}
    </div>`;
  const dom = new JSDOM(`<!doctype html><body>
    <div class="image-gen-prompt-main"><div contenteditable="true"></div></div>
    ${section()}
    <div class="image-gen-mobile-sheet">${section("m")}</div>
    <div id="nai-auto-saver-host"></div></body>`, { pretendToBeVisual: true });
  const { window } = dom;
  // jsdom has no layout: give every element a box, rows stacked by DOM order.
  let y = 0;
  const tops = new WeakMap();
  window.Element.prototype.getBoundingClientRect = function () {
    if (!tops.has(this)) tops.set(this, (y += 5));
    const top = this.closest(".row2") ? 500 : tops.get(this);
    return { top, bottom: top + 20, left: 10, right: 110, width: 100, height: 20 };
  };
  const ctx = {
    window, document: window.document, Element: window.Element, Node: window.Node,
    getComputedStyle: (el) => window.getComputedStyle(el),
    HOST_ID: "nai-auto-saver-host", Array, Number, String, Boolean, Math, Set, Map,
  };
  vm.createContext(ctx);
  vm.runInContext(["isVisible", "isRenderedControl", "accessibleControlText", "ownControlText",
    "characterSectionsOnPage", "findAddCharacterButton", "exactCharacterTrashButton"]
    .map(extractFunction).join("\n") + `
    this.findAdd = findAddCharacterButton; this.trash = exactCharacterTrashButton;`, ctx);

  const plus = ctx.findAdd();
  assert.ok(plus, "icon-only + must be found outside .image-gen-prompt-main");
  assert.equal(plus.id, "plus", "must pick the desktop + in the title row, not Position controls");
  const mobileSection = window.document.querySelector(".image-gen-character-prompts.m");
  assert.equal(ctx.findAdd(mobileSection.querySelector(".character-prompt-input-1")).id, "plusm",
    "a given surface must use its own + button");

  const cards = window.document.querySelectorAll(".image-gen-character-prompts:not(.m) .character-prompt-input");
  assert.equal(ctx.trash(cards[1]).id, "c2-33", "14px sc-e95dc911-33 must be the trash");
}

console.log("semicolon + NovelAI DOM tests passed");

// ------------------------------------------------------- combo generator ---
{
  const ctx = { Store: { createItem: (x) => x }, Math, Array, String, Number, console };
  vm.createContext(ctx);
  vm.runInContext(["stripLeadingNumber", "parseExpressionSet", "genCharacterMembers", "genEmotionCount",
    "genMemberExpression", "joinCharacterColumn", "ensureTrailingComma", "buildGenItems"].map(extractFunction).join("\n")
    + "; this.build = buildGenItems;", ctx);
  ctx.collectGenRaw = () => ({
    base: "B", baseNeg: "", count: "1",
    chars: [
      { code: "wk", appearance: "girl, black hair", expressions: "1 smiling\n2 angry", negative: "bad hands",
        members: [{ appearance: "boy, white hair", expressions: "smirk", negative: "" }] },
      { code: "old", appearance: "girl ;; boy", expressions: "1 happy ;; sad", negative: ";; beard", members: [] },
    ],
    bgs: [{ code: "h", tags: "school", negative: "crowd" }],
  });
  const { items } = ctx.build();
  assert.equal(items.length, 3);
  assert.equal(items[0].title, "wk_h_1");
  assert.equal(items[0].characterPrompt, "girl, black hair,\nsmiling,\nschool, ;; boy, white hair,\nsmirk,");
  assert.equal(items[0].negativePrompt, "bad hands, crowd");
  assert.match(items[1].characterPrompt, /angry.*;; boy, white hair,\nsmirk,/s, "a one-line member expression is fixed for all emotions");
  assert.equal(items[2].characterPrompt, "girl,\nhappy,\nschool, ;; boy,\nsad,");
  assert.equal(items[2].negativePrompt, "crowd ;; beard");
}
console.log("combo multi-person tests passed");
