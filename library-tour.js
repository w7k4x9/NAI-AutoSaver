// 보관함 안내: pick what you want to do, then the real screen is pointed out
// step by step (spotlight + bubble). Opens by itself on the first visit and
// any time from the 안내 button in the toolbar.
(function () {
  "use strict";

  const STORE_KEY = "naiAutoSaver.libraryTour";
  const $ = (sel) => document.querySelector(sel);
  const visible = (node) => {
    if (!node) return false;
    const r = node.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const firstTile = () => [...document.querySelectorAll(".grid .tile")].find(visible) || null;
  // Several steps need a picture on the right; pick the first one if nothing is chosen.
  const ensureSelected = () => {
    if ($(".share-card") || !firstTile()) return;
    firstTile().click();
  };
  const NO_PICTURE = "보관함에 그림이 생기면 여기서 해요. NovelAI에서 생성하면 저절로 쌓이고, 예전 그림은 왼쪽 아래 <b>NovelAI 폴더 연결</b>로 불러와요.";

  const TOPICS = [
    {
      id: "overview", icon: "grid", title: "한눈에 보기", short: "보관함 화면이 어떻게 생겼는지",
      steps: [
        { target: () => $(".side .nav"), title: "왼쪽 · 모아 보기", body: "<b>전체 · 오늘 · 메타데이터 있음/없음</b>으로 나눠 봐요. 아래 <b>캐릭터</b>를 누르면 그 캐릭터 그림만 보여요." },
        { target: () => $(".gallery"), title: "가운데 · 그림", body: "그림을 누르면 고르고, <b>두 번 누르면 크게</b> 봐요. 여러 장도 탐색기처럼 골라요." },
        { target: () => $(".inspector"), title: "오른쪽 · 자세히", body: "고른 그림의 <b>프롬프트 · 시드 · 모델</b>이 보여요. 맨 아래에서 올리기 좋은 <b>공유용 사본</b>을 만들어요." },
        { target: () => [$(".folder-box:not(.notion-box)"), $(".notion-box")], title: "왼쪽 아래 · 연결", body: "<b>NovelAI 폴더</b>를 연결하면 예전 그림까지 보이고, <b>노션</b>을 연결하면 그림을 노션에 정리해요. 둘 다 안 해도 돼요." },
      ],
    },
    {
      id: "search", icon: "search", title: "그림 찾기", short: "프롬프트 단어로 · 캐릭터별로",
      steps: [
        { target: () => $(".search"), title: "프롬프트로 찾기", body: "<b>교실 웃음</b>처럼 띄어 쓰면 두 단어가 다 들어간 그림만 나와요. 빼고 싶은 단어는 <b>-hat</b>처럼 앞에 빼기를 붙여요. 프롬프트 태그와 파일 이름에서 찾아요." },
        { target: () => $(".nav-chars"), title: "캐릭터별로 보기", body: "저장 이름의 <b>_ 앞부분</b>(예: 하린_바다 → 하린)이 캐릭터가 돼요. 누르면 그 캐릭터 그림만 보여요." },
      ],
    },
    {
      id: "view", icon: "visibility", title: "크게 보기", short: "그림을 화면 가득",
      steps: [
        { target: firstTile, empty: NO_PICTURE, title: "두 번 클릭 · 스페이스바", body: "그림을 <b>두 번 클릭</b>하거나, 고른 다음 <b>스페이스바</b>를 눌러요. 키보드 <b>← →</b>로 넘기고, 그림을 누르면 실제 크기, <b>Esc</b>로 닫아요." },
      ],
    },
    {
      id: "select", icon: "check", title: "여러 장 고르기", short: "윈도우 탐색기와 같은 방법",
      steps: [
        { target: firstTile, empty: NO_PICTURE, title: "하나씩 더하기", body: "<b>Ctrl</b>(맥은 ⌘)을 누른 채 클릭하거나, 그림 왼쪽 위 <b>동그라미</b>를 눌러요. <b>Shift</b>+클릭은 사이에 있는 그림 전부예요." },
        { target: () => $(".gallery"), title: "끌어서 고르기", body: "그림 사이 <b>빈 곳에서 끌면</b> 네모 안에 든 그림이 다 골라져요. 빈 곳을 누르거나 <b>Esc</b>를 누르면 풀려요." },
        { target: () => $(".pick-all"), title: "모두 선택", body: "지금 보이는 그림을 전부 골라요 (<b>Ctrl+A</b>). 여러 장을 고르면 오른쪽에서 한꺼번에 사본을 만들거나 노션에 보내요." },
      ],
    },
    {
      id: "cull", icon: "check_circle", title: "셀렉 · 비교", short: "잘 나온 그림 고르기 · 둘 중 고르기",
      steps: [
        { prep: ensureSelected, target: () => $(".cull-row"), empty: NO_PICTURE, title: "안 고름 · 채택 · B컷 · 탈락", body: "오른쪽 버튼 넷 중 하나를 고르거나 키보드 <b>Q 채택 · W B컷 · E 탈락 · R 안 고름</b>. 크게 보기 아래쪽에도 같은 버튼이 있고, 채택·B컷·탈락을 고르면 다음 장으로 넘어가요." },
        { prep: ensureSelected, target: () => $(".cmp-open"), empty: "이름이 같은 그림이 두 장 이상이면(예: 김춘자_교실 웃음 (1), (2)…) 여기에 <b>같은 이름 비교하기</b>가 생겨요. 여러 장을 골라도 비교할 수 있어요.", title: "비교하기", body: "<b>나란히</b>는 왼쪽에 <b>안 고른 그림</b>, 오른쪽에 <b>채택</b>(또는 B컷)을 크게 보여 줘요. 누른 쪽(파란 테두리)만 ←/→로 넘어가고, <b>Q 채택 · W B컷 · E 탈락</b>을 누르면 왼쪽 그림이 오른쪽으로 옮겨 가요. <b>한눈에</b>는 전부 나란히 보여 줘요." },
        { target: () => $(".nav-cull"), title: "고른 것만 보기", body: "<b>안 고름 · 채택 · B컷 · 탈락</b> 중 하나를 누르고 아래 <b>캐릭터</b>를 누르면 「채택 · 김춘자」처럼 같이 걸러져요. 한 번 더 누르면 풀려요." },
        { target: () => $(".cull-export") || $(".nav-cull"), title: "폴더로 나눠 저장", body: "<b>폴더로 나눠 저장…</b>을 누르면 채택·B컷을 <b>다운로드/NovelAI/_셀렉/채택/김춘자/</b>처럼 라벨·캐릭터별 폴더에 복사해요(원본은 그대로). <b>이동</b>을 고르면 원본을 그 폴더로 옮겨요. (채택이나 B컷이 하나라도 있으면 보여요)" },
      ],
    },
    {
      id: "share", icon: "shield", title: "공유용 사본 만들기", short: "올리기 전에 프롬프트 지우기",
      steps: [
        { prep: ensureSelected, target: () => $(".share-card"), empty: NO_PICTURE, title: "왜 사본이 필요해요?", body: "NovelAI 그림 파일 안에는 <b>프롬프트 · 시드가 숨어 있어요.</b> 그대로 올리면 누구나 볼 수 있어서, 원본은 두고 정보를 지운 <b>사본</b>을 따로 만들어요." },
        { prep: ensureSelected, target: () => $(".share-opts"), empty: NO_PICTURE, title: "어떤 사본?", body: "<b>메타데이터만 지우기</b>는 그림은 그대로, 숨은 정보만 지워요. <b>검열까지</b>는 가릴 곳을 하얀 빛으로 덮고 정보도 지워요." },
        { prep: ensureSelected, target: () => $(".copy-go"), empty: NO_PICTURE, title: "만들기", body: "누르면 사본이 <b>다운로드/NovelAI/_메타없음</b> (검열은 <b>_검열</b>) 폴더에 날짜별로 저장돼요. 원본은 건드리지 않아요." },
      ],
    },
    {
      id: "censor", icon: "brush", title: "검열 사본 다듬기", short: "가리는 크기 · 붓 · 지우개",
      steps: [
        { prep: ensureSelected, target: () => $('.share-opt[data-mode="censor"]'), empty: NO_PICTURE, title: "「검열까지」 고르기", body: "고르고 아래 버튼을 누르면 <b>확인 화면</b>이 열려요. 처음 한 번은 검열 모델(약 45MB)을 받을지 물어봐요. 받은 뒤로는 <b>내 컴퓨터 안에서만</b> 찾아요." },
        { target: () => null, title: "확인 화면에서 할 수 있는 것", body: "<b>가리는 크기</b>로 전체를 키우고 줄이고, 찾은 곳마다 <b>−/+</b>로 따로 조절해요. 빠진 곳은 <b>붓(B)</b>으로 칠하고 너무 가린 곳은 <b>지우개(E)</b>로 덜어 내요. <b>원본 보기</b>를 누르고 있으면 가리기 전 그림이 보여요." },
        { target: () => null, title: "여러 장일 때", body: "여러 장을 골라서 만들면 한 장씩 보면서 <b>저장하고 다음</b>으로 넘기거나, <b>남은 N장 한 번에 저장</b>으로 같은 설정 그대로 끝낼 수 있어요. 자동으로 못 찾는 경우도 있으니 한 번은 눈으로 확인해 주세요." },
      ],
    },
    {
      id: "folder", icon: "folder", title: "예전 그림 불러오기", short: "NovelAI 폴더 연결",
      steps: [
        { target: () => $(".folder-box:not(.notion-box)"), title: "NovelAI 폴더 연결", body: "누르고 <b>다운로드 → NovelAI</b> 폴더를 골라요. 예전에 저장한 그림도 보관함에 들어오고, <b>원본 화질로 크게 보기</b>와 사본 만들기도 이 연결이 있어야 돼요. 파일을 옮기거나 지우지는 않아요." },
      ],
    },
    {
      id: "open", icon: "file", title: "다른 그림 열어 보기", short: "받은 그림의 프롬프트 확인",
      steps: [
        { target: () => $(".open-files"), title: "파일 열기 · 끌어다 놓기", body: "다른 데서 받은 PNG · WebP를 열거나 <b>창에 끌어다 놓으면</b> 프롬프트를 볼 수 있어요. 왼쪽 <b>불러온 파일</b>에 잠깐 보이고, 보관함에 저장되지는 않아요." },
      ],
    },
    {
      id: "notion", icon: "notion", title: "노션에 보내기", short: "그림과 프롬프트를 노션 표로",
      steps: [
        { target: () => $(".notion-box"), title: "노션 연결", body: "누르면 연결 창이 열려요. 노션에서 <b>연결(토큰)</b>을 하나 만들어 붙여 넣고, 그림을 모을 <b>페이지</b>를 고르면 끝이에요. 순서는 창 안에 그대로 적혀 있어요." },
        { prep: ensureSelected, target: () => $('.inspector button[aria-label="더 보기"]') || $(".multi-more"), empty: NO_PICTURE, title: "보내기", body: "그림 오른쪽 <b>⋯ → 노션에 보내기</b>. 여러 장을 골라 두고 ⋯ 를 누르면 한꺼번에 보내요. 노션 설정에서 <b>자동으로 보내기</b>를 켜면 생성할 때마다 알아서 올라가요." },
      ],
    },
  ];

  const tour = { topic: null, index: -1, raf: 0 };
  let store = { done: [], autoShown: false };
  let layer, hole, bubble, sheet;

  const save = () => { try { chrome.storage.local.set({ [STORE_KEY]: store }); } catch (error) { void error; } };
  const ico = (name, size) => (globalThis.NAIIcons ? NAIIcons.svg(name, size) : "");

  function build() {
    if (layer) return;
    layer = document.createElement("div");
    layer.className = "lt-layer";
    layer.innerHTML = '<div class="lt-hole" hidden></div><div class="lt-bubble" role="dialog" aria-live="polite" hidden></div><aside class="lt-sheet" role="dialog" aria-label="보관함 안내" hidden></aside>';
    document.body.append(layer);
    hole = layer.querySelector(".lt-hole");
    bubble = layer.querySelector(".lt-bubble");
    sheet = layer.querySelector(".lt-sheet");
    sheet.addEventListener("click", (event) => {
      const go = event.target.closest("[data-topic]");
      if (go) start(go.dataset.topic);
      if (event.target.closest("[data-close]")) closeSheet();
    });
    bubble.addEventListener("click", (event) => {
      if (event.target.closest("[data-next]")) step(tour.index + 1);
      else if (event.target.closest("[data-prev]")) step(tour.index - 1);
      else if (event.target.closest("[data-stop]")) stop();
    });
    // Esc / arrows belong to the guide while it is open (before the page's own keys).
    document.addEventListener("keydown", (event) => {
      if (tour.topic) {
        if (event.key === "Escape") stop();
        else if (event.key === "ArrowRight" || event.key === "Enter") step(tour.index + 1);
        else if (event.key === "ArrowLeft") step(tour.index - 1);
        else return;
      } else if (!sheet.hidden && event.key === "Escape") {
        closeSheet();
      } else {
        return;
      }
      event.preventDefault();
      event.stopImmediatePropagation();
    }, true);
  }

  function openSheet() {
    build();
    stop({ reopen: false });
    const items = TOPICS.map((t) => {
      const done = store.done.includes(t.id);
      return `<li><button type="button" class="lt-topic" data-topic="${t.id}" data-done="${done}"><span class="lt-topic-ic">${ico(t.icon, 18)}</span><span class="lt-topic-text"><span class="lt-topic-title">${t.title}</span><span class="lt-topic-short">${t.short}</span></span><span class="lt-topic-end">${done ? ico("check", 16) : ico("chevron", 18)}</span></button></li>`;
    }).join("");
    sheet.innerHTML = `
      <div class="lt-head"><div><div class="lt-title">보관함 안내</div><div class="lt-sub">하고 싶은 걸 고르면 화면에서 하나씩 짚어 드려요.</div></div>
        <button type="button" class="lt-close" data-close aria-label="안내 닫기">${ico("close", 14)}</button></div>
      <ul class="lt-topics">${items}</ul>
      <p class="lt-foot">왼쪽 아래 <b>안내</b>에서 언제든 다시 볼 수 있어요.</p>`;
    sheet.hidden = false;
    document.querySelector(".help-open")?.setAttribute("aria-expanded", "true");
    sheet.querySelector(".lt-topic")?.focus();
  }

  function closeSheet() {
    if (sheet) sheet.hidden = true;
    document.querySelector(".help-open")?.setAttribute("aria-expanded", "false");
  }

  function start(id) {
    const topic = TOPICS.find((t) => t.id === id);
    if (!topic) return;
    build();
    closeSheet();
    stop();
    tour.topic = topic;
    step(0);
  }

  function step(index) {
    const topic = tour.topic;
    if (!topic) return;
    if (index < 0) return;
    if (index >= topic.steps.length) {
      if (!store.done.includes(topic.id)) store.done.push(topic.id);
      save();
      stop({ reopen: true });
      return;
    }
    tour.index = index;
    const s = topic.steps[index];
    try { s.prep?.(); } catch (error) { void error; }
    // Let a selection made by prep render before measuring.
    requestAnimationFrame(() => {
      if (tour.topic !== topic || tour.index !== index) return;
      const targets = [].concat(s.target() || []).filter(visible);
      targets[0]?.scrollIntoView({ block: "nearest", inline: "nearest" });
      const body = !targets.length && s.empty ? s.empty : s.body;
      const segs = topic.steps.map((_, i) => `<span data-on="${i <= index}"></span>`).join("");
      const last = index === topic.steps.length - 1;
      bubble.innerHTML = `
        <div class="lt-b-top"><span class="lt-b-topic">${topic.title}</span>${topic.steps.length > 1 ? `<span class="lt-b-segs">${segs}</span>` : ""}</div>
        <div class="lt-b-title">${s.title}</div>
        <div class="lt-b-body">${body}</div>
        <div class="lt-b-actions"><button type="button" class="lt-b-stop" data-stop>그만 보기</button>${index ? '<button type="button" class="btn plain small" data-prev>이전</button>' : ""}<button type="button" class="btn small" data-next>${last ? "다 봤어요" : "다음"}</button></div>`;
      bubble.hidden = false;
      bubble.querySelector("[data-next]")?.focus({ preventScroll: true });
      tour.targets = targets;
      place();
      if (!tour.raf) {
        const tick = () => { tour.raf = 0; if (!tour.topic) return; place(); tour.raf = requestAnimationFrame(tick); };
        tour.raf = requestAnimationFrame(tick);
      }
    });
  }

  // Spotlight around the target(s) and the bubble beside it, kept on screen.
  function place() {
    const targets = (tour.targets || []).filter((n) => n.isConnected && visible(n));
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const bw = bubble.offsetWidth;
    const bh = bubble.offsetHeight;
    if (!targets.length) {
      hole.hidden = false;
      Object.assign(hole.style, { left: `${vw / 2}px`, top: `${vh / 2}px`, width: "0px", height: "0px" });
      bubble.dataset.place = "center";
      Object.assign(bubble.style, { left: `${Math.round((vw - bw) / 2)}px`, top: `${Math.round((vh - bh) / 2)}px` });
      return;
    }
    const rects = targets.map((n) => n.getBoundingClientRect());
    const pad = 6;
    const r = {
      left: Math.max(4, Math.min(...rects.map((x) => x.left)) - pad),
      top: Math.max(4, Math.min(...rects.map((x) => x.top)) - pad),
      right: Math.min(vw - 4, Math.max(...rects.map((x) => x.right)) + pad),
      bottom: Math.min(vh - 4, Math.max(...rects.map((x) => x.bottom)) + pad),
    };
    hole.hidden = false;
    Object.assign(hole.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.right - r.left}px`, height: `${r.bottom - r.top}px` });
    const gap = 12;
    const clampX = (x) => Math.max(12, Math.min(vw - bw - 12, x));
    const clampY = (y) => Math.max(12, Math.min(vh - bh - 12, y));
    let place;
    let left;
    let top;
    if (vh - r.bottom >= bh + gap + 12) {
      place = "below"; top = r.bottom + gap; left = clampX((r.left + r.right) / 2 - bw / 2);
    } else if (r.top >= bh + gap + 12) {
      place = "above"; top = r.top - gap - bh; left = clampX((r.left + r.right) / 2 - bw / 2);
    } else if (vw - r.right >= bw + gap + 12) {
      place = "right"; left = r.right + gap; top = clampY((r.top + r.bottom) / 2 - bh / 2);
    } else if (r.left >= bw + gap + 12) {
      place = "left"; left = r.left - gap - bw; top = clampY((r.top + r.bottom) / 2 - bh / 2);
    } else {
      place = "center"; left = clampX((vw - bw) / 2); top = clampY((vh - bh) / 2);
    }
    bubble.dataset.place = place;
    Object.assign(bubble.style, { left: `${Math.round(left)}px`, top: `${Math.round(top)}px` });
  }

  function stop({ reopen = false } = {}) {
    tour.topic = null;
    tour.index = -1;
    tour.targets = [];
    if (tour.raf) cancelAnimationFrame(tour.raf);
    tour.raf = 0;
    if (hole) hole.hidden = true;
    if (bubble) bubble.hidden = true;
    if (reopen) openSheet();
  }

  async function init() {
    const button = document.querySelector(".help-open");
    button?.addEventListener("click", () => (sheet && !sheet.hidden ? closeSheet() : openSheet()));
    try {
      const got = await chrome.storage.local.get(STORE_KEY);
      store = { done: [], autoShown: false, ...(got[STORE_KEY] || {}) };
    } catch (error) {
      void error;
    }
    // First visit: show what the library can do.
    if (!store.autoShown) {
      store.autoShown = true;
      save();
      setTimeout(openSheet, 700);
    }
  }

  globalThis.LibraryTour = { open: openSheet, start, stop, topics: TOPICS.map((t) => t.id) };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else void init();
})();
