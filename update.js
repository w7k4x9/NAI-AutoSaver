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
// The picked folder must be the copy Chrome is running now: its manifest.json
// is byte-for-byte the one Chrome serves (so an old copy or a freshly unzipped
// new one is never mistaken for it). The picked folder itself or one folder
// inside it ("NAI-AutoSaver-main/NAI-AutoSaver-main") — nothing deeper.
let loadedManifestText = null;
async function loadedManifest() {
  if (loadedManifestText == null) {
    loadedManifestText = await (await fetch(chrome.runtime.getURL("manifest.json"), { cache: "no-store" })).text();
  }
  return loadedManifestText;
}
async function resolveExtensionFolder(dir) {
  const want = (await loadedManifest()).trim();
  const candidates = [];
  const look = async (d, path) => {
    const bytes = await readLocal(d, "manifest.json");
    if (!bytes) return false;
    const text = new TextDecoder().decode(bytes);
    let m = null;
    try {
      m = JSON.parse(text);
    } catch (error) {
      return false;
    }
    if (m?.name !== manifest.name) return false;
    if (text.trim() === want) return true;
    candidates.push({ path, version: String(m.version || "?") });
    return false;
  };
  if (await look(dir, dir.name)) return { match: { dir, path: dir.name }, candidates };
  if (!candidates.length) {
    for await (const [name, child] of dir.entries()) {
      if (child.kind === "directory" && await look(child, `${dir.name}/${name}`)) {
        return { match: { dir: child, path: `${dir.name}/${name}` }, candidates };
      }
    }
  }
  return { match: null, candidates };
}
function josaRo(version) {
  return /[036]$/.test(String(version)) ? "으로" : "로";
}

const STAGE_DIR = ".nai-update";

function blockedError(path, cause) {
  const err = new Error(`Windows 보안(백신)이 「${escapeHtml(path)}」 파일을 막았어요. 이번 버전은 아래 「직접 바꾸고 싶어요」로 바꿔 주세요.`);
  err.blockedFile = path;
  err.cause = cause;
  return err;
}

// Moves one staged file over the real one (same name, so no new checks).
async function placeStaged(stage, path) {
  const parts = path.split("/");
  const name = parts.pop();
  const from = await (await dirFor(stage, parts, false)).getFileHandle(name);
  const toDir = await dirFor(folder, parts, true);
  try {
    await from.move(toDir, name);
  } catch (error) {
    await toDir.removeEntry(name).catch(() => {});
    await from.move(toDir, name);
  }
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
  if (info.store) return renderStore();
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

// The Web Store copy updates by itself, so once it's out we suggest moving.
// Installing it is enough: this copy then steps aside on its own and hands
// memos, queue and settings over (see handoff.html).
function renderStore() {
  show({
    icon: "check_circle",
    title: "웹 스토어 버전이 나왔어요",
    sub: `지금 쓰는 버전 ${info.current} (GitHub)`,
    msg: `<p>스토어에서 설치하면 <b>업데이트를 크롬이 알아서</b> 해 줘요. 폴더 고르기도, zip도 이제 필요 없어요.</p>
<ol class="steps">
  <li>아래 「웹 스토어에서 설치」 → <b>Chrome에 추가</b></li>
  <li>NovelAI 탭을 새로고침하면 이 GitHub 버전은 알아서 물러나고, <b>메모·대기열·설정</b>은 스토어 버전으로 넘어가요.</li>
  <li>「예전 버전 지우기」 화면이 뜨면 눌러서 정리해요.</li>
</ol>
<p class="small">보관함은 스토어 버전에서 폴더를 한 번 다시 연결하면 다시 채워져요.</p>`,
    primary: { label: "웹 스토어에서 설치", onClick: () => chrome.tabs.create({ url: info.store }) },
    secondary: info.available ? { label: `그냥 GitHub로 ${info.latest} 업데이트`, onClick: () => renderAvailable() } : null,
  });
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
<p class="small">「소스」 경로를 그대로 붙여 넣으면 헷갈릴 일이 없어요.</p>`;

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
    const { match, candidates } = await resolveExtensionFolder(picked);
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
    const blobByPath = new Map(changed.map((b) => [b.path, b.sha]));
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

    // Stage first: every new file is written into a hidden folder next to
    // the real ones and read back. Windows security scans each file as it
    // lands; if it removes one, we stop here and the real files stay as
    // they were. Only when all of them made it do they move into place.
    const order = [...files.keys()].sort((a, b) => (a === "manifest.json") - (b === "manifest.json"));
    await folder.removeEntry(STAGE_DIR, { recursive: true }).catch(() => {});
    const stage = await folder.getDirectoryHandle(STAGE_DIR, { create: true });
    const total = blobs.length * 4;
    for (let i = 0; i < order.length; i += 1) {
      const path = order[i];
      try {
        await writeLocal(stage, path, files.get(path));
      } catch (error) {
        throw blockedError(path, error);
      }
      progress(blobs.length * 3 + ((i + 1) / order.length) * blobs.length * 0.5, total, `바꿔 넣을 준비 ${i + 1}/${order.length}`);
    }
    for (const path of order) {
      const back = await readLocal(stage, path);
      if (!back || (await gitBlobSha(back)) !== blobByPath.get(path)) throw blockedError(path, null);
    }
    for (let i = 0; i < order.length; i += 1) {
      await placeStaged(stage, order[i]);
      progress(blobs.length * 3.5 + ((i + 1) / order.length) * blobs.length * 0.5, total, `바꿔 넣는 중 ${i + 1}/${order.length}`);
    }
    await folder.removeEntry(STAGE_DIR, { recursive: true }).catch(() => {});
    await chrome.storage.local.set({ [APPLIED_KEY]: { from: manifest.version, to: nextManifest.version, at: Date.now(), notes: info.notes || [] } });
    progress(1, 1, "다시 켜는 중…");
    setTimeout(() => chrome.runtime.reload(), 300);
  } catch (error) {
    if (folder) await folder.removeEntry(STAGE_DIR, { recursive: true }).catch(() => {});
    $("manual").open = Boolean(error?.blockedFile);
    renderAvailable({ msg: `<b>업데이트하지 못했어요.</b> ${error?.blockedFile ? error.message : escapeHtml(error?.message || error)}<br>지금 폴더는 그대로예요.` });
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
