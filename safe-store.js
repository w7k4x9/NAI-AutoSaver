(function attachSafeStore(global) {
  "use strict";

  // ---------------------------------------------------------------------------
  // SafeStore — chrome.storage wrapper that never loses a write silently.
  //
  // Why this exists:
  //   1. An unpacked extension's ID (and therefore its chrome.storage) changes
  //      when it is loaded from another folder or reinstalled. Moving to the
  //      Chrome Web Store build is also a new ID. Without a second copy, every
  //      such move wipes memos / queue / settings.
  //   2. When the extension is reloaded while a NovelAI tab stays open, the old
  //      content script keeps running but every chrome.* call fails
  //      ("Extension context invalidated"). The previous code swallowed that
  //      error, so the user saw "saved" while nothing was written.
  //
  // What it does:
  //   - Every write to a mirrored key is first copied into the NovelAI page's
  //     own localStorage ("mirror"). That storage belongs to novelai.net, not to
  //     the extension, so it survives extension reinstalls and ID changes.
  //   - If chrome.storage rejects the write (dead context, quota, ...), the key
  //     is marked "pending" in the mirror and the UI is told via onHealth().
  //   - On the next boot recover() re-applies pending writes and restores any
  //     mirrored key that chrome.storage does not have at all (fresh install).
  // ---------------------------------------------------------------------------

  const MIRROR_KEY = "naiAutoSaver.mirror.v1";
  const MIRROR_VERSION = 1;

  function emptyMirror() {
    return { v: MIRROR_VERSION, updatedAt: 0, local: {}, sync: {}, pending: { local: {}, sync: {} } };
  }

  function cloneJson(value) {
    return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
  }

  function createSafeStore(options = {}) {
    const getChrome = options.getChrome || (() => global.chrome);
    const pageStorage = options.pageStorage || null;
    const shouldMirror = options.shouldMirror || (() => true);
    const mergers = options.mergers || {};
    const onHealth = options.onHealth || (() => {});
    const now = options.now || (() => Date.now());

    let health = { ok: true, reason: "", contextAlive: true };
    // Pending flags newer than this belong to writes still in flight in THIS
    // page session; recover() must only replay ones left by an earlier session.
    const sessionStartedAt = now();

    function setHealth(next) {
      const changed = next.ok !== health.ok || next.reason !== health.reason || next.contextAlive !== health.contextAlive;
      health = next;
      if (changed) {
        try {
          onHealth({ ...health });
        } catch (error) {
          void error;
        }
      }
    }

    function contextAlive() {
      try {
        const api = getChrome();
        return Boolean(api && api.runtime && api.runtime.id && api.storage);
      } catch (error) {
        return false;
      }
    }

    function readMirror() {
      if (!pageStorage) {
        return emptyMirror();
      }
      try {
        const raw = pageStorage.getItem(MIRROR_KEY);
        if (!raw) {
          return emptyMirror();
        }
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== "object") {
          return emptyMirror();
        }
        const base = emptyMirror();
        return {
          v: MIRROR_VERSION,
          updatedAt: Number(parsed.updatedAt) || 0,
          local: parsed.local && typeof parsed.local === "object" ? parsed.local : base.local,
          sync: parsed.sync && typeof parsed.sync === "object" ? parsed.sync : base.sync,
          pending: {
            local: parsed.pending?.local && typeof parsed.pending.local === "object" ? parsed.pending.local : {},
            sync: parsed.pending?.sync && typeof parsed.pending.sync === "object" ? parsed.pending.sync : {},
          },
        };
      } catch (error) {
        return emptyMirror();
      }
    }

    function writeMirror(mirror) {
      if (!pageStorage) {
        return false;
      }
      try {
        mirror.updatedAt = now();
        pageStorage.setItem(MIRROR_KEY, JSON.stringify(mirror));
        return true;
      } catch (error) {
        return false;
      }
    }

    function mirroredEntries(area, values) {
      const out = {};
      for (const [key, value] of Object.entries(values || {})) {
        if (shouldMirror(area, key)) {
          out[key] = value;
        }
      }
      return out;
    }

    function rawGet(area, keys) {
      return new Promise((resolve, reject) => {
        try {
          const api = getChrome();
          api.storage[area].get(keys, (result) => {
            const err = api.runtime && api.runtime.lastError;
            if (err) {
              reject(new Error(err.message || String(err)));
              return;
            }
            resolve(result || {});
          });
        } catch (error) {
          reject(error);
        }
      });
    }

    function rawSet(area, values) {
      return new Promise((resolve, reject) => {
        try {
          const api = getChrome();
          api.storage[area].set(values, () => {
            const err = api.runtime && api.runtime.lastError;
            if (err) {
              reject(new Error(err.message || String(err)));
              return;
            }
            resolve();
          });
        } catch (error) {
          reject(error);
        }
      });
    }

    function describeError(error) {
      const message = String(error && error.message ? error.message : error || "");
      if (/context invalidated|Extension context|Cannot read properties of undefined/i.test(message) || !contextAlive()) {
        return { contextAlive: false, reason: "context" };
      }
      if (/quota/i.test(message)) {
        return { contextAlive: true, reason: "quota" };
      }
      return { contextAlive: true, reason: message || "unknown" };
    }

    async function get(area, keys) {
      const list = keys == null ? null : (Array.isArray(keys) ? keys : [keys]);
      if (!contextAlive()) {
        setHealth({ ok: false, reason: "context", contextAlive: false });
        return pickFromMirror(area, list);
      }
      try {
        return await rawGet(area, list);
      } catch (error) {
        const info = describeError(error);
        setHealth({ ok: false, reason: info.reason, contextAlive: info.contextAlive });
        return pickFromMirror(area, list);
      }
    }

    function pickFromMirror(area, list) {
      const mirror = readMirror();
      const source = mirror[area] || {};
      const out = {};
      const keys = list || Object.keys(source);
      for (const key of keys) {
        if (Object.prototype.hasOwnProperty.call(source, key)) {
          out[key] = cloneJson(source[key]);
        }
      }
      return out;
    }

    // Resolves to { ok, mirrored, error }. Never rejects.
    async function set(area, values) {
      const toMirror = mirroredEntries(area, values);
      const mirrorKeys = Object.keys(toMirror);
      let mirrored = false;
      if (mirrorKeys.length) {
        const mirror = readMirror();
        for (const key of mirrorKeys) {
          mirror[area][key] = cloneJson(toMirror[key]);
          mirror.pending[area][key] = now();
        }
        mirrored = writeMirror(mirror);
      }

      if (!contextAlive()) {
        setHealth({ ok: false, reason: "context", contextAlive: false });
        return { ok: false, mirrored, error: "context" };
      }
      try {
        await rawSet(area, values);
      } catch (error) {
        const info = describeError(error);
        setHealth({ ok: false, reason: info.reason, contextAlive: info.contextAlive });
        return { ok: false, mirrored, error: info.reason };
      }

      if (mirrorKeys.length && mirrored) {
        const mirror = readMirror();
        for (const key of mirrorKeys) {
          delete mirror.pending[area][key];
        }
        writeMirror(mirror);
      }
      if (!health.ok) {
        setHealth({ ok: true, reason: "", contextAlive: true });
      }
      return { ok: true, mirrored };
    }

    // Boot-time repair. Returns a report the UI can show.
    async function recover() {
      const report = { pendingApplied: [], restored: [], failed: false };
      if (!contextAlive()) {
        report.failed = true;
        return report;
      }
      const mirror = readMirror();
      for (const area of ["local", "sync"]) {
        const areaMirror = mirror[area] || {};
        const keys = Object.keys(areaMirror);
        if (!keys.length) {
          continue;
        }
        let current;
        try {
          current = await rawGet(area, keys);
        } catch (error) {
          report.failed = true;
          continue;
        }
        const writes = {};
        for (const key of keys) {
          const has = Object.prototype.hasOwnProperty.call(current, key);
          const pendingAt = Number((mirror.pending[area] || {})[key]);
          const pending = Number.isFinite(pendingAt) && pendingAt <= sessionStartedAt;
          if (pending && has && JSON.stringify(current[key]) === JSON.stringify(areaMirror[key])) {
            // The write did reach chrome.storage; only the flag was left over.
            const fresh = readMirror();
            delete fresh.pending[area][key];
            writeMirror(fresh);
          } else if (pending) {
            const merge = mergers[key];
            writes[key] = has && typeof merge === "function"
              ? merge(current[key], areaMirror[key])
              : areaMirror[key];
            report.pendingApplied.push(`${area}:${key}`);
          } else if (!has) {
            writes[key] = areaMirror[key];
            report.restored.push(`${area}:${key}`);
          }
        }
        if (Object.keys(writes).length) {
          try {
            await rawSet(area, writes);
            const fresh = readMirror();
            for (const key of Object.keys(writes)) {
              delete fresh.pending[area][key];
              fresh[area][key] = cloneJson(writes[key]);
            }
            writeMirror(fresh);
          } catch (error) {
            report.failed = true;
          }
        }
      }
      // Keep the mirror in sync with what chrome.storage already has, so a
      // later reinstall restores the latest values (not just whatever was
      // written since this feature shipped).
      try {
        const fresh = readMirror();
        for (const area of ["local", "sync"]) {
          const all = await rawGet(area, null);
          for (const [key, value] of Object.entries(all)) {
            if (shouldMirror(area, key) && !Object.prototype.hasOwnProperty.call(fresh.pending[area], key)) {
              fresh[area][key] = cloneJson(value);
            }
          }
        }
        writeMirror(fresh);
      } catch (error) {
        void error;
      }
      return report;
    }

    return {
      MIRROR_KEY,
      contextAlive,
      get,
      set,
      recover,
      readMirror,
      getHealth: () => ({ ...health }),
      checkContext() {
        if (!contextAlive()) {
          setHealth({ ok: false, reason: "context", contextAlive: false });
          return false;
        }
        return true;
      },
    };
  }

  // Memo lists from two places (e.g. a stale tab's pending write and a fresh
  // tab's saved state) are merged by id, keeping the newest version of each.
  // Losing nothing is preferred over perfectly honouring a delete.
  function mergeMemoStates(current, incoming) {
    const pick = (state) => (state && Array.isArray(state.items) ? state.items : []);
    const byId = new Map();
    const order = [];
    for (const item of [...pick(incoming), ...pick(current)]) {
      if (!item || !item.id) {
        continue;
      }
      const prev = byId.get(item.id);
      if (!prev) {
        byId.set(item.id, item);
        order.push(item.id);
      } else if ((Number(item.updatedAt) || 0) > (Number(prev.updatedAt) || 0)) {
        byId.set(item.id, item);
      }
    }
    return { schemaVersion: 1, items: order.map((id) => byId.get(id)) };
  }

  const api = { createSafeStore, mergeMemoStates, MIRROR_KEY };
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
  global.NAISafeStore = api;
})(typeof globalThis !== "undefined" ? globalThis : window);
