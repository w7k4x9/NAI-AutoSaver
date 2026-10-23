// 노션 연동: send 보관함 pictures (picture + prompt + classification) to a
// Notion database. Used by the library page and the background worker.
// API: Notion-Version 2026-03-11 (databases hold "data sources"; files go up
// through the File Upload API: create -> send -> attach within an hour).
(function initNotion(root) {
  "use strict";

  const API = "https://api.notion.com/v1";
  const VERSION = "2026-03-11";
  const CONFIG_KEY = "naiAutoSaver.notion";
  const ORIGIN = "https://api.notion.com/*";
  const PROPS = {
    title: "이름",
    char: "캐릭터",
    date: "날짜",
    tags: "태그",
    model: "모델",
    seed: "시드",
    prompt: "프롬프트",
    negative: "네거티브",
    image: "그림",
    meta: "메타데이터",
    key: "프롬프트 키",
  };
  const SCHEMA = {
    [PROPS.char]: { select: { options: [] } },
    [PROPS.date]: { date: {} },
    [PROPS.tags]: { multi_select: { options: [] } },
    [PROPS.model]: { select: { options: [] } },
    [PROPS.seed]: { number: { format: "number" } },
    [PROPS.prompt]: { rich_text: {} },
    [PROPS.negative]: { rich_text: {} },
    [PROPS.image]: { files: {} },
    [PROPS.meta]: { select: { options: [{ name: "지움", color: "green" }, { name: "남아 있음", color: "orange" }] } },
    [PROPS.key]: { rich_text: {} },
  };
  const SENT_KEY = "naiAutoSaver.notionSent"; // { [dataSourceId]: { [promptKey]: { id, url } } }
  // Tags that say nothing about the picture's content.
  const SKIP_TAGS = /^(masterpiece|best quality|amazing quality|great quality|good quality|normal quality|very aesthetic|aesthetic|absurdres|highres|incredibly absurdres|lowres|newest|recent|year \d{4}|rating:.*|nsfw|sfw|no text|official art|very displeasing|displeasing)$/i;

  // ------------------------------------------------------------- config ---
  async function getConfig() {
    const got = await chrome.storage.local.get(CONFIG_KEY);
    // samePrompt: "first" = a prompt goes up once (first picture only), "all" = every picture.
    return { autoSend: false, upload: "clean", samePrompt: "first", ...(got[CONFIG_KEY] || {}) };
  }
  async function setConfig(patch) {
    const next = { ...(await getConfig()), ...patch };
    await chrome.storage.local.set({ [CONFIG_KEY]: next });
    return next;
  }
  async function clearConfig() {
    await chrome.storage.local.remove(CONFIG_KEY);
  }
  function hasPermission() {
    return chrome.permissions.contains({ origins: [ORIGIN] });
  }
  function requestPermission() {
    return chrome.permissions.request({ origins: [ORIGIN] });
  }

  // ---------------------------------------------------------------- http ---
  let lastCall = 0;
  async function call(token, method, path, body, { form = null, retries = 3 } = {}) {
    // Notion allows about 3 requests a second.
    const wait = lastCall + 340 - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastCall = Date.now();
    const headers = { Authorization: `Bearer ${token}`, "Notion-Version": VERSION };
    let payload;
    if (form) {
      payload = form;
    } else if (body !== undefined) {
      headers["Content-Type"] = "application/json";
      payload = JSON.stringify(body);
    }
    const res = await fetch(`${API}${path}`, { method, headers, body: payload });
    if (res.status === 429 && retries > 0) {
      const after = Number(res.headers.get("retry-after")) || 1;
      await new Promise((r) => setTimeout(r, after * 1000));
      return call(token, method, path, body, { form, retries: retries - 1 });
    }
    let data = null;
    try {
      data = await res.json();
    } catch (error) {
      data = null;
    }
    if (!res.ok) {
      const err = new Error(explain(res.status, data));
      err.status = res.status;
      err.code = data?.code;
      throw err;
    }
    return data;
  }
  function explain(status, data) {
    const code = data?.code || "";
    if (status === 401 || code === "unauthorized") return "토큰이 맞지 않아요. 노션에서 복사한 토큰을 다시 붙여 넣어 주세요.";
    if (status === 404 || code === "object_not_found") return "노션에서 찾을 수 없어요. 그 페이지에 연결(통합)을 추가했는지 확인해 주세요.";
    if (code === "restricted_resource") return "이 연결에 권한이 없어요. 노션 연결 설정에서 콘텐츠 읽기·쓰기·삽입을 켜 주세요.";
    if (code === "validation_error") return `노션이 요청을 거절했어요: ${data?.message || ""}`;
    return `노션 오류 (${status}${code ? ` ${code}` : ""}): ${data?.message || ""}`;
  }

  // --------------------------------------------------------------- setup ---
  async function me(token) {
    return call(token, "GET", "/users/me");
  }
  function plain(rich) {
    return (Array.isArray(rich) ? rich : []).map((t) => t.plain_text || t.text?.content || "").join("");
  }
  // Pages and databases the connection can see.
  async function listTargets(token) {
    const out = [];
    for (const kind of ["data_source", "page"]) {
      let cursor;
      for (let i = 0; i < 5; i += 1) {
        const res = await call(token, "POST", "/search", { filter: { property: "object", value: kind }, page_size: 50, ...(cursor ? { start_cursor: cursor } : {}), sort: { timestamp: "last_edited_time", direction: "descending" } });
        for (const r of res.results || []) {
          if (kind === "data_source") {
            out.push({ kind, id: r.id, databaseId: r.parent?.database_id || null, title: plain(r.title) || "(제목 없는 데이터베이스)", url: r.url || "" });
          } else if (r.parent?.type !== "data_source_id" && r.parent?.type !== "database_id") {
            const titleProp = Object.values(r.properties || {}).find((p) => p.type === "title");
            out.push({ kind, id: r.id, title: plain(titleProp?.title) || "(제목 없는 페이지)", url: r.url || "" });
          }
        }
        if (!res.has_more) break;
        cursor = res.next_cursor;
      }
    }
    return out;
  }

  async function createDatabase(token, pageId, title = "NAI 그림 보관함") {
    const db = await call(token, "POST", "/databases", {
      parent: { type: "page_id", page_id: pageId },
      title: [{ type: "text", text: { content: title } }],
      icon: { type: "emoji", emoji: "🖼️" },
      initial_data_source: { properties: { [PROPS.title]: { title: {} }, ...SCHEMA } },
    });
    let dataSourceId = db.data_sources?.[0]?.id;
    if (!dataSourceId) {
      const full = await call(token, "GET", `/databases/${db.id}`);
      dataSourceId = full.data_sources?.[0]?.id;
    }
    return { databaseId: db.id, dataSourceId, title, url: db.url || "" };
  }

  // Adds our columns to an existing data source; returns the title column name.
  async function prepareDataSource(token, dataSourceId) {
    const ds = await call(token, "GET", `/data_sources/${dataSourceId}`);
    const existing = ds.properties || {};
    const titleName = Object.entries(existing).find(([, p]) => p.type === "title")?.[0] || PROPS.title;
    const missing = {};
    for (const [name, schema] of Object.entries(SCHEMA)) {
      if (!existing[name]) missing[name] = schema;
    }
    if (Object.keys(missing).length) {
      await call(token, "PATCH", `/data_sources/${dataSourceId}`, { properties: missing });
    }
    return { titleName, title: plain(ds.title) || "데이터베이스", databaseId: ds.parent?.database_id || null, url: ds.url || "" };
  }

  // ---------------------------------------------------------------- send ---
  function cleanTag(raw) {
    let t = String(raw || "").trim();
    t = t.replace(/^-?\d+(?:\.\d+)?::/, "").replace(/::\s*$/, "").replace(/[{}[\]]/g, "").replace(/\\([()])/g, "$1");
    t = t.replace(/_/g, " ").replace(/\s+/g, " ").trim().toLowerCase();
    return t;
  }
  function tagsOf(meta, max = 12) {
    const all = [meta?.prompt, ...(meta?.characters || []).map((c) => c.prompt)].filter(Boolean).join(",");
    const out = [];
    for (const raw of all.split(/[,\n|]/)) {
      const t = cleanTag(raw);
      if (!t || t.length > 60 || SKIP_TAGS.test(t) || /^artist\s*:/.test(t) || out.includes(t)) continue;
      out.push(t);
      if (out.length >= max) break;
    }
    return out;
  }
  // Notion rich text: 2,000 characters per piece, 100 pieces.
  function rich(text) {
    const s = String(text || "");
    const pieces = [];
    for (let i = 0; i < s.length && pieces.length < 100; i += 2000) pieces.push({ type: "text", text: { content: s.slice(i, i + 2000) } });
    return pieces;
  }
  function promptText(meta) {
    const lines = [];
    if (meta?.prompt) lines.push(meta.prompt);
    (meta?.characters || []).forEach((c, i) => lines.push(`캐릭터 ${i + 1}: ${c.prompt}`));
    return lines.join("\n");
  }
  function negativeText(meta) {
    const lines = [];
    if (meta?.negative) lines.push(meta.negative);
    (meta?.characters || []).forEach((c, i) => { if (c.negative) lines.push(`캐릭터 ${i + 1}: ${c.negative}`); });
    return lines.join("\n");
  }

  const isWebpBytes = (b) => b && b.length > 12 && b[0] === 82 && b[1] === 73 && b[2] === 70 && b[3] === 70 && b[8] === 87 && b[9] === 69 && b[10] === 66 && b[11] === 80;

  async function uploadImage(token, bytes, filename) {
    const type = isWebpBytes(bytes) ? "image/webp" : "image/png";
    const created = await call(token, "POST", "/file_uploads", { filename, content_type: type });
    const form = new FormData();
    form.append("file", new Blob([bytes], { type }), filename);
    const sent = await call(token, "POST", `/file_uploads/${created.id}/send`, undefined, { form });
    if (sent.status && sent.status !== "uploaded") throw new Error(`그림 올리기 상태: ${sent.status}`);
    return created.id;
  }

  // ------------------------------------------------------- same prompt ---
  // Same base + characters + negatives (seed ignored) = same key.
  async function promptKey(meta) {
    const norm = (t) => String(t || "").replace(/\s+/g, " ").trim();
    const parts = [norm(meta?.prompt), norm(meta?.negative), ...(meta?.characters || []).map((c) => `${norm(c.prompt)}|${norm(c.negative)}`)];
    if (!parts.some(Boolean)) return null; // no prompt to compare (metadata gone)
    const data = new TextEncoder().encode(JSON.stringify(parts));
    const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", data));
    return Array.from(hash.slice(0, 10), (b) => b.toString(16).padStart(2, "0")).join("");
  }
  async function sentMap() {
    return (await chrome.storage.local.get(SENT_KEY))[SENT_KEY] || {};
  }
  async function rememberSent(dataSourceId, key, page) {
    const all = await sentMap();
    all[dataSourceId] = { ...(all[dataSourceId] || {}), [key]: { id: page.id, url: page.url || "" } };
    await chrome.storage.local.set({ [SENT_KEY]: all });
  }
  // Older connections: add the 프롬프트 키 column once.
  async function ensureKeyColumn(cfg) {
    if (cfg.keyColumn) return;
    try {
      await call(cfg.token, "PATCH", `/data_sources/${cfg.dataSourceId}`, { properties: { [PROPS.key]: { rich_text: {} } } });
      await setConfig({ keyColumn: true });
      cfg.keyColumn = true;
    } catch (error) {
      void error;
    }
  }
  // An existing page for this prompt: remembered here, or found in the
  // database (pages sent from another Chrome profile count too).
  async function findSamePrompt(cfg, key) {
    const known = (await sentMap())[cfg.dataSourceId]?.[key];
    if (known) return known;
    if (!cfg.keyColumn) return null;
    try {
      const found = await call(cfg.token, "POST", `/data_sources/${cfg.dataSourceId}/query`, {
        filter: { property: PROPS.key, rich_text: { equals: key } },
        page_size: 1,
      });
      const page = found?.results?.[0];
      if (page) {
        const hit = { id: page.id, url: page.url || "" };
        await rememberSent(cfg.dataSourceId, key, hit);
        return hit;
      }
    } catch (error) {
      void error;
    }
    return null;
  }

  // One send at a time, so ten pictures saved in a row can't race past the
  // "already sent" check.
  let sendChain = Promise.resolve();
  function sendEntry(cfg, entry, bytes, options = {}) {
    const run = sendChain.then(() => sendEntryNow(cfg, entry, bytes, options));
    sendChain = run.catch(() => {});
    return run;
  }

  // entry: a 보관함 record; bytes: the PNG to upload (or null to skip the picture).
  // Returns { id, url } of the new page, or { id, url, skipped: true } when
  // the same prompt is already there and only the first picture goes up.
  async function sendEntryNow(cfg, entry, bytes, { metaStripped = false } = {}) {
    if (!cfg.token || !cfg.dataSourceId) throw new Error("노션이 아직 연결되지 않았어요.");
    const meta = entry.meta || {};
    await ensureKeyColumn(cfg);
    const key = await promptKey(meta);
    if (key && cfg.samePrompt !== "all") {
      const same = await findSamePrompt(cfg, key);
      if (same) return { ...same, skipped: true };
    }
    const name = String(entry.name || "그림");
    const filename = `${name.replace(/[\\/:*?"<>|]/g, "_").slice(0, 150)}.${isWebpBytes(bytes) ? "webp" : "png"}`;
    let uploadId = null;
    let imageNote = "";
    if (bytes) {
      const limit = cfg.maxUploadBytes || 5 * 1048576;
      if (bytes.length > limit) {
        imageNote = `그림이 노션 업로드 한도(${Math.round(limit / 1048576)}MB)보다 커서 그림은 빼고 올렸어요.`;
      } else {
        uploadId = await uploadImage(cfg.token, bytes, filename);
      }
    }
    const props = {
      [cfg.titleName || PROPS.title]: { title: rich(name) },
      [PROPS.date]: { date: { start: new Date(entry.savedAt || Date.now()).toISOString() } },
      [PROPS.prompt]: { rich_text: rich(promptText(meta)) },
      [PROPS.negative]: { rich_text: rich(negativeText(meta)) },
      [PROPS.meta]: { select: { name: metaStripped || !entry.hasMeta ? "지움" : "남아 있음" } },
    };
    if (entry.char) props[PROPS.char] = { select: { name: entry.char.replace(/,/g, " ").slice(0, 100) } };
    const tags = tagsOf(meta);
    if (tags.length) props[PROPS.tags] = { multi_select: tags.map((t) => ({ name: t.replace(/,/g, " ").slice(0, 100) })) };
    if (meta.model) props[PROPS.model] = { select: { name: String(meta.model).replace(/\s+[0-9A-F]{8}$/i, "").replace(/,/g, " ").slice(0, 100) } };
    if (meta.seed != null) props[PROPS.seed] = { number: Number(meta.seed) };
    if (key && cfg.keyColumn) props[PROPS.key] = { rich_text: rich(key) };
    if (uploadId) props[PROPS.image] = { files: [{ type: "file_upload", file_upload: { id: uploadId }, name: filename }] };

    const children = [];
    if (uploadId) children.push({ object: "block", type: "image", image: { type: "file_upload", file_upload: { id: uploadId } } });
    if (imageNote) children.push({ object: "block", type: "callout", callout: { rich_text: rich(imageNote), icon: { type: "emoji", emoji: "⚠️" } } });
    const section = (title, text) => {
      if (!text) return;
      children.push({ object: "block", type: "heading_3", heading_3: { rich_text: rich(title) } });
      children.push({ object: "block", type: "code", code: { language: "plain text", rich_text: rich(text) } });
    };
    section("베이스", meta.prompt);
    (meta.characters || []).forEach((c, i) => section(`캐릭터 ${i + 1}`, [c.prompt, c.negative ? `네거티브: ${c.negative}` : ""].filter(Boolean).join("\n")));
    section("네거티브", meta.negative);
    const facts = [
      meta.seed != null ? `시드 ${meta.seed}` : "",
      meta.steps != null ? `스텝 ${meta.steps}` : "",
      meta.scale != null ? `가이던스 ${meta.scale}` : "",
      meta.sampler || "",
      entry.w && entry.h ? `${entry.w}×${entry.h}` : "",
      entry.path || "",
    ].filter(Boolean).join(" · ");
    if (facts) children.push({ object: "block", type: "paragraph", paragraph: { rich_text: rich(facts) } });

    const page = await call(cfg.token, "POST", "/pages", {
      parent: { type: "data_source_id", data_source_id: cfg.dataSourceId },
      icon: { type: "emoji", emoji: "🖼️" },
      properties: props,
      children: children.slice(0, 100),
    });
    const made = { id: page.id, url: page.url || "" };
    if (key) await rememberSent(cfg.dataSourceId, key, made);
    return made;
  }

  // 「연결 확인」: every step the automatic send needs, with what went wrong.
  // Writes one test row and removes it right away (proves we can write).
  async function check(cfg) {
    const steps = [];
    const step = (ok, text) => { steps.push({ ok, text }); return ok; };
    if (!cfg.token || !cfg.dataSourceId) return { ok: false, steps: [{ ok: false, text: "노션이 연결돼 있지 않아요." }] };
    if (!step(await hasPermission(), "확장 프로그램이 노션에 접속하도록 허락됨")) return { ok: false, steps };
    try {
      await me(cfg.token);
      step(true, "토큰이 맞음");
    } catch (error) {
      step(false, error.message);
      return { ok: false, steps };
    }
    try {
      const ds = await call(cfg.token, "GET", `/data_sources/${cfg.dataSourceId}`);
      step(true, `데이터베이스를 찾음 (「${plain(ds.title) || cfg.title || ""}」)`);
    } catch (error) {
      step(false, error.message);
      return { ok: false, steps };
    }
    try {
      const page = await call(cfg.token, "POST", "/pages", {
        parent: { type: "data_source_id", data_source_id: cfg.dataSourceId },
        properties: { [cfg.titleName || PROPS.title]: { title: rich("연결 확인 (지워져요)") } },
      });
      await call(cfg.token, "PATCH", `/pages/${page.id}`, { in_trash: true }).catch(() => call(cfg.token, "PATCH", `/pages/${page.id}`, { archived: true }));
      step(true, "새 줄을 쓸 수 있음");
    } catch (error) {
      step(false, `새 줄을 못 써요: ${error.message}`);
      return { ok: false, steps };
    }
    return { ok: true, steps };
  }

  const api = {
    VERSION, PROPS, CONFIG_KEY, getConfig, setConfig, clearConfig, hasPermission, requestPermission,
    me, listTargets, createDatabase, prepareDataSource, sendEntry, tagsOf, promptText, rich, promptKey, check,
  };
  root.NotionSync = api;
  if (typeof module === "object" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
