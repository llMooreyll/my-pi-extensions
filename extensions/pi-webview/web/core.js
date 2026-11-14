// pi/view overlay, shared by the md/pdf viewers and by injected HTML pages.
// - selection → tab → slip (ask now / pin), the slip either follows its anchor or stays put
// - markers at every asked or pinned spot; a marker expands the answers in place
// - a floating panel with the live conversation (Wire) and the pin manager (Pins)
// Page-specific code registers an adapter:
//   fromSelection(sel, range) → anchor|null      label(anchor) → string
//   locate(anchor) → { el, range?, rect?(), box? } | null      clip?() → DOMRect
//   reveal?(anchor, loc)  reload?()  goto?(target)  converting?()
(() => {
  if (window.PiView) return;
  const script = document.currentScript;
  const snapshotEl = document.getElementById("pv-snapshot");
  const exportMode = script.dataset.export === "1" || !!snapshotEl;
  let snapshot = null;
  if (exportMode && snapshotEl) {
    try {
      snapshot = JSON.parse(snapshotEl.textContent || "{}");
    } catch {
      snapshot = {};
    }
  }
  const cfg = {
    base: script.dataset.base || "",
    doc: script.dataset.doc || snapshot?.doc?.id || "",
    kind: script.dataset.kind || snapshot?.doc?.kind || "html",
    unit: script.dataset.unit || snapshot?.doc?.unit || "page",
    file: script.dataset.file || snapshot?.doc?.file || "",
  };
  const viewer = cfg.kind !== "html";
  const scrollKey = `pv-scroll:${cfg.doc}`;
  const norm = (s) => (s || "").replace(/\s+/g, " ").trim();
  const keyOf = (a) =>
    [
      a.kind,
      a.lines ? a.lines.join("-") : "",
      a.ranges ? a.ranges.map((r) => r.join("-")).join(",") : "",
      a.page || "",
      a.region ? a.region.map((n) => n.toFixed(3)).join(",") : "",
      a.regions ? a.regions.map((r) => `${r.page}:${r.region.map((n) => n.toFixed(3)).join(",")}`).join(";") : "",
      a.selector || "",
      a.items ? a.items.map((i) => i.selector).join(",") : "",
      norm(a.text).slice(0, 80),
    ].join("|");
  const api = (path, init = {}) =>
    fetch(`${cfg.base}${path}`, { ...init, headers: { "content-type": "application/json", accept: "application/json", ...(init.headers || {}) } }).then(async (res) => {
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `${res.status} ${res.statusText}`);
      return data;
    });

  let adapter = null;
  let status = { online: false, busy: false, session: "", pinned: 0 };
  let pins = [];
  let stars = [];
  let threads = [];
  const pending = new Map(); // anchor key → { anchor, question, at }: asked, thread not seen yet
  const openDrawers = new Set();
  const locCache = new Map();
  let groups = [];
  let current = null; // the open slip: { anchor, range, rectFn, onClose }
  let pendingSel = null;
  let pendingStarSel = null;
  let es = null;
  let ended = false;

  // ── shadow UI ──
  const host = document.createElement("pv-overlay");
  if (exportMode) host.dataset.readonly = "1";
  const root = host.attachShadow({ mode: "open" });
  const uiCssTag = exportMode
    ? `<style>${document.getElementById("pv-katex-css")?.textContent || ""}\n${document.getElementById("pv-ui-css")?.textContent || ""}</style>`
    : `<link rel="stylesheet" href="${cfg.base}/vendor/katex/dist/katex.min.css"><link rel="stylesheet" href="${cfg.base}/assets/ui.css">`;
  root.innerHTML = `
    ${uiCssTag}
    <div class="layer boxes"></div>
    <div class="layer marquee"></div>
    <div class="layer markers"></div>
    <div class="layer drawers"></div>
    <div class="tab" hidden><button class="t-ask">Ask <kbd>Enter</kbd></button><button class="t-pin">Pin</button></div>
    <div class="star-pop" hidden><button type="button">★ 收藏此段</button></div>
    <section class="slip" hidden role="dialog" aria-label="Ask pi">
      <header><span class="no"></span><span class="loc"></span><button class="mode" title="Follow the selection when the page scrolls, or stay fixed on screen"></button></header>
      <div class="quote"></div>
      <textarea rows="3" placeholder="Ask about this…"></textarea>
      <footer><span class="hint">Enter ask · Shift+Enter newline<br>Ctrl+Enter pin · Esc close</span><button class="mic" type="button" title="Voice input">🎙</button><button class="pin" title="Pin: send with your next message">Pin</button><button class="ask">Ask →</button></footer>
    </section>
    <aside class="panel" hidden>
      <header>
        <nav class="tabs"><button data-tab="wire">Wire</button><button data-tab="pins">Pins <b class="count"></b></button></nav>
        <button class="x" title="Close">✕</button>
      </header>
      <div class="filters" data-of="wire"><button data-filter="all">All</button><button data-filter="refs">From browser</button><button data-filter="doc">This document</button><button data-filter="starred">★ <b class="star-count"></b></button><button class="rail-toggle" type="button" title="Toggle turn directory">▤</button></div>
      <div class="filters" data-of="pins"><span class="note">Pins go out with your next message, from here or from pi.</span><button class="clear">Clear all</button></div>
      <div class="wire-wrap" data-of="wire">
        <div class="scroll wire-scroll"></div>
        <nav class="turn-rail" aria-label="Turns"></nav>
      </div>
      <div class="scroll" data-of="pins"></div>
      <footer class="composer">
        <div class="attach" hidden></div>
        <textarea rows="2" placeholder="Message pi…"></textarea>
        <button class="mic" type="button" title="Voice input">🎙</button>
        <button class="send">Send →</button>
      </footer>
    </aside>
    <div class="export-pop" hidden>
      <span class="ep-title">Export PDF as single-file HTML</span>
      <div class="ep-actions">
        <button class="ep-all primary" type="button"></button>
        <button class="ep-ann" type="button"></button>
        <button class="ep-cancel" type="button">✕</button>
      </div>
    </div>
    <div class="dock offline">
      <span class="state"><i></i><b>${exportMode ? "exported" : "offline"}</b></span><span class="session"></span>
      <button class="d-pins" hidden title="Pinned references"></button>
      <button class="d-export" title="Export annotated single-file HTML">⤓</button>
      <button class="d-wire" title="Conversation">✦</button>
    </div>
    <div class="outline" hidden><span></span></div>
    <div class="toasts"></div>`;
  const $ = (s) => root.querySelector(s);
  const tab = $(".tab");
  const slip = $(".slip");
  const slipText = $(".slip textarea");
  const panel = $(".panel");
  const composer = $(".composer textarea");
  const dock = $(".dock");
  const outlineEl = $(".outline");
  document.documentElement.appendChild(host);

  function syncTheme() {
    const system = matchMedia("(prefers-color-scheme: dark)").matches ? "carbon" : "paper";
    host.dataset.theme = (viewer && document.documentElement.dataset.theme) || system;
  }
  syncTheme();

  function addTool(label, title, onClick) {
    const b = document.createElement("button");
    b.textContent = label;
    b.title = title;
    b.addEventListener("click", onClick);
    dock.appendChild(b);
    return b;
  }
  if (viewer) {
    addTool("◐", "Switch paper / carbon theme", () => {
      const next = document.documentElement.dataset.theme === "carbon" ? "paper" : "carbon";
      document.documentElement.dataset.theme = next;
      localStorage.setItem("pv-theme", next);
      syncTheme();
    });
  }

  function toast(text, error = false) {
    const t = document.createElement("div");
    t.className = `toast${error ? " err" : ""}`;
    t.textContent = text;
    $(".toasts").appendChild(t);
    setTimeout(() => {
      t.classList.add("out");
      setTimeout(() => t.remove(), 260);
    }, error ? 6000 : 2400);
  }

  function shake(el) {
    el.classList.remove("shake");
    void el.offsetWidth;
    el.classList.add("shake");
  }

  function outline(rect, text) {
    if (!rect) return void (outlineEl.hidden = true);
    Object.assign(outlineEl.style, { left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, height: `${rect.height}px` });
    outlineEl.firstElementChild.textContent = text || "";
    outlineEl.hidden = false;
  }

  // Text that is in the DOM but not what the reader sees (KaTeX keeps a hidden MathML copy of every formula).
  const SKIP_TEXT = "script, style, .katex-mathml";

  /** The visible text of a range. */
  function rangeText(range) {
    const frag = range.cloneContents();
    frag.querySelectorAll(SKIP_TEXT).forEach((el) => el.remove());
    return frag.textContent;
  }

  // ── text search: whitespace-insensitive, returns a Range over the matching text nodes ──
  function findText(scope, text, from = null) {
    const needle = (text || "").replace(/\s+/g, "");
    if (!scope || !needle) return null;
    const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) => (n.parentElement?.closest(SKIP_TEXT) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
    });
    if (from) walker.currentNode = from;
    let flat = "";
    const map = [];
    for (let n = walker.nextNode(); n && flat.length < 400000; n = walker.nextNode()) {
      const s = n.nodeValue;
      for (let i = 0; i < s.length; i++) {
        if (!/\s/.test(s[i])) {
          flat += s[i];
          map.push(n, i);
        }
      }
      if (flat.length >= needle.length && flat.includes(needle)) break;
    }
    const at = flat.indexOf(needle);
    if (at < 0) return null;
    const end = at + needle.length - 1;
    const range = document.createRange();
    range.setStart(map[at * 2], map[at * 2 + 1]);
    range.setEnd(map[end * 2], map[end * 2 + 1] + 1);
    return range;
  }

  // ── locating anchors on this page ──
  const connected = (loc) =>
    (loc.els ? loc.els.some((el) => el?.isConnected) : loc.el?.isConnected) && (!loc.range || loc.range.startContainer.isConnected);
  function locOf(anchor) {
    const key = keyOf(anchor);
    const hit = locCache.get(key);
    if (hit && connected(hit)) return hit;
    if (hit === null) return null;
    let loc = null;
    try {
      loc = adapter?.locate?.(anchor) || null;
    } catch {
      loc = null;
    }
    locCache.set(key, loc);
    return loc;
  }
  /** body: the whole anchored area; tail: where an inline marker goes (end of the text). */
  function geom(loc) {
    if (loc.rect) {
      const r = loc.rect();
      const full = loc.fullRect ? loc.fullRect() : r;
      return { tail: r, body: r, full: full || r };
    }
    if (loc.range) {
      const rects = [...loc.range.getClientRects()].filter((r) => r.width > 0);
      if (rects.length) {
        const body = loc.range.getBoundingClientRect();
        return { tail: rects[rects.length - 1], body, full: body };
      }
    }
    const r = loc.el.getBoundingClientRect();
    return { tail: r, body: r, full: r };
  }
  function clipRect() {
    return adapter?.clip?.() || new DOMRect(0, viewer ? 46 : 0, innerWidth, innerHeight - (viewer ? 46 : 0));
  }

  // ── smart geometry & minimum bounding box engine ──
  function clipToRect(a, b) {
    if (!a || !b) return null;
    const left = Math.max(a.left, b.left);
    const top = Math.max(a.top, b.top);
    const right = Math.min(a.right, b.right);
    const bottom = Math.min(a.bottom, b.bottom);
    return right > left && bottom > top ? new DOMRect(left, top, right - left, bottom - top) : null;
  }

  function unionRects(rects) {
    let left = Infinity;
    let top = Infinity;
    let right = -Infinity;
    let bottom = -Infinity;
    for (const r of rects) {
      if (!r || r.width <= 0 || r.height <= 0) continue;
      if (r.left < left) left = r.left;
      if (r.top < top) top = r.top;
      if (r.right > right) right = r.right;
      if (r.bottom > bottom) bottom = r.bottom;
    }
    return left < right && top < bottom ? new DOMRect(left, top, right - left, bottom - top) : null;
  }

  function rectsIntersect(a, b) {
    return !!a && !!b && a.right > b.left && a.left < b.right && a.bottom > b.top && a.top < b.bottom;
  }

  function rectArea(r) {
    return r && r.width > 0 && r.height > 0 ? r.width * r.height : 0;
  }

  function rectOf(target, depth = 0) {
    if (!target) return null;
    if (target instanceof Range) {
      const crs = [...target.getClientRects()].filter((r) => r.width > 0.5 && r.height > 0.5);
      return crs.length ? unionRects(crs) : target.getBoundingClientRect();
    }
    if (!(target instanceof Element) || !target.isConnected) return null;
    const cs = getComputedStyle(target);
    if (cs.display === "none" || cs.visibility === "hidden" || parseFloat(cs.opacity) === 0) return null;

    let rect = null;
    if (cs.display === "contents") {
      if (depth < 4) {
        const childRects = [];
        for (const c of target.children) {
          const cr = rectOf(c, depth + 1);
          if (cr) childRects.push(cr);
          if (childRects.length >= 64) break;
        }
        rect = unionRects(childRects);
      }
    } else {
      const raw = target.getBoundingClientRect();
      if (raw.width <= 0.5 || raw.height <= 0.5) {
        if (depth < 3 && target.children.length) {
          const childRects = [];
          for (const c of target.children) {
            const cr = rectOf(c, depth + 1);
            if (cr) childRects.push(cr);
            if (childRects.length >= 64) break;
          }
          rect = unionRects(childRects);
        }
      } else if (cs.display === "inline") {
        const crs = [...target.getClientRects()].filter((r) => r.width > 0.5 && r.height > 0.5);
        rect = crs.length ? unionRects(crs) : raw;
      } else {
        rect = raw;
      }
    }
    if (!rect) return null;

    // Intersect with inner overflow-clipping containers so off-clip descendants do not inflate the box.
    for (let p = target.parentElement; p && p !== document.body && p !== document.documentElement; p = p.parentElement) {
      const pcs = getComputedStyle(p);
      const ox = pcs.overflowX;
      const oy = pcs.overflowY;
      if (ox === "hidden" || ox === "clip" || ox === "scroll" || ox === "auto" || oy === "hidden" || oy === "clip" || oy === "scroll" || oy === "auto") {
        const pr = p.getBoundingClientRect();
        if (pr.width > 0 && pr.height > 0) {
          rect = clipToRect(rect, pr);
          if (!rect) return null;
        }
      }
    }
    return rect;
  }

  /** Visible-first bounding box for placing floating UI (Marker / Slip / Drawer) when items span wide scroll ranges. */
  function smartAnchorRect(rects, clip = clipRect()) {
    const valid = rects.filter((r) => r && r.width > 0 && r.height > 0);
    if (!valid.length) return null;
    const clipped = valid.map((r) => clipToRect(r, clip)).filter(Boolean);
    if (clipped.length) return unionRects(clipped);
    // All items scrolled out of view: pick the one closest to the viewport vertical midpoint.
    const cy = (clip.top + clip.bottom) / 2;
    let best = valid[0];
    let bestDist = Infinity;
    for (const r of valid) {
      const d = Math.abs((r.top + r.bottom) / 2 - cy);
      if (d < bestDist) {
        bestDist = d;
        best = r;
      }
    }
    return best;
  }

  /**
   * Prune raw hit DOM elements into a clean, minimal non-overlapping set inside `dragRect`:
   * - drop giant wrappers that extend far outside `dragRect` when children were matched
   * - promote cohesive containers >= 85% covered inside `dragRect` and drop their descendants
   * - coalesce dense sibling bursts (> 16 items) into covered parents
   */
  function pruneElements(hits, dragRect, shellRoot = document.body) {
    if (!hits.length) return [];
    const byEl = new Map(hits.map((h) => [h.el, h]));
    const isShell = (el) => !el || el === document.documentElement || el === document.body || el === shellRoot || el.tagName === "MAIN";

    // Pass 1: promote well-contained containers (>= 85% inside dragRect) over their descendants.
    const sorted = [...hits].sort((a, b) => rectArea(b.rect) - rectArea(a.rect));
    const dropped = new Set();
    for (const item of sorted) {
      if (dropped.has(item.el) || isShell(item.el)) continue;
      if (item.coverage >= 0.85) {
        for (const other of hits) {
          if (other.el !== item.el && item.el.contains(other.el)) dropped.add(other.el);
        }
      }
    }

    // Pass 2: if a partial wrapper (< 85% inside) still wraps kept descendants, drop the wrapper.
    let kept = hits.filter((h) => !dropped.has(h.el));
    const keptSet = new Set(kept.map((h) => h.el));
    kept = kept.filter((h) => {
      if (isShell(h.el)) return false;
      for (const other of keptSet) {
        if (other !== h.el && h.el.contains(other)) return false;
      }
      return true;
    });

    // Pass 3: if still > 16 fragmented sibling items (e.g. a grid/table), coalesce into well-covered parents.
    if (kept.length > 16) {
      const byParent = new Map();
      for (const h of kept) {
        const p = h.el.parentElement;
        if (!p || isShell(p)) continue;
        if (!byParent.has(p)) byParent.set(p, []);
        byParent.get(p).push(h);
      }
      const promoted = new Set();
      for (const [p, group] of byParent) {
        if (group.length < 2) continue;
        const pr = rectOf(p);
        const inter = clipToRect(pr, dragRect);
        const pCov = pr && inter ? rectArea(inter) / Math.max(1, rectArea(pr)) : 0;
        const visibleKids = [...p.children].filter((c) => rectOf(c));
        if (pCov >= 0.65 && group.length / Math.max(1, visibleKids.length) >= 0.6) {
          promoted.add(p);
          for (const g of group) byEl.delete(g.el);
          byEl.set(p, { el: p, rect: pr, coverage: pCov });
        }
      }
      if (promoted.size) {
        kept = kept.filter((h) => !promoted.has(h.el.parentElement));
        for (const p of promoted) kept.push(byEl.get(p));
      }
    }

    // Order top-to-bottom, left-to-right for stable reading order.
    return kept.sort((a, b) => (Math.abs(a.rect.top - b.rect.top) > 6 ? a.rect.top - b.rect.top : a.rect.left - b.rect.left));
  }

  /** Forget cached locations (after a re-render) and redraw. */
  function relocate() {
    locCache.clear();
    renderMarkers();
    paint();
    schedule();
  }

  // ── highlights (CSS Custom Highlight API: no DOM mutation, host pages stay intact) ──
  const hlStyle = document.createElement("style");
  hlStyle.textContent =
    "::highlight(pv-asked){background-color:rgb(255 74 28/.16);text-decoration:underline 2px rgb(255 74 28);text-underline-offset:4px}" +
    "::highlight(pv-pinned){background-color:rgb(35 53 255/.14);text-decoration:underline 2px dotted rgb(35 53 255);text-underline-offset:4px}" +
    "html.pv-marquee-active,html.pv-marquee-active *{user-select:none!important;-webkit-user-select:none!important}";
  (document.head || document.documentElement).appendChild(hlStyle);
  const canHighlight = typeof Highlight === "function" && !!CSS.highlights;
  function paint() {
    if (!canHighlight) return;
    const asked = [];
    const pinned = [];
    for (const g of groups) {
      const loc = locOf(g.anchor);
      if (!loc?.range || loc.box) continue;
      (g.pins.length ? pinned : asked).push(loc.range);
    }
    CSS.highlights.set("pv-asked", new Highlight(...asked));
    CSS.highlights.set("pv-pinned", new Highlight(...pinned));
  }

  // ── voice input (delegated to Pi's system-wide pi-voice ASR service) ──
  let activeMic = null; // { btn, stop, cancel }

  function pickAudioMime() {
    if (typeof MediaRecorder !== "function" || typeof MediaRecorder.isTypeSupported !== "function") return "";
    return ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus", "audio/mp4"].find((t) => MediaRecorder.isTypeSupported(t)) || "";
  }

  function insertTranscript(ta, text) {
    const clean = (text || "").trim();
    if (!clean) return;
    const start = typeof ta.selectionStart === "number" ? ta.selectionStart : ta.value.length;
    const end = typeof ta.selectionEnd === "number" ? ta.selectionEnd : ta.value.length;
    const before = ta.value.slice(0, start);
    const after = ta.value.slice(end);
    const lead = before && !/[\s\n]$/.test(before) ? " " : "";
    const trail = after && !/^[\s\n]/.test(after) ? " " : "";
    const inserted = `${lead}${clean}${trail}`;
    ta.value = `${before}${inserted}${after}`;
    const caret = before.length + inserted.length;
    ta.focus();
    ta.setSelectionRange?.(caret, caret);
    ta.dispatchEvent(new Event("input", { bubbles: true }));
  }

  function cancelActiveMic(container = null) {
    if (!activeMic) return;
    if (container && !container.contains(activeMic.btn)) return;
    activeMic.cancel();
  }

  function attachMic(btn, ta) {
    btn.addEventListener("click", async () => {
      if (activeMic?.btn === btn) {
        activeMic.stop();
        return;
      }
      if (activeMic) activeMic.cancel();
      if (btn.classList.contains("transcribing")) return;

      if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder !== "function") {
        toast("Microphone recording is not supported in this browser", true);
        return;
      }

      btn.classList.add("transcribing");
      btn.textContent = "…";
      let stream;
      try {
        const st = await api("/asr/status");
        if (!st.available || !st.configured) {
          throw new Error(st.reason || "Pi Voice is not configured. Run /voice-settings in pi.");
        }
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      } catch (e) {
        btn.classList.remove("transcribing");
        btn.textContent = "🎙";
        toast(String(e.message || e), true);
        return;
      }

      const chunks = [];
      let discarded = false;
      const mimeType = pickAudioMime();
      let recorder;
      try {
        recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
      } catch (e) {
        stream.getTracks().forEach((t) => t.stop());
        btn.classList.remove("transcribing");
        btn.textContent = "🎙";
        toast(String(e.message || e), true);
        return;
      }

      const releaseStream = () => stream.getTracks().forEach((t) => t.stop());
      const resetBtn = () => {
        btn.classList.remove("recording", "transcribing");
        btn.textContent = "🎙";
        btn.title = "Voice input";
      };

      const session = {
        btn,
        stop() {
          if (recorder.state === "recording") recorder.stop();
          releaseStream();
          if (activeMic === session) activeMic = null;
        },
        cancel() {
          discarded = true;
          if (recorder.state === "recording") recorder.stop();
          releaseStream();
          if (activeMic === session) activeMic = null;
          resetBtn();
        },
      };
      activeMic = session;

      recorder.ondataavailable = (ev) => {
        if (ev.data && ev.data.size > 0) chunks.push(ev.data);
      };
      recorder.onerror = () => {
        releaseStream();
        if (activeMic === session) activeMic = null;
        resetBtn();
        toast("Microphone recording failed", true);
      };
      recorder.onstop = async () => {
        releaseStream();
        if (activeMic === session) activeMic = null;
        if (discarded) return;
        const blob = new Blob(chunks, { type: recorder.mimeType || mimeType || "audio/webm" });
        if (!blob.size) {
          resetBtn();
          toast("No audio captured", true);
          return;
        }
        btn.classList.remove("recording");
        btn.classList.add("transcribing");
        btn.textContent = "…";
        btn.title = "Transcribing…";
        try {
          const res = await fetch(`${cfg.base}/asr`, {
            method: "POST",
            headers: { "content-type": blob.type || "application/octet-stream", accept: "application/json" },
            body: blob,
          });
          const data = await res.json().catch(() => ({}));
          if (!res.ok) throw new Error(data.error || `${res.status} ${res.statusText}`);
          if (data.text) insertTranscript(ta, data.text);
          else toast("No speech detected");
          if (data.warning) toast(data.warning);
        } catch (e) {
          toast(String(e.message || e), true);
        } finally {
          resetBtn();
        }
      };

      btn.classList.remove("transcribing");
      btn.classList.add("recording");
      btn.textContent = "■";
      btn.title = "Stop recording & transcribe";
      recorder.start();
    });
  }

  // ── groups: one per distinct anchor on this page ──
  function buildGroups() {
    const map = new Map();
    const group = (anchor) => {
      const key = keyOf(anchor);
      if (!map.has(key)) map.set(key, { key, anchor, threads: [], pins: [], stars: [], pending: [] });
      return map.get(key);
    };
    for (const t of threads) for (const r of t.refs) if (r.docId === cfg.doc) group(r.anchor).threads.push(t);
    for (const p of pins) if (p.docId === cfg.doc) group(p.anchor).pins.push(p);
    for (const s of stars) if (s.docId === cfg.doc && s.anchor) group(s.anchor).stars.push(s);
    for (const [key, list] of pending) {
      const count = map.get(key)?.threads.length || 0;
      const remaining = list.filter((p) => count <= p.baseCount);
      if (remaining.length) {
        pending.set(key, remaining);
        group(remaining[0].anchor).pending = remaining;
      } else {
        pending.delete(key);
      }
    }
    groups = [...map.values()];
  }

  function queuePending(key, anchor, question) {
    const existing = groups.find((g) => g.key === key);
    const list = pending.get(key) || [];
    const baseCount = (existing?.threads.length || 0) + list.length;
    list.push({ anchor, question, at: Date.now(), baseCount });
    pending.set(key, list);
  }

  function render() {
    buildGroups();
    renderMarkers();
    renderPanel();
    paint();
    schedule();
  }

  function renderMarkers() {
    const markers = $(".markers");
    const boxes = $(".boxes");
    const drawers = $(".drawers");
    markers.replaceChildren();
    boxes.replaceChildren();
    const existingDrawers = new Map([...drawers.querySelectorAll(".drawer")].map((el) => [el.dataset.key, el]));
    const activeKeys = new Set();

    for (const g of groups) {
      const m = document.createElement("div");
      m.className = "marker";
      m.dataset.key = g.key;
      const asked = g.threads.length + g.pending.length;
      if (asked) {
        const b = document.createElement("button");
        b.className = `chip asked${g.pending.length || g.threads.some((t) => t.status === "running") ? " live" : ""}${openDrawers.has(g.key) ? " open" : ""}`;
        b.textContent = `◉ ${asked}`;
        b.title = "Answers here — click to expand";
        b.addEventListener("click", () => toggleDrawer(g.key));
        m.appendChild(b);
      }
      if (g.pins.length) {
        const b = document.createElement("button");
        b.className = "chip pinned";
        b.textContent = g.pins.length > 1 ? `◆ ${g.pins.length}` : "◆";
        b.title = "Pinned — click to edit";
        b.addEventListener("click", () => openPanel("pins", g.pins[0].id));
        m.appendChild(b);
      }
      if (g.stars.length) {
        const b = document.createElement("button");
        b.className = `chip starred${openDrawers.has(g.key) ? " open" : ""}`;
        b.textContent = g.stars.length > 1 ? `★ ${g.stars.length}` : "★";
        b.title = `${g.stars.length} starred insight${g.stars.length > 1 ? "s" : ""} — click to view`;
        b.addEventListener("click", () => {
          if (!openDrawers.has(g.key)) openDrawers.add(g.key);
          renderMarkers();
          schedule();
          const dr = drawers.querySelector(`.drawer[data-key="${CSS.escape(g.key)}"]`);
          const firstStar = g.stars[0];
          const target = dr?.querySelector(`article.th[data-seq="${firstStar.threadSeq}"]`) || dr?.querySelector(".star-digest");
          target?.scrollIntoView({ block: "nearest", behavior: "smooth" });
        });
        m.appendChild(b);
      }
      markers.appendChild(m);
      const loc = locOf(g.anchor);
      if (loc?.box) {
        const kindCls = `${g.pins.length ? " pinned" : " asked"}${g.stars.length ? " starred" : ""}`;
        const box = document.createElement("div");
        box.className = `box${kindCls}`;
        box.dataset.key = g.key;
        boxes.appendChild(box);
        const subs = loc.subRects ? loc.subRects() : loc.rects;
        if (subs && subs.length > 1) {
          for (let idx = 0; idx < subs.length; idx++) {
            const sb = document.createElement("div");
            sb.className = `box sub${kindCls}`;
            sb.dataset.key = g.key;
            sb.dataset.sub = String(idx);
            boxes.appendChild(sb);
          }
        }
      }
      if (openDrawers.has(g.key) && (asked || g.stars.length)) {
        activeKeys.add(g.key);
        const existing = existingDrawers.get(g.key);
        if (existing) syncDrawer(existing, g);
        else drawers.appendChild(drawerEl(g));
      }
    }
    for (const [k, d] of existingDrawers) {
      if (!activeKeys.has(k)) {
        cancelActiveMic(d);
        d.remove();
      }
    }
  }

  const drawerStates = new Map(); // key → { mode: "follow" | "fixed", left: number, top: number, width?: number, height?: number }

  function drawerState(key) {
    let st = drawerStates.get(key);
    if (!st) {
      st = { mode: "follow", left: 0, top: 0 };
      drawerStates.set(key, st);
    }
    return st;
  }

  function applyDrawerChrome(d, g, st) {
    d.classList.toggle("fixed", st.mode === "fixed");
    const modeBtn = d.querySelector(":scope > header .mode");
    if (modeBtn) modeBtn.textContent = st.mode === "fixed" ? "▣ Fixed" : "⚓ Follow";
    const railOpen = st.railOpen !== undefined ? st.railOpen : g.threads.length >= 2;
    const railBtn = d.querySelector(":scope > header .rail-toggle");
    if (railBtn) railBtn.classList.toggle("on", railOpen);
    const rail = d.querySelector(".turn-rail");
    if (rail) rail.hidden = !railOpen || !g.threads.length;
    if (st.width) d.style.width = `${Math.min(st.width, Math.max(300, innerWidth - 24))}px`;
    if (st.height) {
      d.style.height = `${Math.min(st.height, Math.max(160, innerHeight - 24))}px`;
      d.style.maxHeight = "none";
    }
  }

  function syncDrawer(d, g) {
    d._group = g;
    const st = drawerState(g.key);
    applyDrawerChrome(d, g, st);
    const title = d.querySelector(":scope > header span");
    if (title) title.textContent = adapter?.label?.(g.anchor) || "";
    const list = d.querySelector(".list");
    const follow = list.scrollHeight - list.scrollTop - list.clientHeight < 40;
    const existingTh = new Map([...list.querySelectorAll("article.th[data-thread]")].map((el) => [el.dataset.thread, el]));
    const nodes = [];
    if (g.stars.length) {
      const digest = document.createElement("div");
      digest.className = "star-digest";
      const head = document.createElement("div");
      head.className = "sd-head";
      head.textContent = `★ Starred (${g.stars.length})`;
      digest.appendChild(head);
      for (const s of g.stars) {
        const item = document.createElement("div");
        item.className = "sd-item";
        const bodyEl = document.createElement("div");
        bodyEl.className = "sd-body";
        const meta = document.createElement("span");
        meta.className = "sd-meta";
        meta.textContent = `#${s.threadSeq}${s.scope === "turn" ? " · Full reply" : ""}`;
        const txt = document.createElement("span");
        txt.textContent = norm(s.excerpt || s.question).slice(0, 220) || "(starred reply)";
        bodyEl.append(meta, txt);
        item.appendChild(bodyEl);
        if (!exportMode) {
          const del = document.createElement("button");
          del.className = "sd-del";
          del.type = "button";
          del.textContent = "✕";
          del.title = "Remove star";
          del.addEventListener("click", () => api(`/stars/${s.id}`, { method: "DELETE" }).catch((e) => toast(e.message, true)));
          item.appendChild(del);
        }
        digest.appendChild(item);
      }
      nodes.push(digest);
    }
    for (const t of g.threads) {
      const el = existingTh.get(t.id);
      if (el) {
        fillThread(el, t);
        nodes.push(el);
      } else {
        nodes.push(threadEl(t, false));
      }
    }
    for (const p of g.pending) nodes.push(pendingEl(p));
    list.replaceChildren(...nodes);
    if (follow) list.scrollTop = list.scrollHeight;
    renderTurnRail(d.querySelector(".turn-rail"), list, g.threads);
    const ta = d.querySelector("footer.follow textarea");
    if (ta) {
      const last = g.threads[g.threads.length - 1];
      ta.placeholder = last?.seq ? `Follow up on #${last.seq}…` : "Follow up…";
    }
  }

  async function sendFollowUp(d) {
    if (d.classList.contains("sending")) return;
    const g = d._group;
    const ta = d.querySelector("footer.follow textarea");
    const question = ta.value.trim();
    if (!question) {
      shake(d);
      ta.focus();
      return;
    }
    const { image: _image, preview: _preview, ...anchor } = g.anchor;
    const last = g.threads[g.threads.length - 1];
    const replyTo = last?.id;
    d.classList.add("sending");
    try {
      const data = await api("/ask", {
        method: "POST",
        body: JSON.stringify({ doc: cfg.doc, mode: "ask", question, anchor, ...(replyTo ? { replyTo } : {}) }),
      });
      ta.value = "";
      queuePending(g.key, anchor, question);
      render();
      const list = d.querySelector(".list");
      list.scrollTop = list.scrollHeight;
      toast(data.delivered === "now" ? "→ Sent to pi" : "→ Queued — pi is busy");
    } catch (e) {
      toast(String(e.message || e), true);
    } finally {
      d.classList.remove("sending");
      ta.focus();
    }
  }

  function drawerEl(g) {
    const d = document.createElement("section");
    d.className = "drawer";
    d.dataset.key = g.key;
    d._group = g;
    const head = document.createElement("header");
    const label = document.createElement("span");
    const railBtn = document.createElement("button");
    railBtn.className = "rail-toggle";
    railBtn.type = "button";
    railBtn.textContent = "▤";
    railBtn.title = "Toggle turn directory";
    railBtn.addEventListener("click", () => {
      const cur = d._group;
      const st = drawerState(cur.key);
      const isOpen = st.railOpen !== undefined ? st.railOpen : cur.threads.length >= 2;
      st.railOpen = !isOpen;
      applyDrawerChrome(d, cur, st);
    });
    const modeBtn = document.createElement("button");
    modeBtn.className = "mode";
    modeBtn.type = "button";
    modeBtn.title = "Follow the anchor when the page scrolls, or stay fixed on screen";
    modeBtn.addEventListener("click", () => {
      const st = drawerState(d._group.key);
      if (st.mode === "follow") {
        const r = d.getBoundingClientRect();
        st.mode = "fixed";
        st.left = r.left;
        st.top = r.top;
      } else {
        st.mode = "follow";
      }
      applyDrawerChrome(d, d._group, st);
      schedule();
    });
    const close = document.createElement("button");
    close.className = "close";
    close.type = "button";
    close.textContent = "✕";
    close.title = "Collapse";
    close.addEventListener("click", () => toggleDrawer(d._group.key));
    head.append(label, railBtn, modeBtn, close);

    // Drag by header: automatically switches to Fixed mode and moves freely.
    head.addEventListener("pointerdown", (e) => {
      if (e.button !== 0 || e.target.closest("button")) return;
      e.preventDefault();
      const st = drawerState(d._group.key);
      const rect = d.getBoundingClientRect();
      if (st.mode === "follow") {
        st.mode = "fixed";
        st.left = rect.left;
        st.top = rect.top;
        applyDrawerChrome(d, d._group, st);
      }
      const start = { x: e.clientX, y: e.clientY, left: st.left, top: st.top };
      const move = (ev) => {
        st.left = Math.min(Math.max(0, start.left + ev.clientX - start.x), Math.max(0, innerWidth - 80));
        st.top = Math.min(Math.max(0, start.top + ev.clientY - start.y), Math.max(0, innerHeight - 40));
        d.style.left = `${st.left}px`;
        d.style.top = `${st.top}px`;
      };
      const up = () => removeEventListener("pointermove", move);
      addEventListener("pointermove", move);
      addEventListener("pointerup", up, { once: true });
    });

    const body = document.createElement("div");
    body.className = "drawer-body";
    const list = document.createElement("div");
    list.className = "list";
    const rail = document.createElement("nav");
    rail.className = "turn-rail";
    rail.setAttribute("aria-label", "Turns");
    bindTurnRailScroll(list, rail);
    body.append(list, rail);
    const foot = document.createElement("footer");
    foot.className = "follow";
    foot.innerHTML = `<textarea rows="1" placeholder="Follow up…"></textarea><button class="mic" type="button" title="Voice input">🎙</button><button class="ask" type="button">Ask →</button>`;
    const ta = foot.querySelector("textarea");
    const mic = foot.querySelector(".mic");
    const askBtn = foot.querySelector(".ask");
    attachMic(mic, ta);
    askBtn.addEventListener("click", () => sendFollowUp(d));
    ta.addEventListener("keydown", (e) => {
      if (e.isComposing || e.keyCode === 229) return;
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        sendFollowUp(d);
      } else if (e.key === "Escape") {
        e.preventDefault();
        toggleDrawer(d._group.key);
      }
    });

    const resizer = document.createElement("div");
    resizer.className = "resizer";
    resizer.title = "Drag to resize";
    resizer.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      const st = drawerState(d._group.key);
      const rect = d.getBoundingClientRect();
      const start = { x: e.clientX, y: e.clientY, w: rect.width, h: rect.height };
      const move = (ev) => {
        const w = Math.min(Math.max(300, start.w + ev.clientX - start.x), Math.max(300, innerWidth - 24));
        const h = Math.min(Math.max(160, start.h + ev.clientY - start.y), Math.max(160, innerHeight - 24));
        st.width = w;
        st.height = h;
        d.style.width = `${w}px`;
        d.style.height = `${h}px`;
        d.style.maxHeight = "none";
      };
      const up = () => removeEventListener("pointermove", move);
      addEventListener("pointermove", move);
      addEventListener("pointerup", up, { once: true });
    });

    d.append(head, body, foot, resizer);
    syncDrawer(d, g);
    return d;
  }

  // ── turn directory rail (shared by Wire panel and Drawers) ──
  function syncActiveTurn(scrollEl, railEl) {
    if (!scrollEl || !railEl || railEl.hidden) return;
    const cards = [...scrollEl.querySelectorAll("article.th[data-thread]")];
    if (!cards.length) return;
    const box = scrollEl.getBoundingClientRect();
    let activeId = cards[0].dataset.thread;
    if (scrollEl.scrollHeight - scrollEl.scrollTop - scrollEl.clientHeight < 12) {
      activeId = cards[cards.length - 1].dataset.thread;
    } else {
      for (const c of cards) {
        if (c.getBoundingClientRect().bottom > box.top + 24) {
          activeId = c.dataset.thread;
          break;
        }
      }
    }
    for (const item of railEl.querySelectorAll(".turn-item")) {
      const on = item.dataset.threadId === activeId;
      item.classList.toggle("on", on);
      if (on) item.scrollIntoView({ block: "nearest" });
    }
  }

  function bindTurnRailScroll(scrollEl, railEl) {
    let ticking = false;
    scrollEl.addEventListener(
      "scroll",
      () => {
        if (ticking) return;
        ticking = true;
        requestAnimationFrame(() => {
          ticking = false;
          syncActiveTurn(scrollEl, railEl);
        });
      },
      { passive: true },
    );
  }

  function renderTurnRail(railEl, scrollEl, list) {
    if (!railEl) return;
    if (!list.length) {
      railEl.replaceChildren();
      return;
    }
    const head = document.createElement("div");
    head.className = "rail-head";
    head.textContent = `TURNS · ${list.length}`;
    const ol = document.createElement("ol");
    for (const t of list) {
      const li = document.createElement("li");
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "turn-item";
      btn.dataset.threadId = t.id;
      const meta = document.createElement("span");
      meta.className = "t-meta";
      const num = document.createElement("span");
      num.textContent = t.seq ? `#${t.seq}` : "•";
      meta.appendChild(num);
      if (t.replyToSeq) {
        const rep = document.createElement("span");
        rep.className = "t-rep";
        rep.textContent = `↳#${t.replyToSeq}`;
        meta.appendChild(rep);
      }
      const dot = document.createElement("span");
      dot.className = "t-dot";
      dot.dataset.status = t.status;
      meta.appendChild(dot);
      const q = document.createElement("span");
      q.className = "t-q";
      q.textContent = norm(t.question) || (t.refs?.length ? "(references)" : "(empty)");
      btn.title = `${t.seq ? `#${t.seq} ` : ""}${q.textContent}`;
      btn.append(meta, q);
      btn.addEventListener("click", () => {
        const target = scrollEl.querySelector(`article.th[data-thread="${t.id}"]`);
        if (!target) return;
        target.scrollIntoView({ block: "start", behavior: "smooth" });
        target.classList.remove("pv-jump");
        void target.offsetWidth;
        target.classList.add("pv-jump");
        for (const item of railEl.querySelectorAll(".turn-item")) item.classList.toggle("on", item === btn);
      });
      li.appendChild(btn);
      ol.appendChild(li);
    }
    railEl.replaceChildren(head, ol);
    requestAnimationFrame(() => syncActiveTurn(scrollEl, railEl));
  }

  function toggleDrawer(key) {
    if (openDrawers.has(key)) openDrawers.delete(key);
    else openDrawers.add(key);
    renderMarkers();
    schedule();
  }

  // ── thread rendering, shared by drawers and the Wire tab ──
  const STATUS = { running: "Answering", done: "Done", aborted: "Stopped" };
  const PHASE_LABEL = { waiting: "Waiting", thinking: "Thinking", toolcall: "Calling tool", tool: "Running tool", answering: "Answering" };
  const STEP_ICON = { running: "⚙", done: "✓", error: "✕" };
  const time = (at) => new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

  function fallbackAnchorForDoc() {
    if (cfg.kind === "md") return { kind: "md", text: "", lines: [1, 1], headings: [] };
    if (cfg.kind === "pdf" || cfg.kind === "office") return { kind: "pdf", text: "", page: 1, context: "" };
    return { kind: "html", text: "", selector: "body", hint: { classes: [] } };
  }

  function starTargetOf(t) {
    const docRef = t.refs?.find((r) => r.docId === cfg.doc);
    const anchor = docRef ? docRef.anchor : fallbackAnchorForDoc();
    return { anchor, anchorKey: keyOf(anchor), label: docRef?.label || cfg.file };
  }

  function applyStarMarks(aEl, t) {
    const excerpts = stars.filter((s) => s.threadSeq === t.seq && s.scope === "excerpt" && s.excerpt);
    const sig = excerpts.map((s) => s.id).join(",");
    if (aEl.dataset.starSig === sig && aEl.dataset.html === (t.html || "")) return;
    if (aEl.dataset.html !== (t.html || "")) {
      aEl.innerHTML = t.html || "";
      aEl.dataset.html = t.html || "";
    } else if (aEl.dataset.starSig) {
      aEl.innerHTML = t.html || "";
    }
    aEl.dataset.starSig = sig;
    for (const s of excerpts) {
      const range = findText(aEl, s.excerpt);
      if (!range) continue;
      // Wrap matched text node slices safely without disturbing element nesting.
      const walker = document.createTreeWalker(range.commonAncestorContainer.nodeType === 1 ? range.commonAncestorContainer : range.commonAncestorContainer.parentElement, NodeFilter.SHOW_TEXT, {
        acceptNode: (n) => (n.parentElement?.closest(SKIP_TEXT) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
      });
      const slices = [];
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        if (!range.intersectsNode(n)) continue;
        const start = n === range.startContainer ? range.startOffset : 0;
        const end = n === range.endContainer ? range.endOffset : n.nodeValue.length;
        if (end > start && n.nodeValue.slice(start, end).trim()) slices.push({ node: n, start, end });
      }
      for (const { node, start, end } of slices) {
        const sub = document.createRange();
        sub.setStart(node, start);
        sub.setEnd(node, end);
        const mark = document.createElement("mark");
        mark.className = "pv-star-mark";
        mark.dataset.starId = s.id;
        try {
          sub.surroundContents(mark);
        } catch {
          // Skip split edges that cross inline bounds.
        }
      }
    }
  }

  function threadEl(t, withRefs) {
    const el = document.createElement("article");
    el.className = "th";
    el.dataset.thread = t.id;
    el.dataset.seq = String(t.seq || "");
    el._thread = t;
    el.innerHTML = `<header><span class="num"></span><span class="st"></span><span class="reply-ref" hidden></span><button class="star-btn" type="button" title="Star this reply (★)">☆</button><time></time></header><ul class="refs"></ul><p class="q"></p><div class="a md"></div><div class="progress" hidden><ul class="steps" hidden></ul><div class="act" hidden></div><pre class="think-live" hidden></pre></div>`;
    el.querySelector(".star-btn").addEventListener("click", () => {
      const cur = el._thread;
      if (!cur || exportMode) return;
      const { anchor, anchorKey, label } = starTargetOf(cur);
      const plain = norm(el.querySelector(".a")?.textContent || "");
      api("/stars", {
        method: "POST",
        body: JSON.stringify({
          docId: cfg.doc,
          anchorKey,
          anchor,
          label,
          threadSeq: cur.seq,
          question: cur.question,
          scope: "turn",
          excerpt: plain.slice(0, 360),
          html: cur.html || "",
          toggle: true,
        }),
      })
        .then((r) => toast(r.starred ? "★ Starred reply" : "☆ Removed star"))
        .catch((e) => toast(String(e.message || e), true));
    });
    if (withRefs) {
      const ul = el.querySelector(".refs");
      for (const r of t.refs) {
        const li = document.createElement("li");
        const b = document.createElement("button");
        b.textContent = `⌖ ${r.label}`;
        b.title = r.docId === cfg.doc ? "Show in this document" : "Open the document";
        b.addEventListener("click", () => reveal(r));
        li.appendChild(b);
        ul.appendChild(li);
      }
    }
    fillThread(el, t);
    return el;
  }

  function fillThread(el, t) {
    el._thread = t;
    el.dataset.seq = String(t.seq || "");
    el.dataset.status = t.status;
    if (t.status === "running" && t.phase) el.dataset.phase = t.phase;
    else delete el.dataset.phase;

    const num = el.querySelector(".num");
    if (num) num.textContent = t.seq ? `#${t.seq}` : "";
    el.querySelector(".st").textContent = t.status === "running" ? PHASE_LABEL[t.phase] || "Working" : STATUS[t.status] || t.status;
    const ref = el.querySelector(".reply-ref");
    if (ref) {
      ref.textContent = t.replyToSeq ? `↳ #${t.replyToSeq}` : "";
      ref.hidden = !t.replyToSeq;
    }
    const starBtn = el.querySelector(".star-btn");
    if (starBtn) {
      const isStarred = stars.some((s) => s.docId === cfg.doc && s.threadSeq === t.seq && s.scope === "turn");
      starBtn.classList.toggle("on", isStarred);
      starBtn.textContent = isStarred ? "★" : "☆";
      starBtn.hidden = t.status === "running" || !t.seq;
    }
    el.querySelector("time").textContent = time(t.at);
    const q = el.querySelector(".q");
    q.textContent = t.question || (t.refs.length ? "(references only)" : "");
    q.hidden = !q.textContent;
    const a = el.querySelector(".a");
    applyStarMarks(a, t);
    a.classList.toggle("empty", !t.html);

    const progress = el.querySelector(".progress");
    const stepsEl = el.querySelector(".steps");
    const act = el.querySelector(".act");
    const thinkEl = el.querySelector(".think-live");
    const running = t.status === "running";

    const steps = running ? t.steps || [] : [];
    stepsEl.hidden = !steps.length;
    if (steps.length) {
      stepsEl.replaceChildren(
        ...steps.map((s) => {
          const li = document.createElement("li");
          li.dataset.state = s.state;
          li.textContent = `${STEP_ICON[s.state] || "·"} ${s.label}`;
          return li;
        }),
      );
    } else {
      stepsEl.replaceChildren();
    }

    const phase = t.phase || "waiting";
    const hasRunningStep = steps.some((s) => s.state === "running");
    let actText = "";
    if (running) {
      if (phase === "toolcall") actText = `⚒ ${t.activity || "Preparing tool call…"}`;
      else if (phase === "tool" && !hasRunningStep) actText = `⚙ ${t.activity || "Running tool…"}`;
      else if (phase === "thinking") actText = "◈ Thinking…";
      else if (phase === "waiting") actText = "◌ Waiting for model…";
    }
    act.textContent = actText;
    act.hidden = !actText;

    const showThink = running && phase === "thinking" && !!t.thinking;
    thinkEl.hidden = !showThink;
    if (showThink) {
      thinkEl.textContent = t.thinking;
      thinkEl.scrollTop = thinkEl.scrollHeight;
    } else {
      thinkEl.textContent = "";
    }

    progress.hidden = stepsEl.hidden && act.hidden && thinkEl.hidden;
  }

  function pendingEl(p) {
    const el = document.createElement("article");
    el.className = "th";
    el.dataset.status = "pending";
    el.innerHTML = `<header><span class="st">Queued</span><time></time></header><p class="q"></p><div class="act">Waiting for pi…</div>`;
    el.querySelector("time").textContent = time(p.at);
    el.querySelector(".q").textContent = p.question;
    return el;
  }

  // ── panel ──
  let panelTab = "wire";
  let wireFilter = localStorage.getItem("pv-wire-filter") || "all";
  let wireRailOpen = localStorage.getItem("pv-wire-rail") !== "0";
  bindTurnRailScroll($(".wire-scroll"), $(".wire-wrap .turn-rail"));

  function openPanel(tabName = panelTab, focusPin = null) {
    panelTab = tabName;
    panel.hidden = false;
    $(".d-wire").classList.remove("unread");
    renderPanel();
    if (tabName === "wire") {
      const s = $(".wire-scroll");
      s.scrollTop = s.scrollHeight;
      syncActiveTurn(s, $(".wire-wrap .turn-rail"));
    }
    if (focusPin) {
      const card = root.querySelector(`.pin[data-pin="${focusPin}"]`);
      card?.scrollIntoView({ block: "nearest" });
      card?.querySelector("textarea")?.focus();
    }
  }
  function closePanel() {
    cancelActiveMic(panel);
    panel.hidden = true;
  }

  function renderPanel() {
    $(".count").textContent = pins.length ? String(pins.length) : "";
    const docStarCount = stars.filter((s) => s.docId === cfg.doc).length;
    const sc = $(".star-count");
    if (sc) sc.textContent = docStarCount ? String(docStarCount) : "";
    for (const b of root.querySelectorAll(".tabs button")) b.classList.toggle("on", b.dataset.tab === panelTab);
    for (const el of root.querySelectorAll(".panel [data-of]")) el.hidden = el.dataset.of !== panelTab;
    for (const b of root.querySelectorAll("[data-filter]")) b.classList.toggle("on", b.dataset.filter === wireFilter);
    $(".filters[data-of=\"wire\"] .rail-toggle")?.classList.toggle("on", wireRailOpen);
    const attach = $(".attach");
    attach.hidden = !pins.length;
    attach.textContent = `◆ ${pins.length} pin${pins.length > 1 ? "s" : ""} will be attached`;
    $(".send").textContent = pins.length && panelTab === "pins" ? "Send pins →" : "Send →";
    if (panel.hidden) return;
    if (panelTab === "wire") renderWire();
    else renderPins();
  }

  function wireVisible(t) {
    if (wireFilter === "doc") return t.refs.some((r) => r.docId === cfg.doc);
    if (wireFilter === "refs") return t.refs.length > 0;
    return true;
  }

  function starCard(s) {
    const card = document.createElement("article");
    card.className = "star-card";
    card.innerHTML = `<header><span class="s-badge">★ #${s.threadSeq}</span><button class="loc" type="button"></button><button class="del" type="button" title="Remove star">✕</button></header><p class="q"></p><div class="excerpt md"></div>`;
    const locBtn = card.querySelector(".loc");
    locBtn.textContent = s.label || cfg.file;
    locBtn.addEventListener("click", () => reveal({ docId: s.docId, anchor: s.anchor }));
    const q = card.querySelector(".q");
    q.textContent = s.question || "";
    q.hidden = !s.question;
    const ex = card.querySelector(".excerpt");
    if (s.html) ex.innerHTML = s.html;
    else ex.textContent = s.excerpt;
    card.querySelector(".del").addEventListener("click", () => api(`/stars/${s.id}`, { method: "DELETE" }).catch((e) => toast(e.message, true)));
    return card;
  }

  function renderWire() {
    const scroll = $(".wire-scroll");
    const rail = $(".wire-wrap .turn-rail");
    if (wireFilter === "starred") {
      const docStars = stars.filter((s) => s.docId === cfg.doc);
      scroll.replaceChildren(...docStars.map(starCard));
      if (!docStars.length) {
        const empty = document.createElement("p");
        empty.className = "empty";
        empty.textContent = "No starred replies yet. Click ☆ on a reply or select text inside an answer to bookmark.";
        scroll.appendChild(empty);
      }
      rail.hidden = true;
      return;
    }
    const atBottom = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 40;
    const list = threads.filter(wireVisible);
    scroll.replaceChildren(...list.map((t) => threadEl(t, true)));
    if (!list.length) {
      const empty = document.createElement("p");
      empty.className = "empty";
      empty.textContent = threads.length ? "Nothing under this filter." : "No messages in this session yet.";
      scroll.appendChild(empty);
    }
    if (atBottom) scroll.scrollTop = scroll.scrollHeight;
    rail.hidden = !wireRailOpen || !list.length;
    renderTurnRail(rail, scroll, list);
  }

  function renderPins() {
    const scroll = $('.scroll[data-of="pins"]');
    const existing = new Map([...scroll.querySelectorAll(".pin")].map((el) => [el.dataset.pin, el]));
    const cards = pins.map((p, i) => {
      const card = existing.get(p.id) || pinCard(p);
      card.querySelector(".n").textContent = `◆ ${String(i + 1).padStart(2, "0")}`;
      const note = card.querySelector("textarea");
      if (root.activeElement !== note) note.value = p.note;
      return card;
    });
    scroll.replaceChildren(...cards);
    if (!pins.length) {
      const empty = document.createElement("p");
      empty.className = "empty";
      empty.textContent = "No pins. Select text and press Pin to collect references for one message.";
      scroll.appendChild(empty);
    }
  }

  function pinCard(p) {
    const card = document.createElement("article");
    card.className = "pin";
    card.dataset.pin = p.id;
    card.innerHTML = `<header><span class="n"></span><button class="loc"></button><button class="del" title="Remove pin">✕</button></header><blockquote></blockquote><textarea rows="2" placeholder="Instruction for this reference (optional)"></textarea><span class="saved"></span>`;
    card.querySelector(".loc").textContent = p.label;
    card.querySelector(".loc").addEventListener("click", () => reveal(p));
    const quote = card.querySelector("blockquote");
    quote.textContent = p.anchor.region
      ? "▭ region of the page"
      : p.anchor.items?.length > 1
        ? `${p.anchor.items.length} elements · ${p.anchor.items.map((i) => i.tag || i.selector).join(", ")}`.slice(0, 280)
        : norm(p.anchor.text).slice(0, 280) || p.anchor.selector || "";
    card.querySelector(".del").addEventListener("click", () => api(`/pins/${p.id}`, { method: "DELETE" }).catch((e) => toast(e.message, true)));
    const note = card.querySelector("textarea");
    const saved = card.querySelector(".saved");
    let timer;
    note.addEventListener("input", () => {
      clearTimeout(timer);
      saved.textContent = "…";
      timer = setTimeout(() => {
        api(`/pins/${p.id}`, { method: "PATCH", body: JSON.stringify({ note: note.value }) })
          .then(() => (saved.textContent = "saved"))
          .catch((e) => toast(e.message, true));
      }, 450);
    });
    return card;
  }

  /** Scroll to a reference here, or open its document in a new tab. */
  function reveal(ref) {
    if (ref.docId !== cfg.doc) {
      const a = ref.anchor;
      const hash = a.lines ? `#L${a.lines[0]}` : a.page ? `#page=${a.page}` : "";
      window.open(`${cfg.base}/v/${ref.docId}${hash}`, "_blank");
      return;
    }
    const loc = locOf(ref.anchor);
    if (!loc) return toast("Could not find this spot on the page", true);
    if (adapter?.reveal) adapter.reveal(ref.anchor, loc);
    else (loc.range?.startContainer.parentElement || loc.el).scrollIntoView({ block: "center", behavior: "smooth" });
    if (!ref.id) {
      openDrawers.add(keyOf(ref.anchor));
      renderMarkers();
    }
    schedule();
  }

  root.querySelectorAll(".tabs button").forEach((b) => b.addEventListener("click", () => openPanel(b.dataset.tab)));
  root.querySelectorAll("[data-filter]").forEach((b) =>
    b.addEventListener("click", () => {
      wireFilter = b.dataset.filter;
      localStorage.setItem("pv-wire-filter", wireFilter);
      renderPanel();
    }),
  );
  $('.filters[data-of="wire"] .rail-toggle').addEventListener("click", () => {
    wireRailOpen = !wireRailOpen;
    localStorage.setItem("pv-wire-rail", wireRailOpen ? "1" : "0");
    renderPanel();
  });
  $(".panel .x").addEventListener("click", closePanel);
  $(".panel .clear").addEventListener("click", () => api("/pins", { method: "DELETE" }).catch((e) => toast(e.message, true)));
  $(".d-wire").addEventListener("click", () => (panel.hidden ? openPanel("wire") : closePanel()));
  $(".d-pins").addEventListener("click", () => openPanel("pins"));

  async function sendComposer() {
    const question = composer.value.trim();
    if (!question && !pins.length) return shake(panel);
    try {
      const r = await api("/say", { method: "POST", body: JSON.stringify({ question }) });
      composer.value = "";
      toast(r.delivered === "now" ? "→ Sent to pi" : "→ Queued — pi is busy");
      openPanel("wire");
    } catch (e) {
      toast(e.message, true);
    }
  }
  attachMic($(".composer .mic"), composer);
  $(".send").addEventListener("click", sendComposer);
  composer.addEventListener("keydown", (e) => {
    if (e.isComposing || e.keyCode === 229) return;
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendComposer();
    }
  });

  // ── status & wire ──
  function setStatus(s) {
    status = { ...status, ...s };
    dock.classList.toggle("offline", !status.online);
    dock.classList.toggle("busy", status.online && status.busy);
    $(".state b").textContent = !status.online ? "offline" : status.busy ? "pi · busy" : "pi · idle";
    $(".session").textContent = status.session || "";
    $(".session").hidden = !status.session;
  }

  function setPins(list) {
    pins = list;
    const b = $(".d-pins");
    b.hidden = !pins.length;
    b.textContent = `◆ ${pins.length}`;
    render();
  }

  function upsertThread(t) {
    const i = threads.findIndex((x) => x.id === t.id);
    const prev = threads[i];
    if (prev) {
      threads[i] = t;
      // A status change alters the marker chips; streaming text only patches the open views.
      if (prev.status !== t.status) render();
      else {
        const wire = $(".wire-scroll");
        const follow = wire.scrollHeight - wire.scrollTop - wire.clientHeight < 40;
        const drawerFollows = new Map();
        for (const el of root.querySelectorAll(`[data-thread="${t.id}"]`)) {
          const dList = el.closest(".drawer .list");
          if (dList && !drawerFollows.has(dList)) {
            drawerFollows.set(dList, dList.scrollHeight - dList.scrollTop - dList.clientHeight < 40);
          }
          fillThread(el, t);
        }
        if (follow) wire.scrollTop = wire.scrollHeight;
        for (const [dList, stick] of drawerFollows) {
          if (stick) dList.scrollTop = dList.scrollHeight;
        }
        const wireDot = root.querySelector(`.wire-wrap .turn-item[data-thread-id="${t.id}"] .t-dot`);
        if (wireDot) wireDot.dataset.status = t.status;
        for (const dot of root.querySelectorAll(`.drawer .turn-item[data-thread-id="${t.id}"] .t-dot`)) dot.dataset.status = t.status;
        schedule();
      }
    } else {
      threads.push(t);
      render();
    }
    const shown = !panel.hidden || t.refs.some((r) => r.docId === cfg.doc && openDrawers.has(keyOf(r.anchor)));
    if (!shown) $(".d-wire").classList.add("unread");
  }

  function setStars(list) {
    stars = Array.isArray(list) ? list : [];
    render();
  }

  // ── reply-text selection → ★ 收藏此段 ──
  const starPop = $(".star-pop");

  function hideStarPop() {
    starPop.hidden = true;
    pendingStarSel = null;
  }

  function getShadowSelectionRange() {
    const rs = typeof root.getSelection === "function" ? root.getSelection() : null;
    if (rs && rs.rangeCount && !rs.isCollapsed) return rs.getRangeAt(0);
    const ds = document.getSelection();
    if (!ds) return null;
    if (typeof ds.getComposedRanges === "function") {
      try {
        const cr = ds.getComposedRanges({ shadowRoots: [root] })[0];
        if (cr && !cr.collapsed && root.contains(cr.startContainer)) {
          const r = document.createRange();
          r.setStart(cr.startContainer, cr.startOffset);
          r.setEnd(cr.endContainer, cr.endOffset);
          return r;
        }
      } catch {
        // Ignore if unsupported.
      }
    }
    if (ds.rangeCount && !ds.isCollapsed && root.contains(ds.anchorNode)) return ds.getRangeAt(0);
    return null;
  }

  function checkReplySelection() {
    if (exportMode) return hideStarPop();
    const range = getShadowSelectionRange();
    if (!range) return hideStarPop();
    const node = range.commonAncestorContainer.nodeType === 1 ? range.commonAncestorContainer : range.commonAncestorContainer.parentElement;
    const aEl = node?.closest?.("article.th .a");
    if (!aEl || !root.contains(aEl)) return hideStarPop();
    const thEl = aEl.closest("article.th");
    const t = thEl?._thread;
    const text = norm(rangeText(range));
    if (!t || !t.seq || !text) return hideStarPop();
    const rects = range.getClientRects();
    const r = rects[rects.length - 1] || range.getBoundingClientRect();
    pendingStarSel = { range: range.cloneRange(), thread: t, text };
    starPop.hidden = false;
    const w = starPop.offsetWidth || 110;
    starPop.style.left = `${Math.min(Math.max(8, r.right - 16), innerWidth - w - 12)}px`;
    starPop.style.top = `${Math.min(r.bottom + 8, innerHeight - 44)}px`;
  }

  root.addEventListener("mouseup", () => setTimeout(checkReplySelection, 0));
  root.addEventListener("keyup", (e) => {
    if (e.shiftKey || e.key === "Shift") setTimeout(checkReplySelection, 0);
  });
  root.addEventListener("mousedown", (e) => {
    if (!e.target?.closest?.(".star-pop")) hideStarPop();
  });

  starPop.querySelector("button").addEventListener("click", () => {
    if (!pendingStarSel) return;
    const { range, thread, text } = pendingStarSel;
    const box = document.createElement("div");
    box.appendChild(range.cloneContents());
    const { anchor, anchorKey, label } = starTargetOf(thread);
    hideStarPop();
    (typeof root.getSelection === "function" ? root.getSelection() : document.getSelection())?.removeAllRanges?.();
    api("/stars", {
      method: "POST",
      body: JSON.stringify({
        docId: cfg.doc,
        anchorKey,
        anchor,
        label,
        threadSeq: thread.seq,
        question: thread.question,
        scope: "excerpt",
        excerpt: text.slice(0, 1200),
        html: box.innerHTML.slice(0, 16000),
      }),
    })
      .then(() => toast("★ Starred excerpt"))
      .catch((e) => toast(String(e.message || e), true));
  });

  // ── single-file HTML export ──
  const exportBtn = $(".d-export");
  const exportPop = $(".export-pop");

  function triggerDownload(filename, html) {
    const blob = new Blob([html], { type: "text/html;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }

  async function runExport(body = null) {
    if (exportBtn.classList.contains("busy")) return;
    exportBtn.classList.add("busy");
    exportPop.hidden = true;
    try {
      const res = body
        ? await api(`/export/${cfg.doc}`, { method: "POST", body: JSON.stringify(body) })
        : await api(`/export/${cfg.doc}`);
      if (!res || typeof res.html !== "string" || !res.html.length) {
        throw new Error("Export returned empty HTML payload");
      }
      triggerDownload(res.filename || `${cfg.file || "document"}.annotated.html`, res.html);
      toast(`⤓ Exported ${res.filename || "HTML"}`);
    } catch (e) {
      toast(String(e.message || e), true);
    } finally {
      exportBtn.classList.remove("busy");
    }
  }

  exportBtn.addEventListener("click", async () => {
    if (exportMode || exportBtn.classList.contains("busy")) return;
    if (!adapter?.prepareExport) return void runExport();
    const annotatedPages = new Set();
    for (const g of groups) {
      if (g.anchor?.page) annotatedPages.add(g.anchor.page);
    }
    const info = adapter.exportInfo?.(annotatedPages);
    if (info && info.total > 12 && info.annotated.length > 0 && info.annotated.length < info.total) {
      exportPop.hidden = false;
      const allBtn = exportPop.querySelector(".ep-all");
      const annBtn = exportPop.querySelector(".ep-ann");
      allBtn.textContent = `All ${info.total} pages`;
      annBtn.textContent = `Annotated (${info.annotated.length})`;
      allBtn.onclick = async () => {
        exportPop.hidden = true;
        toast(`Rendering ${info.total} pages…`);
        const pages = await adapter.prepareExport(null);
        await runExport({ pages });
      };
      annBtn.onclick = async () => {
        exportPop.hidden = true;
        toast(`Rendering ${info.annotated.length} pages…`);
        const pages = await adapter.prepareExport(info.annotated);
        await runExport({ pages });
      };
      exportPop.querySelector(".ep-cancel").onclick = () => (exportPop.hidden = true);
      return;
    }
    if (info?.total) toast(`Rendering ${info.total} page${info.total > 1 ? "s" : ""}…`);
    const pages = await adapter.prepareExport(null);
    await runExport({ pages });
  });

  function connect() {
    if (exportMode) {
      dock.classList.remove("offline");
      $(".state b").textContent = "exported";
      $(".session").textContent = cfg.file;
      $(".session").hidden = !cfg.file;
      threads = snapshot?.threads || [];
      stars = snapshot?.stars || [];
      pins = [];
      render();
      return;
    }
    es?.close();
    es = new EventSource(`${cfg.base}/events?doc=${encodeURIComponent(cfg.doc)}`);
    const on = (name, fn) => es.addEventListener(name, (e) => fn(e.data ? JSON.parse(e.data) : {}));
    on("hello", (s) => {
      pending.clear();
      setStatus({ ...s, online: true });
      threads = s.threads || [];
      stars = s.stars || [];
      setPins(s.pins || []);
    });
    on("status", (s) => setStatus({ ...s, online: true }));
    on("pins", setPins);
    on("stars", setStars);
    on("threads", (list) => {
      pending.clear();
      threads = list;
      render();
    });
    on("thread", upsertThread);
    on("change", () => (adapter?.reload ? adapter.reload() : softReload()));
    on("converting", () => adapter?.converting?.());
    on("goto", (t) => adapter?.goto?.(t));
    // The server is shutting down on purpose (/view-stop or pi quit): stop reconnecting.
    on("bye", () => {
      ended = true;
      es.close();
      setStatus({ online: false });
      $(".state b").textContent = "closed";
      toast("pi-webview stopped. Run /view in pi to reopen.", true);
    });
    es.onerror = () => {
      if (ended) return;
      setStatus({ online: false });
      // A 404 (pi restarted, doc unknown) closes the stream for good; keep knocking.
      if (es.readyState === EventSource.CLOSED) setTimeout(connect, 4000);
    };
  }

  function softReload() {
    sessionStorage.setItem(scrollKey, String(scrollY));
    location.reload();
  }
  const savedScroll = sessionStorage.getItem(scrollKey);
  if (savedScroll !== null && cfg.kind === "html") {
    sessionStorage.removeItem(scrollKey);
    addEventListener("load", () => scrollTo(0, Number(savedScroll)));
  }

  // ── layout: everything anchored to the page is re-placed on scroll and resize ──
  let frame = 0;
  function schedule() {
    if (!frame) frame = requestAnimationFrame(layout);
  }
  function layout() {
    frame = 0;
    const clip = clipRect();
    const visible = (r) => r && r.bottom > clip.top && r.top < clip.bottom && r.right > clip.left && r.left < clip.right && (r.width || r.height);
    const geoms = new Map();
    const geomOf = (key) => {
      if (!geoms.has(key)) {
        const g = groups.find((x) => x.key === key);
        const loc = g && locOf(g.anchor);
        geoms.set(key, loc ? geom(loc) : null);
      }
      return geoms.get(key);
    };
    // Pages with a margin (md) line markers up in it; others put them right after the text.
    const gutter = adapter?.gutter?.();
    const usedTops = [];
    for (const m of root.querySelectorAll(".marker")) {
      const g = geomOf(m.dataset.key);
      m.hidden = !visible(g?.body);
      if (m.hidden) continue;
      if (gutter !== undefined && gutter + m.offsetWidth < innerWidth) {
        let top = g.body.top;
        // Keep markers of neighbouring anchors from overlapping.
        while (usedTops.some((t) => Math.abs(t - top) < 22)) top += 22;
        usedTops.push(top);
        m.style.left = `${gutter}px`;
        m.style.top = `${top}px`;
      } else {
        m.style.left = `${Math.min(g.tail.right + 4, clip.right - m.offsetWidth - 8)}px`;
        m.style.top = `${Math.max(clip.top, g.tail.top - 10)}px`;
      }
    }
    const subCache = new Map();
    for (const b of root.querySelectorAll(".box")) {
      const subIdx = b.dataset.sub;
      if (subIdx !== undefined) {
        if (!subCache.has(b.dataset.key)) {
          const gr = groups.find((x) => x.key === b.dataset.key);
          const loc = gr && locOf(gr.anchor);
          subCache.set(b.dataset.key, loc?.subRects ? loc.subRects() : loc?.rects || []);
        }
        const sr = subCache.get(b.dataset.key)[Number(subIdx)];
        b.hidden = !visible(sr);
        if (b.hidden) continue;
        Object.assign(b.style, { left: `${sr.left}px`, top: `${sr.top}px`, width: `${sr.width}px`, height: `${sr.height}px` });
        continue;
      }
      const g = geomOf(b.dataset.key);
      const r = g?.full || g?.body;
      b.hidden = !visible(r);
      if (b.hidden) continue;
      Object.assign(b.style, { left: `${r.left - 3}px`, top: `${r.top - 3}px`, width: `${r.width + 6}px`, height: `${r.height + 6}px` });
    }
    for (const d of root.querySelectorAll(".drawer")) {
      const st = drawerState(d.dataset.key);
      if (st.mode === "fixed") {
        d.hidden = false;
        if (st.width) d.style.width = `${Math.min(st.width, Math.max(300, innerWidth - 24))}px`;
        if (st.height) {
          d.style.height = `${Math.min(st.height, Math.max(160, innerHeight - 24))}px`;
          d.style.maxHeight = "none";
        }
        st.left = Math.min(Math.max(0, st.left), Math.max(0, innerWidth - 80));
        st.top = Math.min(Math.max(0, st.top), Math.max(0, innerHeight - 40));
        d.style.left = `${st.left}px`;
        d.style.top = `${st.top}px`;
        continue;
      }
      const g = geomOf(d.dataset.key);
      d.hidden = !g?.body;
      if (d.hidden) continue;
      const frame = adapter?.drawerFrame?.();
      if (st.width) d.style.width = `${Math.min(st.width, Math.max(300, innerWidth - 24))}px`;
      else if (frame) d.style.width = `${frame.width}px`;
      else d.style.width = "";
      if (st.height) {
        d.style.height = `${Math.min(st.height, Math.max(160, innerHeight - 24))}px`;
        d.style.maxHeight = "none";
      }
      const w = d.offsetWidth;
      const top = g.body.bottom + 10;
      // The drawer hangs below its anchor; hide it only once the drawer itself leaves the view.
      d.hidden = top > clip.bottom || top + d.offsetHeight < clip.top;
      const left = frame ? frame.left : g.body.left;
      d.style.left = `${Math.min(Math.max(16, left), innerWidth - w - 24)}px`;
      d.style.top = `${top}px`;
    }
    if (current && !slip.hidden) {
      if (slipMode === "follow") placeSlip();
      if (current.showBox) syncActiveSlipBox(visible);
    }
  }
  addEventListener("resize", schedule);
  document.addEventListener(
    "scroll",
    () => {
      hideTab();
      schedule();
    },
    { capture: true, passive: true },
  );

  // ── selection → tab ──
  const fromUs = (e) => e.composedPath().includes(host);

  function hideTab() {
    tab.hidden = true;
    pendingSel = null;
  }

  function checkSelection() {
    if (exportMode || !slip.hidden) return;
    const sel = document.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount || !sel.toString().trim()) return hideTab();
    const range = sel.getRangeAt(0);
    const anchor = adapter?.fromSelection?.(sel, range);
    if (!anchor) return hideTab();
    const rects = range.getClientRects();
    const r = rects[rects.length - 1] || range.getBoundingClientRect();
    pendingSel = { anchor, range: range.cloneRange() };
    tab.hidden = false;
    const w = tab.offsetWidth || 150;
    tab.style.left = `${Math.min(Math.max(8, r.right - 12), innerWidth - w - 12)}px`;
    tab.style.top = `${Math.min(r.bottom + 10, innerHeight - 48)}px`;
  }

  document.addEventListener("mouseup", (e) => {
    if (fromUs(e)) return;
    setTimeout(checkSelection, 0);
  });
  document.addEventListener("keyup", (e) => {
    if (e.shiftKey || e.key === "Shift") checkSelection();
  });
  document.addEventListener("selectionchange", () => {
    if (!tab.hidden && document.getSelection()?.isCollapsed) hideTab();
  });
  document.addEventListener("mousedown", (e) => {
    if (fromUs(e)) return;
    if (!slip.hidden && !slipText.value.trim()) closeSlip();
  });
  document.addEventListener("keydown", (e) => {
    if (fromUs(e)) return;
    const editable = e.target instanceof HTMLElement && (e.target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName));
    if (e.key === "Enter" && !tab.hidden && pendingSel && !editable) {
      e.preventDefault();
      fromSelection(false);
    } else if (e.key === "Escape") {
      hideTab();
      closeSlip();
    }
  });

  function fromSelection(pinNow) {
    if (!pendingSel) return;
    const { anchor, range } = pendingSel;
    hideTab();
    if (pinNow) {
      closeSlip();
      slipText.value = "";
      current = { anchor, range };
      return void send("pin");
    }
    openSlip(anchor, { range });
  }
  $(".t-ask").addEventListener("click", () => fromSelection(false));
  $(".t-pin").addEventListener("click", () => fromSelection(true));

  // ── slip ──
  let serial = Number(sessionStorage.getItem("pv-serial") || 0);
  let slipMode = localStorage.getItem("pv-slip-mode") === "fixed" ? "fixed" : "follow";
  let slipBelow = true;

  function renderSlipMode() {
    const b = $(".slip .mode");
    b.textContent = slipMode === "follow" ? "⚓ Follow" : "▣ Fixed";
    slip.classList.toggle("fixed", slipMode === "fixed");
  }
  renderSlipMode();
  $(".slip .mode").addEventListener("click", () => {
    slipMode = slipMode === "follow" ? "fixed" : "follow";
    localStorage.setItem("pv-slip-mode", slipMode);
    renderSlipMode();
    if (slipMode === "follow") placeSlip(true);
  });

  function slipRect() {
    if (!current) return null;
    if (current.rectFn) return current.rectFn();
    if (current.range?.startContainer.isConnected) return current.range.getBoundingClientRect();
    return null;
  }

  function placeSlip(choose = false) {
    const r = slipRect();
    if (!r) return;
    const h = slip.offsetHeight;
    const w = slip.offsetWidth;
    if (choose) slipBelow = r.bottom + 16 + h < innerHeight - 12 || r.top - h - 16 < 12;
    slip.style.top = `${slipBelow ? r.bottom + 16 : r.top - h - 16}px`;
    slip.style.left = `${Math.min(Math.max(16, r.left), innerWidth - w - 28)}px`;
  }

  // Drag by the header (the natural way to move it out of the way in fixed mode).
  $(".slip header").addEventListener("pointerdown", (e) => {
    if (e.target.closest("button")) return;
    e.preventDefault();
    if (slipMode === "follow") {
      slipMode = "fixed";
      localStorage.setItem("pv-slip-mode", slipMode);
      renderSlipMode();
    }
    const start = { x: e.clientX, y: e.clientY, left: slip.offsetLeft, top: slip.offsetTop };
    const move = (ev) => {
      slip.style.left = `${Math.min(Math.max(0, start.left + ev.clientX - start.x), innerWidth - 60)}px`;
      slip.style.top = `${Math.min(Math.max(0, start.top + ev.clientY - start.y), innerHeight - 40)}px`;
    };
    const up = () => removeEventListener("pointermove", move);
    addEventListener("pointermove", move);
    addEventListener("pointerup", up, { once: true });
  });

  function syncActiveSlipBox(visibleFn = () => true) {
    if (!current?.showBox || slip.hidden) return;
    const rawSubs = current.subRects ? current.subRects() : [];
    const subRects = rawSubs.length > 1 ? rawSubs.filter(visibleFn) : [];
    const bbox = current.fullRect ? current.fullRect() : current.rectFn?.();
    if (!bbox || (!visibleFn(bbox) && !subRects.length)) {
      marqueeLayer.replaceChildren();
      return;
    }
    renderMarqueePreview(null, { rects: subRects, bbox, label: current.label });
  }

  function openSlip(anchor, opts = {}) {
    closeSlip();
    current = {
      anchor,
      range: opts.range || null,
      rectFn: opts.rect || null,
      subRects: opts.subRects || null,
      fullRect: opts.fullRect || null,
      label: opts.label ?? (adapter?.label?.(anchor) || ""),
      showBox: opts.showBox ?? (!opts.range && !!opts.rect),
      onClose: opts.onClose || null,
    };
    serial += 1;
    sessionStorage.setItem("pv-serial", String(serial));
    $(".no").textContent = `№ ${String(serial).padStart(2, "0")}`;
    $(".loc").textContent = adapter?.label?.(anchor) || "";
    const quote = $(".quote");
    quote.className = "quote";
    quote.replaceChildren();
    if (anchor.image) {
      quote.classList.add("image");
      const img = document.createElement("img");
      img.src = anchor.image;
      quote.appendChild(img);
    } else if (anchor.preview !== undefined || !anchor.text) {
      const code = document.createElement("code");
      code.textContent = anchor.selector || "";
      quote.append(code, " ", (anchor.preview || "").slice(0, 280));
    } else {
      quote.textContent = norm(anchor.text).slice(0, 420);
    }
    slipText.value = "";
    slip.hidden = false;
    placeSlip(true);
    syncActiveSlipBox();
    slipText.focus({ preventScroll: true });
  }

  function closeSlip() {
    if (slip.hidden) return;
    cancelActiveMic(slip);
    slip.hidden = true;
    clearMarquee();
    current?.onClose?.();
    current = null;
  }

  async function send(mode) {
    if (!current) return;
    const question = slipText.value.trim();
    if (mode === "ask" && !question) {
      shake(slip);
      slipText.focus();
      return;
    }
    const job = current;
    slip.classList.add("sending");
    try {
      const data = await api("/ask", { method: "POST", body: JSON.stringify({ doc: cfg.doc, mode, question, anchor: job.anchor }) });
      if (mode === "pin") {
        toast(`◆ Pinned — ${data.pinned} waiting for your next message`);
      } else {
        const { image: _image, preview: _preview, ...anchor } = job.anchor;
        const key = keyOf(anchor);
        queuePending(key, anchor, question);
        openDrawers.add(key);
        render();
        toast(data.delivered === "now" ? "→ Sent to pi" : "→ Queued — pi is busy");
      }
      if (current === job && !slip.hidden) closeSlip();
      else {
        job.onClose?.();
        if (current === job) current = null;
      }
      document.getSelection()?.removeAllRanges();
    } catch (e) {
      toast(String(e.message || e), true);
    } finally {
      slip.classList.remove("sending");
    }
  }

  attachMic($(".slip .mic"), slipText);
  $(".slip .ask").addEventListener("click", () => send("ask"));
  $(".slip .pin").addEventListener("click", () => send("pin"));
  slipText.addEventListener("keydown", (e) => {
    if (e.isComposing || e.keyCode === 229) return;
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      send("pin");
    } else if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send("ask");
    } else if (e.key === "Escape") {
      e.preventDefault();
      closeSlip();
    }
  });

  // ── Ctrl + drag marquee selection → smart minimum bounding box ──
  const marqueeLayer = $(".marquee");
  let suppressClickUntil = 0;

  function clearMarquee() {
    marqueeLayer.replaceChildren();
    document.documentElement.classList.remove("pv-marquee-active");
  }

  function renderMarqueePreview(dragRect, preview) {
    const nodes = [];
    if (dragRect) {
      const drag = document.createElement("div");
      drag.className = "marquee-drag";
      Object.assign(drag.style, { left: `${dragRect.left}px`, top: `${dragRect.top}px`, width: `${dragRect.width}px`, height: `${dragRect.height}px` });
      nodes.push(drag);
    }
    if (preview?.rects?.length) {
      for (const r of preview.rects) {
        const hit = document.createElement("div");
        hit.className = "marquee-hit";
        Object.assign(hit.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });
        nodes.push(hit);
      }
    }
    if (preview?.bbox) {
      const b = preview.bbox;
      const bboxEl = document.createElement("div");
      bboxEl.className = "marquee-bbox";
      Object.assign(bboxEl.style, { left: `${b.left - 3}px`, top: `${b.top - 3}px`, width: `${b.width + 6}px`, height: `${b.height + 6}px` });
      if (preview.label) {
        const badge = document.createElement("span");
        badge.className = "marquee-badge";
        badge.textContent = preview.label;
        bboxEl.appendChild(badge);
      }
      nodes.push(bboxEl);
    }
    marqueeLayer.replaceChildren(...nodes);
  }

  document.addEventListener(
    "click",
    (e) => {
      if (Date.now() < suppressClickUntil) {
        e.preventDefault();
        e.stopImmediatePropagation();
      }
    },
    true,
  );

  document.addEventListener(
    "pointerdown",
    (e) => {
      if (exportMode || e.button !== 0 || !e.ctrlKey || e.altKey || e.shiftKey || e.metaKey) return;
      if (fromUs(e) || !adapter?.marquee) return;
      if (e.target instanceof Element && e.target.closest("input, textarea, select, [contenteditable='true'], [contenteditable='']")) return;

      const x0 = e.clientX;
      const y0 = e.clientY;
      let active = false;
      let cancelled = false;
      let rafId = 0;
      let latestRect = new DOMRect(x0, y0, 0, 0);

      const updatePreview = () => {
        rafId = 0;
        if (!active || cancelled) return;
        const preview = adapter.marquee.preview?.(latestRect) || null;
        renderMarqueePreview(latestRect, preview);
      };

      const onMove = (ev) => {
        const dx = ev.clientX - x0;
        const dy = ev.clientY - y0;
        if (!active) {
          if (Math.hypot(dx, dy) < 5) return;
          active = true;
          hideTab();
          closeSlip();
          document.documentElement.classList.add("pv-marquee-active");
          document.getSelection()?.removeAllRanges();
        }
        ev.preventDefault();
        const left = Math.min(x0, ev.clientX);
        const top = Math.min(y0, ev.clientY);
        latestRect = new DOMRect(left, top, Math.abs(dx), Math.abs(dy));
        if (!rafId) rafId = requestAnimationFrame(updatePreview);
      };

      const cleanup = () => {
        removeEventListener("pointermove", onMove, true);
        removeEventListener("pointerup", onUp, true);
        removeEventListener("keydown", onKey, true);
        removeEventListener("blur", onCancel);
        if (rafId) cancelAnimationFrame(rafId);
        document.documentElement.classList.remove("pv-marquee-active");
      };

      const onCancel = () => {
        cancelled = true;
        cleanup();
        clearMarquee();
      };

      const onKey = (ev) => {
        if (ev.key === "Escape" && active) {
          ev.preventDefault();
          ev.stopImmediatePropagation();
          onCancel();
        }
      };

      const onUp = (ev) => {
        cleanup();
        if (!active || cancelled) return;
        ev.preventDefault();
        ev.stopImmediatePropagation();
        suppressClickUntil = Date.now() + 200;
        document.getSelection()?.removeAllRanges();
        const left = Math.min(x0, ev.clientX);
        const top = Math.min(y0, ev.clientY);
        const finalRect = new DOMRect(left, top, Math.abs(ev.clientX - x0), Math.abs(ev.clientY - y0));
        const res = adapter.marquee.finish?.(finalRect) || null;
        if (res?.anchor) {
          openSlip(res.anchor, {
            rect: res.rectFn || (() => res.bbox),
            subRects: res.subRectsFn || null,
            fullRect: res.fullRectFn || null,
            label: res.label,
            showBox: true,
          });
        } else {
          clearMarquee();
          if (finalRect.width > 24 || finalRect.height > 24) toast("No selectable objects inside marquee");
        }
      };

      addEventListener("pointermove", onMove, true);
      addEventListener("pointerup", onUp, true);
      addEventListener("keydown", onKey, true);
      addEventListener("blur", onCancel, { once: true });
    },
    true,
  );

  window.PiView = {
    cfg,
    exportMode,
    register(a) {
      adapter = a;
      locCache.clear();
      render();
    },
    openSlip,
    toast,
    addTool,
    outline,
    findText,
    rangeText,
    relocate,
    syncTheme,
    rectOf,
    unionRects,
    clipToRect,
    smartAnchorRect,
    rectsIntersect,
    rectArea,
    pruneElements,
    clipRect,
  };
  connect();
})();
