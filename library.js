// 보관함 page: browse, search, inspect and clean saved NovelAI pictures.
(() => {
  "use strict";

  const $ = (sel, root = document) => root.querySelector(sel);
  const el = (tag, props = {}, children = []) => {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k === "class") node.className = v;
      else if (k === "text") node.textContent = v;
      else if (k === "html") node.innerHTML = v;
      else if (k.startsWith("on")) node.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k in node && typeof v !== "string") node[k] = v;
      else node.setAttribute(k, v === true ? "" : v);
    }
    for (const child of [].concat(children)) {
      if (child != null && child !== false) node.append(child);
    }
    return node;
  };
  NAIIcons.hydrate();
  // Filled icons from icons.js; local names map onto the shared set.
  const ICON_ALIASES = { all: "grid", alert: "warning", drop: "download_circle" };
  const icon = (name, size = 16) => NAIIcons.svg(ICON_ALIASES[name] || name, size);

  const state = {
    entries: [],        // stored pictures, newest first
    dropped: [],        // files opened/dropped this session (not stored)
    files: new Map(),   // id -> File for dropped pictures
    nav: "all",
    cullNav: "",        // 셀렉 filter, combined with nav
    query: "",
    sel: [],
    anchor: null,
    ptab: null,
    shown: [],
    rendered: 0,
    root: null,         // FileSystemDirectoryHandle
    rootPerm: "none",   // none | granted | prompt
    scan: null,         // { done, total }
    saveFolder: "NovelAI",
  };
  const thumbUrls = new Map();
  const PAGE = 120;
  const today = () => LibDB.dateKey(Date.now());

  // ------------------------------------------------------------------ data ---
  // Character from the save folder (see LibDB.characterOf), worked out again
  // on load so older entries and a changed 저장 폴더 follow along.
  function fixChar(entry) {
    if (entry && entry.source !== "dropped") entry.char = LibDB.characterOf(entry.name, entry.path, state.saveFolder);
    return entry;
  }
  async function loadEntries() {
    const all = (await LibDB.all()).map(fixChar);
    all.sort((a, b) => b.savedAt - a.savedAt);
    state.entries = all;
  }
  // One picture file = one entry. The same file could get in twice: once when
  // it was saved ("NovelAI/…") and once from the linked folder under another
  // path (e.g. the 다운로드 folder was linked: "Downloads/NovelAI/…"). Same file
  // name + same size is the same picture; keep one and carry its 셀렉 over.
  const pictureSig = (name, size) => `${String(name).toLowerCase()}|${size}`;
  const SOURCE_RANK = { saved: 0, folder: 1, clean: 2, censored: 3 };
  async function dropDuplicateEntries() {
    const keep = new Map();
    const drop = [];
    const sorted = state.entries.slice().sort((a, b) => (SOURCE_RANK[a.source] ?? 9) - (SOURCE_RANK[b.source] ?? 9) || a.id.length - b.id.length);
    for (const e of sorted) {
      if (!e.bytes) continue;
      const sig = pictureSig(e.name, e.bytes);
      const first = keep.get(sig);
      if (!first) {
        keep.set(sig, e);
        continue;
      }
      drop.push(e);
      const label = cullOf(e.id).label;
      if (label && !cullOf(first.id).label) state.cull.set(first.id, { label });
      state.cull.delete(e.id);
    }
    if (!drop.length) return;
    const gone = new Set(drop.map((e) => e.id));
    state.entries = state.entries.filter((e) => !gone.has(e.id));
    for (const e of drop) await LibDB.remove(e.id).catch(() => {});
    saveCull();
  }
  function allEntries() {
    return state.dropped.concat(state.entries);
  }
  function byId(id) {
    return state.dropped.find((e) => e.id === id) || state.entries.find((e) => e.id === id) || null;
  }
  function thumbUrl(entry) {
    if (!entry.thumb) return "";
    let url = thumbUrls.get(entry.id);
    if (!url) {
      url = URL.createObjectURL(entry.thumb);
      thumbUrls.set(entry.id, url);
    }
    return url;
  }
  function upsert(entry) {
    fixChar(entry);
    invalidateGroups();
    dataVersion += 1;
    const list = entry.source === "dropped" ? state.dropped : state.entries;
    const i = list.findIndex((e) => e.id === entry.id);
    if (i >= 0) {
      const old = thumbUrls.get(entry.id);
      if (old && list[i].thumb !== entry.thumb) {
        URL.revokeObjectURL(old);
        thumbUrls.delete(entry.id);
      }
      list[i] = entry;
    } else {
      list.unshift(entry);
      list.sort((a, b) => b.savedAt - a.savedAt); // stored newest first; the grid order is sortShown()
    }
  }

  // ---------------------------------------------------------------- search ---
  function parseQuery(q) {
    const terms = [];
    const re = /(-?)"([^"]+)"|(-?)(\S+)/g;
    let m;
    while ((m = re.exec(q.toLowerCase()))) {
      const neg = Boolean(m[1] || m[3]);
      const word = (m[2] || m[4] || "").trim();
      if (word && !(word === "-" && !m[2])) terms.push({ neg, word });
    }
    return terms;
  }
  function matches(entry, terms) {
    if (!terms.length) return true;
    const hay = `${entry.search || ""}\n${entry.path.toLowerCase()}`;
    return terms.every((t) => (t.neg ? !hay.includes(t.word) : hay.includes(t.word)));
  }
  const NAV = {
    all: { title: "전체", icon: "all", test: () => true },
    today: { title: "오늘", icon: "today", test: (e) => e.date === today() },
    meta: { title: "메타데이터 있음", icon: "tag", test: (e) => e.hasMeta },
    clean: { title: "메타데이터 없음", icon: "shield", test: (e) => !e.hasMeta },
    dropped: { title: "불러온 파일", icon: "drop", test: (e) => e.source === "dropped" },
    censored: { title: "검열 사본", icon: "shield", test: (e) => e.source === "censored" },
  };
  function navTest(nav) {
    if (nav.startsWith("cull:")) {
      const want = nav.slice(5);
      return want === "none" ? (e) => !cullOf(e.id).label : (e) => cullOf(e.id).label === want;
    }
    if (nav.startsWith("char:")) {
      const name = nav.slice(5);
      return (e) => e.char === name;
    }
    return NAV[nav]?.test || NAV.all.test;
  }
  function navTitle(nav) {
    if (nav.startsWith("cull:")) return nav === "cull:none" ? NONE_LABEL : LABELS[nav.slice(5)] || "셀렉";
    return nav.startsWith("char:") ? nav.slice(5) || "이름 없음" : NAV[nav]?.title || "전체";
  }

  // ---------------------------------------------------------------- render ---
  function renderSidebar() {
    const all = allEntries();
    const nav = $(".nav");
    nav.innerHTML = "";
    const keys = ["all", "today", "meta", "clean"]
      .concat(state.entries.some((e) => e.source === "censored") ? ["censored"] : [])
      .concat(state.dropped.length ? ["dropped"] : []);
    for (const key of keys) {
      const count = all.filter(NAV[key].test).length;
      nav.append(navButton(key, NAV[key].title, NAV[key].icon, count));
    }
    // 셀렉 and 캐릭터 combine: counts on each side follow the other's choice.
    renderCullNav(all.filter(navTest(state.nav)));
    const cullTest = state.cullNav ? navTest(state.cullNav) : () => true;
    const chars = new Map();
    for (const e of all.filter(cullTest)) {
      if (e.char) chars.set(e.char, (chars.get(e.char) || 0) + 1);
    }
    const list = $(".nav-chars");
    list.innerHTML = "";
    [...chars.entries()].sort((a, b) => b[1] - a[1]).slice(0, 30).forEach(([name, count]) => {
      list.append(navButton(`char:${name}`, name, "person", count));
    });
    renderFolderBox();
    renderNotionBox();
    renderAesBox();
  }
  const isCullKey = (key) => key.startsWith("cull:");
  function navButton(key, label, iconName, count) {
    const button = el("button", {
      class: "nav-item", type: "button", "aria-current": String(isCullKey(key) ? state.cullNav === key : state.nav === key),
      onclick: () => setNav(key),
      html: `${icon(iconName)}<span class="label"></span><span class="num">${count.toLocaleString("ko-KR")}</span>`,
    });
    button.querySelector(".label").textContent = label;
    return button;
  }
  function setNav(key) {
    if (state.settings) {
      state.settings = false;
      document.querySelector(".app").removeAttribute("data-settings");
      $(".settings-open").setAttribute("aria-current", "false");
      $(".settings-pane").hidden = true;
    }
    if (isCullKey(key)) state.cullNav = state.cullNav === key ? "" : key; // press again to turn off
    else state.nav = key;
    state.sel = [];
    render();
  }

  // A connection row looks like a sidebar item, not a card: icon, name, and a
  // quiet status on the right. Not yet connected → the name is the action.
  function connRow({ iconName, title, sub, meta, action, actionTitle, extra }) {
    const row = el(action ? "button" : "div", { class: "conn-row", type: action ? "button" : null, title: actionTitle || null, onclick: action || null }, [
      el("span", { class: "conn-ic", html: icon(iconName, 15) }),
      el("span", { class: "conn-text" }, [el("span", { class: "conn-title", text: title }), sub ? el("span", { class: "conn-sub", text: sub }) : null]),
      meta ? el("span", { class: "conn-meta", html: meta }) : null,
    ]);
    return extra ? el("div", { class: "conn-line" }, [row, extra]) : row;
  }

  function renderFolderBox() {
    const box = $(".folder-box");
    box.innerHTML = "";
    if (state.scan) {
      box.dataset.state = "scan";
      const pct = state.scan.total ? Math.round((state.scan.done / state.scan.total) * 100) : 0;
      box.append(
        connRow({ iconName: "folder", title: "폴더 훑는 중…", sub: `${state.scan.done.toLocaleString("ko-KR")} / ${state.scan.total.toLocaleString("ko-KR")}장${state.scan.added ? ` · 새로 ${state.scan.added}장` : ""}` }),
        el("div", { class: "progress", html: `<span style="width:${pct}%"></span>` }),
      );
      return;
    }
    if (state.root && state.rootPerm === "granted") {
      box.dataset.state = "ok";
      box.append(connRow({
        iconName: "folder", title: `${state.root.name} 폴더`,
        meta: `<i class="dot"></i>${state.entries.length.toLocaleString("ko-KR")}장`,
        sub: state.pendingGone?.length ? `폴더에 없는 그림 ${state.pendingGone.length.toLocaleString("ko-KR")}장 · ↻로 정리` : null,
        extra: el("button", { class: "conn-act", type: "button", title: "폴더와 맞추기 (새 그림 넣고, 없어진 그림 빼기)", "aria-label": "폴더와 맞추기", html: icon("refresh", 14), onclick: () => void syncFolder({ quiet: false }) }),
      }));
      return;
    }
    box.dataset.state = state.root ? "prompt" : "none";
    box.append(connRow({
      iconName: "folder",
      title: state.root ? "폴더 다시 허락하기" : "NovelAI 폴더 연결",
      sub: state.root ? "크롬이 다시 물어봐요" : "예전에 저장한 그림도 보여요",
      action: () => void connectFolder(),
      actionTitle: state.root ? "폴더 접근 다시 허락하기" : "다운로드 안의 NovelAI 폴더를 골라 연결해요",
    }));
  }

  function countText() {
    const n = (state.shown || []).length.toLocaleString("ko-KR");
    return state.found ? `${n}장 찾음` : `${n}장`;
  }

  function render() {
    invalidateGroups();
    const terms = parseQuery(state.query);
    const test = navTest(state.nav);
    const cullTest = state.cullNav ? navTest(state.cullNav) : () => true;
    state.shown = sortShown(allEntries().filter((e) => !state.hiding.has(e.id) && test(e) && cullTest(e) && matches(e, terms)));
    renderSortButton();
    const visible = new Set(state.shown.map((e) => e.id));
    state.sel = state.sel.filter((id) => visible.has(id));
    $(".title").textContent = state.cullNav
      ? (state.nav === "all" ? navTitle(state.cullNav) : `${navTitle(state.cullNav)} · ${navTitle(state.nav)}`)
      : navTitle(state.nav);
    state.found = terms.length > 0;
    renderPickBar();
    renderSidebar();
    renderBanner();
    const grid = $(".grid");
    grid.innerHTML = "";
    grid.dataset.multi = String(state.sel.length > 1);
    state.rendered = 0;
    grid.hidden = state.board;
    $(".board").hidden = !state.board;
    renderBoardButton();
    if (state.board) renderBoard();
    else renderMoreTiles();
    feedAesFromView();
    const empty = $(".empty");
    if (!state.shown.length) {
      empty.hidden = false;
      empty.innerHTML = allEntries().length
        ? "<strong>찾는 그림이 없어요</strong>다른 단어로 찾아보거나 왼쪽에서 ‘전체’를 눌러 보세요."
        : "<strong>아직 그림이 없어요</strong>NovelAI에서 자동 저장한 그림이 여기 쌓여요.<br>예전 그림은 왼쪽 아래에서 폴더를 연결하면 보여요.<br>그림 파일을 이 창에 끌어 놓아도 돼요.";
    } else {
      empty.hidden = true;
    }
    renderInspector();
  }

  // ---- 정렬: how the grid (and ←/→, 셀렉, 크게 보기) runs through pictures.
  const SORTS = [
    ["new", "최근 저장순", "새로 저장한 그림이 위로"],
    ["old", "오래된 순", "먼저 저장한 그림이 위로"],
    ["group", "같은 이름끼리", "같은 이름 그림을 붙여서 · 묶음은 최근 순"],
    ["name", "이름순", "가나다 · (1) (2) (10) 순서로"],
    ["aes", "미적 점수순", "점수 높은 그림이 위로 · 미적 점수를 켜면 돼요"],
  ];
  const SORT_KEY = "naiAutoSaver.librarySort";
  state.sort = "new";
  try {
    const saved = localStorage.getItem(SORT_KEY);
    if (SORTS.some(([k]) => k === saved)) state.sort = saved;
  } catch (error) {
    void error;
  }
  const nameOrder = new Intl.Collator("ko", { numeric: true, sensitivity: "base" });
  // The full order is worked out once and reused (by rank) until the
  // pictures change, so filtering a big library stays quick in 이름순 too.
  let sortCache = null;
  function sortShown(list) {
    if (state.sort === "name" || state.sort === "group") {
      const sig = [state.sort, dataVersion, state.entries, state.entries.length, state.dropped.length];
      if (!sortCache || sortCache.sig.some((v, i) => v !== sig[i])) {
        const rank = new Map();
        sortByName(allEntries()).forEach((e, i) => rank.set(e.id, i));
        sortCache = { sig, rank };
      }
      const rank = sortCache.rank;
      return list.sort((a, b) => (rank.get(a.id) ?? 0) - (rank.get(b.id) ?? 0));
    }
    return sortByName(list);
  }
  function sortByName(list) {
    if (state.sort === "aes" && aes.on) {
      const sc = (e) => { const v = Aesthetic.rank(e.id); return v == null ? -1 : v; };
      return list.sort((a, b) => sc(b) - sc(a) || b.savedAt - a.savedAt);
    }
    if (state.sort === "old") return list.sort((a, b) => a.savedAt - b.savedAt);
    if (state.sort !== "name" && state.sort !== "group") return list.sort((a, b) => b.savedAt - a.savedAt);
    // work out each name's group / number once (a big library sorts fast)
    const rows = list.map((e) => {
      const key = groupKeyOf(e);
      return { e, key, n: String(e.name).slice(key.length).trim() };
    });
    if (state.sort === "name") {
      rows.sort((a, b) => nameOrder.compare(a.key, b.key) || nameOrder.compare(a.n, b.n) || a.e.savedAt - b.e.savedAt);
    } else {
      const newest = new Map();
      for (const r of rows) if (!(newest.get(r.key) >= r.e.savedAt)) newest.set(r.key, r.e.savedAt);
      rows.sort((a, b) => (a.key === b.key ? 0 : newest.get(b.key) - newest.get(a.key) || nameOrder.compare(a.key, b.key))
        || nameOrder.compare(a.n, b.n) || a.e.savedAt - b.e.savedAt);
    }
    return rows.map((r) => r.e);
  }
  function setSort(key) {
    if (state.sort === key) return;
    state.sort = key;
    try {
      localStorage.setItem(SORT_KEY, key);
    } catch (error) {
      void error;
    }
    const keep = state.sel[0];
    render();
    $(".gallery").scrollTop = 0;
    if (keep) document.querySelector(`.tile[data-id="${CSS.escape(keep)}"]`)?.scrollIntoView({ block: "nearest" });
  }
  function renderSortButton() {
    const btn = $(".sort-btn");
    if (!btn) return;
    const [, label] = SORTS.find(([k]) => k === state.sort) || SORTS[0];
    btn.innerHTML = `${icon("sort", 15)}<span>${label}</span>`;
  }
  function openSortMenu(event) {
    event.stopPropagation();
    const wrap = $(".sort-wrap");
    const open = wrap.querySelector(".menu");
    if (open) {
      open.remove();
      return;
    }
    const menu = el("div", { class: "menu sort-menu", role: "menu" });
    for (const [key, label, hint] of SORTS) {
      menu.append(el("button", { type: "button", role: "menuitemradio", "aria-checked": String(state.sort === key), onclick: () => { menu.remove(); setSort(key); } }, [
        el("span", { class: "sort-check", html: state.sort === key ? icon("check", 13) : "" }),
        el("span", { class: "sort-text" }, [el("span", { text: label }), el("small", { text: hint })]),
      ]));
    }
    wrap.append(menu);
  }

  // ---- 미적 점수: an anime aesthetic model scores each picture (0–100) in
  // the background; a 칸 then opens best-first, and the bottom N% can be
  // skipped. The user decides how far to trust it with 「내 셀렉과 맞춰 보기」.
  const AES_KEY = "aesSettings";
  const aes = { on: false, skip: 0 };
  async function loadAes() {
    try {
      const saved = await LibDB.getKv(AES_KEY);
      if (saved && typeof saved === "object") Object.assign(aes, { on: Boolean(saved.on), skip: [0, 30, 50, 70].includes(saved.skip) ? saved.skip : 0 });
    } catch (error) {
      void error;
    }
    if (aes.on) await Aesthetic.loadScores();
  }
  function saveAes() {
    void LibDB.setKv(AES_KEY, { ...aes }).catch(() => {});
  }
  const aesReady = () => aes.on && Aesthetic.status().phase === "ready";
  const aesItem = (id) => {
    const e = byId(id);
    return e && e.thumb ? { id, blob: () => e.thumb } : null;
  };
  function scoreText(id) {
    const s = Aesthetic.rank(id);
    const label = Aesthetic.usingTaste() ? "내 점수" : "점수";
    return s == null ? `${label} …` : `${label} ${Math.round(s)}`;
  }
  function aesBadge(id) {
    if (!aes.on) return null;
    return el("span", { class: "cmp-score", "data-score-id": id, title: Aesthetic.usingTaste() ? "내 점수: 내 셀렉으로 배운 점수 (0–100)" : "미적 점수 (0–100)", text: scoreText(id) });
  }
  // Best first, and the bottom N% of the not-yet-sorted ones out of the way —
  // once every picture of the 칸 has a score, and only before the user started.
  function applyAesOrder() {
    if (!aes.on || cmp.aesApplied) return;
    if (!cmp.ids.every((id) => Aesthetic.hasRank(id))) return;
    cmp.aesApplied = true;
    const s = (id) => Aesthetic.rank(id);
    cmp.ids.sort((a, b) => s(b) - s(a));
    if (aes.skip) {
      const ranked = cmp.ids.slice(); // best → worst
      const cut = Math.floor((ranked.length * aes.skip) / 100);
      const keepAtLeast = 2;
      const bottom = ranked.slice(Math.max(keepAtLeast, ranked.length - cut));
      cmp.skipped = new Set(bottom.filter((id) => !cullOf(id).label));
    }
    cmp.lane.a = 0;
    cmp.lane.aId = null;
    pickLeftLane();
  }
  function renderAesChip() {
    const chip = $(".cmp-aes");
    if (!chip) return;
    const n = cmp.skipped.size;
    const waiting = aes.on && !cmp.aesApplied ? cmp.ids.filter((id) => !Aesthetic.hasRank(id)).length : 0;
    chip.hidden = !(n || waiting);
    chip.innerHTML = "";
    if (waiting) {
      chip.append(el("span", { class: "cmp-aes-text", text: Aesthetic.status().phase === "ready" ? `점수 매기는 중 · ${waiting}장 남음` : "미적 점수 준비 중…" }));
    } else if (n) {
      chip.append(
        el("span", { class: "cmp-aes-text", text: `점수 아래쪽 ${n}장 건너뜀` }),
        el("button", { type: "button", "data-aes": "show", text: "보기" }),
        el("button", { type: "button", "data-aes": "hold", text: "B컷으로" }),
      );
    }
  }
  function feedAesFromCompare() {
    if (!aes.on) return;
    Aesthetic.want(cmp.ids.map(aesItem).filter(Boolean), { front: true });
    // the next 칸 to do, so it is ready by the time the user gets there
    const seq = groupSequence().filter((g) => g.ids.length > 1);
    const at = seq.findIndex((g) => g.key === cmp.group);
    const next = [];
    for (let i = 1; i < seq.length && next.length < 3; i += 1) {
      const g = seq[(at + i) % seq.length];
      if (!groupDone(g.ids)) next.push(...g.ids);
    }
    Aesthetic.want(next.map(aesItem).filter(Boolean), { front: false });
  }
  let feedTimer = null;
  function feedAesFromView() {
    if (!aes.on) return;
    clearTimeout(feedTimer);
    feedTimer = setTimeout(() => {
      const ids = state.board ? boardOrder.flatMap((g) => (groupDone(g.ids) ? [] : g.ids)) : (state.shown || []).map((e) => e.id);
      Aesthetic.want(ids.slice(0, 5000).map(aesItem).filter(Boolean));
    }, 1500);
  }
  let aesBoxTimer = null;
  let settingsDrawn = 0;
  function onAesEvent(event) {
    if (event.type === "score") {
      // the 점수 badge in the compare view, if it is showing that picture
      document.querySelectorAll(`.cmp-score[data-score-id="${CSS.escape(event.id)}"]`).forEach((b) => { b.textContent = scoreText(event.id); });
      if (!$(".compare").hidden && cmp.ids.includes(event.id)) {
        if (!cmp.aesApplied && !cmp.touched && cmp.ids.every((id) => Aesthetic.hasRank(id))) {
          applyAesOrder();
          renderCompare({ keepImages: true });
        } else {
          renderAesChip();
        }
      }
      if (sortNeedsScores()) scheduleScoreSort();
    }
    clearTimeout(aesBoxTimer);
    aesBoxTimer = setTimeout(() => {
      renderAesBox();
      refreshAesSheet();
      if (state.settings && Date.now() - settingsDrawn > 1500 && !document.querySelector(".set-scroll select:focus")) { settingsDrawn = Date.now(); void renderSettings(); }
    }, event.type === "score" ? 400 : 0);
  }
  const sortNeedsScores = () => state.sort === "aes" && !state.board;
  let scoreSortTimer = null;
  function scheduleScoreSort() {
    // redraw for the new order only when the user is not busy in the grid
    clearTimeout(scoreSortTimer);
    scoreSortTimer = setTimeout(() => {
      if (Date.now() - lastInput < 3000 || !$(".compare").hidden || !$(".lightbox").hidden) return scheduleScoreSort();
      const y = $(".gallery").scrollTop;
      render();
      $(".gallery").scrollTop = y;
    }, 4000);
  }
  function renderAesBox() {
    const box = $(".aes-box");
    if (!box) return;
    box.innerHTML = "";
    const st = Aesthetic.status();
    const pct = Math.round((st.progress || 0) * 100);
    if (!aes.on) {
      box.dataset.state = "none";
      box.append(connRow({ iconName: "sparkle", title: "미적 점수", sub: "점수 높은 그림부터 보기", action: () => void openAesSettings(), actionTitle: "애니 미적 점수 모델로 그림마다 점수를 매겨요" }));
      return;
    }
    box.dataset.state = st.phase === "error" ? "warn" : "ok";
    const sub = st.phase === "downloading" ? `모델 받는 중 · ${pct}%`
      : st.phase === "loading" ? "준비하는 중…"
        : st.phase === "error" ? "시작하지 못했어요 · 눌러서 보기"
          : st.queued ? `점수 매기는 중 · 남은 ${st.queued.toLocaleString("ko-KR")}장`
            : `준비됨${aes.skip ? ` · 아래쪽 ${aes.skip}% 건너뛰기` : ""}`;
    box.append(connRow({ iconName: "sparkle", title: "미적 점수", sub, meta: st.phase === "ready" ? '<i class="dot"></i>켜짐' : "", action: () => void openAesSettings(), actionTitle: "미적 점수 설정" }));
    if (st.phase === "downloading") box.append(el("div", { class: "progress", html: `<span style="width:${pct}%"></span>` }));
  }

  // The 칸 the user already chose in: same name, 3+ pictures, at least one
  // 채택 and one not. Those that have every score and fingerprint can be learned from.
  function learnableGroups() {
    const groups = new Map();
    for (const e of state.entries) {
      const k = groupKeyOf(e);
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(e.id);
    }
    const ready = [];
    const need = [];
    let total = 0;
    let pictures = 0;
    for (const [key, ids] of groups) {
      if (ids.length < 3) continue;
      const picks = ids.filter((id) => cullOf(id).label === "pick").length;
      if (!picks || picks === ids.length) continue;
      total += 1;
      pictures += ids.length;
      const missing = ids.filter((id) => Aesthetic.needs(id));
      if (missing.length) need.push(...missing);
      else ready.push({ key, ids });
    }
    return { ready, need, total, pictures };
  }
  let tasteRun = null; // { p } while training
  async function trainTaste(redraw) {
    const { ready } = learnableGroups();
    tasteRun = { p: 0 };
    redraw();
    try {
      const fps = await Aesthetic.fingerprints(ready.flatMap((g) => g.ids));
      const groups = ready.map((g) => ({
        key: g.key,
        items: g.ids.filter((id) => fps.has(id)).map((id) => ({ id, label: cullOf(id).label || "none", x: fps.get(id), base: Aesthetic.score(id) })),
      }));
      const result = await new Promise((resolve, reject) => {
        const w = new Worker(chrome.runtime.getURL("taste-worker.js"));
        w.onmessage = ({ data }) => {
          if (data.type === "progress") {
            tasteRun.p = data.p;
            redraw();
          } else if (data.type === "done") {
            w.terminate();
            resolve(data.result);
          } else {
            w.terminate();
            reject(new Error(data.error));
          }
        };
        w.onerror = (e) => { w.terminate(); reject(new Error(e.message || "학습하지 못했어요.")); };
        w.postMessage({ groups });
      });
      if (!result.ok) {
        toast(result.reason === "few" ? "학습할 칸이 아직 적어요. 채택해 둔 칸이 8개 이상 필요해요." : "학습하지 못했어요.", "warn");
      } else {
        await Aesthetic.setTaste(result);
        toast(result.better ? "내 점수를 만들었어요. 이제 칸을 열면 내 점수 순서로 나와요." : "학습했지만 아직은 일반 점수가 더 맞아요. 셀렉을 더 하고 다시 해 보세요.", result.better ? "ok" : "warn");
      }
    } catch (error) {
      toast(`학습하지 못했어요: ${error.message || error}`, "warn");
    } finally {
      tasteRun = null;
      redraw();
      if (!$(".compare").hidden) { cmp.aesApplied = false; if (!cmp.touched) { applyAesOrder(); renderCompare({ keepImages: true }); } }
    }
  }
  function tasteSection(redraw) {
    const box = el("div", { class: "aes-report" });
    if (Aesthetic.fingerprintsSupported() === false) {
      box.append(el("p", { class: "sheet-note", text: "이 모델에서는 그림 지문을 꺼내지 못해서 내 점수를 만들 수 없어요. 일반 점수는 그대로 쓸 수 있어요." }));
      // how the general score does on the 칸 already chosen
      const ranks = [];
      for (const g of learnableGroups().ready) {
        const sorted = g.ids.slice().sort((a, b) => Aesthetic.score(b) - Aesthetic.score(a));
        for (const id of g.ids) if (cullOf(id).label === "pick") ranks.push(sorted.indexOf(id) / (sorted.length - 1));
      }
      if (ranks.length >= 5) {
        const share = (f) => Math.round((ranks.filter(f).length / ranks.length) * 100);
        box.append(el("p", {}, [el("b", { text: `채택 ${ranks.length}장 중 ${share((r) => r <= 0.3)}%` }), document.createTextNode("가 같은 칸에서 점수 위쪽 30% 안에 있었어요. (점수가 아무 의미 없으면 30% 정도)")]),
          el("p", { class: "sheet-note", text: `건너뛰었다면 놓쳤을 채택: 아래쪽 30% → ${share((r) => r > 0.7)}% · 50% → ${share((r) => r > 0.5)}% · 70% → ${share((r) => r > 0.3)}%` }));
      }
      const need = learnableGroups().need;
      if (need.length) {
        const go = el("button", { class: "btn small secondary", type: "button", text: `채택해 둔 칸 점수 매기기 (${need.length.toLocaleString("ko-KR")}장)` });
        go.addEventListener("click", () => { Aesthetic.want(need.map(aesItem).filter(Boolean), { front: true }); go.disabled = true; go.textContent = "점수 매기는 중…"; });
        box.append(el("div", { class: "aes-actions" }, [go]));
      }
      return box;
    }
    const lg = learnableGroups();
    const fmt = (n) => n.toLocaleString("ko-KR");
    box.append(el("p", { class: "sheet-note", text: "채택해 둔 칸에서 「같은 칸 안에서 무엇을 골랐나」를 배워요 (채택 > B컷 > 미분류 > 탈락). 학습에 안 쓴 칸으로 확인해서, 일반 점수보다 나을 때만 써요." }));
    box.append(el("p", {}, [el("b", { text: `배울 수 있는 칸 ${fmt(lg.total)}개` }), document.createTextNode(` · 준비된 칸 ${fmt(lg.ready.length)}개`)]));
    if (lg.need.length) {
      const have = lg.pictures - lg.need.length;
      box.append(el("div", { class: "aes-progress" }, [
        el("span", { text: `그림 지문 ${fmt(have)} / ${fmt(lg.pictures)}장` }),
        el("span", { class: "bar" }, [el("i", { style: `width:${lg.pictures ? Math.round((have / lg.pictures) * 100) : 0}%` })]),
      ]));
    }
    const row = el("div", { class: "aes-actions" });
    if (lg.need.length) {
      const queuedAll = lg.need.every((id) => !Aesthetic.needs(id)) || Aesthetic.pending() >= lg.need.length;
      const go = el("button", { class: "btn small secondary", type: "button", text: queuedAll ? "지문 모으는 중…" : `지문 모으기 (${fmt(lg.need.length)}장)` });
      go.disabled = queuedAll;
      go.addEventListener("click", () => {
        Aesthetic.want(lg.need.map(aesItem).filter(Boolean), { front: true });
        go.disabled = true;
        go.textContent = "지문 모으는 중…";
      });
      row.append(go);
    }
    const trainBtn = el("button", { class: "btn small", type: "button", text: tasteRun ? `학습 중… ${Math.round(tasteRun.p * 100)}%` : Aesthetic.taste() ? "다시 학습하기" : "학습하기" });
    trainBtn.disabled = Boolean(tasteRun) || lg.ready.length < 8;
    if (!tasteRun && lg.ready.length < 8) box.append(el("p", { class: "sheet-note", text: `학습은 준비된 칸이 8개부터 돼요 (30개 넘으면 더 정확해요). 배울 수 있는 칸은 채택 1장 + 나머지 B컷처럼, 고른 것과 안 고른 것이 같이 있는 칸이에요.` }));
    trainBtn.title = lg.ready.length < 8 ? "준비된 칸이 8개 이상 있어야 해요 (30개 이상 권장)" : "";
    trainBtn.addEventListener("click", () => void trainTaste(redraw));
    row.append(trainBtn);
    box.append(row);
    if (lg.ready.length && lg.ready.length < 30 && !tasteRun) box.append(el("p", { class: "sheet-note", text: "칸이 30개 이상 모이면 더 믿을 만해요. 지문 모으기는 뒤에서 계속돼요." }));
    const t = Aesthetic.taste();
    if (t) {
      const pct = (v) => `${Math.round(v)}%`;
      const table = el("table", { class: "aes-table" }, [
        el("thead", {}, [el("tr", {}, [el("th", { text: "" }), el("th", { text: "일반 점수" }), el("th", { text: "내 점수" })])]),
        el("tbody", {}, [
          ["같은 칸 두 장 중 채택을 위로 본 비율", t.generic.pairAcc, t.personal.pairAcc, true],
          ["채택이 위쪽 30% 안에 든 비율", t.generic.top30, t.personal.top30, true],
          ["아래쪽 30% 건너뛰면 놓치는 채택", t.generic.lost[30], t.personal.lost[30], false],
          ["아래쪽 50% 건너뛰면 놓치는 채택", t.generic.lost[50], t.personal.lost[50], false],
          ["아래쪽 70% 건너뛰면 놓치는 채택", t.generic.lost[70], t.personal.lost[70], false],
        ].map(([label, g, p, up]) => el("tr", {}, [
          el("td", { text: label }),
          el("td", { text: pct(g) }),
          el("td", { class: (up ? p > g : p < g) ? "better" : "", text: pct(p) }),
        ]))),
      ]);
      box.append(
        el("p", { class: "sheet-note", text: `${new Date(t.at).toLocaleString("ko-KR")} · 칸 ${fmt(t.groups)}개 · 그림 ${fmt(t.pictures)}장으로 학습 · 숫자는 학습에 안 쓴 칸으로 잰 거예요` }),
        table,
        el("p", { class: "sheet-note", text: t.better ? "내 점수가 네 셀렉을 더 잘 맞혀요." : "아직은 일반 점수가 더 맞아요. 셀렉을 더 하고 다시 학습해 보세요." }),
      );
      const use = el("input", { type: "checkbox", id: "aes-taste", checked: Aesthetic.usingTaste() });
      use.classList.add("ios-switch");
      use.addEventListener("change", async () => {
        await Aesthetic.setUseTaste(use.checked);
        if (!$(".compare").hidden) { cmp.aesApplied = false; if (!cmp.touched) { applyAesOrder(); renderCompare({ keepImages: true }); } }
        redraw();
      });
      box.append(el("div", { class: "ios-group" }, [el("label", { class: "ios-row", for: "aes-taste" }, [el("span", { class: "grow" }, [document.createTextNode("칸 순서·건너뛰기에 내 점수 쓰기"), el("small", { text: "끄면 일반 점수로 해요" })]), use])]));
      box.append(el("button", { class: "btn small plain", type: "button", text: "내 점수 지우기", onclick: async () => { await Aesthetic.clearTaste(); redraw(); } }));
    }
    return box;
  }
  let refreshAesSheet = () => {};
  async function openAesSettings() {
    const { dialog, body, right: save } = notionDialogShell("미적 점수", { leftLabel: "닫기", rightLabel: "" });
    save.hidden = true;
    const draw = () => {
      body.innerHTML = "";
      const st = Aesthetic.status();
      const on = el("input", { type: "checkbox", id: "aes-on", checked: aes.on });
      on.classList.add("ios-switch");
      on.addEventListener("change", async () => {
        aes.on = on.checked;
        saveAes();
        if (aes.on) {
          await Aesthetic.loadScores();
          void Aesthetic.start().then(() => { feedAesFromView(); }, () => {});
          feedAesFromView();
        } else {
          Aesthetic.stop();
        }
        renderAesBox();
        draw();
      });
      body.append(
        el("p", { class: "sheet-note", text: "애니 그림 미적 점수 모델로 그림마다 0–100점을 매겨요. 칸을 열면 점수 높은 그림부터 나오고, 원하면 점수 아래쪽은 건너뛰어요. 고르는 건 그대로 네가 해요." }),
        el("div", { class: "ios-group" }, [el("label", { class: "ios-row", for: "aes-on" }, [el("span", { class: "grow" }, [document.createTextNode("미적 점수 켜기"), el("small", { text: `처음 켤 때 모델을 한 번 받아요 (약 ${Aesthetic.MODEL.sizeMB}MB) · 그림은 밖으로 안 나가요` })]), on])]),
      );
      if (aes.on) {
        const phaseText = st.phase === "downloading" ? `모델 받는 중 · ${Math.round(st.progress * 100)}%`
          : st.phase === "loading" ? "준비하는 중…"
            : st.phase === "error" ? `시작하지 못했어요: ${st.error}`
              : st.phase === "ready" ? (st.queued ? `점수 매기는 중 · 남은 ${st.queued.toLocaleString("ko-KR")}장 (한 번에 ${st.threads}개씩)` : "준비됐어요. 보는 그림부터 뒤에서 점수를 매겨요.") : "";
        if (phaseText) body.append(el("p", { class: st.phase === "error" ? "sheet-warn" : "sheet-note", text: phaseText }));
        const radios = [[0, "건너뛰지 않기", "순서만 점수 높은 순으로"], [30, "아래쪽 30%", ""], [50, "아래쪽 50%", ""], [70, "아래쪽 70%", "과감하게"]];
        body.append(el("div", { class: "ios-group-label", text: "칸을 열 때 점수 아래쪽 건너뛰기" }));
        const group = el("div", { class: "ios-group" });
        for (const [v, label, hint] of radios) {
          const r = el("input", { type: "radio", name: "aes-skip", id: `aes-skip-${v}`, checked: aes.skip === v });
          r.classList.add("ios-check");
          r.addEventListener("change", () => { aes.skip = v; saveAes(); renderAesBox(); });
          group.append(el("label", { class: "ios-row", for: `aes-skip-${v}` }, [el("span", { class: "grow" }, [document.createTextNode(label), hint ? el("small", { text: hint }) : null]), r]));
        }
        body.append(group, el("p", { class: "sheet-note", text: "건너뛴 그림은 미분류로 남고, 비교 화면 위의 「보기」로 다시 볼 수 있어요. 「B컷으로」를 누르면 한꺼번에 B컷이 돼요." }));
        // 내 셀렉으로 학습
        body.append(el("div", { class: "ios-group-label", text: "내 셀렉으로 학습 (내 점수)" }));
        body.append(tasteSection(draw));
        body.append(el("p", { class: "sheet-note", text: `모델: ${Aesthetic.MODEL.repo} (${Aesthetic.MODEL.license}). 많은 사람이 좋아하는 평균 취향이라 네 기준과 다를 수 있어요.` }));
        body.append(el("button", { class: "sheet-danger", type: "button", text: "미적 점수 끄고 모델 지우기", onclick: async () => {
          aes.on = false;
          saveAes();
          await Aesthetic.removeModel();
          renderAesBox();
          dialog.close();
          toast("미적 점수를 끄고 모델을 지웠어요. 매긴 점수는 남아 있어요.");
        } }));
      }
    };
    let last = 0;
    refreshAesSheet = () => {
      if (!dialog.open) return;
      if (Date.now() - last < 1200) return; // not on every score
      last = Date.now();
      const y = dialog.querySelector(".dialog-body")?.scrollTop || 0;
      draw();
      const b = dialog.querySelector(".dialog-body");
      if (b) b.scrollTop = y;
    };
    dialog.addEventListener("close", () => { refreshAesSheet = () => {}; }, { once: true });
    draw();
  }

  // ---- ⚙ 설정: the 보관함's settings in one pane, laid out like the NovelAI
  // panel's 설정 (모양 · 보관함 · 미적 점수 · 태그 뜻 · 데이터 · version).
  state.settings = false;
  function openSettings(on = true) {
    state.settings = Boolean(on);
    document.querySelector(".app").toggleAttribute("data-settings", state.settings);
    $(".settings-open").setAttribute("aria-current", String(state.settings));
    $(".settings-pane").hidden = !state.settings;
    if (state.settings) {
      $(".title").textContent = "설정";
      $(".count").textContent = "";
      void renderSettings();
      checkUpdate();
    } else {
      render();
    }
  }
  let updateInfo = null;
  function checkUpdate(force = false) {
    chrome.runtime.sendMessage({ action: "updateStatus", force }, (info) => {
      void chrome.runtime.lastError;
      updateInfo = info || null;
      if (state.settings) renderSettings();
    });
  }
  function setRow(title, sub, control, attrs = {}) {
    return el("div", { class: "set-row", ...attrs }, [
      el("span", { class: "set-label" }, [document.createTextNode(title), sub ? el("small", { text: sub }) : null]),
      control || null,
    ]);
  }
  function setSwitch(id, checked, onChange) {
    const input = el("input", { type: "checkbox", id, checked: Boolean(checked) });
    input.addEventListener("change", () => onChange(input.checked));
    return el("label", { class: "set-switch", for: id }, [input, el("span", { class: "set-slider" })]);
  }
  function setSeg(label, options, value, onPick) {
    const seg = el("div", { class: "set-seg", role: "radiogroup", "aria-label": label });
    for (const [v, text] of options) {
      seg.append(el("button", { type: "button", role: "radio", "aria-checked": String(value === v), text, onclick: (event) => {
        seg.querySelectorAll("button").forEach((b) => b.setAttribute("aria-checked", String(b === event.currentTarget)));
        onPick(v);
      } }));
    }
    return seg;
  }
  const setBtn = (text, run, primary = false) => el("button", { class: `btn small${primary ? "" : " secondary"}`, type: "button", text, onclick: run });
  let settingsSync = {};
  async function renderSettings() {
    const pane = $(".set-scroll");
    if (!pane) return;
    settingsSync = await chrome.storage.sync.get(["appearance", "tagHover", "tagHoverMachine"]);
    const y = pane.scrollTop;
    pane.innerHTML = "";
    const title = (t) => el("div", { class: "set-title", text: t });
    const group = (...rows) => el("div", { class: "set-group" }, rows.filter(Boolean));
    const fmt = (n) => n.toLocaleString("ko-KR");

    // 모양
    const look = el("div", { class: "set-appearance", role: "group", "aria-label": "모양" });
    for (const [v, label, sw] of [["auto", "자동", '<span style="background:#ECECEE"></span><span style="background:#2A2A2C"></span>'], ["light", "라이트", '<span style="background:#ECECEE"></span>'], ["dark", "다크", '<span style="background:#2A2A2C"></span>']]) {
      look.append(el("button", { type: "button", "data-active": String((settingsSync.appearance || "auto") === v), html: `<span class="set-swatch">${sw}</span>${label}`, onclick: async () => {
        await chrome.storage.sync.set({ appearance: v });
        look.querySelectorAll("button").forEach((b) => b.setAttribute("data-active", String(b.textContent === label)));
      } }));
    }
    pane.append(group(setRow("모양", "NovelAI 패널과 같이 바뀌어요", look)));

    // 보관함
    pane.append(title("보관함"));
    const linked = state.root && state.rootPerm === "granted";
    const folderSub = state.root ? `${state.root.name} · ${linked ? `${fmt(state.entries.length)}장` : "허락이 필요해요"}` : "연결하면 예전 그림도 보이고, 탐색기에서 바꾼 것도 따라가요";
    pane.append(group(
      setRow("연결한 폴더", folderSub, el("div", { class: "set-inline" }, [
        linked ? setBtn("폴더와 맞추기", () => void syncFolder({ quiet: false })) : null,
        setBtn(!state.root ? "연결하기…" : linked ? "다른 폴더로…" : "다시 허락하기", async () => {
          if (linked) state.root = null; // pick another one
          await connectFolder();
          renderFolderBox();
          renderSettings();
        }),
      ])),
      setRow("정렬", "그리드 · ←/→ · 셀렉 · 크게 보기 순서", (() => {
        const sel = el("select", { class: "set-select", "aria-label": "정렬" });
        for (const [k, label] of SORTS) sel.append(el("option", { value: k, text: label, selected: state.sort === k }));
        sel.addEventListener("change", () => setSort(sel.value));
        return sel;
      })()),
    ));

    // 미적 점수
    pane.append(title("미적 점수"));
    const st = Aesthetic.status();
    const aesSub = !aes.on ? `그림마다 0–100점 · 처음 켤 때 모델 약 ${Aesthetic.MODEL.sizeMB}MB를 한 번 받아요`
      : st.phase === "downloading" ? `모델 받는 중 · ${Math.round(st.progress * 100)}%`
        : st.phase === "loading" ? "준비하는 중…"
          : st.phase === "error" ? `시작하지 못했어요: ${st.error}`
            : st.queued ? `점수 매기는 중 · 남은 ${fmt(st.queued)}장` : "준비됐어요 · 보는 그림부터 뒤에서 매겨요";
    const rows = [setRow("미적 점수", aesSub, setSwitch("set-aes", aes.on, async (on) => {
      aes.on = on;
      saveAes();
      if (on) {
        await Aesthetic.loadScores();
        void Aesthetic.start().then(() => feedAesFromView(), () => {});
        feedAesFromView();
      } else {
        Aesthetic.stop();
      }
      renderAesBox();
      renderSettings();
    }))];
    if (aes.on) {
      rows.push(setRow("칸을 열 때 점수 아래쪽 건너뛰기", "건너뛴 그림은 미분류로 남아요 · 비교 화면 위에서 다시 보기", setSeg("건너뛰기", [[0, "끄기"], [30, "30%"], [50, "50%"], [70, "70%"]], aes.skip, (v) => { aes.skip = v; saveAes(); renderAesBox(); })));
      const t = Aesthetic.taste();
      const lg = learnableGroups();
      const tasteSub = Aesthetic.fingerprintsSupported() === false ? "이 모델에서는 만들 수 없어요"
        : t ? `${new Date(t.at).toLocaleDateString("ko-KR")} 학습 · 채택을 위로 본 비율 일반 ${Math.round(t.generic.pairAcc)}% → 내 점수 ${Math.round(t.personal.pairAcc)}%`
          : `배울 수 있는 칸 ${fmt(lg.total)}개 · 준비된 칸 ${fmt(lg.ready.length)}개${lg.need.length ? ` · 지문 ${fmt(lg.pictures - lg.need.length)} / ${fmt(lg.pictures)}장` : ""}`;
      rows.push(setRow("내 점수 (내 셀렉으로 학습)", tasteSub, setBtn(t ? "결과 · 다시 학습…" : "학습…", () => void openAesSettings())));
      if (t) rows.push(setRow("칸 순서·건너뛰기에 내 점수 쓰기", t.better ? "내 점수가 더 잘 맞아요" : "아직은 일반 점수가 더 맞아요", setSwitch("set-taste", Aesthetic.usingTaste(), async (on) => { await Aesthetic.setUseTaste(on); renderSettings(); })));
    }
    pane.append(group(...rows));

    // 태그 뜻
    pane.append(title("태그 뜻"));
    pane.append(group(
      setRow("태그에 마우스 올리면 한국어 뜻", "NovelAI 입력칸 · 패널 · 보관함", setSwitch("set-taghover", settingsSync.tagHover !== false, (on) => void chrome.storage.sync.set({ tagHover: on }))),
      setRow("사전에 없는 태그는 자동 번역", "크롬 내장 번역기 · 처음 한 번 내려받기", setSwitch("set-tagmachine", settingsSync.tagHoverMachine !== false, (on) => void chrome.storage.sync.set({ tagHoverMachine: on }))),
    ));

    // 데이터
    pane.append(title("데이터"));
    const nt = notionReady() ? `${notionCfg.title || "노션"} · 자동 보내기 ${notionCfg.autoSend ? "켜짐" : "꺼짐"}` : "그림·프롬프트를 노션 데이터베이스로";
    const dataRows = [setRow("노션 연결", nt, setBtn(notionReady() ? "설정…" : "연결하기…", () => void (notionReady() ? openNotionSettings() : openNotionConnect())))];
    const u = updateInfo;
    if (u?.eligible) {
      const sub = u.store ? "웹 스토어 버전이 나왔어요 · 업데이트가 자동이에요" : u.available ? `새 버전 ${u.latest} · 지금 ${u.current}` : u.error ? "확인하지 못했어요 · 인터넷을 확인해 주세요" : `최신 버전이에요 · ${u.current}`;
      dataRows.push(setRow("업데이트", sub, setBtn(u.store ? "옮기기…" : u.available ? "업데이트…" : "확인", () => {
        if (u.available || u.store) chrome.runtime.sendMessage({ action: "openUpdatePage" }, () => void chrome.runtime.lastError);
        else checkUpdate(true);
      }, Boolean(u.available || u.store))));
    }
    dataRows.push(setRow("보관함 안내", "할 수 있는 것과 단축키", setBtn("다시 보기", () => { openSettings(false); globalThis.LibraryTour?.open?.(); })));
    pane.append(group(...dataRows));
    pane.append(el("p", { class: "set-version", text: `NAI 자동저장 ${chrome.runtime.getManifest().version}` }));
    pane.scrollTop = y;
  }

  // ---- 셀렉 현황: 캐릭터마다 배경 × 표정 칸. A cell is one same-name group
  // (루페르타 밤_기쁨 (1)…(28)); it is done once it has a 채택. Click a cell
  // to 셀렉 it in 나란히.
  const BOARD_KEY = "naiAutoSaver.libraryBoard";
  state.board = false;
  try {
    state.board = localStorage.getItem(BOARD_KEY) === "1";
  } catch (error) {
    void error;
  }
  let comboNames = { bgs: [], emos: [], emoFirst: false, byChar: new Map() };
  async function loadComboNames() {
    try {
      const raw = (await chrome.storage.local.get("naiAutoSaver.generator"))["naiAutoSaver.generator"] || {};
      const bgs = new Set();
      const emos = [];
      const addEmos = (text) => {
        for (const line of String(text || "").split(/\n/)) {
          const m = line.match(/^\s*([^=,{}\[\]]{1,30}?)\s*=/);
          const name = m ? m[1].trim() : "";
          if (name && !emos.includes(name)) emos.push(name);
        }
      };
      for (const bg of raw.bgs || []) if (bg?.code?.trim()) bgs.add(bg.code.trim());
      addEmos(raw.sharedExpressions);
      for (const ch of raw.chars || []) {
        for (const bg of ch.bgs || []) if (bg?.code?.trim()) bgs.add(bg.code.trim());
        addEmos(ch.expressions);
      }
      // where 표정 sits against 배경 in the file name ("{캐릭터}_{표정} {배경}")
      const n = raw.naming || {};
      let emoFirst = false;
      if (typeof n.template === "string" && n.template.trim()) {
        const t = n.template;
        const at = (re) => { const m = t.search(re); return m < 0 ? Infinity : m; };
        emoFirst = at(/\{\s*(표정|감정|emo)\s*\}/i) < at(/\{\s*(배경|bg)\s*\}/i);
      } else if (Array.isArray(n.nameOrder)) {
        emoFirst = n.nameOrder.indexOf("emo") >= 0 && n.nameOrder.indexOf("emo") < n.nameOrder.indexOf("bg");
      }
      // per character: the 표정 and 배경 the 조합 screen makes for them
      const byChar = new Map();
      const namesOf = (text) => String(text || "").split(/\n/).map((line) => (line.match(/^\s*([^=,{}\[\]]{1,30}?)\s*=/) || [])[1]?.trim()).filter(Boolean);
      for (const ch of raw.chars || []) {
        const name = String(ch?.code || "").trim();
        if (!name) continue;
        byChar.set(name, {
          emos: raw.emoShared ? namesOf(raw.sharedExpressions) : namesOf(ch.expressions),
          bgs: (raw.bgShared === false ? ch.bgs || [] : raw.bgs || []).map((b) => String(b?.code || "").trim()).filter(Boolean),
        });
      }
      comboNames = { bgs: [...bgs].sort((a, b) => b.length - a.length), emos, emoFirst, byChar };
    } catch (error) {
      void error;
    }
  }
  // 캐릭터 · 배경 · 표정 of a picture: saved with it (조합, from 1.15.7) or
  // read back from its name ("루페르타 밤_기쁨 (3)").
  function axesOf(entry) {
    const char = entry.char || entry.axes?.char || "";
    if (entry.axes?.emo) return { char, bg: entry.axes.bg || "", emo: entry.axes.emo };
    const key = groupKeyOf(entry);
    let rest = char && key.startsWith(char) ? key.slice(char.length) : key;
    rest = rest.replace(/^[\s_-]+/, "");
    const sep = (text, at) => at >= text.length || /[\s_-]/.test(text[at]);
    const clean = (text) => text.replace(/^[\s_-]+|[\s_-]+$/g, "");
    for (const bg of comboNames.bgs) {
      if (!comboNames.emoFirst && rest.startsWith(bg) && sep(rest, bg.length)) return { char, bg, emo: clean(rest.slice(bg.length)) || "—" };
      if (comboNames.emoFirst && rest.endsWith(bg) && (rest.length === bg.length || /[\s_-]/.test(rest[rest.length - bg.length - 1]))) return { char, bg, emo: clean(rest.slice(0, -bg.length)) || "—" };
    }
    const m = rest.match(/^(.+?)[_\s-]+(.+)$/);
    if (m) return comboNames.emoFirst ? { char, bg: m[2], emo: m[1] } : { char, bg: m[1], emo: m[2] };
    return { char, bg: "", emo: rest || key };
  }
  function setBoard(on) {
    state.board = Boolean(on);
    try {
      localStorage.setItem(BOARD_KEY, state.board ? "1" : "0");
    } catch (error) {
      void error;
    }
    render();
    $(".gallery").scrollTop = 0;
  }
  function renderBoardButton() {
    const btn = $(".board-btn");
    if (!btn) return;
    btn.setAttribute("aria-pressed", String(state.board));
    // the board has no single picture to show, sort or select
    document.querySelector(".app")?.toggleAttribute("data-board", state.board);
    $(".sort-wrap").hidden = state.board;
    $(".pick-all").hidden = state.board;
    btn.innerHTML = state.board ? `${icon("grid", 15)}<span>그림으로 보기</span>` : `${icon("table", 15)}<span>셀렉 현황</span>`;
  }
  let boardOrder = []; // 셀렉 현황 cells, 캐릭터 → 배경 → 표정: what ] walks through
  function renderBoard({ keepScroll = false } = {}) {
    const board = $(".board");
    const order2 = [];
    const scroll = $(".gallery").scrollTop;
    board.innerHTML = "";
    // character → background → emotion → pictures (in the order they were made)
    const chars = new Map();
    const order = state.shown.slice().sort((a, b) => a.savedAt - b.savedAt);
    // A 표정/배경 renamed only by spaces or _ ("과거섹스" → "과거 섹스") is the
    // same row: old pictures keep the old name in their files. The row shows
    // the name used in the 조합 screen now, else the newest one.
    const loose = (t) => String(t || "").replace(/[\s_\-·]+/g, "").toLowerCase();
    const named = new Map();
    const nameFor = (kind, name, list) => {
      const k = `${kind}:${loose(name)}`;
      const current = list.find((n) => loose(n) === loose(name));
      if (current) named.set(k, current);
      else if (!named.has(k) || !list.some((n) => n === named.get(k))) named.set(k, name);
    };
    const axesCache = new Map();
    for (const e of order) {
      if (e.source === "dropped") continue;
      const ax = axesOf(e);
      axesCache.set(e.id, ax);
      nameFor("b", ax.bg, comboNames.bgs);
      nameFor("e", ax.emo, comboNames.emos);
    }
    for (const e of order) {
      if (e.source === "dropped") continue;
      const raw = axesCache.get(e.id);
      const ax = { char: raw.char, bg: named.get(`b:${loose(raw.bg)}`) ?? raw.bg, emo: named.get(`e:${loose(raw.emo)}`) ?? raw.emo };
      boardRaw.set(e.id, raw);
      const charKey = ax.char || "캐릭터 없음";
      if (!chars.has(charKey)) chars.set(charKey, { bgs: [], emos: [], cells: new Map() });
      const c = chars.get(charKey);
      if (!c.bgs.includes(ax.bg)) c.bgs.push(ax.bg);
      if (!c.emos.includes(ax.emo)) c.emos.push(ax.emo);
      const cellKey = `${ax.bg}\u0000${ax.emo}`;
      if (!c.cells.has(cellKey)) c.cells.set(cellKey, []);
      c.cells.get(cellKey).push(e);
    }
    // the 조합 screen's 표정/배경 for a character show even before (or after
    // moving away) any picture: a row to copy pictures into
    for (const [charName, c] of chars) {
      const plan = comboNames.byChar?.get(charName);
      if (!plan) continue;
      for (const bg of plan.bgs) if (!c.bgs.some((b) => loose(b) === loose(bg))) c.bgs.push(bg);
      for (const emo of plan.emos) if (!c.emos.some((m) => loose(m) === loose(emo))) c.emos.push(emo);
    }
    boardCells.clear();
    for (const [charName, c] of chars) for (const [k, list] of c.cells) boardCells.set(`${charName}\u0000${k}`, list);
    const emoRank = (name) => {
      const at = comboNames.emos.indexOf(name);
      return at < 0 ? 1e6 : at;
    };
    for (const [charName, c] of [...chars.entries()].sort((a, b) => a[0].localeCompare(b[0], "ko"))) {
      // 표정 in the order of the combination screen; unknown ones after, as made
      c.emos.sort((a, b) => emoRank(a) - emoRank(b));
      let done = 0;
      const table = el("div", { class: "bd-table", style: `--cols: ${c.bgs.length}` });
      table.append(el("div", { class: "bd-corner", text: "표정" }));
      for (const bg of c.bgs) table.append(el("div", { class: "bd-colhead", text: bg || "배경 없음" }));
      for (const emo of c.emos) {
        table.append(el("button", { type: "button", class: "bd-rowhead", "data-row-char": charName, "data-row-emo": emo, title: "이 표정 줄: 이름 바꾸기 · 옮기기 · 복사해 오기 · 휴지통", text: emo }));
        for (const bg of c.bgs) {
          const list = c.cells.get(`${bg}\u0000${emo}`) || [];
          if (!list.length) {
            table.append(el("button", { type: "button", class: "bd-cell", "data-state": "none", "data-empty": "1", "data-char": charName, "data-bg": bg, "data-emo": emo, title: "빈 칸 · 눌러서 다른 표정에서 복사해 오기", html: icon("add", 14) }));
            continue;
          }
          const counts = { pick: 0, hold: 0, reject: 0, none: 0 };
          for (const e of list) counts[cullOf(e.id).label || "none"] += 1;
          const picked = list.filter((e) => cullOf(e.id).label === "pick");
          const st = picked.length ? "done" : counts.none === list.length ? "todo" : "doing";
          if (picked.length) done += 1;
          const cover = picked[0] || null;
          const url = cover ? thumbUrl(cover) : "";
          const ids = list.map((e) => e.id).join("\n");
          const cell = el("button", { type: "button", class: "bd-cell", "data-state": st, "data-board-group": groupKeyOf(list[0]), "data-ids": ids, "data-char": charName, "data-bg": bg, "data-emo": emo, title: `${groupKeyOf(list[0])} · ${list.length}장 · 오른쪽 클릭: 칸 관리` });
          if (url) cell.append(el("img", { src: url, alt: "", loading: "lazy", draggable: "false" }));
          const text = st === "done"
            ? (picked.length > 1 ? `채택 ${picked.length}` : "")
            : st === "doing" ? `${NONE_LABEL} ${counts.none} / ${list.length}` : `${list.length}장`;
          cell.append(el("span", { class: "bd-badge", html: st === "done" ? `${icon("check", 12)}${text ? `<b>${text}</b>` : ""}` : text }));
          table.append(cell);
        }
      }
      for (const bg of c.bgs) for (const emo of c.emos) {
        const list = c.cells.get(`${bg}\u0000${emo}`);
        if (list?.length) order2.push({ key: groupKeyOf(list[0]), ids: list.map((e) => e.id) });
      }
      const total = [...c.cells.keys()].length;
      board.append(el("section", { class: "bd-char" }, [
        el("div", { class: "bd-head" }, [
          el("h2", { text: charName }),
          el("span", { class: "bd-progress", text: `${total}칸 중 ${done}칸 셀렉 완료` }),
          el("span", { class: "bd-bar" }, [el("i", { style: `width: ${total ? Math.round((done / total) * 100) : 0}%` })]),
        ]),
        table,
      ]));
    }
    if (!chars.size) board.append(el("p", { class: "bd-empty", text: "보이는 그림이 없어요." }));
    boardOrder = order2;
    if (cmp.sequence && !$(".compare").hidden) cmp.sequence = boardOrder;
    if (keepScroll) $(".gallery").scrollTop = scroll;
  }

  // ---- 칸 관리 (셀렉 현황): a 표정 줄 (all 배경) or one 칸 (one 배경) can be
  // renamed / moved to another 표정, filled by copying from another 표정, or
  // sent to the 휴지통. Renaming changes the file names; 셀렉 stays.
  const boardRaw = new Map(); // id → axes as written in the file name
  const boardCells = new Map(); // char \0 bg \0 emo → entries
  function slotEntries({ char, bg, emo }) {
    const out = [];
    for (const [k, list] of boardCells) {
      const [c, b, m] = k.split("\u0000");
      if (c === char && m === emo && (bg == null || b === bg)) out.push(...list);
    }
    return out;
  }
  function slotEmotions(char) {
    const set = [];
    for (const k of boardCells.keys()) {
      const [c, , m] = k.split("\u0000");
      if (c === char && !set.includes(m)) set.push(m);
    }
    for (const m of comboNames.byChar?.get(char)?.emos || []) if (!set.includes(m)) set.push(m);
    return set;
  }
  const slotTitle = ({ char, bg, emo }) => `${char} · ${bg ? `${bg} · ` : ""}${emo}`;
  function openSlotMenu(x, y, slot) {
    document.querySelectorAll(".menu.ctx").forEach((m) => m.remove());
    const list = slotEntries(slot);
    const menu = el("div", { class: "menu ctx", role: "menu" });
    menu.append(el("div", { class: "menu-head", text: slot.bg ? `${slot.char} · ${slot.bg} · ${slot.emo}` : `${slot.char} · ${slot.emo} (모든 배경)` }));
    const items = [];
    if (list.length) items.push([`표정 이름 바꾸기 · 다른 표정으로 옮기기… (${list.length}장)`, () => void moveSlot(slot)]);
    items.push(["다른 표정에서 복사해 오기…", () => void copyIntoSlot(slot)]);
    if (list.length > 1 && slot.bg) items.push(["비교하기", () => openCompare(list.map((e) => e.id), { group: groupKeyOf(list[0]), sequence: boardOrder })]);
    if (list.length) items.push([`휴지통으로 (${list.length}장)`, async () => {
      if (await confirmDialog(`${slotTitle(slot)} ${list.length}장을 휴지통으로 보낼까요?`, `파일은 ${TRASH_FOLDER} 폴더로 옮겨지고, 바로 되돌릴 수 있어요.`, "휴지통으로")) await trashEntries(list);
    }, true]);
    for (const [label, run, danger] of items) menu.append(el("button", { type: "button", role: "menuitem", "data-danger": danger ? "true" : null, text: label, onclick: () => { menu.remove(); run(); } }));
    document.body.append(menu);
    const r = menu.getBoundingClientRect();
    menu.style.left = `${Math.min(x, window.innerWidth - r.width - 8)}px`;
    menu.style.top = `${Math.min(y, window.innerHeight - r.height - 8)}px`;
  }
  // Choose a 표정: one of the character's, or a new name.
  function pickEmotion(title, hint, char, exclude, { allowNew = true, okLabel = "확인" } = {}) {
    const { dialog, body, right } = notionDialogShell(title, { leftLabel: "취소", rightLabel: allowNew ? okLabel : "" });
    return new Promise((resolve) => {
      // resolve once the dialog's close event is over, so the next dialog
      // opened right after is not closed by it
      let result = null;
      let done = false;
      const finish = (v) => { if (done) return; done = true; result = v; dialog.close(); };
      dialog.addEventListener("close", () => { done = true; setTimeout(() => resolve(result), 0); }, { once: true });
      if (hint) body.append(el("p", { class: "sheet-note", text: hint }));
      const chips = el("div", { class: "emo-chips" });
      for (const m of slotEmotions(char)) {
        if (m === exclude) continue;
        const n = slotEntries({ char, bg: null, emo: m }).length;
        chips.append(el("button", { type: "button", class: "emo-chip", onclick: () => finish(m) }, [document.createTextNode(m), el("small", { text: n ? ` ${n}` : " 빈 줄" })]));
      }
      body.append(chips);
      if (allowNew) {
        const input = el("input", { class: "dialog-input", type: "text", placeholder: "새 표정 이름", spellcheck: "false" });
        input.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.isComposing) { e.preventDefault(); finish(input.value.trim() || null); } });
        body.append(el("div", { class: "ios-group-label", text: "새 이름으로" }), input);
        right.onclick = () => finish(input.value.trim() || null);
      }
    });
  }
  // The file name with its 표정 swapped: "루페르트 밤_과한웃음 (5)_2" → "루페르트 밤_잠식 (5)_2".
  function renamedFor(entry, toEmo) {
    const raw = boardRaw.get(entry.id) || axesOf(entry);
    const key = groupKeyOf(entry);
    const at = comboNames.emoFirst ? key.indexOf(raw.emo) : key.lastIndexOf(raw.emo);
    if (!raw.emo || at < 0) return null;
    return { key: key.slice(0, at) + toEmo + key.slice(at + raw.emo.length), tail: entry.name.slice(key.length) };
  }
  // A free "(n)" for a new picture of `key`, after the ones already there.
  function nextCounter(key) {
    let max = 0;
    for (const e of state.entries) {
      if (groupKeyOf(e) !== key) continue;
      const m = counterOf(e).match(/\d+/);
      if (m) max = Math.max(max, Number(m[0]));
    }
    return max + 1;
  }
  async function moveSlot(slot) {
    const list = slotEntries(slot);
    const to = await pickEmotion(`${slotTitle(slot)} → 어느 표정으로?`, `${list.length}장의 파일 이름에서 「${slot.emo}」를 바꿔요. 있는 표정을 고르면 그 줄로 합쳐지고, 새 이름을 쓰면 이름만 바뀌어요. 채택·B컷은 그대로예요.`, slot.char, slot.emo, { okLabel: "바꾸기" });
    const toEmo = String(to || "").replace(UNSAFE_NAME, "_").replace(/[_]+$/, "").trim();
    if (!toEmo || toEmo === slot.emo) return;
    if (!(await ensureWritable())) {
      toast("폴더를 고쳐도 된다는 허락이 있어야 이름을 바꿀 수 있어요.", "warn");
      return;
    }
    let done = 0;
    const failed = [];
    const counters = new Map();
    for (let i = 0; i < list.length; i += 1) {
      const entry = list[i];
      if (list.length > 3) toast(`옮기는 중… ${i + 1} / ${list.length}`);
      try {
        const r = renamedFor(entry, toEmo);
        if (!r) throw new Error("이름에서 표정을 못 찾음");
        const { rel, dir, name, handle } = await locate(entry);
        const ext = (name.match(/\.(png|webp)$/i) || [".png"])[0];
        let target = `${r.key}${r.tail}${ext}`;
        const taken = async (n) => (await dir.getFileHandle(n).then(() => true, () => false)) || state.entries.some((e) => e.id === [state.root.name, ...rel.slice(0, -1), n].join("/"));
        if (await taken(target)) {
          // the 표정 it joins already has this number: next free one
          let n = counters.get(r.key) || nextCounter(r.key);
          while (await taken(`${r.key} (${n})${ext}`)) n += 1;
          counters.set(r.key, n + 1);
          target = `${r.key} (${n})${ext}`;
        }
        ownChange(rel, [...rel.slice(0, -1), target]);
        await moveFile(handle, dir, name, dir, target);
        const moved = await retarget(entry, [state.root.name, ...rel.slice(0, -1), target].join("/"));
        if (moved.axes) {
          moved.axes = { ...moved.axes, emo: toEmo };
          await LibDB.put(moved);
        }
        done += 1;
      } catch (error) {
        failed.push(entry.name);
      }
    }
    saveCull();
    render();
    toast(done ? `${done}장을 「${toEmo}」로 옮겼어요${failed.length ? ` · ${failed.length}장은 못 옮겼어요 (${failed[0]})` : ""}.` : `옮기지 못했어요${failed.length ? ` (${failed[0]})` : ""}.`, done && !failed.length ? "ok" : "warn");
  }
  // Fill a 칸/줄 with copies from another 표정 (same character, same 배경).
  async function copyIntoSlot(slot) {
    const from = await pickEmotion(`${slotTitle(slot)} ← 어느 표정에서 가져올까요?`, "고른 표정의 그림을 이 표정 이름으로 복사해 넣어요. 원래 그림은 그대로 있어요.", slot.char, slot.emo, { allowNew: false });
    if (!from) return;
    const source = slotEntries({ char: slot.char, bg: slot.bg, emo: from });
    if (!source.length) {
      toast(`「${from}」${slot.bg ? `의 ${slot.bg}` : ""}에는 그림이 없어요.`, "warn");
      return;
    }
    const picked = await pickPictures(`${from} → ${slot.emo}${slot.bg ? ` (${slot.bg})` : ""}`, source);
    if (!picked) return;
    if (!(await ensureWritable())) {
      toast("폴더를 고쳐도 된다는 허락이 있어야 복사할 수 있어요.", "warn");
      return;
    }
    let made = 0;
    const failed = [];
    const counters = new Map();
    for (let i = 0; i < picked.ids.length; i += 1) {
      const entry = byId(picked.ids[i]);
      if (picked.ids.length > 3) toast(`복사하는 중… ${i + 1} / ${picked.ids.length}`);
      try {
        const r = renamedFor(entry, slot.emo);
        if (!r) throw new Error("이름에서 표정을 못 찾음");
        const { rel, dir, name } = await locate(entry);
        const ext = (name.match(/\.(png|webp)$/i) || [".png"])[0];
        let n = counters.get(r.key) || nextCounter(r.key);
        while (await dir.getFileHandle(`${r.key} (${n})${ext}`).then(() => true, () => false)) n += 1;
        counters.set(r.key, n + 1);
        const target = `${r.key} (${n})${ext}`;
        const file = await originalFile(entry, { ask: false });
        if (!file) throw new Error("원본 없음");
        const bytes = new Uint8Array(await file.arrayBuffer());
        const path = [state.root.name, ...rel.slice(0, -1), target].join("/");
        ownChange([...rel.slice(0, -1), target]);
        const writable = await (await dir.getFileHandle(target, { create: true })).createWritable();
        await writable.write(bytes);
        await writable.close();
        const copy = await LibDB.buildEntry({ path, bytes, savedAt: Date.now(), source: "folder" });
        if (entry.axes) copy.axes = { ...entry.axes, emo: slot.emo };
        await LibDB.put(copy);
        upsert(copy);
        if (picked.asPick) state.cull.set(copy.id, { label: "pick" });
        made += 1;
      } catch (error) {
        failed.push(entry?.name || "?");
      }
    }
    saveCull();
    render();
    toast(made ? `「${slot.emo}」에 ${made}장을 복사해 넣었어요${picked.asPick ? " (채택)" : ""}${failed.length ? ` · ${failed.length}장은 못 했어요` : ""}.` : "복사하지 못했어요. 폴더를 연결했는지 확인해 주세요.", made && !failed.length ? "ok" : "warn");
  }
  // Pictures to choose from (채택 first): → { ids, asPick } or null.
  function pickPictures(title, list) {
    const { dialog, body, right } = notionDialogShell(title, { leftLabel: "취소", rightLabel: "복사해 오기" });
    dialog.classList.add("wide");
    dialog.addEventListener("close", () => dialog.classList.remove("wide"), { once: true });
    const rank = { pick: 0, hold: 1, none: 2, reject: 3 };
    const sorted = list.slice().sort((a, b) => rank[cullOf(a.id).label || "none"] - rank[cullOf(b.id).label || "none"] || b.savedAt - a.savedAt);
    const chosen = new Set();
    const grid = el("div", { class: "pick-grid" });
    const count = () => { right.textContent = chosen.size ? `${chosen.size}장 복사해 오기` : "복사해 오기"; right.disabled = !chosen.size; };
    for (const e of sorted) {
      const tile = el("button", { type: "button", class: "pick-tile", "aria-pressed": "false", title: e.name }, [
        el("img", { src: thumbUrl(e), alt: "", loading: "lazy", draggable: "false" }),
        el("span", { class: "pick-cap", html: `${tileCullHtml(e.id)}<span>${counterOf(e) || ""}</span>` }),
      ]);
      tile.addEventListener("click", () => {
        if (chosen.has(e.id)) chosen.delete(e.id); else chosen.add(e.id);
        tile.setAttribute("aria-pressed", String(chosen.has(e.id)));
        count();
      });
      grid.append(tile);
    }
    const asPick = el("input", { type: "checkbox", id: "pick-as", checked: true });
    asPick.classList.add("ios-switch");
    body.append(
      el("p", { class: "sheet-note", text: "가져올 그림을 눌러 골라요 (여러 장 가능). 채택한 그림이 앞에 있어요." }),
      grid,
      el("div", { class: "ios-group" }, [el("label", { class: "ios-row", for: "pick-as" }, [el("span", { class: "grow" }, [document.createTextNode("가져온 그림을 채택으로"), el("small", { text: "끄면 미분류로 들어가요" })]), asPick])]),
    );
    count();
    return new Promise((resolve) => {
      let result = null;
      let done = false;
      const finish = (v) => { if (done) return; done = true; result = v; dialog.close(); };
      dialog.addEventListener("close", () => { done = true; setTimeout(() => resolve(result), 0); }, { once: true });
      right.onclick = () => { if (chosen.size) finish({ ids: [...chosen], asPick: asPick.checked }); };
    });
  }

  function renderBanner() {
    const banner = $(".banner");
    const gone = state.pendingGone || [];
    if (gone.length) {
      // Pictures listed here whose files are no longer in the linked folder.
      const folders = [...new Set(gone.map((e) => e.path.split("/").slice(0, -1).join("/")))];
      banner.hidden = false;
      banner.innerHTML = "";
      banner.append(
        el("div", { class: "banner-text" }, [
          el("strong", { text: `연결한 폴더에 없는 그림 ${gone.length.toLocaleString("ko-KR")}장이 목록에 남아 있어요` }),
          el("span", { text: `예전에 보관함에 들어온 뒤 지워지거나 옮겨진 그림이에요 (${folders.slice(0, 3).join(", ")}${folders.length > 3 ? ` 외 ${folders.length - 3}곳` : ""}). 파일은 건드리지 않고 목록에서만 빼요.` }),
        ]),
        el("button", { class: "btn small", type: "button", text: "목록에서 빼기", onclick: async () => {
          const list = state.pendingGone || [];
          state.pendingGone = null;
          for (const e of list) await forget(e);
          saveCull();
          render();
          renderFolderBox();
          toast(`목록에서 ${list.length.toLocaleString("ko-KR")}장을 뺐어요.`, "ok");
        } }),
      );
    } else {
      banner.hidden = true;
    }
  }

  function renderMoreTiles() {
    const grid = $(".grid");
    const selected = new Set(state.sel);
    const end = Math.min(state.shown.length, state.rendered + PAGE);
    const frag = document.createDocumentFragment();
    for (let i = state.rendered; i < end; i += 1) {
      const entry = state.shown[i];
      const on = selected.has(entry.id);
      const tile = el("div", { class: "tile", role: "option", "aria-selected": String(on), "data-id": entry.id });
      const box = el("div", { class: "tile-box" });
      const img = el("button", { class: "tile-img", type: "button", "aria-label": entry.name, title: entry.path });
      const url = thumbUrl(entry);
      if (url) img.append(el("img", { src: url, alt: "", loading: "lazy", decoding: "async" }));
      if (entry.source === "censored") img.append(el("span", { class: "tile-badge censored", html: `${icon("shield", 12)}검열`, title: "검열 사본" }));
      else if (!entry.hasMeta) img.append(el("span", { class: "tile-badge", html: `${icon("shield", 12)}사본`, title: "메타데이터 없음" }));
      img.append(el("span", { class: "tile-cull", html: tileCullHtml(entry.id) }));
      const cullLabel = cullOf(entry.id).label;
      if (cullLabel) tile.dataset.cull = cullLabel;
      const check = el("button", { class: "tile-check", type: "button", "aria-label": `여러 장 고르기: ${entry.name}`, "aria-pressed": String(on), html: icon("check", 15) });
      box.append(img, check);
      tile.append(box, el("span", { class: "tile-name", text: entry.name }));
      frag.append(tile);
    }
    grid.append(frag);
    state.rendered = end;
  }

  function updateSelectionLook() {
    const selected = new Set(state.sel);
    document.querySelectorAll(".tile").forEach((tile) => {
      const on = selected.has(tile.dataset.id);
      tile.setAttribute("aria-selected", String(on));
      tile.querySelector(".tile-check")?.setAttribute("aria-pressed", String(on));
    });
    $(".grid").dataset.multi = String(state.sel.length > 1);
    renderPickBar();
    renderInspector();
  }

  function renderPickBar() {
    const n = state.sel.length;
    $(".pick-all").disabled = !(state.shown || []).length;
    $(".clear-sel").hidden = n < 2;
    $(".count").textContent = n > 1 ? `${countText()} · ${n.toLocaleString("ko-KR")}장 선택됨` : countText();
  }

  // ------------------------------------------------------------- inspector ---
  function parts(entry) {
    const m = entry.meta || {};
    const out = [];
    if (m.prompt || m.negative) out.push({ key: "base", label: "베이스", text: m.prompt || "", neg: m.negative || "" });
    (m.characters || []).forEach((c, i) => out.push({ key: `c${i}`, label: `캐릭터 ${i + 1}`, text: c.prompt, neg: c.negative }));
    return out;
  }
  function samplerName(value) {
    const map = { k_euler_ancestral: "Euler Ancestral", k_euler: "Euler", k_dpmpp_2s_ancestral: "DPM++ 2S Ancestral", k_dpmpp_2m: "DPM++ 2M", k_dpmpp_sde: "DPM++ SDE", k_dpmpp_2m_sde: "DPM++ 2M SDE", ddim_v3: "DDIM" };
    return map[value] || value || "";
  }
  function formatWhen(ms) {
    const d = new Date(ms);
    const pad = (n) => String(n).padStart(2, "0");
    const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
    if (LibDB.dateKey(ms) === today()) return `오늘 ${time}`;
    if (LibDB.dateKey(ms + 86400000) === today()) return `어제 ${time}`;
    return `${d.getFullYear()}. ${d.getMonth() + 1}. ${d.getDate()}. ${time}`;
  }

  function renderInspector() {
    const box = $(".inspector");
    box.innerHTML = "";
    const selected = state.sel.map(byId).filter(Boolean);
    if (selected.length === 1) {
      renderSingle(box, selected[0]);
    } else if (selected.length > 1) {
      renderMulti(box, selected);
    } else {
      box.append(el("div", { class: "insp-empty" }, [
        el("strong", { text: "그림을 눌러 보세요" }),
        el("span", { text: "프롬프트와 설정이 여기 보여요." }),
      ]));
    }
  }

  function renderSingle(box, entry) {
    const m = entry.meta || {};
    const body = el("div", { class: "insp-body" });
    const preview = el("div", { class: "preview", title: "크게 보기 (Space)", onclick: () => openLightbox(entry.id) });
    const url = thumbUrl(entry);
    if (url) preview.append(el("img", { src: url, alt: entry.name }));
    body.append(preview);
    void loadPreview(entry, preview);

    const sizeText = entry.w && entry.h ? `${entry.w}×${entry.h}` : "";
    const where = entry.source === "dropped" ? "불러온 파일" : entry.path.split("/").slice(0, -1).join("/");
    const menuWrap = el("div", { class: "menu-wrap" });
    const menuBtn = el("button", { class: "icon-btn", type: "button", "aria-label": "더 보기", "aria-haspopup": "menu", html: icon("more", 17) });
    menuWrap.append(menuBtn);
    menuBtn.addEventListener("click", (event) => {
      event.stopPropagation();
      const open = menuWrap.querySelector(".menu");
      if (open) {
        open.remove();
        return;
      }
      const menu = el("div", { class: "menu", role: "menu" });
      if (entry.downloadId != null) menu.append(el("button", { type: "button", role: "menuitem", text: "폴더에서 보기", onclick: () => chrome.downloads.show(entry.downloadId) }));
      if (parts(entry).length) {
        menu.append(el("button", { type: "button", role: "menuitem", text: "메모로 만들기", onclick: () => void sendToNai("memo", [entry]) }));
        menu.append(el("button", { type: "button", role: "menuitem", text: "대기열에 넣기", onclick: () => void sendToNai("queue", [entry]) }));
      }
      if (entry.notion?.url) {
        menu.append(el("button", { type: "button", role: "menuitem", text: "노션에서 보기 ↗", onclick: () => window.open(entry.notion.url, "_blank", "noopener") }));
        menu.append(el("button", { type: "button", role: "menuitem", text: "노션에 다시 보내기", onclick: () => void sendToNotion([entry]) }));
      } else {
        menu.append(el("button", { type: "button", role: "menuitem", text: notionReady() ? "노션에 보내기" : "노션에 보내기…", onclick: () => void sendToNotion([entry]) }));
      }
      menu.append(el("button", { type: "button", role: "menuitem", text: "파일 위치 복사", onclick: () => copyText(entry.path, "파일 위치를 복사했어요.") }));
      for (const [label, run, danger] of fileMenuItems([entry])) {
        menu.append(el("button", { type: "button", role: "menuitem", "data-danger": danger ? "true" : null, text: label, onclick: run }));
      }
      if (entry.source !== "dropped") menu.append(el("button", { type: "button", role: "menuitem", "data-danger": "true", text: "보관함에서 빼기 (파일은 그대로)", onclick: () => void removeEntries([entry.id]) }));
      menu.addEventListener("click", (e) => {
        if (e.target.closest("button")) menu.remove();
      });
      menuWrap.append(menu);
    });
    body.append(el("div", { class: "insp-head" }, [
      el("div", {}, [
        el("span", { class: "insp-title", text: entry.name }),
        el("span", { class: "insp-sub", text: [formatWhen(entry.savedAt), sizeText, where].filter(Boolean).join(" · ") }),
      ]),
      menuWrap,
    ]));
    body.append(cullControls([entry.id]));
    const group = groupMembers(entry);
    if (group.length > 1) {
      body.append(el("button", { class: "btn secondary small cmp-open", type: "button", html: `${icon("grid", 14)}<span>같은 이름 ${group.length}장 비교하기</span>`, title: "이름이 같은 그림을 나란히 놓고 골라요 (C)", onclick: () => openCompare(group.map((e) => e.id), { group: groupKeyOf(entry), sequence: null }) }));
    }

    const ps = parts(entry);
    if (ps.length) {
      if (!ps.some((p) => p.key === state.ptab)) state.ptab = ps[0].key;
      const current = ps.find((p) => p.key === state.ptab);
      const seg = el("div", { class: "seg", role: "tablist", "aria-label": "프롬프트 부분" });
      for (const p of ps) {
        seg.append(el("button", { type: "button", role: "tab", "aria-selected": String(p.key === state.ptab), text: p.label, onclick: () => { state.ptab = p.key; renderInspector(); } }));
      }
      body.append(el("div", { class: "tabs-row" }, [
        seg,
        el("span", { class: "grow" }),
        el("button", { class: "icon-btn", type: "button", title: "이 부분 복사", "aria-label": "프롬프트 복사", html: icon("copy", 15), onclick: () => copyText(current.text, "프롬프트를 복사했어요.") }),
      ]));
      body.append(el("p", { class: "prompt-box", "data-tag-hover": "true", text: current.text || "(비어 있음)" }));
      if (current.neg) {
        // Negatives are often very long: one line until opened.
        const neg = el("details", { class: "neg", open: state.negOpen || null });
        neg.addEventListener("toggle", () => { state.negOpen = neg.open; });
        neg.append(
          el("summary", {}, [el("b", { text: "네거티브" }), el("span", { class: "neg-peek", text: current.neg })]),
          el("p", { class: "prompt-box neg-box", "data-tag-hover": "true", text: current.neg }),
        );
        body.append(neg);
      } else {
        body.append(el("p", { class: "neg-line" }, [el("b", { text: "네거티브 · " }), document.createTextNode("없음")]));
      }
      const facts = el("dl", { class: "facts" });
      const fact = (k, v) => { if (v != null && v !== "") facts.append(el("dt", { text: k }), el("dd", { text: String(v) })); };
      fact("시드", m.seed);
      fact("스텝 · 가이던스", [m.steps, m.scale != null ? `${m.scale}${m.cfgRescale ? ` (리스케일 ${m.cfgRescale})` : ""}` : null].filter((v) => v != null).join(" · "));
      fact("샘플러", [samplerName(m.sampler), m.noiseSchedule].filter(Boolean).join(" · "));
      fact("모델", (m.model || "").replace(/\s+[0-9A-F]{8}$/i, ""));
      fact("파일", entry.bytes ? (entry.bytes >= 104858 ? `${(entry.bytes / 1048576).toFixed(1)}MB` : `${Math.max(1, Math.round(entry.bytes / 1024))}KB`) : "");
      body.append(facts);
    } else if (!entry.hasMeta) {
      body.append(el("p", { class: "neg-line", text: "이 그림에는 읽을 프롬프트가 없어요." }));
    }
    box.append(body, el("div", { class: "insp-foot" }, [shareCard([entry])]));
  }

  async function loadPreview(entry, preview) {
    // The full picture when we can read it (dropped file or linked folder).
    try {
      const file = await originalFile(entry, { ask: false });
      if (!file || !preview.isConnected) return;
      const url = URL.createObjectURL(file);
      const img = preview.querySelector("img") || el("img", { alt: entry.name });
      img.onload = () => setTimeout(() => URL.revokeObjectURL(url), 1000);
      img.src = url;
      if (!img.isConnected) preview.append(img);
    } catch (error) {
      void error;
    }
  }

  function renderMulti(box, entries) {
    const body = el("div", { class: "insp-body", style: "padding: 22px 20px; position: relative;" });
    const stack = el("div", { class: "stack" });
    entries.slice(0, 3).forEach((entry, i, arr) => {
      const off = i - (arr.length - 1) / 2;
      stack.append(el("img", { src: thumbUrl(entry), alt: "", style: `left: calc(50% - 60px + ${off * 26}px); transform: rotate(${off * 6}deg); z-index: ${i};` }));
    });
    const withMeta = entries.filter((e) => e.hasMeta);
    body.append(
      stack,
      el("div", { class: "multi-title", text: `${entries.length}장 골랐어요` }),
      el("div", { class: "multi-sub", html: "⌘/Ctrl을 누른 채 클릭하면 더하고 빼요.<br>Shift는 범위, 빈 곳을 끌면 상자로 골라요." }),
      cullControls(entries.map((e) => e.id)),
      el("button", { class: "btn small cmp-open", type: "button", html: `${icon("grid", 14)}<span>${entries.length}장 나란히 비교하기</span>`, title: "고른 그림을 나란히 놓고 채택·탈락을 골라요 (C)", onclick: () => openCompare(entries.map((e) => e.id), { sequence: null }) }),
      el("div", { class: "grow" }),
    );
    const withPrompt = entries.filter((e) => parts(e).length);
    const notSent = entries.filter((e) => !e.notion?.url);
    const items = [];
    if (withPrompt.length) {
      items.push([`대기열에 넣기 (${withPrompt.length}장)`, () => void sendToNai("queue", withPrompt)]);
      items.push([`프롬프트 복사 (${withPrompt.length}장)`, () => copyText(withPrompt.map(promptSummary).join("\n\n"), `${withPrompt.length}장의 프롬프트를 복사했어요.`)]);
    }
    if (notSent.length) items.push([notionReady() ? `노션에 보내기 (${notSent.length}장)` : "노션에 보내기…", () => void sendToNotion(notSent)]);
    items.push(...fileMenuItems(entries).map(([label, run]) => [label, run]));
    if (items.length) body.prepend(el("div", { class: "multi-more" }, [menuButton(items)]));
    box.append(body, el("div", { class: "insp-foot" }, [shareCard(entries)]));
  }

  // ------------------------------------------------- 공유용 사본 (one control) ---
  // Clean copy and censored copy are the same job — a copy that is safe to
  // share — so they are one button with a remembered choice, for one picture
  // or many. Everything else lives in the ⋯ menu.
  const COPY_MODE_KEY = "naiAutoSaver.copyMode";
  function copyMode() {
    try {
      return localStorage.getItem(COPY_MODE_KEY) === "censor" ? "censor" : "clean";
    } catch (error) {
      return "clean";
    }
  }
  function setCopyMode(mode) {
    try {
      localStorage.setItem(COPY_MODE_KEY, mode);
    } catch (error) {
      void error;
    }
  }

  function shareCard(entries) {
    const single = entries.length === 1;
    const withMeta = entries.filter((e) => e.hasMeta);
    const kind = withMeta.length ? "has" : "clean";
    const m = single ? entries[0].meta || {} : {};
    const status = single
      ? (withMeta.length ? `프롬프트·시드가 그림 안에 들어 있어요${m.sources?.stealth ? " (글자 + 숨은 정보)" : ""}. 공유할 땐 사본을 만들어 쓰세요.` : "메타데이터가 없어요. 그대로 공유해도 돼요.")
      : (withMeta.length ? (withMeta.length === entries.length ? `${entries.length}장 모두에 프롬프트·시드가 들어 있어요.` : `${entries.length}장 중 ${withMeta.length}장에 프롬프트·시드가 들어 있어요.`) : "고른 그림에는 메타데이터가 없어요.");
    const card = el("section", { class: "share-card", "data-kind": kind, "aria-label": "공유용 사본" });
    card.append(el("div", { class: "share-head", html: `${icon(kind === "has" ? "alert" : "shield", 15)}<span></span>` }));
    card.querySelector(".share-head span").textContent = status;
    const opts = el("div", { class: "share-opts", role: "radiogroup", "aria-label": "사본 종류" });
    const go = el("button", { class: "btn wide copy-go", type: "button" });
    const path = el("div", { class: "share-path" });
    const update = (mode) => {
      for (const b of opts.children) b.setAttribute("aria-checked", String(b.dataset.mode === mode));
      const targets = mode === "censor" ? entries.filter((e) => e.source !== "censored") : withMeta;
      const n = targets.length;
      go.innerHTML = `${icon(mode === "censor" ? "shield" : "eraser", 15)}<span></span>`;
      go.querySelector("span").textContent = n === 0
        ? (mode === "censor" ? "이미 검열 사본이에요" : "지울 메타데이터가 없어요")
        : single ? (mode === "censor" ? "가릴 곳 확인하고 만들기" : "사본 만들기") : (mode === "censor" ? `${n}장 확인하고 만들기` : `사본 ${n}장 만들기`);
      go.disabled = n === 0;
      path.textContent = `→ 다운로드/${mode === "censor" ? censoredFolder() : cleanFolder()}/`;
      go.onclick = () => {
        if (mode === "censor") void openCensorReview(single ? targets[0] : targets);
        else void makeCleanCopies(targets);
      };
    };
    for (const [mode, title, sub] of [["clean", "메타데이터만 지우기", "프롬프트·시드 같은 생성 정보를 지워요"], ["censor", "검열까지", "가릴 곳을 하얗게 덮고 메타도 지워요"]]) {
      opts.append(el("button", { class: "share-opt", type: "button", role: "radio", "data-mode": mode, onclick: () => { setCopyMode(mode); update(mode); } }, [
        el("b", { text: title }), el("span", { text: sub }),
      ]));
    }
    update(copyMode());
    card.append(opts, go, path);
    return card;
  }

  // A ⋯ button with a small menu; items: [label, run].
  function menuButton(items, direction = "down") {
    const wrap = el("div", { class: "menu-wrap" });
    const btn = el("button", { class: "icon-btn", type: "button", "aria-label": "더 보기", "aria-haspopup": "menu", title: "더 보기", html: icon("more", 17) });
    wrap.append(btn);
    btn.addEventListener("click", (event) => {
      event.stopPropagation();
      const open = wrap.querySelector(".menu");
      if (open) {
        open.remove();
        return;
      }
      const menu = el("div", { class: `menu${direction === "up" ? " up" : ""}`, role: "menu" });
      for (const [label, run] of items) menu.append(el("button", { type: "button", role: "menuitem", text: label, onclick: () => { menu.remove(); run(); } }));
      wrap.append(menu);
    });
    return wrap;
  }

  function promptSummary(entry) {
    const m = entry.meta || {};
    const lines = [`# ${entry.name}`];
    if (m.prompt) lines.push(m.prompt);
    (m.characters || []).forEach((c, i) => lines.push(`캐릭터 ${i + 1}: ${c.prompt}`));
    if (m.negative) lines.push(`네거티브: ${m.negative}`);
    if (m.seed != null) lines.push(`시드: ${m.seed}`);
    return lines.join("\n");
  }

  // ------------------------------------------------------------ 크게 보기 ---
  const lb = { id: null, url: null, token: 0 };
  async function showInLightbox(id) {
    const entry = byId(id);
    if (!entry) return;
    lb.id = id;
    const token = (lb.token += 1);
    const box = $(".lightbox");
    const img = $(".lb-img");
    const ids = state.shown.map((e) => e.id);
    $(".lb-name").textContent = entry.name;
    $(".lb-cull").innerHTML = cullSummaryHtml(id);
    syncLightboxActions(id);
    $(".lb-count").textContent = ids.length > 1 ? `${ids.indexOf(id) + 1} / ${ids.length}` : "";
    box.dataset.actual = "false";
    if (lb.url) URL.revokeObjectURL(lb.url);
    lb.url = null;
    img.src = thumbUrl(entry) || "";
    $(".lb-note").hidden = true;
    const file = await originalFile(entry, { ask: false });
    if (token !== lb.token) return;
    if (!file) {
      $(".lb-note").hidden = false;
      return;
    }
    lb.url = URL.createObjectURL(file);
    img.src = lb.url;
  }
  function syncLightboxActions(id) {
    const c = cullOf(id);
    document.querySelectorAll("[data-lb-label]").forEach((b) => b.setAttribute("aria-pressed", String((c.label || "none") === b.dataset.lbLabel)));
  }
  function lightboxCull(action) {
    if (!lb.id) return;
    applyCullAction([lb.id], action);
    $(".lb-cull").innerHTML = cullSummaryHtml(lb.id);
    syncLightboxActions(lb.id);
    if ("label" in action && action.label && cullOf(lb.id).label) setTimeout(() => stepLightbox(1), 160); // keep going, like a culling viewer
  }
  function openLightbox(id) {
    $(".lightbox").hidden = false;
    void showInLightbox(id);
  }
  function closeLightbox() {
    $(".lightbox").hidden = true;
    if (lb.url) URL.revokeObjectURL(lb.url);
    lb.url = null;
    if (lb.id && state.shown.some((e) => e.id === lb.id) && state.sel.length <= 1) {
      state.sel = [lb.id];
      state.anchor = lb.id;
      updateSelectionLook();
      document.querySelector(`.tile[data-id="${CSS.escape(lb.id)}"]`)?.scrollIntoView({ block: "nearest" });
    }
  }
  function stepLightbox(step) {
    const ids = state.shown.map((e) => e.id);
    const i = ids.indexOf(lb.id);
    if (i < 0) return;
    const next = ids[(i + step + ids.length) % ids.length];
    void showInLightbox(next);
  }
  function bindLightbox() {
    const box = $(".lightbox");
    $(".lb-close").addEventListener("click", closeLightbox);
    $(".lb-actions").addEventListener("click", (event) => {
      const label = event.target.closest("[data-lb-label]");
      if (label) lightboxCull({ label: label.dataset.lbLabel === "none" ? null : label.dataset.lbLabel });
    });
    $(".lb-prev").addEventListener("click", () => stepLightbox(-1));
    $(".lb-next").addEventListener("click", () => stepLightbox(1));
    $(".lb-stage").addEventListener("click", (event) => {
      if (event.target.closest(".lb-img")) box.dataset.actual = String(box.dataset.actual !== "true");
      else closeLightbox();
    });
    box.addEventListener("keydown", (event) => event.stopPropagation());
    document.addEventListener("keydown", (event) => {
      if (box.hidden) return;
      event.stopImmediatePropagation();
      const action = cullAction(event);
      if (action && lb.id) {
        event.preventDefault();
        lightboxCull(action);
        return;
      }
      if (event.key === "Escape" || event.key === " ") { event.preventDefault(); closeLightbox(); }
      else if (event.key === "ArrowRight" || event.key === "ArrowDown") { event.preventDefault(); stepLightbox(1); }
      else if (event.key === "ArrowLeft" || event.key === "ArrowUp") { event.preventDefault(); stepLightbox(-1); }
    });
  }

  // ---------------------------------------------------------------- 셀렉 ---
  // Culling mark per picture: 미분류 (nothing), 채택, B컷 or 탈락. Kept in the
  // library database next to the entries (not inside them, so re-reading a
  // folder never wipes them). Keys follow the physical key so they also work
  // while typing Korean: Q/P 채택, W B컷, E/X 탈락, R/U 미분류.
  const LABELS = { pick: "채택", hold: "B컷", reject: "탈락" };
  const NONE_LABEL = "미분류";
  const CULL_CHOICES = [["pick", "채택", "Q"], ["hold", "B컷", "W"], ["reject", "탈락", "E"], ["none", NONE_LABEL, "R"]];
  const CULL_KV = "cull";
  state.cull = new Map();
  let cullTimer = null;
  async function loadCull() {
    try {
      const saved = await LibDB.getKv(CULL_KV);
      if (saved && typeof saved === "object") {
        // Older marks may carry a 별점 (dropped): keep only the label.
        state.cull = new Map(Object.entries(saved).filter(([, v]) => v?.label).map(([k, v]) => [k, { label: v.label }]));
      }
    } catch (error) {
      void error;
    }
  }
  function saveCull() {
    clearTimeout(cullTimer);
    cullTimer = setTimeout(() => { void LibDB.setKv(CULL_KV, Object.fromEntries(state.cull)).catch(() => {}); }, 200);
  }
  function cullOf(id) {
    return state.cull.get(id) || {};
  }
  function setCull(ids, patch) {
    for (const id of ids) {
      const next = { ...cullOf(id), ...patch };
      delete next.rating; // 별점 was dropped in 1.13
      if (!next.label) delete next.label;
      if (next.label) state.cull.set(id, next);
      else state.cull.delete(id);
    }
    saveCull();
    refreshCullLook(ids);
  }
  // A plain choice, like a segmented control: 미분류 is its own option.
  function applyCullAction(ids, action) {
    if (!ids.length || !action || !("label" in action)) return;
    if (!$(".compare").hidden) cmp.touched = true;
    setCull(ids, { label: action.label || null });
  }
  function cullAction(event) {
    if (event.metaKey || event.ctrlKey || event.altKey) return null;
    const code = event.code || "";
    if (code === "KeyQ" || code === "KeyP") return { label: "pick" };
    if (code === "KeyW") return { label: "hold" };
    if (code === "KeyE" || code === "KeyX") return { label: "reject" };
    if (code === "KeyR" || code === "KeyU") return { label: null };
    return null;
  }
  function tileCullHtml(id) {
    const c = cullOf(id);
    return c.label ? `<span class="cull-pill" data-label="${c.label}">${LABELS[c.label]}</span>` : "";
  }
  function cullSummaryHtml(id) {
    return tileCullHtml(id) || `<span class="cull-none">${NONE_LABEL}</span>`;
  }
  function cullControls(ids) {
    const all = (fn) => ids.length && ids.every(fn);
    const wrap = el("div", { class: "cull-row" });
    const seg = el("div", { class: "seg cull-seg", role: "group", "aria-label": "셀렉" });
    for (const [label, text, key] of CULL_CHOICES) {
      seg.append(el("button", {
        type: "button", "data-label": label, "aria-pressed": String(all((id) => (cullOf(id).label || "none") === label)),
        title: `${text} (${key})`, text,
        onclick: () => applyCullAction(ids, { label: label === "none" ? null : label }),
      }));
    }
    wrap.append(seg);
    return wrap;
  }
  function refreshCullLook(ids) {
    for (const id of ids) {
      const tile = document.querySelector(`.tile[data-id="${CSS.escape(id)}"]`);
      if (!tile) continue;
      const label = cullOf(id).label;
      if (label) tile.dataset.cull = label;
      else delete tile.dataset.cull;
      const badge = tile.querySelector(".tile-cull");
      if (badge) badge.innerHTML = tileCullHtml(id);
    }
    // Only the 셀렉 counts (and characters, when filtered by 셀렉) change.
    renderCullNav(allEntries().filter(navTest(state.nav)));
    if (state.cullNav) renderSidebar();
    if (state.sel.some((id) => ids.includes(id))) renderInspector();
    if (!$(".compare").hidden) renderCompare({ keepImages: true });
  }
  function renderCullNav(all) {
    const nav = $(".nav-cull");
    if (!nav) return;
    nav.innerHTML = "";
    const counts = { pick: 0, hold: 0, reject: 0 };
    for (const e of all) {
      const label = cullOf(e.id).label;
      if (label) counts[label] += 1;
    }
    const icons = { pick: "check_circle", hold: "counter_2", reject: "minus_circle" };
    for (const label of ["pick", "hold", "reject"]) nav.append(navButton(`cull:${label}`, LABELS[label], icons[label], counts[label]));
    nav.append(navButton("cull:none", NONE_LABEL, "ring", all.length - counts.pick - counts.hold - counts.reject));
    if (counts.pick + counts.hold) {
      nav.append(el("button", { class: "nav-item cull-export", type: "button", title: "채택·B컷을 캐릭터별 폴더로 나눠서 따로 저장해요", html: `${icon("folder")}<span class="label">폴더로 나눠 저장…</span>`, onclick: () => openCullExport() }));
    }
  }

  // ------------------------------------------------- 셀렉 → 폴더로 나눠 저장 ---
  // Copies (originals untouched) into 다운로드/NovelAI/_셀렉/채택/김춘자/… so the
  // picks and B컷 of every character end up in their own folders.
  const CULL_FOLDER = "_셀렉";
  function openCullExport() {
    const { dialog, body, right: save } = notionDialogShell("폴더로 나눠 저장", { rightLabel: "저장" });
    const scopeIds = new Set((state.shown || []).map((e) => e.id));
    const inScope = (onlyShown) => allEntries().filter((e) => !onlyShown || scopeIds.has(e.id));
    const countOf = (label, onlyShown) => inScope(onlyShown).filter((e) => cullOf(e.id).label === label).length;
    const boxes = {};
    const labelRows = ["pick", "hold", "reject"].map((label) => {
      const box = el("input", { type: "checkbox", class: "ios-check", id: `cx-${label}`, checked: label !== "reject" });
      boxes[label] = box;
      return el("label", { class: "ios-row", for: `cx-${label}` }, [el("span", { class: "grow" }, [document.createTextNode(LABELS[label]), el("small", { "data-count": label })]), box]);
    });
    const byChar = el("input", { type: "checkbox", class: "ios-switch", id: "cx-char", checked: true });
    const onlyShown = el("input", { type: "checkbox", class: "ios-switch", id: "cx-shown", checked: false });
    const copyMode = el("input", { type: "radio", name: "cx-how", class: "ios-check", id: "cx-copy", checked: true });
    const moveMode = el("input", { type: "radio", name: "cx-how", class: "ios-check", id: "cx-move" });
    const intro = el("p", { class: "sheet-note" });
    const orig = el("input", { type: "radio", name: "cx-file", class: "ios-check", id: "cx-orig", checked: true });
    const clean = el("input", { type: "radio", name: "cx-file", class: "ios-check", id: "cx-clean" });
    const preview = el("p", { class: "sheet-note" });
    const update = () => {
      for (const label of ["pick", "hold", "reject"]) body.querySelector(`[data-count="${label}"]`).textContent = `${countOf(label, onlyShown.checked)}장`;
      const label = ["pick", "hold", "reject"].find((l) => boxes[l].checked) || "pick";
      const sample = inScope(onlyShown.checked).find((e) => cullOf(e.id).label === label) || { name: "김춘자_교실 웃음 (3)", char: "김춘자" };
      preview.textContent = `→ 다운로드/${state.saveFolder}/${CULL_FOLDER}/${LABELS[label]}/${byChar.checked ? `${sample.char || "기타"}/` : ""}${sample.name}.${sample.format || "webp"}`;
      const total = ["pick", "hold", "reject"].filter((l) => boxes[l].checked).reduce((n, l) => n + countOf(l, onlyShown.checked), 0);
      const moving = moveMode.checked;
      // Moving keeps the file as it is, so the clean-copy choice does not apply.
      clean.disabled = moving;
      if (moving) orig.checked = true;
      clean.closest(".ios-row").dataset.disabled = String(moving);
      intro.textContent = moving
        ? "원본 파일을 라벨 · 캐릭터별 폴더로 옮겨요. 날짜 폴더에서는 빠지고, 보관함은 새 위치를 따라가요."
        : "원본은 그대로 두고 복사본을 라벨 · 캐릭터별 폴더에 따로 저장해요.";
      save.textContent = total ? `${total}장 ${moving ? "옮기기" : "저장"}` : moving ? "옮기기" : "저장";
      save.disabled = !total;
    };
    body.append(
      intro,
      el("div", { class: "ios-group-label", text: "방법" }),
      el("div", { class: "ios-group" }, [
        el("label", { class: "ios-row", for: "cx-copy" }, [el("span", { class: "grow" }, [document.createTextNode("복사"), el("small", { text: "원본은 그대로 · 추천" })]), copyMode]),
        el("label", { class: "ios-row", for: "cx-move" }, [el("span", { class: "grow" }, [document.createTextNode("이동"), el("small", { text: "원본을 옮겨요 · 크롬이 폴더 수정 허락을 한 번 물어봐요" })]), moveMode]),
      ]),
      el("div", { class: "ios-group-label", text: "무엇을" }),
      el("div", { class: "ios-group" }, labelRows),
      el("div", { class: "ios-group-label", text: "나누는 방법" }),
      el("div", { class: "ios-group" }, [
        el("label", { class: "ios-row", for: "cx-char" }, [el("span", { class: "grow", text: "캐릭터별 폴더로 나누기" }), byChar]),
        el("label", { class: "ios-row", for: "cx-shown" }, [el("span", { class: "grow" }, [document.createTextNode("지금 보이는 그림 중에서만"), el("small", { text: `「${$(".title").textContent}」 ${scopeIds.size}장` })]), onlyShown]),
      ]),
      el("div", { class: "ios-group-label", text: "파일" }),
      el("div", { class: "ios-group" }, [
        el("label", { class: "ios-row", for: "cx-orig" }, [el("span", { class: "grow" }, [document.createTextNode("원본 그대로"), el("small", { text: "프롬프트·시드가 들어 있어요" })]), orig]),
        el("label", { class: "ios-row", for: "cx-clean" }, [el("span", { class: "grow" }, [document.createTextNode("메타데이터 지운 사본"), el("small", { text: "바로 올려도 되는 파일" })]), clean]),
      ]),
      preview,
    );
    body.addEventListener("change", update);
    update();
    save.addEventListener("click", () => {
      const labels = ["pick", "hold", "reject"].filter((l) => boxes[l].checked);
      const list = inScope(onlyShown.checked).filter((e) => labels.includes(cullOf(e.id).label));
      dialog.close();
      if (moveMode.checked) void moveCulled(list, { byChar: byChar.checked });
      else void exportCulled(list, { byChar: byChar.checked, clean: clean.checked });
    });
  }

  // ---- 이동: move the originals inside the linked folder ----------------------
  async function ensureWritable() {
    if (!state.root && !(await connectFolder())) return false;
    try {
      if ((await state.root.queryPermission({ mode: "readwrite" })) === "granted") return true;
      return (await state.root.requestPermission({ mode: "readwrite" })) === "granted";
    } catch (error) {
      return false;
    }
  }
  // Path segments of an entry relative to the linked folder.
  function relSegments(entry) {
    const segments = entry.path.split("/");
    const at = segments.indexOf(state.root.name);
    return at >= 0 ? segments.slice(at + 1) : segments;
  }
  async function dirAt(parts, create = false) {
    let dir = state.root;
    for (const part of parts) dir = await dir.getDirectoryHandle(part, { create });
    return dir;
  }
  async function freeName(dir, name) {
    const dot = name.lastIndexOf(".");
    const stem = dot > 0 ? name.slice(0, dot) : name;
    const ext = dot > 0 ? name.slice(dot) : "";
    for (let n = 1; n < 1000; n += 1) {
      const candidate = n === 1 ? name : `${stem} [${n}]${ext}`;
      try {
        await dir.getFileHandle(candidate);
      } catch (error) {
        return candidate;
      }
    }
    return `${stem} [${Date.now()}]${ext}`;
  }
  async function moveCulled(list, { byChar }) {
    const movable = list.filter((e) => e.source !== "dropped");
    if (!movable.length) {
      toast("불러온 파일은 옮길 수 없어요. 복사를 골라 주세요.", "warn");
      return;
    }
    const ok = await confirmDialog(`${movable.length}장을 옮길까요?`, `날짜 폴더에서 다운로드/${state.saveFolder}/${CULL_FOLDER}/ 아래 라벨${byChar ? " · 캐릭터" : ""} 폴더로 옮겨요. 되돌리려면 직접 옮겨야 해요.`, "옮기기");
    if (!ok || !(await ensureWritable())) {
      if (ok) toast("폴더를 수정하도록 허락해야 옮길 수 있어요.", "warn");
      return;
    }
    const safe = (text) => String(text || "").replace(/[\\/:*?"<>|]/g, "_").trim();
    // Keep the sorted folders next to the date folders, inside the save folder.
    const saveParts = state.saveFolder.split("/").filter(Boolean);
    const lead = relSegments(movable[0]);
    const base = state.root.name === saveParts[saveParts.length - 1] ? []
      : saveParts.every((part, i) => lead[i] === part) ? saveParts : [];
    let moved = 0;
    const failed = [];
    for (let i = 0; i < movable.length; i += 1) {
      const entry = movable[i];
      toast(`옮기는 중… ${i + 1} / ${movable.length}`);
      try {
        const rel = relSegments(entry);
        const from = await dirAt(rel.slice(0, -1));
        const handle = await from.getFileHandle(rel[rel.length - 1]);
        const target = [...base, CULL_FOLDER, LABELS[cullOf(entry.id).label] || "기타"];
        if (byChar) target.push(safe(entry.char) || "기타");
        const to = await dirAt(target, true);
        const name = await freeName(to, rel[rel.length - 1]);
        if (typeof handle.move === "function") {
          await handle.move(to, name);
        } else {
          // Older Chrome: write a copy, then remove the original.
          const data = await (await handle.getFile()).arrayBuffer();
          const writable = await (await to.getFileHandle(name, { create: true })).createWritable();
          await writable.write(data);
          await writable.close();
          await from.removeEntry(rel[rel.length - 1]);
        }
        const newPath = [state.root.name, ...target, name].join("/");
        const moved_ = { ...entry, id: newPath, path: newPath, downloadId: null };
        await LibDB.put(moved_);
        await LibDB.remove(entry.id);
        const at = state.entries.findIndex((e) => e.id === entry.id);
        if (at >= 0) state.entries[at] = moved_;
        if (state.cull.has(entry.id)) {
          state.cull.set(newPath, state.cull.get(entry.id));
          state.cull.delete(entry.id);
        }
        const url = thumbUrls.get(entry.id);
        if (url) {
          thumbUrls.set(newPath, url);
          thumbUrls.delete(entry.id);
        }
        state.sel = state.sel.map((id) => (id === entry.id ? newPath : id));
        moved += 1;
      } catch (error) {
        failed.push(entry.name);
      }
    }
    saveCull();
    render();
    if (moved) toast(`${moved}장을 ${CULL_FOLDER} 폴더로 옮겼어요${failed.length ? ` · ${failed.length}장은 못 옮겼어요` : ""}.`, failed.length ? "warn" : "ok");
    else toast(`옮기지 못했어요${failed.length ? `: ${failed.slice(0, 2).join(", ")}${failed.length > 2 ? " …" : ""}` : ""}. 파일이 그 자리에 있는지 확인해 주세요.`, "warn");
  }

  // ------------------------------------------- 파일 다루기 (탐색기처럼) ---
  // Works on the real files in the linked folder. Delete goes to a _휴지통
  // folder (a browser cannot use the Windows Recycle Bin), with 되돌리기.
  const TRASH_FOLDER = "_휴지통";
  const UNSAFE_NAME = /[\\/:*?"<>|]/g;
  function saveBaseFor(rel) {
    const saveParts = state.saveFolder.split("/").filter(Boolean);
    if (state.root.name === saveParts[saveParts.length - 1]) return [];
    return saveParts.every((part, i) => rel[i] === part) ? saveParts : [];
  }
  async function locate(entry) {
    const rel = relSegments(entry);
    const dir = await dirAt(rel.slice(0, -1));
    const name = rel[rel.length - 1];
    return { rel, dir, name, handle: await dir.getFileHandle(name) };
  }
  // Moves a file handle into `toDir` as `name` (rename when toDir is its own folder).
  async function moveFile(handle, fromDir, oldName, toDir, name) {
    if (typeof handle.move === "function") {
      await handle.move(toDir, name);
      return;
    }
    const data = await (await handle.getFile()).arrayBuffer();
    const writable = await (await toDir.getFileHandle(name, { create: true })).createWritable();
    await writable.write(data);
    await writable.close();
    await fromDir.removeEntry(oldName);
  }
  // The library follows a file that moved inside the linked folder.
  async function retarget(entry, newPath) {
    const name = newPath.split("/").pop().replace(/\.(png|webp)$/i, "");
    const moved = { ...entry, id: newPath, path: newPath, name, downloadId: null };
    moved.char = LibDB.characterOf(name, newPath, state.saveFolder);
    moved.search = LibDB.searchText(moved.meta, name);
    await LibDB.put(moved);
    await LibDB.remove(entry.id);
    const at = state.entries.findIndex((e) => e.id === entry.id);
    if (at >= 0) state.entries[at] = moved;
    invalidateGroups();
    dataVersion += 1;
    if (state.cull.has(entry.id)) {
      state.cull.set(newPath, state.cull.get(entry.id));
      state.cull.delete(entry.id);
    }
    const url = thumbUrls.get(entry.id);
    if (url) {
      thumbUrls.set(newPath, url);
      thumbUrls.delete(entry.id);
    }
    state.sel = state.sel.map((id) => (id === entry.id ? newPath : id));
    return moved;
  }
  // A file that left the linked folder: out of the library (its 셀렉 too).
  // Our own file moves: the folder watcher sees them too, but the library
  // already knows — no need to walk the whole folder again for them. Only
  // these exact paths are skipped; a change made in 탐색기 still counts.
  const ownPaths = new Map(); // path inside the linked folder → until when
  function ownChange(...paths) {
    const until = Date.now() + 15000;
    for (const p of paths) if (p) ownPaths.set(Array.isArray(p) ? p.join("/") : p, until);
  }
  function isOwnChange(parts) {
    const key = (parts || []).join("/");
    const until = ownPaths.get(key);
    if (until) ownPaths.delete(key); // each own change is skipped once
    return Boolean(until && until > Date.now());
  }
  const selfOps = async (run) => run();
  // Pictures on their way out (휴지통·옮기기): gone from the grid right away,
  // while the files move in the background.
  state.hiding = new Set();
  async function forgetMany(list) {
    const gone = new Set(list.map((e) => e.id));
    for (const e of list) await LibDB.remove(e.id).catch(() => {});
    state.entries = state.entries.filter((e) => !gone.has(e.id));
    invalidateGroups();
    dataVersion += 1;
    for (const id of gone) {
      state.cull.delete(id);
      const url = thumbUrls.get(id);
      if (url) URL.revokeObjectURL(url);
      thumbUrls.delete(id);
      state.hiding.delete(id);
    }
    state.sel = state.sel.filter((id) => !gone.has(id));
  }
  async function forget(entry) {
    await LibDB.remove(entry.id);
    state.entries = state.entries.filter((e) => e.id !== entry.id);
    invalidateGroups();
    dataVersion += 1;
    state.cull.delete(entry.id);
    const url = thumbUrls.get(entry.id);
    if (url) URL.revokeObjectURL(url);
    thumbUrls.delete(entry.id);
    state.sel = state.sel.filter((id) => id !== entry.id);
  }
  const onDisk = (list) => list.filter((e) => e.source !== "dropped");

  async function trashEntries(list) {
    const files = onDisk(list);
    if (!files.length) {
      toast("불러온 파일은 폴더에 있는 파일이 아니라서 휴지통으로 보낼 게 없어요.", "warn");
      return;
    }
    if (!(await ensureWritable())) {
      toast("폴더를 고쳐도 된다는 허락이 있어야 지울 수 있어요.", "warn");
      return;
    }
    const undo = [];
    const failed = [];
    const done = [];
    // gone from view at once; the files follow
    for (const e of files) state.hiding.add(e.id);
    const keepScroll = $(".gallery").scrollTop;
    render();
    $(".gallery").scrollTop = keepScroll;
    await selfOps(async () => {
      for (let i = 0; i < files.length; i += 1) {
        const entry = files[i];
        if (files.length > 3) toast(`휴지통으로 옮기는 중… ${i + 1} / ${files.length}`);
        try {
          const { rel, dir, name, handle } = await locate(entry);
          const base = saveBaseFor(rel);
          const keep = rel.slice(base.length, -1); // e.g. 2026-10-23/루페르타
          const to = await dirAt([...base, TRASH_FOLDER, ...keep], true);
          const trashedName = await freeName(to, name);
          ownChange(rel, [...base, TRASH_FOLDER, ...keep, trashedName]);
          await moveFile(handle, dir, name, to, trashedName);
          undo.push({ entry, label: cullOf(entry.id).label || null, from: rel, to: [...base, TRASH_FOLDER, ...keep, trashedName] });
          done.push(entry);
        } catch (error) {
          failed.push(entry.name);
          state.hiding.delete(entry.id); // still there: show it again
        }
      }
    });
    await forgetMany(done);
    saveCull();
    if (failed.length || state.board) {
      const y = $(".gallery").scrollTop;
      render();
      $(".gallery").scrollTop = y;
    } else {
      renderSidebar();
      renderPickBar();
      renderInspector();
    }
    if (undo.length) {
      toast(`${undo.length}장을 휴지통(${TRASH_FOLDER})으로 옮겼어요${failed.length ? ` · ${failed.length}장은 못 옮겼어요` : ""}.`, failed.length ? "warn" : "ok", { label: "되돌리기", run: () => void restoreTrashed(undo) });
    } else {
      toast("지우지 못했어요. 파일이 그 자리에 있는지 확인해 주세요.", "warn");
    }
  }
  async function restoreTrashed(undo) {
    let back = 0;
    for (const u of undo) {
      try {
        const dir = await dirAt(u.to.slice(0, -1));
        const handle = await dir.getFileHandle(u.to[u.to.length - 1]);
        const toDir = await dirAt(u.from.slice(0, -1), true);
        const name = await freeName(toDir, u.from[u.from.length - 1]);
        ownChange(u.to, [...u.from.slice(0, -1), name]);
        await moveFile(handle, dir, u.to[u.to.length - 1], toDir, name);
        const path = [state.root.name, ...u.from.slice(0, -1), name].join("/");
        const restored = { ...u.entry, id: path, path, name: name.replace(/\.(png|webp)$/i, "") };
        await LibDB.put(restored);
        upsert(restored);
        if (u.label) state.cull.set(path, { label: u.label });
        back += 1;
      } catch (error) {
        void error;
      }
    }
    saveCull();
    render();
    toast(back ? `${back}장을 제자리로 되돌렸어요.` : "되돌리지 못했어요.", back ? "ok" : "warn");
  }

  async function pickDestination(id) {
    try {
      return await window.showDirectoryPicker({ id, mode: "readwrite", startIn: state.root || "pictures" });
    } catch (error) {
      return null;
    }
  }
  async function moveEntriesTo(list) {
    const files = onDisk(list);
    if (!files.length) {
      toast("불러온 파일은 옮길 수 없어요. 「다른 폴더로 복사」를 써 주세요.", "warn");
      return;
    }
    if (!(await ensureWritable())) {
      toast("폴더를 고쳐도 된다는 허락이 있어야 옮길 수 있어요.", "warn");
      return;
    }
    const dest = await pickDestination("nai-move-to");
    if (!dest) return;
    const inside = await state.root.resolve(dest).catch(() => null); // path inside the linked folder, or null
    let moved = 0;
    const failed = [];
    const out = [];
    if (!inside) {
      for (const e of files) state.hiding.add(e.id);
      render();
    }
    await selfOps(async () => {
      for (let i = 0; i < files.length; i += 1) {
        const entry = files[i];
        if (files.length > 3) toast(`옮기는 중… ${i + 1} / ${files.length}`);
        try {
          const { rel, dir, name, handle } = await locate(entry);
          const target = await freeName(dest, name);
          ownChange(rel, inside ? [...inside, target] : null);
          await moveFile(handle, dir, name, dest, target);
          if (inside) await retarget(entry, [state.root.name, ...inside, target].join("/"));
          else out.push(entry);
          moved += 1;
        } catch (error) {
          failed.push(entry.name);
          state.hiding.delete(entry.id);
        }
      }
    });
    await forgetMany(out);
    saveCull();
    render();
    const where = inside ? `「${[state.root.name, ...inside].join("/")}」` : `「${dest.name}」 (연결한 폴더 밖이라 보관함에서는 빠져요)`;
    toast(moved ? `${moved}장을 ${where}로 옮겼어요${failed.length ? ` · ${failed.length}장은 못 옮겼어요` : ""}.` : "옮기지 못했어요.", moved && !failed.length ? "ok" : "warn");
  }
  async function copyEntriesTo(list) {
    if (!list.length) return;
    const dest = await pickDestination("nai-copy-to");
    if (!dest) return;
    let made = 0;
    const failed = [];
    for (let i = 0; i < list.length; i += 1) {
      const entry = list[i];
      if (list.length > 3) toast(`복사하는 중… ${i + 1} / ${list.length}`);
      try {
        const file = await originalFile(entry, { ask: i === 0 });
        if (!file) throw new Error("원본 없음");
        const ext = /\.webp$/i.test(file.name) || entry.format === "webp" ? ".webp" : ".png";
        const name = await freeName(dest, `${entry.name}${ext}`);
        const writable = await (await dest.getFileHandle(name, { create: true })).createWritable();
        await writable.write(await file.arrayBuffer());
        await writable.close();
        made += 1;
      } catch (error) {
        failed.push(entry.name);
      }
    }
    toast(made ? `${made}장을 「${dest.name}」에 복사했어요${failed.length ? ` · ${failed.length}장은 못 했어요` : ""}.` : "복사하지 못했어요. 폴더를 연결했는지 확인해 주세요.", made && !failed.length ? "ok" : "warn");
    if (made && state.root) void syncFolder({ quiet: true });
  }
  // Ctrl+C: the picture itself, ready to paste into Discord, Notion, … (as PNG).
  async function copyPicture(entry) {
    try {
      const file = await originalFile(entry, { ask: true });
      const source = file || entry.thumb;
      if (!source) throw new Error("no picture");
      const bitmap = await createImageBitmap(source);
      const canvas = Object.assign(document.createElement("canvas"), { width: bitmap.width, height: bitmap.height });
      canvas.getContext("2d").drawImage(bitmap, 0, 0);
      bitmap.close?.();
      const blob = await new Promise((r) => canvas.toBlob(r, "image/png"));
      await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
      toast(`그림을 복사했어요. 붙여 넣기(Ctrl+V) 하면 돼요${file ? " · 메타데이터는 빠져요" : " · 원본을 못 읽어서 작은 미리보기예요"}.`, "ok");
    } catch (error) {
      toast("그림을 복사하지 못했어요.", "warn");
    }
  }
  function textDialog(title, value, okLabel, hint = "") {
    const dialog = $(".dialog");
    if (dialog.open) dialog.close();
    dialog.classList.remove("sheet");
    dialog.innerHTML = "";
    return new Promise((resolve) => {
      const input = el("input", { class: "dialog-input", type: "text", value, spellcheck: "false" });
      const finish = (v) => { dialog.close(); dialog.classList.remove("alert"); resolve(v); };
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && !e.isComposing) { e.preventDefault(); finish(input.value); }
      });
      dialog.classList.add("alert");
      dialog.append(
        el("div", { class: "dialog-body" }, [el("strong", { text: title }), hint ? el("p", { text: hint }) : null, input]),
        el("div", { class: "dialog-foot" }, [
          el("button", { class: "btn secondary", type: "button", text: "취소", onclick: () => finish(null) }),
          el("button", { class: "btn", type: "button", text: okLabel, onclick: () => finish(input.value) }),
        ]),
      );
      dialog.addEventListener("cancel", () => { dialog.classList.remove("alert"); resolve(null); }, { once: true });
      dialog.showModal();
      input.focus();
      input.select();
    });
  }
  async function renameEntry(entry) {
    if (!entry || entry.source === "dropped") return;
    const raw = await textDialog("이름 바꾸기", entry.name, "바꾸기", "확장자(.webp/.png)는 그대로 둬요.");
    const next = String(raw ?? "").replace(UNSAFE_NAME, "_").trim();
    if (!next || next === entry.name) return;
    if (!(await ensureWritable())) {
      toast("폴더를 고쳐도 된다는 허락이 있어야 이름을 바꿀 수 있어요.", "warn");
      return;
    }
    try {
      const { rel, dir, name, handle } = await locate(entry);
      const ext = (name.match(/\.(png|webp)$/i) || [".png"])[0];
      const target = `${next}${ext}`;
      const exists = await dir.getFileHandle(target).then(() => true, () => false);
      if (exists) {
        toast(`「${target}」이 이미 있어요. 다른 이름을 써 주세요.`, "warn");
        return;
      }
      ownChange(rel, [...rel.slice(0, -1), target]);
      await moveFile(handle, dir, name, dir, target);
      await retarget(entry, [state.root.name, ...rel.slice(0, -1), target].join("/"));
      saveCull();
      render();
      toast(`「${next}」로 바꿨어요.`, "ok");
    } catch (error) {
      toast(`이름을 바꾸지 못했어요: ${error.message || error}`, "warn");
    }
  }
  // The same file actions for the ⋯ menus and the right-click menu.
  function fileMenuItems(entries) {
    const files = onDisk(entries);
    const one = entries.length === 1 ? entries[0] : null;
    const items = [];
    if (one) items.push(["그림 복사 (Ctrl+C)", () => void copyPicture(one)]);
    if (one && files.length) items.push(["이름 바꾸기 (F2)", () => void renameEntry(one)]);
    if (files.length) items.push([`다른 폴더로 이동…${entries.length > 1 ? ` (${files.length}장)` : ""}`, () => void moveEntriesTo(files)]);
    items.push([`다른 폴더로 복사…${entries.length > 1 ? ` (${entries.length}장)` : ""}`, () => void copyEntriesTo(entries)]);
    if (files.length) items.push([`휴지통으로 (Delete)${entries.length > 1 ? ` · ${files.length}장` : ""}`, () => void trashEntries(files)]);
    return items;
  }
  function showContextMenu(x, y, entries) {
    document.querySelectorAll(".menu.ctx").forEach((m) => m.remove());
    const menu = el("div", { class: "menu ctx", role: "menu" });
    const one = entries.length === 1 ? entries[0] : null;
    const items = [];
    if (one) items.push(["크게 보기 (Space)", () => openLightbox(one.id)]);
    if (one?.downloadId != null) items.push(["폴더에서 보기", () => chrome.downloads.show(one.downloadId)]);
    items.push(...fileMenuItems(entries));
    const ids = onDisk(entries).map((e) => e.id);
    if (ids.length) items.push([`보관함에서 빼기 (파일은 그대로)`, () => void removeEntries(ids)]);
    for (const [label, run, danger] of items) {
      menu.append(el("button", { type: "button", role: "menuitem", "data-danger": danger ? "true" : null, text: label, onclick: () => { menu.remove(); run(); } }));
    }
    document.body.append(menu);
    const r = menu.getBoundingClientRect();
    menu.style.left = `${Math.min(x, window.innerWidth - r.width - 8)}px`;
    menu.style.top = `${Math.min(y, window.innerHeight - r.height - 8)}px`;
  }

  async function exportCulled(list, { byChar, clean }) {
    if (!list.length) return;
    let made = 0;
    let lastId = null;
    const missing = [];
    for (let i = 0; i < list.length; i += 1) {
      const entry = list[i];
      toast(`폴더로 나눠 저장하는 중… ${i + 1} / ${list.length}`);
      const file = await originalFile(entry, { ask: i === 0 || Boolean(state.root) });
      if (!file) {
        missing.push(entry.name);
        if (!state.root && !state.files.has(entry.id)) break;
        continue;
      }
      try {
        let bytes = new Uint8Array(await file.arrayBuffer());
        if (clean) {
          const stripped = await NAIMeta.strip(bytes);
          if (!stripped.bytes) throw new Error(stripped.error || "지우지 못함");
          bytes = stripped.bytes;
        }
        const ext = NAIMeta.imageType(bytes) || "png";
        const safe = (text) => String(text || "").replace(/[\\/:*?"<>|]/g, "_").trim();
        const parts = [state.saveFolder, CULL_FOLDER, LABELS[cullOf(entry.id).label] || "기타"];
        if (byChar) parts.push(safe(entry.char) || "기타");
        const dl = await downloadBlob(new Blob([bytes], { type: `image/${ext}` }), `${parts.join("/")}/${safe(entry.name)}.${ext}`);
        if (!dl.ok) throw new Error("저장이 중단됐어요");
        lastId = dl.id;
        made += 1;
      } catch (error) {
        missing.push(entry.name);
      }
    }
    if (made) {
      toast(`${made}장을 ${CULL_FOLDER} 폴더에 나눠 저장했어요${missing.length ? ` · ${missing.length}장은 원본을 못 찾았어요` : ""}.`, missing.length ? "warn" : "ok", lastId != null ? { label: "폴더에서 보기", run: () => chrome.downloads.show(lastId) } : null);
    } else if (missing.length) {
      toast("원본을 읽지 못해서 저장하지 못했어요. 왼쪽 아래에서 NovelAI 폴더를 연결해 주세요.", "warn");
    }
  }

  // ------------------------------------------------------------- 비교 ---
  // Pictures side by side. Opened for the selected pictures, or for every
  // picture with the same name (김춘자_교실 웃음 (1), (2)…), then mark them.
  // Two ways to look: 한눈에 (every picture at once) and 나란히: two lanes.
  // The right lane is the 기준 (채택, or B컷) and stays put; the left lane rolls
  // through 미분류 — or through 채택 too, for "mark all 채택, then knock them
  // down to B컷 one by one against the best". Click a lane (or Tab) to choose
  // which one ←/→ rolls; Q/W/E/R mark the picture in that lane; S swaps the
  // two (the left picture becomes the 기준).
  const cmp = { ids: [], focus: 0, filter: "all", group: null, urls: new Map(), token: 0, mode: "pair", actual: false, lane: { side: "a", a: 0, b: 0, aId: null, bId: null, left: "none", right: "pick" }, skipped: new Set(), order: [], aesApplied: false, touched: false };
  const CMP_MODE_KEY = "naiAutoSaver.compareMode2";
  try {
    cmp.mode = localStorage.getItem(CMP_MODE_KEY) === "grid" ? "grid" : "pair";
  } catch (error) {
    void error;
  }
  const CMP_HINTS = {
    grid: "←/→ 고르기 · Q 채택 · W B컷 · E 탈락 · R 미분류 · 두 번 누르면 크게 · M 나란히로 · Esc 닫기",
    pair: "←/→ 넘기기 · 왼쪽·오른쪽을 눌러(또는 Tab) 넘길 쪽 고르기 · Q 채택 · W B컷 · E 탈락 · R 미분류 · S 왼쪽을 기준으로 · Z 둘 다 확대 · M 한눈에로 · Esc 닫기",
  };
  const laneLabelOf = (key) => (key === "none" ? null : key);
  function laneList(side) {
    const want = laneLabelOf(side === "a" ? cmp.lane.left : cmp.lane.right);
    // the 기준 on the right never shows up on the left as well
    const skip = side === "a" ? laneCurrent("b") : null;
    return cmp.ids.filter((id) => (cullOf(id).label || null) === want && id !== skip && !cmp.skipped.has(id));
  }
  // Each lane holds on to the picture it shows (by id): marking another
  // picture never swaps the 기준 out. When a lane's picture leaves the lane,
  // the one that took its place shows (= the next one).
  function laneIndex(side) {
    laneCurrent(side);
    return cmp.lane[side];
  }
  function laneCurrent(side) {
    const list = laneList(side);
    const key = `${side}Id`;
    const at = list.indexOf(cmp.lane[key]);
    if (at >= 0) {
      cmp.lane[side] = at;
      return cmp.lane[key];
    }
    if (!list.length) {
      cmp.lane[side] = 0;
      cmp.lane[key] = null;
      return null;
    }
    cmp.lane[side] = Math.max(0, Math.min(cmp.lane[side], list.length - 1));
    cmp.lane[key] = list[cmp.lane[side]];
    return cmp.lane[key];
  }
  function rollLane(side, step) {
    cmp.touched = true;
    const list = laneList(side);
    cmp.lane.side = side;
    if (list.length) {
      const at = (laneIndex(side) + step + list.length) % list.length;
      cmp.lane[side] = at;
      cmp.lane[`${side}Id`] = list[at];
    }
    cmp.actual = false;
  }
  // After a mark: the left lane shows the next picture by itself; a picture
  // that was marked into the right lane's label (from the left) is shown there.
  function followMark(id, fromSide) {
    if (fromSide === "a" && laneList("b").includes(id) && laneLabelOf(cmp.lane.left) !== laneLabelOf(cmp.lane.right)) cmp.lane.bId = id;
    laneCurrent("b");
    laneCurrent("a");
  }
  // 「이걸로 확정」: the 기준 stays 채택; every other 채택 or 미분류 of the 칸 → B컷
  // (탈락 stays 탈락). One click instead of pressing W on each.
  const finishTargets = (keep) => cmp.ids.filter((id) => id !== keep && (cullOf(id).label === "pick" || !cullOf(id).label));
  const finishCount = (keep) => finishTargets(keep).length;
  function finishGroup() {
    const keep = laneCurrent("b");
    if (!keep) return;
    const ids = finishTargets(keep);
    if (!ids.length) return;
    const before = ids.map((id) => [id, cullOf(id).label || null]);
    applyCullAction(ids, { label: "hold" });
    cmp.skipped = new Set();
    laneCurrent("a");
    renderCompare({ keepImages: true });
    toast(`이 칸은 채택 1장으로 확정했어요 · ${ids.length}장 B컷`, "ok", { label: "되돌리기", run: () => {
      for (const [id, label] of before) applyCullAction([id], { label });
      renderCompare({ keepImages: true });
    } });
  }
  // S: the left picture becomes the 기준 and the old 기준 goes to the left —
  // each takes the other's label when the lanes show different ones.
  function swapLanes() {
    const a = laneCurrent("a");
    const b = laneCurrent("b");
    if (!a) return;
    const left = laneLabelOf(cmp.lane.left);
    const right = laneLabelOf(cmp.lane.right);
    if (left !== right) {
      applyCullAction([a], { label: right });
      if (b) applyCullAction([b], { label: left });
    }
    cmp.lane.bId = a;
    cmp.lane.aId = b;
    cmp.lane.side = "a";
    laneCurrent("b");
    laneCurrent("a");
    renderCompare({ keepImages: true });
  }
  // 나란히 opened on pictures that are all marked already (e.g. everything
  // 채택 first): roll the left lane through that label, not an empty 미분류.
  function pickLeftLane() {
    const count = (want) => cmp.ids.filter((id) => (cullOf(id).label || null) === want).length;
    if (count(laneLabelOf(cmp.lane.left)) > (cmp.lane.left === cmp.lane.right ? 1 : 0)) return;
    if (count(null)) cmp.lane.left = "none";
    else if (count(laneLabelOf(cmp.lane.right)) > 1) cmp.lane.left = cmp.lane.right;
    else if (count("pick") > 1) cmp.lane.left = cmp.lane.right = "pick";
    else if (count("hold") > 1) cmp.lane.left = cmp.lane.right = "hold";
  }
  function markInLane(action) {
    const side = cmp.lane.side;
    const id = laneCurrent(side);
    if (!id) return;
    applyCullAction([id], action);
    followMark(id, side);
    renderCompare({ keepImages: true });
  }
  function setCompareMode(mode) {
    cmp.mode = mode === "pair" ? "pair" : "grid";
    cmp.actual = false;
    try {
      localStorage.setItem(CMP_MODE_KEY, cmp.mode);
    } catch (error) {
      void error;
    }
    renderCompare({ keepImages: true });
  }
  function groupKeyOf(entry) {
    return LibDB.stripCounter(entry.name).trim();
  }
  // What tells pictures of one name apart: "(3)", or "(3) (1)" after Chrome
  // renamed a second "(3)".
  function counterOf(entry) {
    return String(entry.name).slice(groupKeyOf(entry).length).trim();
  }
  // Same-name groups, built once per change of the picture list (a big
  // library made every arrow key / 셀렉 key scan all of it again).
  let groupIndex = null;
  function invalidateGroups() {
    groupIndex = null;
  }
  let dataVersion = 0; // bumped when a picture is added, renamed, moved or removed
  function groupMembers(entry) {
    if (!groupIndex) {
      groupIndex = new Map();
      for (const e of allEntries()) {
        const k = groupKeyOf(e);
        const list = groupIndex.get(k);
        if (list) list.push(e);
        else groupIndex.set(k, [e]);
      }
      for (const list of groupIndex.values()) {
        if (list.length > 1) list.sort((a, b) => a.savedAt - b.savedAt || a.name.localeCompare(b.name, "ko", { numeric: true }));
      }
    }
    return (groupIndex.get(groupKeyOf(entry)) || [entry]).slice();
  }
  function groupsInView() {
    const seen = new Map();
    for (const e of state.shown || []) {
      const key = groupKeyOf(e);
      if (!seen.has(key)) seen.set(key, e);
    }
    return [...seen.entries()].filter(([, e]) => groupMembers(e).length > 1);
  }
  function compareVisible() {
    return cmp.ids.filter((id) => {
      if (cmp.skipped.has(id)) return false;
      const label = cullOf(id).label;
      if (cmp.filter === "keep") return label !== "reject";
      if (cmp.filter === "pick") return label === "pick";
      return true;
    });
  }
  // The groups ‹ › and ] [ walk through: the 셀렉 현황 order when opened from
  // there (캐릭터 → 배경 → 표정), otherwise the same-name groups in view.
  function groupSequence() {
    if (cmp.sequence) return cmp.sequence;
    return groupsInView().map(([key, e]) => ({ key, ids: groupMembers(e).map((m) => m.id) }));
  }
  const groupDone = (ids) => ids.some((id) => cullOf(id).label === "pick");
  // The next group without a 채택 (the one after it when every group is done).
  function nextGroup(step) {
    const seq = groupSequence().filter((g) => g.ids.length > 1);
    if (!seq.length) return null;
    const at = seq.findIndex((g) => g.key === cmp.group);
    for (let i = 1; i <= seq.length; i += 1) {
      const g = seq[(at + step * i + seq.length * i) % seq.length];
      if (g.key !== cmp.group && !groupDone(g.ids)) return g;
    }
    return seq.length > 1 ? seq[(at + step + seq.length) % seq.length] : null;
  }
  function openCompare(ids, { group = null, sequence = undefined } = {}) {
    if (ids.length < 2) return;
    if (sequence !== undefined) cmp.sequence = sequence;
    cmp.ids = ids.slice(0, 600); // a 칸 can hold many takes (several days); all of them are compared
    cmp.group = group;
    cmp.order = cmp.ids.slice(); // as given, before 미적 점수
    cmp.skipped = new Set();
    cmp.aesApplied = false;
    cmp.touched = false;
    applyAesOrder();
    feedAesFromCompare();
    cmp.focus = 0;
    cmp.lane = { side: "a", a: 0, b: 0, aId: null, bId: null, left: cmp.lane.left || "none", right: cmp.lane.right || "pick" };
    pickLeftLane();
    cmp.actual = false;
    $(".compare").hidden = false;
    renderCompare();
  }
  function closeCompare() {
    $(".compare").hidden = true;
    if (state.board) renderBoard({ keepScroll: true });
    cmp.token += 1;
    for (const url of cmp.urls.values()) URL.revokeObjectURL(url);
    cmp.urls.clear();
    $(".cmp-grid").innerHTML = "";
  }
  function stepGroup(step) {
    const g = nextGroup(step);
    if (g) openCompare(g.ids, { group: g.key });
  }
  // Columns that make the pictures as big as possible in the space we have.
  function bestColumns(n, width, height, aspect) {
    let best = 1;
    let bestSize = 0;
    for (let cols = 1; cols <= n; cols += 1) {
      const rows = Math.ceil(n / cols);
      const w = width / cols;
      const h = height / rows;
      const size = Math.min(w, h * aspect);
      if (size > bestSize) {
        bestSize = size;
        best = cols;
      }
    }
    return best;
  }
  function renderCompare({ keepImages = false } = {}) {
    const box = $(".compare");
    const grid = $(".cmp-grid");
    const visible = compareVisible();
    cmp.focus = Math.max(0, Math.min(cmp.focus, visible.length - 1));
    const counts = { none: 0, pick: 0, hold: 0, reject: 0 };
    for (const id of cmp.ids) counts[cullOf(id).label || "none"] += 1;
    $(".cmp-title").textContent = cmp.group || `고른 ${cmp.ids.length}장`;
    const groups = cmp.group ? groupSequence().filter((g) => g.ids.length > 1) : [];
    const left = groups.filter((g) => !groupDone(g.ids)).length;
    $(".cmp-sub").textContent = [cmp.mode === "pair" ? `${cmp.ids.length}장` : `${visible.length} / ${cmp.ids.length}장`, `채택 ${counts.pick}`, `B컷 ${counts.hold}`, `탈락 ${counts.reject}`, `${NONE_LABEL} ${counts.none}`, groups.length > 1 ? (left ? `남은 칸 ${left} / ${groups.length}` : `${groups.length}칸 모두 채택 ✓`) : ""].filter(Boolean).join(" · ");
    box.querySelectorAll(".cmp-nav").forEach((b) => { b.hidden = !(groups.length > 1); });
    box.querySelectorAll("[data-cmp-filter]").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.cmpFilter === cmp.filter)));
    box.querySelectorAll("[data-cmp-mode]").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.cmpMode === cmp.mode)));
    box.dataset.mode = cmp.mode;
    box.dataset.actual = String(cmp.actual);
    $(".cmp-hint").textContent = CMP_HINTS[cmp.mode];
    renderAesChip();
    if (cmp.mode === "pair") {
      renderPair(grid);
      return;
    }
    if (!visible.length) {
      grid.style.gridTemplateColumns = "";
      grid.innerHTML = `<div class="cmp-empty">${cmp.filter === "pick" ? "아직 채택한 그림이 없어요." : "보이는 그림이 없어요."}<br><button type="button" class="btn small" data-cmp-filter="all">전체 보기</button></div>`;
      return;
    }
    const first = byId(visible[0]) || {};
    const aspect = first.w && first.h ? first.w / first.h : 2 / 3;
    const rect = grid.getBoundingClientRect();
    const cols = bestColumns(visible.length, Math.max(200, rect.width - 24), Math.max(200, rect.height - 24), aspect);
    const rows = Math.ceil(visible.length / cols);
    grid.style.gridTemplateColumns = `repeat(${cols}, minmax(0, 1fr))`;
    grid.style.gridTemplateRows = `repeat(${rows}, minmax(${rows > 4 ? "220px" : "0"}, 1fr))`;
    const old = keepImages ? new Map([...grid.querySelectorAll(".cmp-cell")].map((c) => [c.dataset.id, c.querySelector("img")])) : new Map();
    grid.innerHTML = "";
    visible.forEach((id, i) => {
      const entry = byId(id);
      if (!entry) return;
      const label = cullOf(id).label;
      const cell = el("div", { class: "cmp-cell", "data-id": id, "data-focus": String(i === cmp.focus), "data-cull": label || null });
      const img = old.get(id) || el("img", { src: cmp.urls.get(id) || thumbUrl(entry), alt: entry.name, draggable: "false" });
      cell.append(img, el("div", { class: "cmp-cap" }, [
        el("span", { class: "cmp-name", text: counterOf(entry) || entry.name }),
        el("span", { class: "tile-cull", html: tileCullHtml(id) }),
        aesBadge(id),
      ]));
      const quick = el("div", { class: "cmp-quick", role: "group", "aria-label": "셀렉" });
      for (const [l, text] of CULL_CHOICES) quick.append(el("button", { type: "button", "data-quick": l, "aria-pressed": String((label || "none") === l), text }));
      cell.append(quick);
      grid.append(cell);
    });
    if (!keepImages) void loadCompareOriginals(visible);
    grid.querySelector('.cmp-cell[data-focus="true"]')?.scrollIntoView({ block: "nearest" });
  }
  function renderPair(grid) {
    const old = new Map([...grid.querySelectorAll(".cmp-cell")].map((c) => [c.dataset.id, c.querySelector("img")]));
    grid.innerHTML = "";
    grid.style.gridTemplateColumns = "repeat(2, minmax(0, 1fr))";
    grid.style.gridTemplateRows = "minmax(0, 1fr)";
    const preload = [];
    for (const side of ["a", "b"]) {
      const list = laneList(side);
      const at = laneIndex(side);
      const id = list[at] || null;
      const entry = id ? byId(id) : null;
      const cell = el("div", { class: "cmp-cell cmp-lane", "data-side": side, "data-id": id || null, "data-focus": String(cmp.lane.side === side), "data-cull": id ? cullOf(id).label || null : null });
      const title = side === "a"
        ? el("div", { class: "cmp-lane-pick", role: "radiogroup", "aria-label": "왼쪽에서 넘겨 볼 것" },
          ["none", "pick", "hold"].map((l) => el("button", { type: "button", role: "radio", "data-lane-left": l, "aria-checked": String(cmp.lane.left === l), text: l === "none" ? NONE_LABEL : LABELS[l] })))
        : el("div", { class: "cmp-lane-pick", role: "radiogroup", "aria-label": "기준 (오른쪽)" },
          ["pick", "hold"].map((l) => el("button", { type: "button", role: "radio", "data-lane-right": l, "aria-checked": String(cmp.lane.right === l), text: `기준 ${LABELS[l]}` })));
      cell.append(el("div", { class: "cmp-lane-head" }, [
        title,
        side === "b" ? el("button", { class: "cmp-swap", type: "button", "data-swap": "1", title: "왼쪽 그림을 기준으로 (S)", disabled: laneCurrent("a") ? null : "", html: `${icon("swap", 14)}<span>바꾸기</span>` }) : null,
        side === "b" && id && cmp.lane.right === "pick" && finishCount(id) ? el("button", { class: "cmp-swap cmp-finish", type: "button", "data-finish": "1", title: "이 그림만 채택으로 남기고, 이 칸의 나머지(채택·미분류)는 전부 B컷으로", html: `${icon("check", 14)}<span>이걸로 확정 · 나머지 ${finishCount(id)}장 B컷</span>` }) : null,
        el("span", { class: "cmp-lane-count", text: list.length ? `${at + 1} / ${list.length}` : "0장" }),
        el("button", { class: "cmp-roll", type: "button", "data-roll": "-1", "aria-label": "이전", disabled: list.length < 2 ? "" : null, text: "‹" }),
        el("button", { class: "cmp-roll", type: "button", "data-roll": "1", "aria-label": "다음", disabled: list.length < 2 ? "" : null, text: "›" }),
      ]));
      if (entry) {
        const img = old.get(id) || el("img", { src: cmp.urls.get(id) || thumbUrl(entry), alt: entry.name, draggable: "false" });
        cell.append(el("div", { class: "cmp-scroll" }, [img]), el("div", { class: "cmp-cap" }, [
          el("span", { class: "cmp-name", text: counterOf(entry) || entry.name }),
          el("span", { class: "tile-cull", html: tileCullHtml(id) }),
          aesBadge(id),
        ]));
        const quick = el("div", { class: "cmp-quick", role: "group", "aria-label": "셀렉" });
        const label = cullOf(id).label;
        for (const [l, text] of CULL_CHOICES) quick.append(el("button", { type: "button", "data-quick": l, "aria-pressed": String((label || "none") === l), text }));
        cell.append(quick);
        preload.push(id, list[(at + 1) % list.length], list[(at - 1 + list.length) % list.length]);
      } else {
        const leftName = cmp.lane.left === "none" ? NONE_LABEL : LABELS[cmp.lane.left];
        const msg = side === "a"
          ? (!cmp.ids.length ? ""
            : cmp.lane.left === cmp.lane.right ? `<p>기준 말고 남은 ${leftName}이 없어요. 다 골랐어요!</p>`
            : `<p>${leftName} 그림이 없어요.${cmp.lane.left === "none" ? " 다 골랐어요!" : ""}</p>`)
          : `<p>아직 ${LABELS[cmp.lane.right]}이 없어요.<br>왼쪽에서 <b>${cmp.lane.right === "pick" ? "Q" : "W"}</b>를 누르면 여기로 와요.</p>`;
        cell.append(el("div", { class: "cmp-lane-empty", html: msg }));
        const next = side === "a" && cmp.group ? nextGroup(1) : null;
        if (next) {
          const label = groupDone(next.ids) ? "다음 이름" : "다음 안 한 칸";
          cell.querySelector(".cmp-lane-empty").append(el("button", { class: "btn small", type: "button", "data-next-group": "1", text: `${label}: ${next.key} ›` }));
        }
      }
      grid.append(cell);
    }
    void loadCompareOriginals([...new Set(preload.filter(Boolean))]);
    syncPairScroll(grid);
  }
  // In 1:1 zoom both pictures scroll together, so the same spot stays side by side.
  function syncPairScroll(grid) {
    const panes = [...grid.querySelectorAll(".cmp-scroll")];
    let busy = false;
    for (const pane of panes) {
      pane.addEventListener("scroll", () => {
        if (busy || !cmp.actual) return;
        busy = true;
        const fx = pane.scrollLeft / Math.max(1, pane.scrollWidth - pane.clientWidth);
        const fy = pane.scrollTop / Math.max(1, pane.scrollHeight - pane.clientHeight);
        for (const other of panes) {
          if (other === pane) continue;
          other.scrollLeft = fx * (other.scrollWidth - other.clientWidth);
          other.scrollTop = fy * (other.scrollHeight - other.clientHeight);
        }
        requestAnimationFrame(() => { busy = false; });
      });
    }
  }
  function togglePairZoom(atX = 0.5, atY = 0.5) {
    cmp.actual = !cmp.actual;
    $(".compare").dataset.actual = String(cmp.actual);
    if (!cmp.actual) return;
    requestAnimationFrame(() => {
      for (const pane of document.querySelectorAll(".cmp-scroll")) {
        pane.scrollLeft = atX * (pane.scrollWidth - pane.clientWidth);
        pane.scrollTop = atY * (pane.scrollHeight - pane.clientHeight);
      }
    });
  }

  async function loadCompareOriginals(ids) {
    const token = (cmp.token += 1);
    for (const id of ids) {
      if (cmp.urls.has(id)) continue;
      const entry = byId(id);
      const file = entry ? await originalFile(entry, { ask: false }).catch(() => null) : null;
      if (token !== cmp.token) return;
      if (!file) continue;
      const url = URL.createObjectURL(file);
      cmp.urls.set(id, url);
      const img = document.querySelector(`.cmp-cell[data-id="${CSS.escape(id)}"] img`);
      if (img) img.src = url;
    }
  }
  function bindCompare() {
    const box = $(".compare");
    $(".cmp-close").addEventListener("click", closeCompare);
    $(".cmp-prev-group").addEventListener("click", () => stepGroup(-1));
    $(".cmp-next-group").addEventListener("click", () => stepGroup(1));
    box.addEventListener("click", (event) => {
      const mode = event.target.closest("[data-cmp-mode]");
      if (mode) {
        setCompareMode(mode.dataset.cmpMode);
        return;
      }
      const filter = event.target.closest("[data-cmp-filter]");
      if (filter) {
        cmp.filter = filter.dataset.cmpFilter;
        renderCompare({ keepImages: true });
        return;
      }
      const quick = event.target.closest("[data-quick]");
      if (quick) {
        const id = quick.closest(".cmp-cell").dataset.id;
        cmp.focus = compareVisible().indexOf(id);
        if (cmp.mode === "pair") cmp.lane.side = quick.closest(".cmp-cell").dataset.side;
        applyCullAction([id], { label: quick.dataset.quick === "none" ? null : quick.dataset.quick });
        if (cmp.mode === "pair") { followMark(id, quick.closest(".cmp-cell").dataset.side); renderCompare({ keepImages: true }); }
        return;
      }
      const roll = event.target.closest("[data-roll]");
      if (roll) {
        rollLane(roll.closest(".cmp-cell").dataset.side, Number(roll.dataset.roll));
        renderCompare({ keepImages: true });
        return;
      }
      const right = event.target.closest("[data-lane-right]");
      if (right) {
        cmp.lane.right = right.dataset.laneRight;
        cmp.lane.b = 0;
        cmp.lane.bId = null;
        cmp.lane.side = "b";
        renderCompare({ keepImages: true });
        return;
      }
      const left = event.target.closest("[data-lane-left]");
      if (left) {
        cmp.lane.left = left.dataset.laneLeft;
        cmp.lane.a = 0;
        cmp.lane.aId = null;
        cmp.lane.side = "a";
        renderCompare({ keepImages: true });
        return;
      }
      if (event.target.closest("[data-swap]")) { swapLanes(); return; }
      if (event.target.closest("[data-finish]")) { finishGroup(); return; }
      if (event.target.closest("[data-next-group]")) { stepGroup(1); return; }
      const cell = event.target.closest(".cmp-cell");
      if (cell && cmp.mode === "pair") {
        cmp.lane.side = cell.dataset.side;
        box.querySelectorAll(".cmp-cell").forEach((c) => { c.dataset.focus = String(c === cell); });
        return;
      }
      if (cell) {
        cmp.focus = compareVisible().indexOf(cell.dataset.id);
        box.querySelectorAll(".cmp-cell").forEach((c) => { c.dataset.focus = String(c === cell); });
      }
    });
    box.addEventListener("dblclick", (event) => {
      const cell = event.target.closest(".cmp-cell");
      if (!cell || !cell.querySelector("img")) return;
      if (cmp.mode === "pair") {
        // zoom both to the spot that was double-clicked
        const img = cell.querySelector("img").getBoundingClientRect();
        togglePairZoom((event.clientX - img.left) / Math.max(1, img.width), (event.clientY - img.top) / Math.max(1, img.height));
        return;
      }
      openLightbox(cell.dataset.id);
    });
    let resizeTimer = null;
    window.addEventListener("resize", () => {
      if (box.hidden) return;
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => renderCompare({ keepImages: true }), 120);
    });
    document.addEventListener("keydown", (event) => {
      if (box.hidden || !$(".lightbox").hidden) return;
      if (event.target.closest?.("input, textarea")) return;
      const visible = compareVisible();
      const action = cullAction(event);
      const stop = () => { event.preventDefault(); event.stopImmediatePropagation(); };
      if (!event.metaKey && !event.ctrlKey && event.code === "KeyM") {
        stop();
        setCompareMode(cmp.mode === "pair" ? "grid" : "pair");
        return;
      }
      if (cmp.mode === "pair") {
        if (action) { stop(); markInLane(action); return; }
        if (event.key === "ArrowLeft" || event.key === "ArrowUp") { stop(); rollLane(cmp.lane.side, -1); renderCompare({ keepImages: true }); return; }
        if (event.key === "ArrowRight" || event.key === "ArrowDown") { stop(); rollLane(cmp.lane.side, 1); renderCompare({ keepImages: true }); return; }
        if (event.code === "KeyS" && !event.metaKey && !event.ctrlKey && !event.altKey) { stop(); swapLanes(); return; }
        if (event.key === "Tab") { stop(); cmp.lane.side = cmp.lane.side === "a" ? "b" : "a"; renderCompare({ keepImages: true }); return; }
        if (event.code === "KeyZ" && !event.metaKey && !event.ctrlKey) { stop(); togglePairZoom(); return; }
        if (event.key === "Escape" && cmp.actual) { stop(); togglePairZoom(); return; }
        if (event.key === " ") { stop(); const id = laneCurrent(cmp.lane.side); if (id) openLightbox(id); return; }
      }
      if (action) {
        event.preventDefault();
        event.stopImmediatePropagation();
        const id = visible[cmp.focus];
        if (!id) return;
        applyCullAction([id], action);
        // Marked: move on to the next picture (unless it just left the view).
        if ("label" in action && action.label && compareVisible().includes(id)) cmp.focus = Math.min(cmp.focus + 1, compareVisible().length - 1);
        renderCompare({ keepImages: true });
        return;
      }
      const moves = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 };
      if (event.key in moves) {
        event.preventDefault();
        event.stopImmediatePropagation();
        cmp.focus = (cmp.focus + moves[event.key] + visible.length) % Math.max(1, visible.length);
        renderCompare({ keepImages: true });
      } else if (event.key === "Escape") {
        event.preventDefault();
        event.stopImmediatePropagation();
        closeCompare();
      } else if (event.key === "[" || event.key === "]") {
        event.preventDefault();
        event.stopImmediatePropagation();
        if (cmp.group) stepGroup(event.key === "]" ? 1 : -1);
      } else if (event.key === " " && visible[cmp.focus]) {
        event.preventDefault();
        event.stopImmediatePropagation();
        openLightbox(visible[cmp.focus]);
      }
    }, true);
  }

  // ------------------------------------------------------------ selection ---
  // Standard file-browser selection (Finder / Explorer / Google Drive):
  //   click            → only this one
  //   ⌘/Ctrl + click   → add / remove this one
  //   Shift + click    → range from the last clicked (⌘/Ctrl+Shift adds the range)
  //   circle on a tile → add / remove (for mouse-only use)
  //   drag on empty space → box selection; click on empty space → nothing selected
  function handleGridClick(event) {
    const tile = event.target.closest(".tile");
    if (!tile) return;
    const id = tile.dataset.id;
    if (event.detail > 1) return; // second click of a double-click opens the viewer
    const additive = event.metaKey || event.ctrlKey;
    if (event.shiftKey && state.anchor) {
      const ids = state.shown.map((e) => e.id);
      const a = ids.indexOf(state.anchor);
      const b = ids.indexOf(id);
      if (a >= 0 && b >= 0) {
        const range = ids.slice(Math.min(a, b), Math.max(a, b) + 1);
        state.sel = additive ? [...new Set([...state.sel, ...range])] : range;
      }
    } else if (additive || event.target.closest(".tile-check")) {
      state.sel = state.sel.includes(id) ? state.sel.filter((x) => x !== id) : [...state.sel, id];
      state.anchor = id;
    } else {
      state.sel = [id];
      state.anchor = id;
    }
    updateSelectionLook();
  }

  // Box selection: press on empty space in the gallery and drag.
  function bindMarquee() {
    const gallery = $(".gallery");
    let start = null;
    let box = null;
    let base = [];
    const point = (e) => {
      const r = gallery.getBoundingClientRect();
      return { x: e.clientX - r.left + gallery.scrollLeft, y: e.clientY - r.top + gallery.scrollTop };
    };
    gallery.addEventListener("pointerdown", (e) => {
      if (e.button !== 0 || e.target.closest(".tile, button, a, input, .banner")) return;
      if (e.offsetX > gallery.clientWidth) return; // the scrollbar
      start = point(e);
      base = e.metaKey || e.ctrlKey || e.shiftKey ? [...state.sel] : [];
      box = null;
      gallery.setPointerCapture(e.pointerId);
    });
    gallery.addEventListener("pointermove", (e) => {
      if (!start) return;
      const p = point(e);
      if (!box) {
        if (Math.abs(p.x - start.x) < 4 && Math.abs(p.y - start.y) < 4) return;
        box = el("div", { class: "marquee" });
        gallery.append(box);
      }
      const x0 = Math.min(start.x, p.x);
      const y0 = Math.min(start.y, p.y);
      const x1 = Math.max(start.x, p.x);
      const y1 = Math.max(start.y, p.y);
      Object.assign(box.style, { left: `${x0}px`, top: `${y0}px`, width: `${x1 - x0}px`, height: `${y1 - y0}px` });
      const g = gallery.getBoundingClientRect();
      const hit = [];
      document.querySelectorAll(".tile").forEach((tile) => {
        const r = tile.getBoundingClientRect();
        const tx0 = r.left - g.left + gallery.scrollLeft;
        const ty0 = r.top - g.top + gallery.scrollTop;
        if (tx0 < x1 && tx0 + r.width > x0 && ty0 < y1 && ty0 + r.height > y0) hit.push(tile.dataset.id);
      });
      state.sel = [...new Set([...base, ...hit])];
      updateSelectionLook();
      // keep going past the edge
      if (e.clientY > g.bottom - 30) gallery.scrollTop += 18;
      else if (e.clientY < g.top + 30) gallery.scrollTop -= 18;
    });
    const end = () => {
      if (!start) return;
      if (!box && !base.length) {
        state.sel = []; // a plain click on empty space clears
        updateSelectionLook();
      }
      box?.remove();
      box = null;
      start = null;
    };
    gallery.addEventListener("pointerup", end);
    gallery.addEventListener("pointercancel", end);
  }

  function moveSelection(step) {
    const ids = state.shown.map((e) => e.id);
    if (!ids.length) return;
    const current = ids.indexOf(state.sel[state.sel.length - 1]);
    const cols = Math.max(1, Math.round($(".grid").clientWidth / 164));
    const delta = { left: -1, right: 1, up: -cols, down: cols }[step];
    const next = Math.max(0, Math.min(ids.length - 1, (current < 0 ? 0 : current + delta)));
    while (next >= state.rendered) renderMoreTiles();
    state.sel = [ids[next]];
    state.anchor = ids[next];
    updateSelectionLook();
    document.querySelector(`.tile[data-id="${CSS.escape(ids[next])}"]`)?.scrollIntoView({ block: "nearest" });
  }

  // ----------------------------------------------------- originals & folder ---
  async function connectFolder() {
    try {
      let handle = state.root;
      if (handle) {
        const perm = await handle.requestPermission({ mode: "read" });
        if (perm !== "granted") return;
      } else {
        handle = await window.showDirectoryPicker({ id: "nai-autosaver-library", mode: "read", startIn: "downloads" });
        await LibDB.setKv("root", handle);
      }
      state.root = handle;
      state.rootPerm = "granted";
      renderFolderBox();
      void scanFolder().then(() => syncFolder({ quiet: true }));
      return true;
    } catch (error) {
      if (error?.name !== "AbortError") toast(`폴더를 열지 못했어요: ${error.message || error}`, "warn");
      return false;
    }
  }

  async function restoreFolder() {
    try {
      const handle = await LibDB.getKv("root");
      if (!handle) return;
      state.root = handle;
      state.rootPerm = (await handle.queryPermission({ mode: "read" })) === "granted" ? "granted" : "prompt";
    } catch (error) {
      state.root = null;
    }
  }

  async function* walk(dir, prefix) {
    for await (const [name, handle] of dir.entries()) {
      if (name.startsWith(".")) continue;
      if (handle.kind === "directory" && (name === CULL_FOLDER || name === TRASH_FOLDER)) continue; // our own sorted copies, trash
      if (handle.kind === "directory") {
        yield* walk(handle, `${prefix}/${name}`);
      } else if (/\.(png|webp)$/i.test(name)) {
        yield { path: `${prefix}/${name}`, handle };
      }
    }
  }

  async function scanFolder({ quiet = false } = {}) {
    if (!state.root || state.scan) return;
    const known = new Set(await LibDB.keys());
    const knownSig = new Set(state.entries.filter((e) => e.bytes).map((e) => pictureSig(e.name, e.bytes)));
    const found = [];
    state.scan = { done: 0, total: 0, added: 0 };
    renderFolderBox();
    try {
      for await (const item of walk(state.root, state.root.name)) {
        found.push(item);
        state.scan.total = found.length;
        if (found.length % 200 === 0) renderFolderBox();
      }
      renderFolderBox();
      let lastRender = Date.now();
      for (const item of found) {
        state.scan.done += 1;
        if (known.has(item.path)) continue;
        try {
          const file = await item.handle.getFile();
          const name = item.path.split("/").pop().replace(/\.(png|webp)$/i, "");
          if (knownSig.has(pictureSig(name, file.size))) continue; // already here under another path
          const bytes = new Uint8Array(await file.arrayBuffer());
          const entry = await LibDB.buildEntry({
            path: item.path, bytes, savedAt: file.lastModified || Date.now(),
            source: item.path.includes("/_메타없음/") ? "clean" : "folder",
          });
          await LibDB.put(entry);
          upsert(entry);
          state.scan.added += 1;
        } catch (error) {
          void error;
        }
        if (Date.now() - lastRender > 700) {
          lastRender = Date.now();
          renderFolderBox();
          if (state.scan.added && state.scan.added % 50 === 0) render();
        }
      }
      const added = state.scan.added;
      state.scan = null;
      if (added) render();
      else renderFolderBox();
      if (!quiet || added) toast(added ? `폴더에서 새 그림 ${added.toLocaleString("ko-KR")}장을 가져왔어요.` : "폴더의 그림은 이미 다 보관함에 있어요.");
      watchFolder();
    } catch (error) {
      state.scan = null;
      render();
      toast(`폴더를 훑다가 멈췄어요: ${error.message || error}`, "warn");
    }
  }

  // ---- New pictures while the page is open (a queue is running). They are
  // gathered and drawn in one go, and never while the user is pressing keys
  // (셀렉): a full redraw of a big library under the fingers feels like a freeze.
  let lastInput = 0;
  const incoming = new Set();
  let incomingTimer = null;
  let incomingSince = 0;
  function arrived(id) {
    incoming.add(id);
    if (!incomingSince) incomingSince = Date.now();
    clearTimeout(incomingTimer);
    incomingTimer = setTimeout(flushIncoming, 800);
  }
  async function flushIncoming() {
    incomingTimer = null;
    const busy = Date.now() - lastInput < 2500;
    if (busy && Date.now() - incomingSince < 20000) {
      incomingTimer = setTimeout(flushIncoming, 1500);
      return;
    }
    const ids = [...incoming];
    incoming.clear();
    incomingSince = 0;
    let changed = false;
    for (const id of ids) {
      const entry = await LibDB.get(id).catch(() => null);
      if (!entry) continue;
      upsert(entry);
      changed = true;
    }
    if (!changed) return;
    const keepScroll = $(".gallery").scrollTop;
    render();
    $(".gallery").scrollTop = keepScroll;
  }

  // ---- 폴더와 맞추기: what changed in the folder (탐색기에서 지우기·옮기기·새 파일)
  // shows up here. Runs when the page comes back into view, every minute while
  // it is visible, and right away where Chrome can watch the folder.
  let syncing = false;
  let lastSync = 0;
  let syncAgain = null;
  async function syncFolder({ quiet = true } = {}) {
    if (!state.root || state.rootPerm !== "granted") return;
    if (state.scan || syncing || (quiet && Date.now() - lastSync < 5000)) {
      // busy or just done: come back once instead of dropping the change
      clearTimeout(syncAgain);
      syncAgain = setTimeout(() => void syncFolder({ quiet }), Math.max(1000, 5000 - (Date.now() - lastSync)));
      return;
    }
    syncing = true;
    lastSync = Date.now();
    try {
      const found = new Map(); // path inside the linked folder → handle
      for await (const item of walk(state.root, state.root.name)) found.set(item.path.split("/").slice(1).join("/"), item);
      if (!found.size) return; // an empty or unreachable folder never empties the library
      const tops = new Set([...found.keys()].map((k) => k.split("/")[0]));
      // An entry belongs to this folder when its path runs through the linked
      // folder's name (NovelAI/2/… with NovelAI linked: even if folder "2" is
      // gone now), or starts with a folder that is there (NovelAI/… with 다운로드
      // linked).
      const covered = (e, rel) => rel.length > 1 && !rel.includes(CULL_FOLDER) && !rel.includes(TRASH_FOLDER)
        && (e.path.split("/").slice(0, -1).includes(state.root.name) || tops.has(rel[0]));
      const files = onDisk(state.entries);
      const known = new Set();
      const gone = [];
      for (const e of files) {
        const rel = relSegments(e);
        const key = rel.join("/");
        known.add(key);
        if (covered(e, rel) && !found.has(key)) gone.push(e);
      }
      // Same name + size showing up elsewhere = the file was moved: follow it.
      const goneBySig = new Map();
      for (const e of gone) if (e.bytes) goneBySig.set(pictureSig(e.name, e.bytes), e);
      const fresh = [...found.entries()].filter(([key]) => !known.has(key));
      let moved = 0;
      const rest = [];
      for (const [key, item] of fresh) {
        const name = key.split("/").pop().replace(/\.(png|webp)$/i, "");
        let size = -1;
        try { size = (await item.handle.getFile()).size; } catch (error) { continue; }
        const match = goneBySig.get(pictureSig(name, size));
        if (match) {
          goneBySig.delete(pictureSig(name, size));
          gone.splice(gone.indexOf(match), 1);
          await retarget(match, `${state.root.name}/${key}`);
          moved += 1;
        } else {
          rest.push({ item, key, size });
        }
      }
      // Renamed in 탐색기 (과한웃음 → 잠식): same folder, same size, and the
      // only such pair there → the same picture; its 셀렉 goes along.
      const dirOf = (p) => p.split("/").slice(0, -1).join("/");
      const goneByDirSize = new Map();
      for (const e of gone) {
        if (!e.bytes) continue;
        const k = `${dirOf(relSegments(e).join("/"))}|${e.bytes}`;
        goneByDirSize.set(k, goneByDirSize.has(k) ? null : e);
      }
      const freshByDirSize = new Map();
      for (const r of rest) {
        const k = `${dirOf(r.key)}|${r.size}`;
        freshByDirSize.set(k, (freshByDirSize.get(k) || 0) + 1);
      }
      const stillNew = [];
      for (const r of rest) {
        const k = `${dirOf(r.key)}|${r.size}`;
        const match = goneByDirSize.get(k);
        if (match && freshByDirSize.get(k) === 1) {
          goneByDirSize.delete(k);
          gone.splice(gone.indexOf(match), 1);
          await retarget(match, `${state.root.name}/${r.key}`);
          moved += 1;
        } else {
          stillNew.push(r.item);
        }
      }
      rest.length = 0;
      rest.push(...stillNew);
      // Many files missing at once looks like a drive/folder problem: ask first.
      const coveredCount = files.filter((e) => covered(e, relSegments(e))).length;
      const drop = async () => {
        for (const e of gone) await forget(e);
        saveCull();
        render();
      };
      const massive = gone.length > 30 && gone.length > coveredCount * 0.3;
      let dropped = 0;
      if (gone.length && (!massive || (!quiet && await confirmDialog(`폴더에 없는 그림 ${gone.length.toLocaleString("ko-KR")}장`, "보관함에는 있는데 연결한 폴더에서 파일을 찾을 수 없어요 (지웠거나, 이름이 바뀌었거나, 옮겼어요). 목록에서 뺄까요? 파일은 건드리지 않아요.", "목록에서 빼기")))) {
        await drop();
        dropped = gone.length;
      }
      // a big "missing" batch found in the background waits on the folder row
      state.pendingGone = massive && !dropped ? gone : null;
      renderFolderBox();
      renderBanner();
      if (moved && !dropped) {
        saveCull();
        render();
      }
      const parts = [];
      if (moved) parts.push(`옮겨진 ${moved}장 따라감`);
      if (dropped) parts.push(`폴더에 없는 ${dropped.toLocaleString("ko-KR")}장 뺌`);
      if (parts.length) toast(`폴더에 맞췄어요 · ${parts.join(" · ")}`, "ok");
      else if (!quiet && !rest.length) toast("보관함이 폴더와 이미 맞아요.", "ok");
      syncing = false;
      if (rest.length) await scanFolder({ quiet: true }); // new files: the usual import (with progress)
    } catch (error) {
      void error; // permission gone, folder unplugged, …: try again next time
    } finally {
      syncing = false;
    }
  }
  async function importNew(items) {
    if (!state.root || state.scan) return;
    // pictures the extension already filed but not drawn yet count as known
    for (const id of incoming) {
      const entry = await LibDB.get(id).catch(() => null);
      if (entry) upsert(entry);
    }
    const byPath = new Set(state.entries.map((e) => e.path));
    const knownSig = new Set(state.entries.filter((e) => e.bytes).map((e) => pictureSig(e.name, e.bytes)));
    let added = 0;
    for (const [rel, handle] of items) {
      const path = `${state.root.name}/${rel}`;
      if (byPath.has(path) || incoming.has(path)) continue;
      try {
        const file = await handle.getFile();
        const name = rel.split("/").pop().replace(/\.(png|webp)$/i, "");
        if (knownSig.has(pictureSig(name, file.size))) continue;
        if (await LibDB.get(path)) { arrived(path); continue; }
        const bytes = new Uint8Array(await file.arrayBuffer());
        const entry = await LibDB.buildEntry({ path, bytes, savedAt: file.lastModified || Date.now(), source: path.includes("/_메타없음/") ? "clean" : "folder" });
        await LibDB.put(entry);
        arrived(entry.id);
        added += 1;
      } catch (error) {
        void error; // gone again, still being written, …
      }
    }
    return added;
  }
  let folderObserver = null;
  function watchFolder() {
    if (!state.root || state.rootPerm !== "granted") return;
    if (!folderObserver && typeof window.FileSystemObserver === "function") {
      let t = null;
      const later = new Map(); // path inside the folder → file handle
      let laterTimer = null;
      try {
        folderObserver = new window.FileSystemObserver((records) => {
          let full = false;
          for (const r of records || []) {
            const parts = r.relativePathComponents || [];
            const name = parts[parts.length - 1] || "";
            if (parts.includes(CULL_FOLDER) || parts.includes(TRASH_FOLDER) || parts.some((p) => p.startsWith("."))) continue;
            const from = r.relativePathMovedFrom || [];
            const finished = r.type === "moved" && String(from[from.length - 1] || "").endsWith(".crdownload");
            if ((r.type === "appeared" || r.type === "modified" || finished) && r.changedHandle?.kind === "file") {
              if (/\.(png|webp)$/i.test(name)) later.set(parts.join("/"), r.changedHandle);
              continue; // .crdownload and other files: nothing to do
            }
            if (r.type === "appeared" && r.changedHandle?.kind === "directory") continue; // its files report themselves
            if ((r.type === "disappeared" || r.type === "moved") && name.endsWith(".crdownload")) continue; // a download finishing
            if ((r.type === "disappeared" || r.type === "moved") && (isOwnChange(parts) || isOwnChange(r.relativePathMovedFrom))) continue; // our own 휴지통·옮기기·이름 바꾸기
            full = true; // removed, moved, renamed, unknown: look at the whole folder
          }
          if (later.size) {
            clearTimeout(laterTimer);
            // the extension usually files a new save itself within a few seconds
            laterTimer = setTimeout(() => {
              const items = [...later];
              later.clear();
              void importNew(items);
            }, 6000);
          }
          if (full) {
            clearTimeout(t);
            t = setTimeout(() => void syncFolder(), 2500);
          }
        });
        folderObserver.observe(state.root, { recursive: true }).catch(() => { folderObserver = null; });
      } catch (error) {
        folderObserver = null;
      }
    }
  }

  // Returns the original picture file, from a dropped File or the linked folder.
  async function originalFile(entry, { ask = true } = {}) {
    if (state.files.has(entry.id)) return state.files.get(entry.id);
    if (!state.root) {
      if (!ask) return null;
      const ok = await confirmDialog("원본 그림을 읽으려면 폴더 연결이 필요해요", `보관함에는 작은 미리보기만 있어요. NovelAI 그림이 저장된 폴더(다운로드/${state.saveFolder})를 한 번 연결하면 원본으로 사본을 만들어요.`, "폴더 연결");
      if (!ok || !(await connectFolder())) return null;
    }
    if (state.rootPerm !== "granted") {
      if (!ask) return null;
      const perm = await state.root.requestPermission({ mode: "read" });
      if (perm !== "granted") return null;
      state.rootPerm = "granted";
      renderFolderBox();
    }
    const segments = entry.path.split("/");
    const at = segments.indexOf(state.root.name);
    const rest = at >= 0 ? segments.slice(at + 1) : segments;
    let dir = state.root;
    try {
      for (const part of rest.slice(0, -1)) dir = await dir.getDirectoryHandle(part);
      const handle = await dir.getFileHandle(rest[rest.length - 1]);
      return await handle.getFile();
    } catch (error) {
      if (ask) toast(`원본을 찾지 못했어요: ${entry.path}`, "warn");
      return null;
    }
  }

  // ------------------------------------------------------------- clean copy ---
  function cleanFolder() {
    return `${state.saveFolder}/_메타없음/${today()}`;
  }
  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    return new Promise((resolve, reject) => {
      chrome.downloads.download({ url, filename, saveAs: false, conflictAction: "uniquify" }, async (id) => {
        const err = chrome.runtime.lastError;
        if (err || id == null) {
          URL.revokeObjectURL(url);
          reject(new Error(err?.message || "다운로드 실패"));
          return;
        }
        // Poll instead of relying on one onChanged event: it can be missed.
        let item = null;
        for (let i = 0; i < 120; i += 1) {
          [item] = await chrome.downloads.search({ id });
          if (!item || item.state !== "in_progress") break;
          await new Promise((r) => setTimeout(r, 250));
        }
        setTimeout(() => URL.revokeObjectURL(url), 5000);
        resolve({ id, item, ok: !item || item.state !== "interrupted" });
      });
    });
  }

  async function makeCleanCopies(entries) {
    if (!entries.length) return;
    let made = 0;
    let lastId = null;
    const failed = [];
    for (let i = 0; i < entries.length; i += 1) {
      const entry = entries[i];
      toast(`메타데이터 지운 사본 만드는 중… ${i + 1} / ${entries.length}`);
      const file = await originalFile(entry, { ask: i === 0 || Boolean(state.root) });
      if (!file) {
        failed.push(entry.name);
        if (!state.root && !state.files.has(entry.id)) break;
        continue;
      }
      try {
        const bytes = new Uint8Array(await file.arrayBuffer());
        const result = await NAIMeta.strip(bytes);
        if (!result.bytes) throw new Error(result.error || "지우지 못함");
        const ext = NAIMeta.imageType(result.bytes) || "png";
        const name = `${entry.name.replace(/[\\/:*?"<>|]/g, "_")}.${ext}`;
        const filename = `${cleanFolder()}/${name}`;
        const dl = await downloadBlob(new Blob([result.bytes], { type: `image/${ext}` }), filename);
        if (!dl.ok) throw new Error("저장이 중단됐어요");
        lastId = dl.id;
        made += 1;
        const abs = (dl.item?.filename || "").replace(/\\/g, "/");
        const first = state.saveFolder.split("/")[0];
        const at = abs.lastIndexOf(`/${first}/`);
        const path = at >= 0 ? abs.slice(at + 1) : filename;
        const copy = await LibDB.buildEntry({ path, bytes: result.bytes, savedAt: Date.now(), downloadId: dl.id, source: "clean", thumb: entry.thumb });
        state.files.set(copy.id, new File([result.bytes], name, { type: `image/${ext}` })); // full size this session
        await LibDB.put(copy);
        upsert(copy);
      } catch (error) {
        failed.push(entry.name);
      }
    }
    render();
    if (made) {
      toast(`메타데이터 지운 사본 ${made}장을 만들었어요${failed.length ? ` · ${failed.length}장 실패` : ""}.`, failed.length ? "warn" : "ok", lastId != null ? { label: "폴더에서 보기", run: () => chrome.downloads.show(lastId) } : null);
    } else if (failed.length) {
      toast(`사본을 만들지 못했어요: ${failed.slice(0, 3).join(", ")}${failed.length > 3 ? " …" : ""}`, "warn");
    }
  }

  // ---------------------------------------------------------------- 검열 사본 ---
  const CENSOR_PREF_KEY = "naiAutoSaver.censorPrefs";
  function censorPrefs() {
    try {
      return { nipples: true, strength: 0.7, ...JSON.parse(localStorage.getItem(CENSOR_PREF_KEY) || "{}") };
    } catch (error) {
      return { nipples: true, strength: 0.7 };
    }
  }
  function saveCensorPrefs(prefs) {
    try {
      localStorage.setItem(CENSOR_PREF_KEY, JSON.stringify(prefs));
    } catch (error) {
      void error;
    }
  }
  // Copies keep the picture's own format (NovelAI WebP stays WebP).
  function formatOf(entry) {
    return entry.format === "webp" || /\.webp$/i.test(entry.path || "") ? "webp" : "png";
  }
  function censoredFolder() {
    return `${state.saveFolder}/_검열/${today()}`;
  }

  // Makes sure the model is here; asks before the one-time download.
  async function ensureCensorModel(busy) {
    if (await Censor.isDownloaded()) {
      if (busy) busy("검열 모델 여는 중…");
      await Censor.loadModel();
      return true;
    }
    const ok = await confirmDialog(
      "검열 모델을 처음 한 번 내려받을게요",
      `가릴 곳을 찾아 주는 공개 모델을 한 번만 받아요 (약 ${Censor.MODEL.sizeMB}MB). 다음부터는 바로 돼요. 그림은 밖으로 보내지 않고 이 컴퓨터 안에서만 검사해요.\n\n출처: Hugging Face ${Censor.MODEL.repo}`,
      "내려받기",
    );
    if (!ok) return false;
    try {
      await Censor.loadModel({ onProgress: (p) => busy && busy(`검열 모델 내려받는 중… ${Math.round(p * 100)}%`, p) });
      return true;
    } catch (error) {
      toast(`검열 모델을 받지 못했어요: ${error.message || error}`, "warn");
      return false;
    }
  }

  async function saveCensoredCopy(entry, bytes) {
    const ext = NAIMeta.imageType(bytes) || "png";
    const name = `${entry.name.replace(/[\\/:*?"<>|]/g, "_")}.${ext}`;
    const filename = `${censoredFolder()}/${name}`;
    const dl = await downloadBlob(new Blob([bytes], { type: `image/${ext}` }), filename);
    if (!dl.ok) throw new Error("저장이 중단됐어요");
    const abs = (dl.item?.filename || "").replace(/\\/g, "/");
    const first = state.saveFolder.split("/")[0];
    const at = abs.lastIndexOf(`/${first}/`);
    const path = at >= 0 ? abs.slice(at + 1) : filename;
    const copy = await LibDB.buildEntry({ path, bytes, savedAt: Date.now(), downloadId: dl.id, source: "censored" });
    state.files.set(copy.id, new File([bytes], name, { type: `image/${ext}` })); // full size this session
    await LibDB.put(copy);
    upsert(copy);
    return dl.id;
  }

  // One picture, or several in a row: each can be checked and touched up
  // (붓/지우개, per-area size), and at any point "나머지 한 번에" saves the
  // rest automatically with the same settings.
  async function openCensorReview(entryOrList) {
    const queue = [].concat(entryOrList).map((entry) => ({ entry, bitmap: null, marks: null, done: false }));
    const many = queue.length > 1;
    const firstFile = await originalFile(queue[0].entry, { ask: true });
    if (!firstFile) return;
    // Ask about the one-time model download before opening an empty review.
    if (!(await Censor.isDownloaded()) && !(await ensureCensorModel((text) => toast(text)))) return;
    let entry = queue[0].entry;
    let cur = 0;
    let saved = 0;
    let lastSavedId = null;
    const dialog = $(".censor-dialog");
    dialog.innerHTML = "";
    const prefs = censorPrefs();
    const stageWrap = el("div", { class: "cz-stage-wrap" });
    const stage = el("div", { class: "cz-stage", "data-preview": "false" });
    const canvas = el("canvas");
    stage.append(canvas);
    stageWrap.append(stage);
    const busyBox = el("div", { class: "cz-busy" }, [el("span", { text: "준비 중…" }), el("div", { class: "progress", html: "<span></span>" })]);
    stageWrap.append(busyBox);
    const busy = (text, p = null) => {
      busyBox.hidden = false;
      busyBox.firstChild.textContent = text;
      busyBox.querySelector(".progress").hidden = p == null;
      if (p != null) busyBox.querySelector(".progress span").style.width = `${Math.round(p * 100)}%`;
    };
    const side = el("div", { class: "cz-side" });
    const body = el("div", { class: "cz-body" });
    const list = el("div", { class: "cz-list" });
    const nippleBox = el("input", { type: "checkbox", id: "cz-nipples", checked: prefs.nipples });
    const strength = el("input", { type: "range", min: "0", max: "1", step: "0.05", value: String(prefs.strength), id: "cz-strength" });
    const brush = el("input", { type: "range", min: "6", max: "80", step: "1", value: String(prefs.brush || 22), id: "cz-brush" });
    const sizeIn = el("input", { type: "range", min: "0.5", max: "1.8", step: "0.05", value: String(prefs.size || 1), id: "cz-size" });
    const sizeOut = el("span", { class: "cz-val" });
    const undoBtn = el("button", { class: "btn secondary small", type: "button", text: "되돌리기", title: "마지막으로 칠하거나 지운 것 되돌리기 (⌘/Ctrl+Z)" });
    const clearBtn = el("button", { class: "btn plain small", type: "button", text: "손댄 것 모두 취소" });
    let tool = "brush";
    const toolSeg = el("div", { class: "seg cz-tools", role: "radiogroup", "aria-label": "도구" });
    for (const [t, label, tip] of [["brush", "붓", "칠해서 더 가리기 (B)"], ["erase", "지우개", "가려진 곳을 조금 지우기 (E)"]]) {
      toolSeg.append(el("button", { type: "button", role: "radio", "data-tool": t, "aria-checked": String(t === tool), text: label, title: tip, onclick: () => setTool(t) }));
    }
    const peekBtn = el("button", { class: "btn secondary small cz-peek", type: "button", text: "원본 보기", title: "누르고 있는 동안 원본을 보여 줘요" });
    const titleEl = el("div", { class: "cz-title", text: "검열 사본 만들기" });
    const restBtn = el("button", { class: "btn secondary wide", type: "button" });
    const batchBox = many ? el("div", { class: "cz-batch" }, [
      el("p", { class: "cz-note", html: "한 장씩 보고 <b>저장하고 다음</b>으로 넘기거나, 이 설정 그대로 <b>나머지를 한 번에</b> 저장할 수 있어요. 크기·하얀 정도·붓 크기는 모든 그림에 같이 적용돼요." }),
      restBtn,
    ]) : null;
    body.append(
      titleEl,
      ...(batchBox ? [batchBox] : []),
      el("p", { class: "cz-note", html: "찾은 곳을 <b>하얀 빛</b>으로 가렸어요. 크기는 아래에서 키우고 줄여요. 빠진 곳은 <b>붓</b>으로 칠하고, 너무 가린 곳은 <b>지우개</b>로 덜어 내요." }),
      el("div", { class: "cz-row" }, [el("label", { for: "cz-size" }, [document.createTextNode("가리는 크기 "), sizeOut]), sizeIn]),
      el("div", { class: "cz-row" }, [el("label", { for: "cz-strength", text: "하얀 정도" }), strength]),
      el("div", { class: "cz-row" }, [el("label", { for: "cz-nipples", text: "유두도 가리기" }), nippleBox]),
      el("div", { class: "cz-sub", text: "찾은 곳 · 하나씩 크기 조절" }),
      list,
      el("div", { class: "cz-sub", text: "직접 손보기" }),
      el("div", { class: "cz-row" }, [toolSeg]),
      el("div", { class: "cz-row" }, [el("label", { for: "cz-brush", text: "크기" }), brush]),
      el("div", { class: "cz-row" }, [undoBtn, clearBtn]),
    );
    const saveBtn = el("button", { class: "btn", type: "button", text: many ? "저장하고 다음" : "사본 만들기" });
    const skipBtn = el("button", { class: "btn plain", type: "button", text: "건너뛰기" });
    const cancelBtn = el("button", { class: "btn secondary", type: "button", text: "닫기" });
    side.append(body, el("div", { class: "cz-foot" }, [el("span", { class: "grow" }), cancelBtn, many ? skipBtn : null, saveBtn]));
    stageWrap.append(peekBtn);
    dialog.append(stageWrap, side);
    body.style.visibility = "hidden"; // controls appear with the first picture
    dialog.showModal();
    let closed = false;
    cancelBtn.addEventListener("click", () => { closed = true; dialog.close(); });
    dialog.addEventListener("close", () => { closed = true; }, { once: true });

    let bitmap = null;
    let marks = [];
    let scale = 1;
    const overlay = el("canvas", { class: "cz-overlay" });
    const cursor = el("div", { class: "cz-cursor" });
    stage.append(overlay, cursor);
    if (!(await ensureCensorModel(busy))) {
      dialog.close();
      return;
    }
    // Opens picture i (detects once, keeps edits when coming back).
    const show = async (i) => {
      const item = queue[i];
      cur = i;
      entry = item.entry;
      try {
        if (!item.bitmap) {
          busy("그림 여는 중…");
          const file = i === 0 ? firstFile : await originalFile(item.entry, { ask: false });
          if (!file) throw new Error(`원본을 찾지 못해 건너뛰었어요: ${item.entry.name}`);
          item.bitmap = await createImageBitmap(file);
        }
        if (!item.marks) {
          busy("가릴 곳 찾는 중…");
          item.marks = (await Censor.detect(item.bitmap)).map((b) => ({ ...b, on: true, manual: false }));
        }
      } catch (error) {
        toast(`${error.message || error}`, "warn");
        item.done = true;
        return next();
      }
      if (closed) return;
      busyBox.hidden = true;
      body.style.visibility = "";
      bitmap = item.bitmap;
      marks = item.marks;
      // the picture as large as the stage allows
      const maxW = stageWrap.clientWidth - 24;
      const maxH = stageWrap.clientHeight - 24;
      scale = Math.min(maxW / bitmap.width, maxH / bitmap.height, 2);
      canvas.width = overlay.width = Math.round(bitmap.width * scale);
      canvas.height = overlay.height = Math.round(bitmap.height * scale);
      titleEl.textContent = many ? `검열 사본 만들기 · ${i + 1} / ${queue.length}` : "검열 사본 만들기";
      const left = queue.filter((q, k) => !q.done && k !== i).length;
      restBtn.textContent = `이 그림 포함 남은 ${left + 1}장 한 번에 저장`;
      saveBtn.textContent = many ? (left ? "저장하고 다음" : "저장하고 끝내기") : "사본 만들기";
      drawBase();
      renderList();
    };
    const next = () => {
      const k = queue.findIndex((q, j) => !q.done && j > cur);
      const any = k >= 0 ? k : queue.findIndex((q) => !q.done);
      if (any < 0) return finish();
      return show(any);
    };
    const finish = () => {
      dialog.close();
      render();
      if (saved) toast(`검열 사본 ${saved}장을 저장했어요. 메타데이터도 지웠어요.`, "ok", lastSavedId != null ? { label: "폴더에서 보기", run: () => chrome.downloads.show(lastSavedId) } : null);
    };
    const ctx = canvas.getContext("2d");
    const octx = overlay.getContext("2d");
    const isHand = (m) => m.kind === "stroke" || m.kind === "erase";
    const active = () => marks.filter((m) => m.on && (isHand(m) || nippleBox.checked || m.label !== "nipple_f"));
    const setTool = (t) => {
      tool = t;
      for (const b of toolSeg.children) b.setAttribute("aria-checked", String(b.dataset.tool === t));
      stage.dataset.tool = t;
    };
    let peeking = false;
    const drawBase = () => {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      if (peeking) ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      else ctx.drawImage(Censor.render(bitmap, active(), { strength: Number(strength.value), size: Number(sizeIn.value) }), 0, 0, canvas.width, canvas.height);
      sizeOut.textContent = `${Math.round(Number(sizeIn.value) * 100)}%`;
    };
    const renderList = () => {
      list.innerHTML = "";
      const auto = marks.filter((m) => !isHand(m));
      auto.forEach((m) => {
        const hiddenByPref = m.label === "nipple_f" && !nippleBox.checked;
        const name = Censor.LABEL_KO[m.label] || m.label;
        const check = el("input", { type: "checkbox", checked: m.on && !hiddenByPref, disabled: hiddenByPref, "aria-label": name });
        check.addEventListener("change", () => { m.on = check.checked; drawBase(); renderList(); });
        const step = (d) => (e) => {
          e.preventDefault();
          m.scale = Math.max(0.4, Math.min(2.5, Math.round(((m.scale || 1) + d) * 10) / 10));
          drawBase();
          renderList();
        };
        const row = el("label", { class: "cz-item" }, [
          check, el("span", { class: "grow", text: name }),
          el("button", { class: "cz-step", type: "button", "aria-label": `${name} 작게`, text: "−", onclick: step(-0.1) }),
          el("span", { class: "cz-val", text: `${Math.round((m.scale || 1) * 100)}%` }),
          el("button", { class: "cz-step", type: "button", "aria-label": `${name} 크게`, text: "+", onclick: step(0.1) }),
        ]);
        row.addEventListener("mouseenter", () => outline(m));
        row.addEventListener("mouseleave", () => outline(null));
        list.append(row);
      });
      if (!auto.length) list.append(el("p", { class: "cz-note", text: "자동으로 찾은 곳이 없어요. 가릴 곳이 있다면 그림 위를 칠해 주세요." }));
      const strokes = marks.filter(isHand).length;
      undoBtn.disabled = !strokes;
      clearBtn.disabled = !strokes;
      clearBtn.textContent = strokes ? `손댄 것 모두 취소 (${strokes})` : "손댄 것 모두 취소";
      saveBtn.disabled = !active().some((m) => m.kind !== "erase");
    };
    // hovering a list row shows where that mark is
    const outline = (m) => {
      octx.clearRect(0, 0, overlay.width, overlay.height);
      if (!m || !m.shape) return;
      octx.save();
      octx.strokeStyle = "#FF9F0A";
      octx.setLineDash([6, 4]);
      octx.lineWidth = 2;
      octx.strokeRect(m.x0 * scale, m.y0 * scale, (m.x1 - m.x0) * scale, (m.y1 - m.y0) * scale);
      octx.restore();
    };
    // brush: drag to paint more white
    const toImage = (e) => {
      const r = canvas.getBoundingClientRect();
      return { x: (e.clientX - r.left) / scale, y: (e.clientY - r.top) / scale, sx: e.clientX - r.left, sy: e.clientY - r.top };
    };
    let stroke = null;
    stage.addEventListener("pointermove", (e) => {
      const p = toImage(e);
      const d = Number(brush.value);
      Object.assign(cursor.style, { left: `${p.sx - d / 2}px`, top: `${p.sy - d / 2}px`, width: `${d}px`, height: `${d}px` });
      if (!stroke) return;
      stroke.points.push({ x: p.x, y: p.y });
      octx.lineTo(p.sx, p.sy);
      octx.stroke();
    });
    stage.addEventListener("pointerleave", () => { cursor.style.width = "0px"; });
    stage.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      const p = toImage(e);
      stroke = { kind: tool === "erase" ? "erase" : "stroke", manual: true, on: true, r: Number(brush.value) / 2 / scale, points: [{ x: p.x, y: p.y }] };
      octx.clearRect(0, 0, overlay.width, overlay.height);
      octx.strokeStyle = tool === "erase" ? "rgba(255,69,58,0.55)" : "rgba(255,255,255,0.85)";
      octx.lineCap = "round";
      octx.lineJoin = "round";
      octx.lineWidth = Number(brush.value);
      octx.beginPath();
      octx.moveTo(p.sx, p.sy);
      octx.lineTo(p.sx + 0.01, p.sy);
      octx.stroke();
      stage.setPointerCapture(e.pointerId);
    });
    stage.addEventListener("pointerup", () => {
      if (!stroke) return;
      marks.push(stroke);
      stroke = null;
      octx.clearRect(0, 0, overlay.width, overlay.height);
      drawBase();
      renderList();
    });
    const undo = () => {
      for (let i = marks.length - 1; i >= 0; i -= 1) {
        if (isHand(marks[i])) {
          marks.splice(i, 1);
          break;
        }
      }
      drawBase();
      renderList();
    };
    undoBtn.addEventListener("click", undo);
    clearBtn.addEventListener("click", () => { marks = queue[cur].marks = marks.filter((m) => !isHand(m)); drawBase(); renderList(); });
    dialog.addEventListener("keydown", (e) => {
      if (!e.metaKey && !e.ctrlKey && !e.target.closest("input:not([type=range]):not([type=checkbox])")) {
        if (e.key.toLowerCase() === "e") setTool("erase");
        if (e.key.toLowerCase() === "b") setTool("brush");
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        undo();
      }
    });
    const peek = (on) => { peeking = on; drawBase(); };
    peekBtn.addEventListener("pointerdown", () => peek(true));
    for (const ev of ["pointerup", "pointerleave"]) peekBtn.addEventListener(ev, () => { if (peeking) peek(false); });
    brush.addEventListener("input", () => saveCensorPrefs({ ...censorPrefs(), brush: Number(brush.value) }));
    nippleBox.addEventListener("change", () => { saveCensorPrefs({ ...censorPrefs(), nipples: nippleBox.checked }); renderList(); drawBase(); });
    strength.addEventListener("change", () => { saveCensorPrefs({ ...censorPrefs(), strength: Number(strength.value) }); drawBase(); });
    sizeIn.addEventListener("input", () => { sizeOut.textContent = `${Math.round(Number(sizeIn.value) * 100)}%`; });
    sizeIn.addEventListener("change", () => { saveCensorPrefs({ ...censorPrefs(), size: Number(sizeIn.value) }); drawBase(); });
    saveBtn.addEventListener("click", async () => {
      saveBtn.disabled = true;
      try {
        const bytes = await Censor.censoredBytes(bitmap, active(), { strength: Number(strength.value), size: Number(sizeIn.value), format: formatOf(entry) });
        lastSavedId = await saveCensoredCopy(entry, bytes);
        saved += 1;
        queue[cur].done = true;
        saveBtn.disabled = false;
        await next();
      } catch (error) {
        saveBtn.disabled = false;
        toast(`저장하지 못했어요: ${error.message || error}`, "warn");
      }
    });
    skipBtn.addEventListener("click", () => {
      queue[cur].done = true;
      void next();
    });
    restBtn.addEventListener("click", async () => {
      // this picture as it is now (with any touch-ups), the rest automatically
      restBtn.disabled = true;
      try {
        if (active().some((m) => m.kind !== "erase")) {
          lastSavedId = await saveCensoredCopy(entry, await Censor.censoredBytes(bitmap, active(), { strength: Number(strength.value), size: Number(sizeIn.value), format: formatOf(entry) }));
          saved += 1;
        }
        queue[cur].done = true;
        const rest = queue.filter((q) => !q.done).map((q) => q.entry);
        if (rest.length) {
          dialog.close();
          render();
          await makeCensoredCopies(rest, { strength: Number(strength.value), size: Number(sizeIn.value), nipples: nippleBox.checked, already: saved });
        } else {
          finish();
        }
      } finally {
        restBtn.disabled = false;
      }
    });
    setTool("brush");
    await show(0);
  }

  async function makeCensoredCopies(entries, settings = null) {
    if (!entries.length) return;
    const busy = (text) => toast(text);
    if (!(await ensureCensorModel(busy))) return;
    const prefs = { ...censorPrefs(), ...(settings || {}) };
    let made = settings?.already || 0;
    let lastId = null;
    const nothing = [];
    const failed = [];
    for (let i = 0; i < entries.length; i += 1) {
      const entry = entries[i];
      toast(`검열 사본 만드는 중… ${i + 1} / ${entries.length}`);
      const file = await originalFile(entry, { ask: i === 0 && !settings });
      if (!file) {
        failed.push(entry.name);
        continue;
      }
      try {
        const bitmap = await createImageBitmap(file);
        const boxes = (await Censor.detect(bitmap)).filter((b) => prefs.nipples || b.label !== "nipple_f");
        if (!boxes.length) {
          nothing.push(entry.name);
          continue;
        }
        lastId = await saveCensoredCopy(entry, await Censor.censoredBytes(bitmap, boxes, { strength: prefs.strength, size: prefs.size || 1, format: formatOf(entry) }));
        made += 1;
      } catch (error) {
        failed.push(entry.name);
      }
    }
    render();
    const parts = [`검열 사본 ${made}장을 만들었어요`];
    if (nothing.length) parts.push(`가릴 곳을 못 찾은 ${nothing.length}장은 저장하지 않았어요 (하나씩 열어서 직접 가려 주세요)`);
    if (failed.length) parts.push(`${failed.length}장 실패`);
    toast(`${parts.join(" · ")}.`, nothing.length || failed.length ? "warn" : "ok", lastId != null ? { label: "폴더에서 보기", run: () => chrome.downloads.show(lastId) } : null);
  }

  // ------------------------------------------------------------------ 노션 ---
  let notionCfg = { autoSend: false, upload: "clean" };
  // Last automatic send, good or bad (written by the background worker).
  let notionAuto = { ok: null, err: null };
  async function loadNotion() {
    notionCfg = await NotionSync.getConfig();
    const [ok, err] = await Promise.all([LibDB.getKv("notionLastOk").catch(() => null), LibDB.getKv("notionLastError").catch(() => null)]);
    notionAuto = { ok, err };
  }
  // Notion works again (연결 확인 passed, or a send went through): an old
  // failure message would only confuse.
  async function clearNotionError() {
    await LibDB.delKv("notionLastError").catch(() => {});
    notionAuto.err = null;
    renderNotionBox();
    refreshNotionLast();
  }
  let refreshNotionLast = () => {};
  function notionLastLine() {
    return notionAutoFailing()
      ? el("p", { class: "sheet-warn", text: `마지막 자동 보내기 실패 (${new Date(notionAuto.err.at).toLocaleString("ko-KR")} · ${notionAuto.err.name || ""}): ${notionAuto.err.message}` })
      : notionAuto.ok ? el("p", { class: "sheet-note", text: `마지막으로 자동으로 보낸 그림: ${notionAuto.ok.name || ""} (${new Date(notionAuto.ok.at).toLocaleString("ko-KR")})${notionAuto.ok.same ? " · 같은 프롬프트라 건너뜀" : ""}` }) : null;
  }
  function notionAutoFailing() {
    const { ok, err } = notionAuto;
    return Boolean(err && (!ok || err.at > ok.at));
  }
  function notionReady() {
    return Boolean(notionCfg.token && notionCfg.dataSourceId);
  }
  function renderNotionBox() {
    const box = $(".notion-box");
    if (!box) return;
    box.innerHTML = "";
    box.dataset.state = notionReady() ? "ok" : "none";
    if (notionReady()) {
      const failing = notionCfg.autoSend && notionAutoFailing();
      box.dataset.state = failing ? "warn" : "ok";
      box.append(connRow({
        iconName: "notion", title: notionCfg.title || "노션",
        sub: failing ? "자동 보내기가 실패했어요 · 눌러서 보기" : notionCfg.autoSend ? "새 그림 자동으로 보내는 중" : "자동 보내기 꺼짐 · 눌러서 켜기",
        meta: notionCfg.autoSend && !failing ? '<i class="dot"></i>자동' : "",
        action: () => void openNotionSettings(), actionTitle: "노션 설정",
      }));
    } else {
      box.append(connRow({
        iconName: "notion", title: "노션 연결", sub: "캐릭터·날짜별로 정리해요",
        action: () => void openNotionConnect(), actionTitle: "그림과 프롬프트를 내 노션 데이터베이스에 모아요",
      }));
    }
  }

  // iOS form sheet: 취소 · title · action in a bar on top, content below.
  function notionDialogShell(title, { leftLabel = "취소", rightLabel = "" } = {}) {
    const dialog = $(".dialog");
    dialog.classList.remove("alert");
    dialog.classList.add("sheet");
    dialog.addEventListener("close", () => dialog.classList.remove("sheet"), { once: true });
    dialog.innerHTML = "";
    const left = el("button", { class: "bar-btn", type: "button", text: leftLabel, onclick: () => dialog.close() });
    const right = el("button", { class: "bar-btn primary", type: "button", text: rightLabel });
    right.hidden = !rightLabel;
    const bar = el("div", { class: "sheet-bar" }, [left, el("strong", { class: "sheet-title", text: title }), right]);
    const body = el("div", { class: "dialog-body" });
    dialog.append(bar, body);
    if (!dialog.open) dialog.showModal();
    return { dialog, body, right };
  }

  async function openNotionConnect() {
    const { body, right: next } = notionDialogShell("노션 연결 1/2", { rightLabel: "다음" });
    const input = el("input", { class: "text-input", type: "password", placeholder: "ntn_… 또는 secret_…", autocomplete: "off", "aria-label": "노션 연결 토큰" });
    body.append(
      el("p", { html: "① 아래 버튼으로 노션 <b>연결(통합)</b> 페이지를 열고 <b>새 연결 → 내부</b>로 하나 만들어요. 이름은 아무거나 (예: NAI 자동저장)." }),
      el("button", { class: "btn secondary small", type: "button", text: "노션 연결 페이지 열기 ↗", onclick: () => window.open("https://www.notion.so/profile/integrations", "_blank", "noopener") }),
      el("p", { html: "② 만든 연결의 <b>내부 연결 토큰</b>을 복사해서 붙여 넣어요. 토큰은 이 컴퓨터에만 저장돼요." }),
      input,
    );
    const status = el("p", { class: "dialog-status" });
    body.append(status);
    input.focus();
    next.addEventListener("click", async () => {
      const token = input.value.trim();
      if (!token) {
        status.textContent = "토큰을 붙여 넣어 주세요.";
        return;
      }
      // Ask for api.notion.com access right on the click (Chrome needs a gesture).
      const granted = await NotionSync.requestPermission().catch(() => false);
      if (!granted) {
        status.textContent = "노션에 접속하려면 권한 허락이 필요해요.";
        return;
      }
      next.disabled = true;
      status.textContent = "확인 중…";
      try {
        const bot = await NotionSync.me(token);
        const limit = bot?.bot?.workspace_limits?.max_file_upload_size_in_bytes || null;
        await openNotionPick(token, limit, bot?.bot?.workspace_name || "");
      } catch (error) {
        next.disabled = false;
        status.textContent = error.message || String(error);
      }
    });
  }

  async function openNotionPick(token, maxUploadBytes, workspace) {
    const { dialog, body, right: refresh } = notionDialogShell("그림을 넣을 곳 2/2", { rightLabel: "다시 찾기" });
    body.append(el("p", { html: `③ 노션에서 그림을 모아 둘 <b>페이지</b>를 열고, 오른쪽 위 <b>•••</b> → <b>연결</b> → 방금 만든 연결을 추가해요. 그다음 아래 「다시 찾기」를 눌러요.${workspace ? `<br><small>워크스페이스: ${escapeHtml(workspace)}</small>` : ""}` }));
    const list = el("div", { class: "pick-list" });
    const status = el("p", { class: "dialog-status" });
    body.append(list, status);
    const load = async () => {
      list.innerHTML = "";
      status.textContent = "찾는 중…";
      try {
        const targets = await NotionSync.listTargets(token);
        status.textContent = targets.length ? "" : "아직 보이는 페이지가 없어요. ③을 하고 「다시 찾기」를 눌러 주세요.";
        for (const t of targets) {
          const label = t.kind === "page" ? "이 페이지 안에 새 「NAI 그림 보관함」 만들기" : "이 데이터베이스에 넣기";
          const row = el("button", { class: "pick-row", type: "button" }, [
            el("span", { class: "pick-kind", text: t.kind === "page" ? "페이지" : "데이터베이스" }),
            el("span", { class: "pick-title", text: t.title }),
            el("span", { class: "pick-act", text: label }),
          ]);
          row.addEventListener("click", async () => {
            list.querySelectorAll("button").forEach((b) => { b.disabled = true; });
            status.textContent = t.kind === "page" ? "데이터베이스 만드는 중…" : "데이터베이스 준비 중…";
            try {
              let cfg;
              if (t.kind === "page") {
                const db = await NotionSync.createDatabase(token, t.id);
                cfg = { token, dataSourceId: db.dataSourceId, databaseId: db.databaseId, title: db.title, url: db.url, titleName: NotionSync.PROPS.title };
              } else {
                const prep = await NotionSync.prepareDataSource(token, t.id);
                cfg = { token, dataSourceId: t.id, databaseId: prep.databaseId || t.databaseId, title: prep.title || t.title, url: prep.url || t.url, titleName: prep.titleName };
              }
              notionCfg = await NotionSync.setConfig({ ...cfg, maxUploadBytes });
              dialog.close();
              render();
              toast(`노션 「${notionCfg.title}」에 연결했어요. 그림 ⋯ 메뉴의 「노션에 보내기」로 보내거나, 노션 설정에서 자동으로 보내기를 켜세요.`, "ok", notionCfg.url ? { label: "노션에서 보기", run: () => window.open(notionCfg.url, "_blank", "noopener") } : null);
            } catch (error) {
              list.querySelectorAll("button").forEach((b) => { b.disabled = false; });
              status.textContent = error.message || String(error);
            }
          });
          list.append(row);
        }
      } catch (error) {
        status.textContent = error.message || String(error);
      }
    };
    refresh.addEventListener("click", () => void load());
    await load();
  }

  async function openNotionSettings() {
    const { dialog, body, right: save } = notionDialogShell("노션 설정", { leftLabel: "닫기", rightLabel: "저장" });
    const auto = el("input", { type: "checkbox", id: "nt-auto", checked: Boolean(notionCfg.autoSend) });
    const clean = el("input", { type: "radio", name: "nt-up", id: "nt-clean", checked: notionCfg.upload !== "original" });
    const orig = el("input", { type: "radio", name: "nt-up", id: "nt-orig", checked: notionCfg.upload === "original" });
    const once = el("input", { type: "radio", name: "nt-same", id: "nt-once", checked: notionCfg.samePrompt !== "all" });
    const every = el("input", { type: "radio", name: "nt-same", id: "nt-every", checked: notionCfg.samePrompt === "all" });
    auto.classList.add("ios-switch");
    clean.classList.add("ios-check");
    orig.classList.add("ios-check");
    once.classList.add("ios-check");
    every.classList.add("ios-check");
    const last = el("div", { class: "nt-last" });
    refreshNotionLast = () => {
      if (!last.isConnected && dialog.open === false) return;
      last.replaceChildren(...[notionLastLine()].filter(Boolean));
    };
    refreshNotionLast();
    dialog.addEventListener("close", () => { refreshNotionLast = () => {}; }, { once: true });
    const checkOut = el("div", { class: "nt-check", hidden: true });
    const checkBtn = el("button", { class: "btn small", type: "button", text: "연결 확인" });
    checkBtn.addEventListener("click", async () => {
      checkBtn.disabled = true;
      checkOut.hidden = false;
      checkOut.textContent = "확인하는 중…";
      // the click lets Chrome ask for the Notion permission again if it is off
      if (!(await NotionSync.hasPermission())) await NotionSync.requestPermission().catch(() => false);
      const result = await NotionSync.check(notionCfg);
      if (result.ok) await clearNotionError();
      checkOut.innerHTML = "";
      for (const st of result.steps) checkOut.append(el("div", { class: "nt-step", "data-ok": String(st.ok), text: `${st.ok ? "✓" : "✕"} ${st.text}` }));
      checkOut.append(el("p", { class: "sheet-note", text: result.ok
        ? (notionCfg.autoSend ? "노션 쪽은 정상이에요. 이제 새로 저장되는 그림이 올라가요. (같은 프롬프트는 처음 1장만)" : "노션 쪽은 정상이에요. 위의 「자동으로 보내기」를 켜고 저장하면 올라가요.")
        : "✕ 줄을 고치면 돼요. 토큰·권한 문제면 노션 연결을 끊고 다시 연결하는 게 가장 빨라요." }));
      checkBtn.disabled = false;
    });
    body.append(
      el("p", { class: "sheet-note", text: `연결된 곳: ${notionCfg.title || ""} · 노션에서 이름이나 아이콘을 바꿔도 괜찮아요.` }),
      el("div", { class: "ios-group" }, [el("div", { class: "ios-row" }, [el("span", { class: "grow" }, [document.createTextNode("노션에 잘 들어가는지 확인"), el("small", { text: "시험 줄을 하나 썼다가 바로 지워요" })]), checkBtn])]),
      checkOut,
      last,
      el("div", { class: "ios-group" }, [
        el("label", { class: "ios-row", for: "nt-auto" }, [el("span", { class: "grow", text: "새로 저장되는 그림 자동으로 보내기" }), auto]),
      ]),
      el("div", { class: "ios-group-label", text: "노션에 올릴 그림" }),
      el("div", { class: "ios-group" }, [
        el("label", { class: "ios-row", for: "nt-clean" }, [el("span", { class: "grow" }, [document.createTextNode("메타데이터 지운 사본"), el("small", { text: "추천 · 프롬프트는 칸에 따로 들어가요" })]), clean]),
        el("label", { class: "ios-row", for: "nt-orig" }, [el("span", { class: "grow", text: "원본 그대로" }), orig]),
      ]),
      el("div", { class: "ios-group-label", text: "같은 프롬프트로 여러 장 뽑았을 때" }),
      el("div", { class: "ios-group" }, [
        el("label", { class: "ios-row", for: "nt-once" }, [el("span", { class: "grow" }, [document.createTextNode("처음 1장만 올리기"), el("small", { text: "프롬프트 하나에 페이지 하나 · 10장 뽑아도 1개" })]), once]),
        el("label", { class: "ios-row", for: "nt-every" }, [el("span", { class: "grow" }, [document.createTextNode("전부 올리기"), el("small", { text: "그림마다 페이지 하나 · 10장이면 10개" })]), every]),
      ]),
      el("p", { class: "sheet-note", text: "같은 프롬프트 = 베이스·캐릭터·네거티브가 글자까지 같은 것 (시드는 상관없어요)." }),
    );
    body.append(el("button", { class: "sheet-danger", type: "button", text: "노션 연결 끊기", onclick: async () => { await NotionSync.clearConfig(); notionCfg = await NotionSync.getConfig(); dialog.close(); render(); toast("노션 연결을 끊었어요. 노션에 올라간 페이지는 그대로 있어요."); } }));
    save.addEventListener("click", async () => {
      notionCfg = await NotionSync.setConfig({ autoSend: auto.checked, upload: orig.checked ? "original" : "clean", samePrompt: every.checked ? "all" : "first" });
      dialog.close();
      render();
    });
  }

  async function sendToNotion(entries) {
    if (!notionReady()) {
      await openNotionConnect();
      return;
    }
    if (!(await NotionSync.hasPermission())) {
      if (!(await NotionSync.requestPermission().catch(() => false))) {
        toast("노션에 접속하려면 권한 허락이 필요해요.", "warn");
        return;
      }
    }
    let sent = 0;
    let lastUrl = "";
    const failed = [];
    let noPicture = 0;
    let same = 0;
    for (let i = 0; i < entries.length; i += 1) {
      const entry = entries[i];
      toast(`노션에 보내는 중… ${i + 1} / ${entries.length}`);
      try {
        const file = await originalFile(entry, { ask: i === 0 });
        let bytes = file ? new Uint8Array(await file.arrayBuffer()) : null;
        let stripped = false;
        if (bytes && notionCfg.upload !== "original" && entry.hasMeta) {
          const result = await NAIMeta.strip(bytes);
          if (result.bytes) {
            bytes = result.bytes;
            stripped = true;
          }
        }
        const page = await NotionSync.sendEntry(notionCfg, entry, bytes, { metaStripped: stripped });
        lastUrl = page.url || lastUrl;
        if (page.skipped) same += 1;
        else {
          sent += 1;
          if (!bytes) noPicture += 1;
        }
        if (entry.source !== "dropped") {
          entry.notion = { id: page.id, url: page.url, at: Date.now() };
          await LibDB.put(entry);
        }
      } catch (error) {
        failed.push(`${entry.name}: ${error.message || error}`);
        if (error.status === 401 || error.status === 404) break;
      }
    }
    render();
    if ((sent || same) && !failed.length) await clearNotionError();
    const parts = [`노션에 ${sent}장을 보냈어요`];
    if (same) parts.push(`${same}장은 같은 프롬프트가 이미 있어서 건너뛰었어요`);
    if (noPicture) parts.push(`${noPicture}장은 원본을 못 읽어서 프롬프트만`);
    if (failed.length) parts.push(`실패 ${failed.length}장 (${failed[0]})`);
    toast(`${parts.join(" · ")}.`, failed.length || noPicture ? "warn" : "ok", lastUrl ? { label: "노션에서 보기", run: () => window.open(lastUrl, "_blank", "noopener") } : null);
  }

  // ----------------------------------------------------- dropped / opened ---
  async function importFiles(fileList) {
    const files = Array.from(fileList || []).filter((f) => /\.(png|webp)$/i.test(f.name) || f.type === "image/png" || f.type === "image/webp");
    if (!files.length) {
      toast("PNG나 WebP 그림만 읽을 수 있어요.", "warn");
      return;
    }
    let readable = 0;
    for (const file of files) {
      try {
        const bytes = new Uint8Array(await file.arrayBuffer());
        const id = `drop:${file.name}:${file.size}:${file.lastModified}`;
        const entry = await LibDB.buildEntry({ path: file.name, bytes, savedAt: file.lastModified || Date.now(), source: "dropped", meta: await NAIMeta.read(bytes) });
        entry.id = id;
        state.files.set(id, file);
        upsert(entry);
        if (entry.hasMeta) readable += 1;
      } catch (error) {
        void error;
      }
    }
    state.nav = "dropped";
    state.sel = state.dropped.slice(0, files.length === 1 ? 1 : 0).map((e) => e.id);
    render();
    toast(readable === files.length || !readable ? `${files.length}장을 열었어요.` : `${files.length}장을 열었어요 · 그중 ${readable}장에 프롬프트가 있어요.`);
  }

  // -------------------------------------------- memo / queue via the NAI tab ---
  function entryValues(entry) {
    const m = entry.meta || {};
    const chars = m.characters || [];
    const join = (list) => {
      const values = list.slice();
      while (values.length && !values[values.length - 1]) values.pop();
      return values.join(" ;; ");
    };
    const values = {
      basePrompt: m.prompt || "",
      baseNegativePrompt: m.negative || "",
      characterPrompt: join(chars.map((c) => c.prompt || "")),
      characterNegativePrompt: join(chars.map((c) => c.negative || "")),
    };
    for (const k of Object.keys(values)) if (!values[k].trim()) delete values[k];
    return values;
  }

  async function sendToNai(kind, entries) {
    const payload = entries.map((entry) => ({ name: LibDB.stripCounter(entry.name), values: entryValues(entry) })).filter((p) => Object.keys(p.values).length);
    if (!payload.length) {
      toast("넣을 프롬프트가 없어요.", "warn");
      return;
    }
    const action = kind === "memo" ? "libraryAddMemos" : "libraryAddQueue";
    let tabs = [];
    try {
      tabs = await chrome.tabs.query({ url: "https://novelai.net/*" });
    } catch (error) {
      tabs = [];
    }
    tabs.sort((a, b) => Number(b.active) - Number(a.active));
    for (const tab of tabs) {
      try {
        const res = await chrome.tabs.sendMessage(tab.id, { action, items: payload });
        if (res?.ok) {
          toast(kind === "memo" ? `메모 ${payload.length}개를 만들었어요.` : `대기열에 ${payload.length}개를 넣었어요.`, "ok");
          return;
        }
        if (res?.error) {
          toast(res.error, "warn");
          return;
        }
      } catch (error) {
        void error;
      }
    }
    // No NovelAI tab open: nothing holds the lists in memory, write them directly.
    try {
      if (kind === "memo") {
        const key = "naiAutoSaver.promptMemos";
        const current = (await chrome.storage.local.get(key))[key] || { schemaVersion: 1, items: [] };
        const now = Date.now();
        const items = payload.map((p, i) => ({ id: `memo-${now}-${i}-${Math.random().toString(36).slice(2, 7)}`, name: p.name.slice(0, 80), values: p.values, createdAt: now, updatedAt: now }));
        await chrome.storage.local.set({ [key]: { schemaVersion: 1, items: [...items, ...(current.items || [])] } });
        toast(`메모 ${items.length}개를 만들었어요.`, "ok");
      } else {
        const key = "naiAutoSaver.queue";
        const current = (await chrome.storage.local.get(key))[key] || { schemaVersion: 1, items: [], options: {} };
        const now = Date.now();
        const items = payload.map((p, i) => ({
          id: `q-${now}-${i}-${Math.random().toString(36).slice(2, 7)}`,
          title: p.name, count: 1,
          basePrompt: p.values.basePrompt || "", baseNegativePrompt: p.values.baseNegativePrompt || "",
          characterPrompt: p.values.characterPrompt || "", negativePrompt: p.values.characterNegativePrompt || "",
        }));
        await chrome.storage.local.set({ [key]: { ...current, items: [...(current.items || []), ...items] } });
        toast(`대기열에 ${items.length}개를 넣었어요.`, "ok");
      }
    } catch (error) {
      toast(`넣지 못했어요: ${error.message || error}`, "warn");
    }
  }

  async function removeEntries(ids) {
    for (const id of ids) {
      await LibDB.remove(id);
      state.entries = state.entries.filter((e) => e.id !== id);
      const url = thumbUrls.get(id);
      if (url) URL.revokeObjectURL(url);
      thumbUrls.delete(id);
    }
    state.sel = [];
    render();
    toast("보관함에서 뺐어요. 파일은 그대로 있어요.");
  }

  // ------------------------------------------------------------------ misc ---
  function escapeHtml(text) {
    return String(text).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }
  async function copyText(text, message) {
    try {
      await navigator.clipboard.writeText(text);
      toast(message, "ok");
    } catch (error) {
      toast("복사하지 못했어요.", "warn");
    }
  }
  let toastTimer = null;
  const TOAST_IC = {
    ok: '<svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10" fill="currentColor"/><path d="M7.5 12.5l3 3 6-6.5" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    warn: '<svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3L2 20.5h20z" fill="currentColor" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><path d="M12 9.5v5" stroke="#fff" stroke-width="2.2" stroke-linecap="round"/><circle cx="12" cy="17.6" r="1.25" fill="#fff"/></svg>',
    neutral: '<svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10" fill="currentColor"/><path d="M12 11v6" stroke="#fff" stroke-width="2.2" stroke-linecap="round"/><circle cx="12" cy="7.6" r="1.3" fill="#fff"/></svg>',
  };
  function toast(message, tone = "neutral", action = null) {
    const node = $(".toast");
    node.innerHTML = "";
    node.dataset.tone = tone;
    node.append(el("span", { class: "toast-ic", html: TOAST_IC[tone] || TOAST_IC.neutral }), el("span", { class: "toast-text", text: message }));
    if (action) node.append(el("button", { class: "btn small secondary", type: "button", text: action.label, onclick: action.run }));
    node.append(el("button", { class: "toast-close", type: "button", "aria-label": "닫기", title: "닫기", text: "×", onclick: () => { node.hidden = true; } }));
    node.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { node.hidden = true; }, action ? 9000 : 4500);
  }
  async function confirmDialog(title, text, okLabel) {
    const dialog = $(".dialog");
    if (dialog.open) dialog.close();
    // Let a just-closed sheet finish its own close handling first.
    await new Promise((r) => setTimeout(r, 0));
    dialog.classList.remove("sheet");
    dialog.innerHTML = "";
    return new Promise((resolve) => {
      const finish = (value) => { dialog.close(); dialog.classList.remove("alert"); resolve(value); };
      dialog.classList.add("alert"); // iOS-style alert
      dialog.append(
        el("div", { class: "dialog-body" }, [el("strong", { text: title }), el("p", { text })]),
        el("div", { class: "dialog-foot" }, [
          el("button", { class: "btn secondary", type: "button", text: "취소", onclick: () => finish(false) }),
          el("button", { class: "btn", type: "button", text: okLabel, onclick: () => finish(true) }),
        ]),
      );
      dialog.addEventListener("cancel", () => { dialog.classList.remove("alert"); resolve(false); }, { once: true });
      dialog.showModal();
    });
  }

  function applyTheme(appearance) {
    const dark = appearance === "dark" || (appearance !== "light" && window.matchMedia("(prefers-color-scheme: dark)").matches);
    document.body.dataset.theme = dark ? "dark" : "light";
  }

  // ------------------------------------------------------------------ init ---
  async function init() {
    const settings = await chrome.storage.sync.get(["appearance", "saveFolder", "tagHover", "tagHoverMachine"]);
    TagKo.setOptions({ enabled: settings.tagHover !== false, machine: settings.tagHoverMachine !== false });
    TagKo.attachHover({ roots: [document], scope: (block) => Boolean(block.closest("[data-tag-hover]")) });
    let appearance = settings.appearance || "auto";
    state.saveFolder = String(settings.saveFolder || "NovelAI").replace(/^\/+|\/+$/g, "") || "NovelAI";
    applyTheme(appearance);
    window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => applyTheme(appearance));
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === "sync" && changes.appearance) {
        appearance = changes.appearance.newValue || "auto";
        applyTheme(appearance);
      }
      if (area === "sync" && changes.saveFolder) state.saveFolder = changes.saveFolder.newValue || "NovelAI";
      if (area === "sync" && (changes.tagHover || changes.tagHoverMachine)) {
        chrome.storage.sync.get(["tagHover", "tagHoverMachine"]).then((v) => TagKo.setOptions({ enabled: v.tagHover !== false, machine: v.tagHoverMachine !== false }));
      }
    });

    const q = new URLSearchParams(location.hash.slice(1)).get("q");
    if (q) {
      state.query = q;
      $(".search-input").value = q;
    }
    await Promise.all([loadEntries(), restoreFolder(), loadNotion(), loadCull(), loadComboNames(), loadAes()]);
    await dropDuplicateEntries();
    // nothing selected at first: the first click shows that picture
    render();

    $(".search-input").addEventListener("input", (event) => {
      state.query = event.target.value;
      render();
    });
    $(".grid").addEventListener("click", handleGridClick);
    $(".grid").addEventListener("dblclick", (event) => {
      const tile = event.target.closest(".tile");
      if (!tile) return;
      openLightbox(tile.dataset.id);
    });
    $(".sort-btn").addEventListener("click", openSortMenu);
    $(".settings-open").addEventListener("click", () => openSettings(!state.settings));
    $(".board-btn").addEventListener("click", () => setBoard(!state.board));
    $(".cmp-aes").addEventListener("click", (event) => {
      const b = event.target.closest("[data-aes]");
      if (!b) return;
      if (b.dataset.aes === "show") {
        cmp.skipped = new Set();
        renderCompare({ keepImages: true });
      } else if (b.dataset.aes === "hold") {
        const ids = [...cmp.skipped];
        cmp.skipped = new Set();
        applyCullAction(ids, { label: "hold" });
        renderCompare({ keepImages: true });
        toast(`점수 아래쪽 ${ids.length}장을 B컷으로 넣었어요.`, "ok", { label: "되돌리기", run: () => { applyCullAction(ids, { label: null }); renderCompare({ keepImages: true }); } });
      }
    });
    Aesthetic.on(onAesEvent);
    if (aes.on) void Aesthetic.start().catch(() => {});
    $(".board").addEventListener("contextmenu", (event) => {
      const cell = event.target.closest(".bd-cell[data-char]");
      const row = event.target.closest("[data-row-emo]");
      if (!cell && !row) return;
      event.preventDefault();
      if (row) openSlotMenu(event.clientX, event.clientY, { char: row.dataset.rowChar, bg: null, emo: row.dataset.rowEmo });
      else openSlotMenu(event.clientX, event.clientY, { char: cell.dataset.char, bg: cell.dataset.bg, emo: cell.dataset.emo });
    });
    $(".board").addEventListener("click", (event) => {
      const row = event.target.closest("[data-row-emo]");
      if (row) {
        event.stopPropagation(); // the page's "click elsewhere closes menus" would close it at once
        const r = row.getBoundingClientRect();
        openSlotMenu(r.left, r.bottom + 4, { char: row.dataset.rowChar, bg: null, emo: row.dataset.rowEmo });
        return;
      }
      const empty = event.target.closest("[data-empty]");
      if (empty) {
        void copyIntoSlot({ char: empty.dataset.char, bg: empty.dataset.bg, emo: empty.dataset.emo });
        return;
      }
      const cell = event.target.closest("[data-board-group]");
      if (!cell) return;
      const ids = cell.dataset.ids.split("\n");
      if (ids.length > 1) openCompare(ids, { group: cell.dataset.boardGroup, sequence: boardOrder });
      else openLightbox(ids[0]);
    });
    $(".pick-all").addEventListener("click", () => {
      while (state.rendered < state.shown.length) renderMoreTiles();
      state.sel = state.shown.map((e) => e.id);
      updateSelectionLook();
    });
    $(".clear-sel").addEventListener("click", () => { state.sel = []; updateSelectionLook(); });
    bindLightbox();
    bindCompare();
    bindMarquee();
    $(".open-files").addEventListener("click", () => $(".file-input").click());
    $(".file-input").addEventListener("change", (event) => {
      void importFiles(event.target.files);
      event.target.value = "";
    });
    new IntersectionObserver((list) => {
      if (!state.board && list.some((e) => e.isIntersecting) && state.rendered < state.shown.length) renderMoreTiles();
    }, { root: $(".gallery"), rootMargin: "600px" }).observe($(".sentinel"));

    let dragDepth = 0;
    // Dragging a picture inside this page (a tile, the big view) is not
    // "opening a file": Chrome hands it over as a file named after the
    // thumbnail (6af0df3b-….webp), which used to land in 불러온 파일.
    let draggingFromPage = false;
    document.addEventListener("dragstart", () => { draggingFromPage = true; });
    document.addEventListener("dragend", () => { draggingFromPage = false; });
    window.addEventListener("dragenter", (event) => {
      if (draggingFromPage || ![...(event.dataTransfer?.types || [])].includes("Files")) return;
      dragDepth += 1;
      $(".drop-overlay").hidden = false;
    });
    window.addEventListener("dragleave", () => {
      dragDepth = Math.max(0, dragDepth - 1);
      if (!dragDepth) $(".drop-overlay").hidden = true;
    });
    window.addEventListener("dragover", (event) => event.preventDefault());
    window.addEventListener("drop", (event) => {
      event.preventDefault();
      dragDepth = 0;
      $(".drop-overlay").hidden = true;
      if (draggingFromPage) {
        draggingFromPage = false;
        return;
      }
      if (event.dataTransfer?.files?.length) void importFiles(event.dataTransfer.files);
    });
    document.addEventListener("click", (event) => {
      if (!event.target.closest(".menu-wrap")) document.querySelectorAll(".menu").forEach((m) => m.remove());
    });
    $(".gallery").addEventListener("contextmenu", (event) => {
      const tile = event.target.closest(".tile");
      if (!tile) return;
      event.preventDefault();
      const id = tile.dataset.id;
      if (!state.sel.includes(id)) {
        state.sel = [id];
        state.anchor = id;
        updateSelectionLook();
      }
      showContextMenu(event.clientX, event.clientY, state.sel.map(byId).filter(Boolean));
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") document.querySelectorAll(".menu.ctx").forEach((m) => m.remove());
    });
    document.addEventListener("keydown", (event) => {
      const typing = event.target.closest?.("input, textarea, [contenteditable]");
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "f") {
        event.preventDefault();
        $(".search-input").focus();
        return;
      }
      if (typing) {
        if (event.key === "Escape") event.target.blur();
        return;
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "a") {
        event.preventDefault();
        while (state.rendered < state.shown.length) renderMoreTiles();
        state.sel = state.shown.map((e) => e.id);
        updateSelectionLook();
      } else if (!$(".lightbox").hidden) {
        return; // the viewer has its own keys
      } else if (!$(".compare").hidden) {
        return; // so does the compare view
      } else if ($(".dialog").open) {
        return;
      } else if (state.board) {
        return; // the 현황 board has no picture to move to or mark
      } else if (state.sel.length && (event.key === "Delete" || ((event.metaKey || event.ctrlKey) && event.key === "Backspace"))) {
        event.preventDefault();
        void trashEntries(state.sel.map(byId).filter(Boolean));
      } else if (state.sel.length === 1 && event.key === "F2") {
        event.preventDefault();
        void renameEntry(byId(state.sel[0]));
      } else if (state.sel.length === 1 && (event.metaKey || event.ctrlKey) && event.code === "KeyC" && !String(window.getSelection?.() || "")) {
        event.preventDefault();
        void copyPicture(byId(state.sel[0]));
      } else if (cullAction(event) && state.sel.length) {
        event.preventDefault();
        applyCullAction(state.sel, cullAction(event));
      } else if (event.code === "KeyC" && !event.metaKey && !event.ctrlKey && state.sel.length) {
        event.preventDefault();
        if (state.sel.length > 1) openCompare(state.sel.slice(), { sequence: null });
        else {
          const entry = byId(state.sel[0]);
          const group = entry ? groupMembers(entry) : [];
          if (group.length > 1) openCompare(group.map((e) => e.id), { group: groupKeyOf(entry), sequence: null });
        }
      } else if (event.key === " " && state.sel.length) {
        event.preventDefault();
        openLightbox(state.sel[state.sel.length - 1]);
      } else if (event.key === "Escape") {
        state.sel = [];
        updateSelectionLook();
      } else if (event.key.startsWith("Arrow")) {
        event.preventDefault();
        moveSelection(event.key.slice(5).toLowerCase());
      }
    });
    chrome.runtime.onMessage.addListener((message) => {
      if (message?.action === "libraryChanged" && message.id) arrived(message.id);
      if (message?.action === "notionStatus") void loadNotion().then(() => { renderNotionBox(); refreshNotionLast(); });
    });
    for (const type of ["keydown", "pointerdown", "wheel"]) document.addEventListener(type, () => { lastInput = Date.now(); }, { capture: true, passive: true });
    if (state.root && state.rootPerm === "granted") void scanFolder().then(() => syncFolder({ quiet: true }));
    // Coming back to the page re-checks the folder (at most every 2 minutes);
    // without a folder watcher, a slow check every 5 minutes covers the rest.
    const sometimes = () => { if (!document.hidden && Date.now() - lastSync > 120000) void syncFolder(); };
    document.addEventListener("visibilitychange", sometimes);
    window.addEventListener("focus", sometimes);
    setInterval(() => { if (!folderObserver && !document.hidden) void syncFolder(); }, 300000);
    if (location.hash.includes("notion")) void (notionReady() ? openNotionSettings() : openNotionConnect());
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === "local" && changes["naiAutoSaver.generator"]) void loadComboNames().then(() => { if (state.board) renderBoard({ keepScroll: true }); });
      if (area === "local" && changes[NotionSync.CONFIG_KEY]) {
        void loadNotion().then(() => { renderNotionBox(); refreshNotionLast(); });
      }
    });
  }

  init().catch((error) => {
    console.error(error);
    toast(`보관함을 열지 못했어요: ${error.message || error}`, "warn");
  });
})();
