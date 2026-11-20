"use strict";

// Additions to the update page, loaded after update.js.
//
// update.js is frozen on purpose: when the updater rewrites its own update.js,
// Windows security (Defender cloud check) takes the freshly written file for a
// downloader and removes it. So updates never touch update.js (the SKIP entry
// below), and anything new for this page goes here instead. Keep update.js
// byte-for-byte as it is; change this file.
if (typeof SKIP !== "undefined" && Array.isArray(SKIP)) {
  SKIP.push(/^update\.js$/);
}

// Web Store copy available: suggest moving (it updates by itself, and this
// copy steps aside and hands memos, queue and settings over — handoff.html).
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

if (typeof render === "function") {
  const baseRender = render;
  // eslint-disable-next-line no-global-assign
  render = async function renderWithStore(options = {}) {
    if (location.hash !== "#done") {
      show({ title: "확인하는 중…" });
      info = await U.check(options);
      if (info.eligible && info.store) return renderStore();
    }
    return baseRender(options);
  };
}

// 기억해 둔 설치 폴더가 옮겨졌거나 지워졌을 때 크롬이 "A requested file or directory could not be found…"를
// 내고 멈췄음 → 기억을 지우고 폴더를 한 번 다시 고르게 함.
// 고른 폴더에 이미 받으려던 버전이 들어 있으면(압축을 풀어 덮어씀) → 다시 켜기만 하게 함.
(() => {
  if (typeof resolveExtensionFolder !== "function") return;
  const isGone = (e) => e && (e.name === "NotFoundError" || /could not be found/i.test(String(e.message || e)));
  let gone = false;
  let readyVer = null;
  const forget = async () => { folder = null; await LibDB.delKv(FOLDER_KEY).catch(() => {}); };

  const baseResolve = resolveExtensionFolder;
  // eslint-disable-next-line no-global-assign
  resolveExtensionFolder = async (dir) => {
    gone = false; readyVer = null;
    let r;
    try { r = await baseResolve(dir); } catch (e) { if (!isGone(e)) throw e; gone = true; await forget(); return { match: null, candidates: [] }; }
    const ready = !r.match && info && info.latest && r.candidates.find((c) => c.version === info.latest);
    if (ready) { readyVer = ready.version; throw new Error("이미 새 버전이 들어 있어요"); }
    return r;
  };
  const basePick = renderPickStep;
  // eslint-disable-next-line no-global-assign
  renderPickStep = (extraMsg = "") => basePick(gone ? "전에 기억해 둔 폴더가 옮겨졌거나 없어져서 찾지 못했어요. 지금 NAI 자동저장이 들어 있는 폴더를 한 번만 다시 골라 주세요." : extraMsg);
  const baseAvail = renderAvailable;
  // eslint-disable-next-line no-global-assign
  renderAvailable = (extra = {}) => {
    if (readyVer) {
      const v = readyVer; readyVer = null;
      return show({ icon: "check_circle", title: `새 버전 ${v}`, sub: `지금 쓰는 버전 ${manifest.version}`, notes: info.notes,
        msg: `<p>폴더에는 이미 <b>${escapeHtml(v)}</b> 파일이 들어 있어요. 다시 켜기만 하면 돼요. 메모·대기열·설정은 그대로예요.</p>`,
        primary: { label: "다시 켜기", onClick: async () => { await chrome.storage.local.set({ [APPLIED_KEY]: { from: manifest.version, to: v, at: Date.now(), notes: info.notes || [] } }); chrome.runtime.reload(); } } });
    }
    if (!gone && /could not be found/i.test(String(extra.msg || ""))) { gone = true; void forget(); return renderPickStep(); }
    return baseAvail(extra);
  };
})();
