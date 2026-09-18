"use strict";

// NovelAI (build abddd3b) collapses every character card but the selected one:
// editors sit in a display:none wrapper and a preview <button> (direct child of
// the card) expands it. Both characters must be written.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { JSDOM } = require("jsdom");

const source = fs.readFileSync(path.join(__dirname, "..", "content.js"), "utf8");
function extractFunction(name) {
  let start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, name);
  if (source.slice(start - 6, start) === "async ") start -= 6;
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

const card = (i, open, text) => `
<div class="character-prompt-input character-prompt-input-${i}">
  <div class="head"><input placeholder="Character ${i}">
    <div><button><div class="sc-e95dc911-1 sc-e95dc911-33" style="height:14px;width:14px"></div></button></div></div>
  <div class="body" style="${open ? "" : "display: none;"}">
    <div><button>Prompt</button><button>Undesired Content</button></div>
    <div class="prompt-input-box-character-prompts-${i}"><div contenteditable="true" class="ProseMirror"><p>${text}</p></div></div>
  </div>
  ${open ? "" : `<button class="preview"><div><span>${text}</span></div></button>`}
</div>`;

const dom = new JSDOM(`<!doctype html><body><div class="image-gen-character-prompts">
  ${card(1, false, "girl, ")}${card(2, true, "girl, pink hair")}
</div></body>`, { pretendToBeVisual: true });
const { window } = dom;
const doc = window.document;
const hidden = (el) => {
  for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
    if (n.style && n.style.display === "none") return true;
  }
  return false;
};
window.Element.prototype.getBoundingClientRect = function () {
  if (hidden(this)) return { top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0 };
  return { top: 10, bottom: 40, left: 10, right: 300, width: 290, height: 30 };
};
window.Element.prototype.scrollIntoView = () => {};
// jsdom does not implement isContentEditable.
Object.defineProperty(window.HTMLElement.prototype, "isContentEditable", {
  get() { return this.getAttribute("contenteditable") === "true"; },
});

// Emulate NovelAI: clicking a preview expands that card and collapses others.
const setOpen = (target) => {
  for (const c of doc.querySelectorAll(".character-prompt-input")) {
    const open = c === target;
    const body = c.querySelector(".body");
    const editorText = c.querySelector(".ProseMirror").textContent;
    body.style.display = open ? "" : "none";
    c.querySelector(":scope > .preview")?.remove();
    if (!open) {
      const b = doc.createElement("button");
      b.className = "preview";
      b.innerHTML = `<div><span>${editorText}</span></div>`;
      c.append(b);
    }
  }
};
doc.addEventListener("click", (event) => {
  const preview = event.target.closest?.(".preview");
  if (preview) setOpen(preview.closest(".character-prompt-input"));
});

const logs = [];
const ctx = {
  window, document: doc, Element: window.Element, Node: window.Node, HTMLElement: window.HTMLElement,
  MouseEvent: window.MouseEvent, PointerEvent: undefined, FocusEvent: window.FocusEvent,
  getComputedStyle: (el) => window.getComputedStyle(el),
  HOST_ID: "nai-auto-saver-host",
  CHAR_WRAPPER_SELECTOR: '[class*="prompt-input-box-character-prompt"]',
  delay: () => Promise.resolve(),
  logEvent: (...args) => logs.push(args),
  Array, Number, String, Boolean, Math, Map, Set, Promise,
};
vm.createContext(ctx);
vm.runInContext(["isVisible", "isRenderedControl", "getCharacterContainers", "getCharacterBoxEditor",
  "waitForCharacterEditorAt", "characterPreviewButton", "readCharacterPreviewText",
  "clickControlLikeUser", "ensureCharacterExpandedAt", "getCharacterHeaderElements",
  "getCharacterHeaderIndex", "findCharacterCardFromHeader", "getCharacterHeaderInContainer",
  "getCharacterActivationTarget", "normalizeCharacterHeaderText", "ownControlText", "accessibleControlText"]
  .map(extractFunction).join("\n") + `
  const CHARACTER_HEADER_RE = /^(?:♀|♂|⚧)?\\s*character\\s+(\\d+)\\s*$/i;
  const UC_TAB_RE = /undesired/i;
  function normalizeButtonText(b) { return (b.textContent || "").trim(); }
  this.expand = ensureCharacterExpandedAt;
  this.preview = readCharacterPreviewText;
  this.containers = getCharacterContainers;`, ctx);

(async () => {
  assert.equal(ctx.containers().length, 2);
  assert.equal(ctx.preview(ctx.containers()[0]), "girl,");

  const first = await ctx.expand(0);
  assert.ok(first.editor, "collapsed Character 1 must be expanded via its preview button");
  assert.equal(first.editor.textContent, "girl, ");
  assert.equal(ctx.containers()[1].querySelector(".body").style.display, "none", "NovelAI collapses the other card");

  const second = await ctx.expand(1);
  assert.ok(second.editor, "Character 2 must be re-expanded");
  assert.ok(!logs.some(([level, msg]) => level === "warn" && /바로 보이지 않음/.test(msg)),
    "the preview button must be used before the blind click fallback");
  console.log("collapsed card tests passed");
})().catch((error) => { console.error(error); process.exit(1); });
