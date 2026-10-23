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
