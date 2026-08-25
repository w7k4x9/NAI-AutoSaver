(function attachPanelKeyShield(global) {
  "use strict";

  // Why this file exists, and why it runs at document_start
  // ---------------------------------------------------------------------------
  // The panel lives inside a shadow root. When a key event crosses the shadow
  // boundary the browser RETARGETS it: every listener on document/window sees
  // `event.target` as the panel's host <div>, not the <textarea> the user is
  // typing in. NovelAI's global shortcut handlers (WASD to pan the canvas,
  // ArrowUp/ArrowDown to walk the history, +/- to zoom) all guard with some
  // form of "is the target an input?" — and that guard cannot see our textarea,
  // so it decides the keystroke is a shortcut and calls preventDefault(). That
  // is why letters and underscores never appeared in the panel's fields.
  //
  // Retargeting cannot be turned off, so the panel is isolated instead: any key
  // or wheel event that STARTS inside the panel is hidden from the rest of the
  // page. Two things make this safe:
  //
  //   * stopImmediatePropagation() only stops DISPATCH. The default action
  //     (inserting the character, scrolling the field) is governed by
  //     preventDefault(), which this file never calls. Typing keeps working.
  //   * The listener is registered in the CAPTURE phase on window at
  //     document_start, i.e. before NovelAI's bundle has run a single line.
  //     Listeners on the same node fire in registration order, so being first
  //     is the only way to reliably beat a capture-phase handler in the page.
  //
  // Because capture on window fires before the event reaches the panel, the
  // panel's own key handling can no longer arrive by bubbling — it is invoked
  // through `hook` below instead.

  if (global.__NAI_AUTOSAVER_KEY_SHIELD__) {
    return;
  }

  const SHIELDED_EVENTS = ["keydown", "keypress", "keyup", "wheel"];
  const EDITABLE_TAGS = new Set(["INPUT", "TEXTAREA", "SELECT"]);

  const hosts = new Set();
  const handledEvents = new WeakSet();
  let hook = null;
  // When the panel is open it behaves like a focused window: every key that
  // starts inside it belongs to it. When it is collapsed to the floating
  // button, only real text fields are shielded, so clicking the button never
  // swallows NovelAI's canvas shortcuts afterwards.
  let panelOpen = false;

  function pathOf(event) {
    if (typeof event.composedPath !== "function") {
      return null;
    }
    const path = event.composedPath();
    return path && path.length ? path : null;
  }

  function deepTargetOf(event) {
    const path = pathOf(event);
    return path ? path[0] : event.target;
  }

  function originatesInPanel(event) {
    if (!hosts.size) {
      return false;
    }
    const path = pathOf(event);
    if (path) {
      for (const node of path) {
        if (hosts.has(node)) {
          return true;
        }
      }
      return false;
    }
    // composedPath is missing only in very old engines; the retargeted target
    // is the host itself there.
    const target = event.target;
    for (const host of hosts) {
      if (target === host || (host.contains && target && host.contains(target))) {
        return true;
      }
    }
    return false;
  }

  function isEditable(node) {
    if (!node || node.nodeType !== 1) {
      return false;
    }
    if (EDITABLE_TAGS.has(node.tagName)) {
      return true;
    }
    return Boolean(node.isContentEditable);
  }

  function onShieldedEvent(event) {
    if (!originatesInPanel(event)) {
      return;
    }
    const target = deepTargetOf(event);
    if (!panelOpen && !isEditable(target)) {
      return;
    }
    if (hook && event.type === "keydown") {
      handledEvents.add(event);
      try {
        hook(event, target);
      } catch (error) {
        void error;
      }
    }
    // Hide the event from NovelAI. Never preventDefault here: the keystroke
    // must still reach the field the user is typing in.
    event.stopImmediatePropagation();
  }

  for (const type of SHIELDED_EVENTS) {
    global.addEventListener(type, onShieldedEvent, true);
  }

  global.__NAI_AUTOSAVER_KEY_SHIELD__ = {
    registerHost(host) {
      if (host) {
        hosts.add(host);
      }
    },
    unregisterHost(host) {
      hosts.delete(host);
    },
    setHook(fn) {
      hook = typeof fn === "function" ? fn : null;
    },
    setPanelOpen(open) {
      panelOpen = Boolean(open);
    },
    wasHandled(event) {
      return Boolean(event) && handledEvents.has(event);
    },
    markHandled(event) {
      if (event) {
        handledEvents.add(event);
      }
    },
  };
})(typeof globalThis !== "undefined" ? globalThis : window);
