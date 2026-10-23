"use strict";

// In-place update for copies loaded from GitHub. The user picks this
// extension's folder once (we remember it); we then fetch only the files that
// changed on GitHub, check every one against its git hash, write them into the
// folder (manifest.json last) and reload the extension from disk. Same folder
// = same extension, so memos, queue and 보관함 stay as they are.

const U = globalThis.NAIUpdate;
const API = `https://api.github.com/repos/${U.REPO}`;
const FOLDER_KEY = "updateFolder";
const APPLIED_KEY = "naiAutoSaver.updateApplied";
const SKIP = [/^tests\//, /^docs\//, /^guide\//, /(^|\/)\./];

const $ = (id) => document.getElementById(id);
const manifest = chrome.runtime.getManifest();
let folder = null;
let info = null;
let busy = false;

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
function hex(buf) {
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
}
async function gitBlobSha(bytes) {
  const head = new TextEncoder().encode(`blob ${bytes.byteLength}\0`);
  const all = new Uint8Array(head.length + bytes.byteLength);
  all.set(head, 0);
  all.set(new Uint8Array(bytes), head.length);
  return hex(await crypto.subtle.digest("SHA-1", all));
}
function wanted(path) {
  return !SKIP.some((re) => re.test(path)) && !path.split("/").some((seg) => seg === ".." || seg === "");
}
async function dirFor(rootDir, parts, create) {
  let dir = rootDir;
  for (const seg of parts) {
    dir = await dir.getDirectoryHandle(seg, { create });
  }
  return dir;
}
async function readLocal(rootDir, path) {
  const parts = path.split("/");
  const name = parts.pop();
  try {
    const dir = await dirFor(rootDir, parts, false);
    const file = await (await dir.getFileHandle(name)).getFile();
    return new Uint8Array(await file.arrayBuffer());
  } catch (error) {
    return null;
  }
}
async function writeLocal(rootDir, path, bytes) {
  const parts = path.split("/");
  const name = parts.pop();
  const dir = await dirFor(rootDir, parts, true);
  const writable = await (await dir.getFileHandle(name, { create: true })).createWritable();
  await writable.write(bytes);
  await writable.close();
}
async function getJson(url) {
  const res = await fetch(url, { cache: "no-store", headers: { Accept: "application/vnd.github+json" } });
  if (res.status === 403 || res.status === 429) throw new Error("GitHub가 잠깐 바빠요. 몇 분 뒤에 다시 해 주세요.");
  if (!res.ok) throw new Error(`GitHub에서 목록을 못 받았어요 (${res.status}).`);
  return res.json();
}
async function readManifestIn(dir) {
  const bytes = await readLocal(dir, "manifest.json");
  if (!bytes) return null;
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch (error) {
    return null;
  }
}
// Finds the copy Chrome is running *now* inside the picked folder: the picked
// folder itself, or anywhere a few levels below it (so picking 문서 or
// 다운로드 works too). The running copy is recognised by its manifest.json
// being byte-for-byte the one Chrome serves, so an old copy or a freshly
// unzipped new one never gets mistaken for it.
const SEARCH_DEPTH = 4;
const SEARCH_LIMIT = 4000;
const SKIP_DIRS = /^(\.|node_modules$|\$RECYCLE\.BIN$|System Volume Information$|AppData$|Library$)/i;
let loadedManifestText = null;
async function loadedManifest() {
  if (loadedManifestText == null) {
    loadedManifestText = await (await fetch(chrome.runtime.getURL("manifest.json"), { cache: "no-store" })).text();
  }
  return loadedManifestText;
}
async function resolveExtensionFolder(dir, onProgress = () => {}) {
  const want = (await loadedManifest()).trim();
  const candidates = [];
  const queue = [{ dir, path: dir.name, depth: 0 }];
  let seen = 0;
  while (queue.length && seen < SEARCH_LIMIT) {
    const { dir: d, path, depth } = queue.shift();
    seen += 1;
    if (seen % 50 === 0) onProgress(seen);
    const bytes = await readLocal(d, "manifest.json");
    if (bytes) {
      const text = new TextDecoder().decode(bytes);
      let m = null;
      try {
        m = JSON.parse(text);
      } catch (error) {
        m = null;
      }
      if (m?.name === manifest.name) {
        if (text.trim() === want) return { match: { dir: d, path }, candidates };
        candidates.push({ path, version: String(m.version || "?") });
        continue; // an extension folder: nothing more to find inside
      }
    }
    if (depth >= SEARCH_DEPTH) continue;
    try {
      for await (const [name, child] of d.entries()) {
        if (child.kind === "directory" && !SKIP_DIRS.test(name)) queue.push({ dir: child, path: `${path}/${name}`, depth: depth + 1 });
      }
    } catch (error) {
      void error;
    }
  }
  return { match: null, candidates };
}
function josaRo(version) {
  return /[036]$/.test(String(version)) ? "으로" : "로";
}

// ---------------------------------------------------------------------------
// screens
// ---------------------------------------------------------------------------
function show({ icon = "download_circle", title, sub = "", notes = null, primary = null, tip = "", secondary = null, msg = "", manual = false }) {
  $("badge").innerHTML = globalThis.NAIIcons ? NAIIcons.svg(icon, 56) : "";
  $("title").textContent = title;
  $("sub").textContent = sub;
  renderNotes(notes);
  const p = $("primary");
  p.hidden = !primary;
  if (primary) {
    p.textContent = primary.label;
    p.disabled = Boolean(primary.disabled);
    p.onclick = primary.onClick;
  }
  $("tip").hidden = !tip;
  $("tip").textContent = tip;
  const s = $("secondary");
  s.hidden = !secondary;
  if (secondary) {
    s.textContent = secondary.label;
    s.onclick = secondary.onClick;
  }
  $("msg").hidden = !msg;
  $("msg").innerHTML = msg;
  $("manual").hidden = !manual;
  $("progress").hidden = true;
}
function renderNotes(notes) {
  const box = $("notes");
  box.textContent = "";
  for (const n of notes || []) {
    const section = document.createElement("section");
    const h = document.createElement("h2");
    h.textContent = `v${n.version}`;
    if (n.title) {
      const t = document.createElement("span");
      t.textContent = ` · ${n.title}`;
      h.append(t);
    }
    section.append(h);
    if (n.items?.length) {
      const ul = document.createElement("ul");
      for (const item of n.items) {
        const li = document.createElement("li");
        li.textContent = item;
        ul.append(li);
      }
      section.append(ul);
    }
    box.append(section);
  }
}
function progress(done, total, text) {
  $("progress").hidden = false;
  $("barFill").style.width = `${total ? Math.round((done / total) * 100) : 0}%`;
  $("progressText").textContent = text;
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

async function render({ force = false } = {}) {
  if (location.hash === "#done") return renderDone();
  show({ title: "확인하는 중…" });
  info = await U.check({ force });
  if (!info.eligible) {
    show({
      icon: "check_circle",
      title: "자동으로 업데이트돼요",
      sub: `지금 ${manifest.version}`,
      msg: "웹 스토어에서 설치한 버전은 크롬이 알아서 새 버전으로 바꿔 줘요. 따로 할 일이 없어요.",
    });
    return;
  }
  if (!info.available) {
    show({
      icon: "check_circle",
      title: "최신 버전이에요",
      sub: info.error ? `지금 ${info.current} · 확인하지 못했어요 (${info.error})` : `지금 ${info.current}`,
      secondary: { label: "다시 확인", onClick: () => render({ force: true }) },
    });
    return;
  }
  renderAvailable();
}

function renderAvailable(extra = {}) {
  show({
    title: `새 버전 ${info.latest}`,
    sub: `지금 쓰는 버전 ${info.current}`,
    notes: info.notes,
    primary: { label: "업데이트", onClick: startUpdate },
    tip: folder
      ? "바뀐 파일만 받아서 지금 폴더에 바꿔 넣어요. 메모·대기열·보관함은 그대로예요."
      : "처음 한 번만, 지금 설치돼 있는 폴더를 알려 주면 돼요. 다음부턴 버튼 하나예요.",
    manual: true,
    ...extra,
  });
}

async function renderDone() {
  const applied = (await chrome.storage.local.get(APPLIED_KEY))[APPLIED_KEY] || {};
  const tabs = await chrome.tabs.query({ url: "https://novelai.net/image*" }).catch(() => []);
  show({
    icon: "check_circle",
    title: `${manifest.version}${josaRo(manifest.version)} 업데이트됐어요`,
    sub: applied.from ? `${applied.from} → ${manifest.version}` : "",
    notes: applied.notes || [],
    primary: tabs.length ? {
      label: "NovelAI 탭 새로고침",
      onClick: async () => {
        for (const tab of tabs) await chrome.tabs.reload(tab.id).catch(() => {});
        await chrome.tabs.update(tabs[0].id, { active: true }).catch(() => {});
        window.close();
      },
    } : null,
    tip: tabs.length ? "열려 있던 NovelAI 탭은 새로고침해야 새 버전 패널이 떠요." : "",
    secondary: { label: "닫기", onClick: () => window.close() },
  });
  await chrome.storage.local.remove(APPLIED_KEY);
}

// ---------------------------------------------------------------------------
// the update
// ---------------------------------------------------------------------------
async function pickFolder() {
  // A remembered folder: one permission prompt (or none) instead of a picker.
  if (folder) {
    const mode = { mode: "readwrite" };
    if ((await folder.queryPermission(mode)) === "granted" || (await folder.requestPermission(mode)) === "granted") {
      return folder;
    }
    // Declined: next tap opens the picker again.
    folder = null;
    await LibDB.delKv(FOLDER_KEY).catch(() => {});
    throw Object.assign(new Error("denied"), { name: "NotAllowedError" });
  }
  const dir = await window.showDirectoryPicker({ id: "nai-autosaver-ext", mode: "readwrite" });
  return dir;
}

const WHERE_HELP = `<ol class="steps">
  <li><a href="#" data-open-ext>폴더 위치 보기</a>를 눌러요. 열린 화면의 <b>「소스」</b>에 적힌 경로가 그 폴더예요. 경로를 복사해 두세요.</li>
  <li>아래 <b>「설치된 폴더 고르기」</b> → 뜨는 창 맨 위 주소칸에 붙여 넣고 Enter → <b>「폴더 선택」</b>.</li>
</ol>
<p class="small">위치를 잘 모르겠으면 그 폴더가 들어 있을 만한 <b>상위 폴더</b>(예: 문서, 다운로드)를 골라도 돼요. 안쪽까지 찾아봐요.</p>`;

// First time only: say plainly which folder we mean before the picker opens.
function renderPickStep(extraMsg = "") {
  show({
    icon: "folder",
    title: "설치된 폴더를 알려 주세요",
    sub: "처음 한 번만 해요",
    msg: `${extraMsg ? `<div class="warn">${extraMsg}</div>` : ""}<p><b>새로 설치할 곳이 아니에요.</b> 지금 NAI 자동저장이 <b>들어 있는</b> 폴더예요. 새 버전 파일을 그 폴더에 바꿔 넣어요.</p>${WHERE_HELP}`,
    primary: { label: "설치된 폴더 고르기", onClick: runUpdate },
    secondary: { label: "취소", onClick: () => renderAvailable() },
  });
}

function startUpdate() {
  if (folder) return runUpdate();
  return renderPickStep();
}

async function runUpdate() {
  if (busy) return;
  busy = true;
  $("primary").disabled = true;
  try {
    let picked;
    try {
      picked = await pickFolder();
    } catch (error) {
      if (error?.name === "AbortError") return folder ? renderAvailable() : renderPickStep();
      if (error?.name === "NotAllowedError") {
        return renderPickStep("폴더를 고쳐도 된다는 허락이 있어야 새 파일을 바꿔 넣을 수 있어요. 크롬이 물으면 「수정 허용」을 눌러 주세요.");
      }
      throw new Error(`폴더를 열지 못했어요 (${error?.message || error}).`);
    }
    show({ icon: "folder", title: "폴더를 살펴보는 중…", sub: "안쪽까지 찾고 있어요" });
    progress(0, 1, "찾는 중…");
    const { match, candidates } = await resolveExtensionFolder(picked, (n) => progress(0, 1, `폴더 ${n}개 살펴봄…`));
    if (!match) {
      folder = null;
      await LibDB.delKv(FOLDER_KEY).catch(() => {});
      const list = candidates.slice(0, 4).map((c) => `<li><code>${escapeHtml(c.path)}</code> · ${escapeHtml(c.version)}</li>`).join("");
      const msg = candidates.length
        ? `고른 「${escapeHtml(picked.name)}」 안에 NAI 자동저장이 있긴 한데, <b>지금 켜져 있는 버전(${escapeHtml(manifest.version)})이 아닌 다른 복사본</b>이에요.<ul class="found">${list}</ul>`
        : `고른 「${escapeHtml(picked.name)}」 안에서 지금 켜져 있는 NAI 자동저장을 못 찾았어요.`;
      return renderPickStep(msg);
    }
    const found = match;
    folder = found.dir;
    await LibDB.setKv(FOLDER_KEY, folder).catch(() => {});

    show({ title: `${info.latest}${josaRo(info.latest)} 바꾸는 중`, sub: "창을 닫지 말고 잠깐만 기다려 주세요." });
    progress(0, 1, "바뀐 파일을 찾는 중…");
    const commit = await getJson(`${API}/commits/${U.BRANCH}`);
    const tree = await getJson(`${API}/git/trees/${commit.commit.tree.sha}?recursive=1`);
    if (tree.truncated) throw new Error("GitHub 파일 목록이 너무 길어서 다 못 받았어요.");
    const blobs = tree.tree.filter((t) => t.type === "blob" && wanted(t.path));
    if (!blobs.some((b) => b.path === "manifest.json")) throw new Error("GitHub에 manifest.json이 없어요.");

    const changed = [];
    for (let i = 0; i < blobs.length; i += 1) {
      const local = await readLocal(folder, blobs[i].path);
      if (!local || (await gitBlobSha(local)) !== blobs[i].sha) changed.push(blobs[i]);
      progress(i + 1, blobs.length * 4, "바뀐 파일을 찾는 중…");
    }

    // Everything is downloaded and checked before the first write, so a
    // broken connection never leaves a half-updated folder.
    const files = new Map();
    for (let i = 0; i < changed.length; i += 1) {
      const b = changed[i];
      const url = `${U.RAW}${commit.sha}/${b.path.split("/").map(encodeURIComponent).join("/")}`;
      const res = await fetch(url, { cache: "no-store" });
      if (!res.ok) throw new Error(`${b.path} 파일을 못 받았어요 (${res.status}).`);
      const bytes = new Uint8Array(await res.arrayBuffer());
      if ((await gitBlobSha(bytes)) !== b.sha) throw new Error(`${b.path} 파일이 깨져서 받아졌어요. 다시 해 주세요.`);
      files.set(b.path, bytes);
      progress(blobs.length + ((i + 1) / changed.length) * blobs.length * 2, blobs.length * 4, `받는 중 ${i + 1}/${changed.length}`);
    }
    const nextManifest = files.has("manifest.json")
      ? JSON.parse(new TextDecoder().decode(files.get("manifest.json")))
      : await readManifestIn(folder);
    if (nextManifest?.name !== manifest.name) throw new Error("받은 파일이 NAI 자동저장이 아니에요.");

    const order = [...files.keys()].sort((a, b) => (a === "manifest.json") - (b === "manifest.json"));
    for (let i = 0; i < order.length; i += 1) {
      await writeLocal(folder, order[i], files.get(order[i]));
      progress(blobs.length * 3 + ((i + 1) / order.length) * blobs.length, blobs.length * 4, `바꿔 넣는 중 ${i + 1}/${order.length}`);
    }
    await chrome.storage.local.set({ [APPLIED_KEY]: { from: manifest.version, to: nextManifest.version, at: Date.now(), notes: info.notes || [] } });
    progress(1, 1, "다시 켜는 중…");
    setTimeout(() => chrome.runtime.reload(), 300);
  } catch (error) {
    renderAvailable({ msg: `<b>업데이트하지 못했어요.</b> ${escapeHtml(error?.message || error)}<br>지금 폴더는 그대로예요.` });
  } finally {
    busy = false;
    if (!$("primary").hidden) $("primary").disabled = false;
  }
}

// ---------------------------------------------------------------------------
document.addEventListener("click", (event) => {
  const ext = event.target.closest?.("#extLink, [data-open-ext]");
  if (ext) {
    event.preventDefault();
    void chrome.tabs.create({ url: `chrome://extensions/?id=${chrome.runtime.id}` });
  }
});
$("zipLink").href = `https://github.com/${U.REPO}/archive/refs/heads/${U.BRANCH}.zip`;
window.addEventListener("hashchange", () => void render());
globalThis.NAIUpdater = { gitBlobSha, wanted, resolveExtensionFolder, runUpdate };

(async () => {
  globalThis.NAIIcons?.hydrate();
  folder = await LibDB.getKv(FOLDER_KEY).catch(() => null);
  await render();
})();
