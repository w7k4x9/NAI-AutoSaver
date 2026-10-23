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
  async function loadEntries() {
    const all = await LibDB.all();
    all.sort((a, b) => b.savedAt - a.savedAt);
    state.entries = all;
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
      list.sort((a, b) => b.savedAt - a.savedAt);
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
    if (nav.startsWith("rating:")) {
      const min = Number(nav.slice(7)) || 1;
      return (e) => (cullOf(e.id).rating || 0) >= min;
    }
    if (nav.startsWith("char:")) {
      const name = nav.slice(5);
      return (e) => e.char === name;
    }
    return NAV[nav]?.test || NAV.all.test;
  }
  function navTitle(nav) {
    if (nav.startsWith("cull:")) return nav === "cull:none" ? "안 고른 그림" : LABELS[nav.slice(5)] || "셀렉";
    if (nav.startsWith("rating:")) return `별점 ${nav.slice(7)}개 이상`;
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
    renderCullNav(all);
    const chars = new Map();
    for (const e of all) {
      if (e.char) chars.set(e.char, (chars.get(e.char) || 0) + 1);
    }
    const list = $(".nav-chars");
    list.innerHTML = "";
    [...chars.entries()].sort((a, b) => b[1] - a[1]).slice(0, 30).forEach(([name, count]) => {
      list.append(navButton(`char:${name}`, name, "person", count));
    });
    renderFolderBox();
    renderNotionBox();
  }
  function navButton(key, label, iconName, count) {
    const button = el("button", {
      class: "nav-item", type: "button", "aria-current": String(state.nav === key),
      onclick: () => setNav(key),
      html: `${icon(iconName)}<span class="label"></span><span class="num">${count.toLocaleString("ko-KR")}</span>`,
    });
    button.querySelector(".label").textContent = label;
    return button;
  }
  function setNav(key) {
    state.nav = key;
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
        extra: el("button", { class: "conn-act", type: "button", title: "폴더 다시 훑기", "aria-label": "폴더 다시 훑기", html: icon("refresh", 14), onclick: () => void scanFolder() }),
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
    const terms = parseQuery(state.query);
    const test = navTest(state.nav);
    state.shown = allEntries().filter((e) => test(e) && matches(e, terms));
    const visible = new Set(state.shown.map((e) => e.id));
    state.sel = state.sel.filter((id) => visible.has(id));
    $(".title").textContent = navTitle(state.nav);
    state.found = terms.length > 0;
    renderPickBar();
    renderSidebar();
    renderBanner();
    const grid = $(".grid");
    grid.innerHTML = "";
    grid.dataset.multi = String(state.sel.length > 1);
    state.rendered = 0;
    renderMoreTiles();
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

  function renderBanner() {
    const banner = $(".banner");
    if (false) {
      banner.hidden = false;
      banner.innerHTML = "";
      banner.append(
        el("div", { class: "banner-text" }, [
          el("strong", { text: `프롬프트가 들어 있는 그림 ${state.shown.length.toLocaleString("ko-KR")}장` }),
          el("span", { text: "공유하기 전에 메타데이터 지운 사본을 만들어 두세요." }),
        ]),
        el("button", { class: "btn small", type: "button", text: "전부 고르기", onclick: () => { state.sel = state.shown.map((e) => e.id); render(); } }),
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
      body.append(el("button", { class: "btn secondary small cmp-open", type: "button", html: `${icon("grid", 14)}<span>같은 이름 ${group.length}장 비교하기</span>`, title: "이름이 같은 그림을 나란히 놓고 골라요 (C)", onclick: () => openCompare(group.map((e) => e.id), { group: groupKeyOf(entry) }) }));
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
      el("button", { class: "btn small cmp-open", type: "button", html: `${icon("grid", 14)}<span>${entries.length}장 나란히 비교하기</span>`, title: "고른 그림을 나란히 놓고 채택·탈락을 골라요 (C)", onclick: () => openCompare(entries.map((e) => e.id)) }),
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
        applyCullAction([lb.id], action);
        $(".lb-cull").innerHTML = cullSummaryHtml(lb.id);
        if ("label" in action && action.label) setTimeout(() => stepLightbox(1), 120); // keep going, like a culling viewer
        return;
      }
      if (event.key === "Escape" || event.key === " ") { event.preventDefault(); closeLightbox(); }
      else if (event.key === "ArrowRight" || event.key === "ArrowDown") { event.preventDefault(); stepLightbox(1); }
      else if (event.key === "ArrowLeft" || event.key === "ArrowUp") { event.preventDefault(); stepLightbox(-1); }
    });
  }

  // ---------------------------------------------------------------- 셀렉 ---
  // Culling marks per picture: a label (채택 / 보류 / 탈락) and 0–5 stars. Kept in
  // the library database next to the entries (not inside them, so re-reading a
  // folder never wipes them). Keys follow the physical key so they also work
  // while typing Korean: Q/P 채택, W 보류, E/X 탈락, R/U 지우기, 1–5 별점, 0 별점 지우기.
  const LABELS = { pick: "채택", hold: "보류", reject: "탈락" };
  const CULL_KV = "cull";
  state.cull = new Map();
  let cullTimer = null;
  async function loadCull() {
    try {
      const saved = await LibDB.getKv(CULL_KV);
      if (saved && typeof saved === "object") state.cull = new Map(Object.entries(saved));
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
      if (!next.label) delete next.label;
      if (!next.rating) delete next.rating;
      if (next.label || next.rating) state.cull.set(id, next);
      else state.cull.delete(id);
    }
    saveCull();
    refreshCullLook(ids);
  }
  // Pressing the label every picture already has clears it (same for stars).
  function applyCullAction(ids, action) {
    if (!ids.length || !action) return;
    if ("label" in action) {
      const same = action.label && ids.every((id) => cullOf(id).label === action.label);
      setCull(ids, { label: same ? null : action.label });
    } else {
      const same = action.rating && ids.every((id) => cullOf(id).rating === action.rating);
      setCull(ids, { rating: same ? 0 : action.rating });
    }
  }
  function cullAction(event) {
    if (event.metaKey || event.ctrlKey || event.altKey) return null;
    const code = event.code || "";
    if (code === "KeyQ" || code === "KeyP") return { label: "pick" };
    if (code === "KeyW") return { label: "hold" };
    if (code === "KeyE" || code === "KeyX") return { label: "reject" };
    if (code === "KeyR" || code === "KeyU") return { label: null };
    const digit = code.match(/^(?:Digit|Numpad)([0-5])$/);
    if (digit) return { rating: Number(digit[1]) };
    if (code === "Backquote") return { rating: 0 };
    return null;
  }
  const starText = (n) => "★".repeat(n);
  function tileCullHtml(id) {
    const c = cullOf(id);
    return `${c.label ? `<span class="cull-pill" data-label="${c.label}">${LABELS[c.label]}</span>` : ""}${c.rating ? `<span class="cull-stars">${starText(c.rating)}</span>` : ""}`;
  }
  function cullSummaryHtml(id) {
    const c = cullOf(id);
    return tileCullHtml(id) || (c.label || c.rating ? "" : '<span class="cull-none">안 고름</span>');
  }
  function cullControls(ids) {
    const all = (fn) => ids.length && ids.every(fn);
    const wrap = el("div", { class: "cull-row" });
    const seg = el("div", { class: "seg cull-seg", role: "group", "aria-label": "셀렉" });
    for (const [label, key] of [["pick", "Q"], ["hold", "W"], ["reject", "E"]]) {
      seg.append(el("button", {
        type: "button", "data-label": label, "aria-pressed": String(all((id) => cullOf(id).label === label)),
        title: `${LABELS[label]} (${key}) · 한 번 더 누르면 지워져요`, text: LABELS[label],
        onclick: () => applyCullAction(ids, { label }),
      }));
    }
    const stars = el("div", { class: "cull-stars-input", role: "group", "aria-label": "별점" });
    const shown = ids.length && ids.every((id) => (cullOf(id).rating || 0) === (cullOf(ids[0]).rating || 0)) ? cullOf(ids[0]).rating || 0 : 0;
    for (let n = 1; n <= 5; n += 1) {
      stars.append(el("button", { type: "button", "data-on": String(n <= shown), title: `별 ${n}개 (${n})`, "aria-label": `별 ${n}개`, text: "★", onclick: () => applyCullAction(ids, { rating: n }) }));
    }
    wrap.append(seg, stars);
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
    renderCullNav(allEntries());
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
    const icons = { pick: "check_circle", hold: "pause", reject: "close" };
    for (const label of ["pick", "hold", "reject"]) nav.append(navButton(`cull:${label}`, LABELS[label], icons[label], counts[label]));
    if (counts.pick + counts.hold + counts.reject) {
      nav.append(navButton("cull:none", "안 고른 그림", "image", all.length - counts.pick - counts.hold - counts.reject));
    }
    const current = state.nav.startsWith("rating:") ? Number(state.nav.slice(7)) : 0;
    const row = el("div", { class: "rating-filter", title: "별점이 이만큼 이상인 그림만 봐요" }, [el("span", { class: "label", text: "별점" })]);
    for (let n = 1; n <= 5; n += 1) {
      row.append(el("button", { type: "button", "data-on": String(n <= current), "aria-label": `별점 ${n}개 이상`, text: "★", onclick: () => setNav(current === n ? "all" : `rating:${n}`) }));
    }
    nav.append(row);
  }

  // ------------------------------------------------------------- 비교 ---
  // Pictures side by side. Opened for the selected pictures, or for every
  // picture with the same name (김춘자_교실 웃음 (1), (2)…), then mark them.
  const cmp = { ids: [], focus: 0, filter: "all", group: null, urls: new Map(), token: 0 };
  function groupKeyOf(entry) {
    return LibDB.stripCounter(entry.name).trim();
  }
  function counterOf(entry) {
    const m = String(entry.name).match(/\((\d+)\)\s*$/);
    return m ? Number(m[1]) : 0;
  }
  function groupMembers(entry) {
    const key = groupKeyOf(entry);
    return allEntries().filter((e) => groupKeyOf(e) === key).sort((a, b) => counterOf(a) - counterOf(b) || a.savedAt - b.savedAt);
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
      const label = cullOf(id).label;
      if (cmp.filter === "keep") return label !== "reject";
      if (cmp.filter === "pick") return label === "pick";
      return true;
    });
  }
  function openCompare(ids, { group = null } = {}) {
    if (ids.length < 2) return;
    cmp.ids = ids.slice(0, 48);
    cmp.group = group;
    cmp.focus = 0;
    $(".compare").hidden = false;
    renderCompare();
  }
  function closeCompare() {
    $(".compare").hidden = true;
    cmp.token += 1;
    for (const url of cmp.urls.values()) URL.revokeObjectURL(url);
    cmp.urls.clear();
    $(".cmp-grid").innerHTML = "";
  }
  function stepGroup(step) {
    const groups = groupsInView();
    if (!groups.length) return;
    const at = groups.findIndex(([key]) => key === cmp.group);
    const [key, entry] = groups[(at + step + groups.length) % groups.length];
    openCompare(groupMembers(entry).map((e) => e.id), { group: key });
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
    const counts = { pick: 0, hold: 0, reject: 0 };
    for (const id of cmp.ids) {
      const label = cullOf(id).label;
      if (label) counts[label] += 1;
    }
    $(".cmp-title").textContent = cmp.group || `고른 ${cmp.ids.length}장`;
    const groups = cmp.group ? groupsInView() : [];
    const at = groups.findIndex(([key]) => key === cmp.group);
    $(".cmp-sub").textContent = [`${visible.length} / ${cmp.ids.length}장`, `채택 ${counts.pick}`, `보류 ${counts.hold}`, `탈락 ${counts.reject}`, groups.length > 1 && at >= 0 ? `묶음 ${at + 1} / ${groups.length}` : ""].filter(Boolean).join(" · ");
    box.querySelectorAll(".cmp-nav").forEach((b) => { b.hidden = !(groups.length > 1); });
    box.querySelectorAll("[data-cmp-filter]").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.cmpFilter === cmp.filter)));
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
        el("span", { class: "cmp-name", text: counterOf(entry) ? `(${counterOf(entry)})` : entry.name }),
        el("span", { class: "tile-cull", html: tileCullHtml(id) }),
      ]));
      grid.append(cell);
    });
    if (!keepImages) void loadCompareOriginals(visible);
    grid.querySelector('.cmp-cell[data-focus="true"]')?.scrollIntoView({ block: "nearest" });
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
      const filter = event.target.closest("[data-cmp-filter]");
      if (filter) {
        cmp.filter = filter.dataset.cmpFilter;
        renderCompare({ keepImages: true });
        return;
      }
      const cell = event.target.closest(".cmp-cell");
      if (cell) {
        cmp.focus = compareVisible().indexOf(cell.dataset.id);
        box.querySelectorAll(".cmp-cell").forEach((c) => { c.dataset.focus = String(c === cell); });
      }
    });
    box.addEventListener("dblclick", (event) => {
      const cell = event.target.closest(".cmp-cell");
      if (cell) openLightbox(cell.dataset.id);
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
      void scanFolder();
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
      if (handle.kind === "directory") {
        yield* walk(handle, `${prefix}/${name}`);
      } else if (/\.(png|webp)$/i.test(name)) {
        yield { path: `${prefix}/${name}`, handle };
      }
    }
  }

  async function scanFolder() {
    if (!state.root || state.scan) return;
    const known = new Set(await LibDB.keys());
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
      render();
      toast(added ? `폴더에서 새 그림 ${added.toLocaleString("ko-KR")}장을 가져왔어요.` : "폴더의 그림은 이미 다 보관함에 있어요.");
    } catch (error) {
      state.scan = null;
      render();
      toast(`폴더를 훑다가 멈췄어요: ${error.message || error}`, "warn");
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
  async function loadNotion() {
    notionCfg = await NotionSync.getConfig();
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
      box.append(connRow({
        iconName: "notion", title: notionCfg.title || "노션",
        meta: notionCfg.autoSend ? '<i class="dot"></i>자동' : '<i class="dot"></i>',
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
    auto.classList.add("ios-switch");
    clean.classList.add("ios-check");
    orig.classList.add("ios-check");
    body.append(
      el("p", { class: "sheet-note", text: `연결된 곳: ${notionCfg.title || ""}` }),
      el("div", { class: "ios-group" }, [
        el("label", { class: "ios-row", for: "nt-auto" }, [el("span", { class: "grow", text: "새로 저장되는 그림 자동으로 보내기" }), auto]),
      ]),
      el("div", { class: "ios-group-label", text: "노션에 올릴 그림" }),
      el("div", { class: "ios-group" }, [
        el("label", { class: "ios-row", for: "nt-clean" }, [el("span", { class: "grow" }, [document.createTextNode("메타데이터 지운 사본"), el("small", { text: "추천 · 프롬프트는 칸에 따로 들어가요" })]), clean]),
        el("label", { class: "ios-row", for: "nt-orig" }, [el("span", { class: "grow", text: "원본 그대로" }), orig]),
      ]),
    );
    body.append(el("button", { class: "sheet-danger", type: "button", text: "노션 연결 끊기", onclick: async () => { await NotionSync.clearConfig(); notionCfg = await NotionSync.getConfig(); dialog.close(); render(); toast("노션 연결을 끊었어요. 노션에 올라간 페이지는 그대로 있어요."); } }));
    save.addEventListener("click", async () => {
      notionCfg = await NotionSync.setConfig({ autoSend: auto.checked, upload: orig.checked ? "original" : "clean" });
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
        if (!bytes) noPicture += 1;
        const page = await NotionSync.sendEntry(notionCfg, entry, bytes, { metaStripped: stripped });
        lastUrl = page.url;
        sent += 1;
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
    const parts = [`노션에 ${sent}장을 보냈어요`];
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
  function confirmDialog(title, text, okLabel) {
    const dialog = $(".dialog");
    dialog.innerHTML = "";
    return new Promise((resolve) => {
      const finish = (value) => { dialog.close(); resolve(value); };
      dialog.classList.add("alert"); // iOS-style alert
      dialog.addEventListener("close", () => dialog.classList.remove("alert"), { once: true });
      dialog.append(
        el("div", { class: "dialog-body" }, [el("strong", { text: title }), el("p", { text })]),
        el("div", { class: "dialog-foot" }, [
          el("button", { class: "btn secondary", type: "button", text: "취소", onclick: () => finish(false) }),
          el("button", { class: "btn", type: "button", text: okLabel, onclick: () => finish(true) }),
        ]),
      );
      dialog.addEventListener("cancel", () => resolve(false), { once: true });
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
    await Promise.all([loadEntries(), restoreFolder(), loadNotion(), loadCull()]);
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
      if (list.some((e) => e.isIntersecting) && state.rendered < state.shown.length) renderMoreTiles();
    }, { root: $(".gallery"), rootMargin: "600px" }).observe($(".sentinel"));

    let dragDepth = 0;
    window.addEventListener("dragenter", (event) => {
      if (![...(event.dataTransfer?.types || [])].includes("Files")) return;
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
      if (event.dataTransfer?.files?.length) void importFiles(event.dataTransfer.files);
    });
    document.addEventListener("click", (event) => {
      if (!event.target.closest(".menu-wrap")) document.querySelectorAll(".menu").forEach((m) => m.remove());
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
      } else if (cullAction(event) && state.sel.length) {
        event.preventDefault();
        applyCullAction(state.sel, cullAction(event));
      } else if (event.code === "KeyC" && !event.metaKey && !event.ctrlKey && state.sel.length) {
        event.preventDefault();
        if (state.sel.length > 1) openCompare(state.sel.slice());
        else {
          const entry = byId(state.sel[0]);
          const group = entry ? groupMembers(entry) : [];
          if (group.length > 1) openCompare(group.map((e) => e.id), { group: groupKeyOf(entry) });
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
      if (message?.action === "libraryChanged" && message.id) {
        void LibDB.get(message.id).then((entry) => {
          if (!entry) return;
          upsert(entry);
          const keepScroll = $(".gallery").scrollTop;
          render();
          $(".gallery").scrollTop = keepScroll;
        });
      }
    });
    if (state.root && state.rootPerm === "granted") void scanFolder();
    if (location.hash.includes("notion")) void (notionReady() ? openNotionSettings() : openNotionConnect());
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === "local" && changes[NotionSync.CONFIG_KEY]) {
        void loadNotion().then(renderNotionBox);
      }
    });
  }

  init().catch((error) => {
    console.error(error);
    toast(`보관함을 열지 못했어요: ${error.message || error}`, "warn");
  });
})();
