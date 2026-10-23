// New-version check for copies loaded from GitHub ("압축해제된 확장 프로그램
// 로드"). Chrome never updates those by itself, so we look at the version in
// the repository's manifest.json now and then and tell the user. Web Store
// installs update through the store and never run this check.
(function initUpdateCheck(root) {
  "use strict";

  const REPO = "w7k4x9/NAI-AutoSaver";
  const BRANCH = "main";
  const RAW = `https://raw.githubusercontent.com/${REPO}/`;
  const STATE_KEY = "naiAutoSaver.update";
  const RETIRED_KEY = "naiAutoSaver.retiredForStore";
  const CHECK_EVERY = 6 * 60 * 60 * 1000;

  function parseVersion(v) {
    return String(v || "").trim().replace(/^v/i, "").split(".").map((n) => parseInt(n, 10) || 0);
  }
  // <0 when a is older than b.
  function compareVersions(a, b) {
    const x = parseVersion(a);
    const y = parseVersion(b);
    for (let i = 0; i < Math.max(x.length, y.length); i += 1) {
      const d = (x[i] || 0) - (y[i] || 0);
      if (d) return d < 0 ? -1 : 1;
    }
    return 0;
  }

  // "## v1.11.0 — 더 쉬운 셀렉" + "- item" lines → [{version, title, items}],
  // newest first, only versions newer than `since`.
  function changesSince(readme, since, { maxVersions = 6, maxItems = 5 } = {}) {
    const out = [];
    let cur = null;
    for (const line of String(readme || "").split(/\r?\n/)) {
      const head = line.match(/^##\s+v(\d+(?:\.\d+)*)\s*(.*)$/);
      if (head) {
        cur = null;
        if (compareVersions(head[1], since) > 0) {
          const title = head[2].replace(/변경\s*사항/, "").replace(/^[\s—–-]+/, "").trim();
          cur = { version: head[1], title, items: [] };
          out.push(cur);
        }
        continue;
      }
      if (/^#{1,2}\s/.test(line)) {
        cur = null;
        continue;
      }
      const item = cur && line.match(/^[-*]\s+(.+)$/);
      if (item && cur.items.length < maxItems) {
        cur.items.push(item[1].replace(/\*\*|`/g, "").trim());
      }
    }
    out.sort((a, b) => compareVersions(b.version, a.version));
    return out.slice(0, maxVersions);
  }

  async function eligible() {
    try {
      const self = await chrome.management.getSelf();
      if (self.installType !== "development") return false;
      const retired = (await chrome.storage.local.get(RETIRED_KEY))[RETIRED_KEY];
      return !retired;
    } catch (error) {
      return false;
    }
  }

  function currentVersion() {
    return chrome.runtime.getManifest().version;
  }

  function describe(state, isEligible) {
    const current = currentVersion();
    const latest = state?.latest || null;
    return {
      eligible: isEligible,
      current,
      latest,
      available: Boolean(isEligible && latest && compareVersions(latest, current) > 0),
      notes: latest && compareVersions(latest, current) > 0 ? (state.notes || []).filter((n) => compareVersions(n.version, current) > 0) : [],
      checkedAt: state?.checkedAt || 0,
      error: state?.error || "",
    };
  }

  async function fetchText(path) {
    const res = await fetch(`${RAW}${BRANCH}/${path}?t=${Date.now()}`, { cache: "no-store" });
    if (!res.ok) throw new Error(`GitHub ${res.status}`);
    return res.text();
  }

  let inflight = null;
  async function check({ force = false } = {}) {
    const isEligible = await eligible();
    const state = (await chrome.storage.local.get(STATE_KEY))[STATE_KEY] || {};
    if (!isEligible) return describe(state, false);
    if (!force && Date.now() - (state.checkedAt || 0) < CHECK_EVERY) return describe(state, true);
    if (!inflight) {
      inflight = (async () => {
        const next = { ...state, checkedAt: Date.now(), error: "" };
        try {
          const manifest = JSON.parse(await fetchText("manifest.json"));
          next.latest = String(manifest.version || "");
          next.notes = [];
          if (compareVersions(next.latest, currentVersion()) > 0) {
            try {
              next.notes = changesSince(await fetchText("README.md"), currentVersion());
            } catch (error) {
              next.notes = [];
            }
          }
        } catch (error) {
          next.error = String(error?.message || error);
        }
        await chrome.storage.local.set({ [STATE_KEY]: next });
        return next;
      })().finally(() => { inflight = null; });
    }
    return describe(await inflight, true);
  }

  async function status() {
    const state = (await chrome.storage.local.get(STATE_KEY))[STATE_KEY] || {};
    return describe(state, await eligible());
  }

  const api = { REPO, BRANCH, RAW, STATE_KEY, compareVersions, changesSince, check, status, eligible };
  if (typeof module === "object" && module.exports) module.exports = api;
  root.NAIUpdate = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
