// Injected by pi-webview into a video page's isolated world (CDP Page.createIsolatedWorld /
// addScriptToEvaluateOnNewDocument). It shares the DOM with the site but none of its JS. Everything
// talks to pi through the CDP binding window.__piVideo(json); pi answers via window.__piVideoPanel.receive().
// Sites like YouTube enforce Trusted Types: the UI is built with createElement, and reply HTML
// (rendered by pi, raw HTML disabled) goes through a private policy.
//
// Two layouts share one state: "side" (a docked column next to the page) and "full" (fullscreen or a
// player filling the window: a subtitle wheel in a narrow strip at the screen edge; the rest of the UI
// appears while the pointer is over that strip).
//
// Asking: select lines (drag across them, or click the round button at the end of each line to add it),
// then type in the one composer at the bottom. Answers stream into the dock above the composer.
(function piVideoPanel(CSS, SITES, OWN) {
  "use strict";
  if (window.top !== window || !/^https?:$/.test(location.protocol)) return;

  const HOST_ID = "pi-video-host";
  const send = (msg) => {
    try {
      window.__piVideo(JSON.stringify(msg));
      return true;
    } catch {
      return false;
    }
  };

  // A previous injection into this world (pi re-attached): replace it. Panels left in other worlds by a
  // pi process that has since exited hear the DOM event below and remove themselves.
  window.__piVideoPanel?.destroy?.();
  const REPLACE_EVENT = "pi-video:replace";
  document.dispatchEvent(new CustomEvent(REPLACE_EVENT));

  const site = SITES.find((s) => s.hosts.some((h) => location.hostname === h || location.hostname.endsWith(`.${h}`)));
  const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

  const fmt = (sec) => {
    const s = Math.max(0, Math.floor(sec || 0));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const ss = String(s % 60).padStart(2, "0");
    return h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
  };

  function el(tag, props, ...children) {
    const e = document.createElement(tag);
    if (props) {
      for (const [k, v] of Object.entries(props)) {
        if (v == null || v === false) continue;
        if (k === "class") e.className = v;
        else if (k === "text") e.textContent = v;
        else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
        else e.setAttribute(k, v === true ? "" : String(v));
      }
    }
    for (const c of children.flat()) if (c != null && c !== false) e.append(c instanceof Node ? c : String(c));
    return e;
  }

  const ICONS = {
    captions: "M4 6.5h16a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1z M10.2 10.4a2 2 0 1 0 0 3.2 M16.2 10.4a2 2 0 1 0 0 3.2",
    // Lucide "settings" (ISC licence).
    gear: "M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z M12 9a3 3 0 1 0 0 6a3 3 0 1 0 0-6z",
    chat: "M4.5 5.5h15v10h-9l-4.5 3.5v-3.5h-1.5z",
    list: "M5 7h14 M5 12h14 M5 17h9",
    hide: "M9.5 6l6 6-6 6",
    hideLeft: "M14.5 6l-6 6 6 6",
    close: "M7 7l10 10 M17 7L7 17",
    search: "M10.5 4.5a6 6 0 1 0 0 12a6 6 0 1 0 0-12z M15 15l4.5 4.5",
    folder: "M3.5 7.5v10.5h17v-9h-9l-2-2.5h-6z",
    file: "M6.5 3.5h7l4 4v13h-11z M13.5 3.5v4h4",
    camera: "M4 8.5h3.5l1.8-2.5h5.4l1.8 2.5h3.5v10h-16z M12 10.5a3 3 0 1 0 0 6a3 3 0 1 0 0-6z",
    send: "M12 18.5v-13 M6.5 11l5.5-5.5 5.5 5.5",
    check: "M6 12.5l3.8 3.8L18 8",
    plus: "M12 7v10 M7 12h10",
    chevron: "M10 7l5 5-5 5",
    back: "M14.5 6l-6 6 6 6",
    refresh: "M19 12a7 7 0 1 1-2.1-5 M19 4.5V9h-4.5",
    play: "M8.5 6.5l9 5.5-9 5.5z",
    lines: "M5 8h14 M5 12h14 M5 16h8",
    reply: "M9.5 7.5L5 12l4.5 4.5 M5 12h9a5 5 0 0 1 5 5v1",
  };
  const SVG_NS = "http://www.w3.org/2000/svg";
  function icon(name) {
    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("class", `ic ic-${name}`);
    svg.setAttribute("aria-hidden", "true");
    const p = document.createElementNS(SVG_NS, "path");
    p.setAttribute("d", ICONS[name]);
    svg.append(p);
    return svg;
  }

  let policy;
  function setHTML(node, html) {
    if (policy === undefined) {
      policy = null;
      try {
        if (window.trustedTypes?.createPolicy) policy = window.trustedTypes.createPolicy(`pi-video-${Math.random().toString(36).slice(2)}`, { createHTML: (s) => s });
      } catch {
        // The page restricts policy names: fall back below.
      }
    }
    try {
      node.innerHTML = policy ? policy.createHTML(html) : html;
    } catch {
      node.textContent = html.replace(/<[^>]+>/g, "");
    }
  }

  // ---------- state ----------
  let meta = null;
  let settings = null;
  let cues = [];
  let subtitle = null;
  let files = [];
  let filesRoot = "";
  let threads = new Map();
  let busy = false;
  let current = -1;
  let mode = "side"; // "side" | "full"
  let view = "cues"; // "cues" | "qa"
  let sheet = null; // null | "settings" | "subs"
  let sheetBack = null; // the sheet the back button returns to
  let selection = null; // { a, b } cue indexes, inclusive
  let focusIds = []; // threads shown in the dock when no lines are selected
  let awaitingThread = false; // the next new thread is the answer to a question sent from here
  let frameShot = null; // { t, url } a frame to attach to the next question
  let dockPinned = false; // full layout: keep a fresh answer on screen until the pointer has visited the strip
  let drag = null;
  let hot = false; // the pointer is over the subtitle area
  let hotTimer = 0;
  let flat = false;
  let userScrolled = false; // side layout: manual scroll pauses follow until "Back to current"
  let video = null;
  let lastReport = 0;
  let pending = null; // { rid, timer } the question in flight
  const timers = [];
  const docStyles = [];
  let defaults = null; // default settings and numeric ranges, from pi
  let limits = null;
  const RUBY_KEYS = ["rubyPosition", "rubySize", "rubyOpacity"];
  const OVERLAY_KEYS = ["overlayFontSize", "overlayWeight", "overlayBg", "overlayBlur", "overlayShadow", "overlayRadius", "overlayBottom", "overlayWidth"];
  const WHEEL_KEYS = ["wheelRadius", "wheelBend", "wheelEdge", "wheelSize", "wheelDim", "wheelOpacity", "wheelBlur", "wheelGlow", "wheelBold", "listOpacity"];

  // ---------- DOM ----------
  document.getElementById(HOST_ID)?.remove();
  const host = el("div", { id: HOST_ID });
  host.style.cssText = "all:initial;position:fixed;top:0;left:0;width:0;height:0;z-index:2147483646;";
  const root = host.attachShadow({ mode: "closed" });
  root.append(el("style", { text: CSS }));

  const ui = {};
  const iconBtn = (name, title, cls = "") => el("button", { class: `ib ${cls}`, title }, icon(name));
  ui.panel = el("div", { class: "pv", "data-mode": "side", "data-view": "cues" });
  ui.veil = el("div", { class: "veil" });
  ui.resize = el("div", { class: "resize", title: "Drag to resize" });
  ui.course = el("div", { class: "course" });
  ui.title = el("div", { class: "title" });
  ui.dot = el("span", { class: "busy-dot", title: "pi is idle" });
  ui.segCues = el("button", { class: "seg-b on", text: "Subtitles" });
  ui.segQa = el("button", { class: "seg-b", text: "Q&A" });
  ui.seg = el("div", { class: "seg", style: "--i:0" }, ui.segCues, ui.segQa);
  ui.viewBtn = iconBtn("chat", "Show Q&A (Alt+Q)", "view-toggle");
  ui.ccBtn = iconBtn("captions", "Subtitle file");
  ui.setBtn = iconBtn("gear", "Settings");
  ui.hideBtn = iconBtn("hide", "Hide panel (Alt+S)");
  ui.controls = el("div", { class: "controls" }, ui.seg, el("span", { class: "grow" }), ui.viewBtn, ui.ccBtn, ui.setBtn, ui.hideBtn, ui.dot);
  ui.cues = el("div", { class: "list cues active" });
  ui.qa = el("div", { class: "list qa" });
  ui.thumb = el("div", { class: "thumb" });
  ui.ticks = el("div", { class: "ticks" });
  ui.rail = el("div", { class: "rail" }, ui.ticks, ui.thumb);
  ui.now = el("button", { class: "now pill" }, icon("play"), "Back to current");
  ui.measure = el("div", { class: "measure", "aria-hidden": "true" });
  ui.body = el("div", { class: "body" }, ui.cues, ui.qa, ui.rail, ui.now, ui.measure);

  // Foot: the dock (answers for the selection), context chips and the one composer.
  ui.dockList = el("div", { class: "d-threads" });
  ui.dock = el("div", { class: "dock" }, el("div", { class: "dock-in glass" }, el("button", { class: "ib small d-close", title: "Close (Esc)" }, icon("close")), ui.dockList));
  ui.ctx = el("div", { class: "ctx" });
  ui.ta = el("textarea", { rows: "1", placeholder: "Ask about this moment…" });
  ui.frameBtn = el("button", { class: "ib frame", title: "Attach the current frame (pauses the video)" }, icon("camera"));
  ui.sendBtn = el("button", { class: "ib send", title: "Send (Enter)" }, icon("send"));
  ui.status = el("div", { class: "c-status" });
  ui.composer = el("div", { class: "composer" }, el("div", { class: "c-row" }, ui.ta, ui.frameBtn, ui.sendBtn), ui.status);
  ui.foot = el("footer", { class: "foot" }, ui.dock, ui.ctx, ui.composer);

  ui.sheet = el("div", { class: "sheet glass" });
  ui.reopen = el("button", { class: "reopen glass", title: "Show pi panel (Alt+S)", text: "pi" });
  ui.overlay = el("div", { class: "overlay", hidden: true });
  ui.toast = el("div", { class: "toast glass" });

  ui.panel.append(ui.veil, ui.resize, el("header", { class: "head" }, el("div", { class: "names" }, ui.course, ui.title), ui.controls), ui.body, ui.foot, ui.sheet);
  ui.overlay.append(el("span"));
  root.append(ui.panel, ui.reopen, ui.overlay, ui.toast);

  function docStyle(id) {
    document.getElementById(id)?.remove();
    const s = el("style", { id });
    (document.head || document.documentElement).append(s);
    docStyles.push(s);
    return s;
  }
  // Created at boot: a script injected into a new document runs before <head> exists.
  let layoutStyle = null;
  let hideStyle = null;

  function mount() {
    const fe = document.fullscreenElement;
    // A fullscreen <video> cannot hold children; stay in the document then.
    const target = fe && fe.tagName !== "VIDEO" ? fe : document.documentElement;
    if (host.parentNode !== target) target.append(host);
  }

  /** Restart a one-shot CSS animation class. */
  function replay(node, cls) {
    node.classList.remove(cls);
    void node.offsetWidth;
    node.classList.add(cls);
  }

  // ---------- video ----------
  function findVideo() {
    for (const sel of site?.videoSelectors ?? []) {
      const v = document.querySelector(sel);
      if (v) return v;
    }
    let best = null;
    let area = 0;
    for (const v of document.querySelectorAll("video")) {
      const r = v.getBoundingClientRect();
      if (r.width * r.height > area) {
        area = r.width * r.height;
        best = v;
      }
    }
    return best;
  }

  const inAd = () => !!(site?.adSelector && document.querySelector(site.adSelector));
  const VIDEO_EVENTS = ["timeupdate", "play", "pause", "seeked", "ratechange", "durationchange", "loadedmetadata", "emptied"];
  const onVideoEvent = (e) => {
    report(e.type !== "timeupdate", e.type);
    updateCurrent();
  };

  function attachVideo() {
    const v = findVideo();
    if (v === video) return;
    if (video) for (const t of VIDEO_EVENTS) video.removeEventListener(t, onVideoEvent);
    video = v;
    if (video) for (const t of VIDEO_EVENTS) video.addEventListener(t, onVideoEvent);
    report(true);
    updateCurrent();
  }

  function report(force, ev) {
    if (!video || inAd()) return;
    const now = Date.now();
    if (!force && now - lastReport < 1000) return;
    lastReport = now;
    send({ type: "state", ev, t: video.currentTime, paused: video.paused, duration: Number.isFinite(video.duration) ? video.duration : 0, rate: video.playbackRate });
  }

  function seek(t) {
    const v = video || findVideo();
    if (v) v.currentTime = Math.max(0, Number(t) || 0);
  }

  const nowTime = () => (video || findVideo())?.currentTime ?? 0;

  // ---------- cues ----------
  function cueAt(t) {
    let lo = 0;
    let hi = cues.length - 1;
    let ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (cues[mid].start <= t) {
        ans = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    return ans;
  }

  const rowOf = (i) => (i >= 0 ? (rowEls[i] ?? null) : null);
  const linesOf = (a, b) => cues.slice(a, b + 1).map((c) => ({ start: c.start, end: c.end, text: c.text }));

  /** The list follows playback unless the learner is working with it. */
  const following = () => !!settings?.follow && !settings.collapsed && (!hot || tuning()) && !drag && (mode === "full" || !userScrolled);
  /** Fullscreen with Settings open: the wheel stays a wheel so style changes show live. */
  const tuning = () => mode === "full" && sheet === "settings";

  function updateCurrent() {
    if (!video || inAd() || !cues.length) {
      placeOverlay();
      return;
    }
    const t = video.currentTime;
    const i = cueAt(t + 0.05);
    const active = i >= 0 && t <= cues[i].end + 0.25 ? i : -1;
    if (i !== current) {
      rowOf(current)?.classList.remove("cur");
      current = i;
      rowOf(current)?.classList.add("cur");
      applyWheel();
      if (following()) centerCurrent(true);
      renderRail();
    }
    if (active !== overlayCue) {
      overlayCue = active;
      const span = ui.overlay.firstChild;
      if (active >= 0) cueText(span, cues[active]);
      else span.textContent = "";
    }
    placeOverlay();
  }
  let overlayCue = -1; // the cue shown on the video

  /** Put a cue's text into `node`; annotations (ruby) sit beside their base words. */
  function cueText(node, c) {
    if (!c.ruby) node.textContent = c.text;
    else node.replaceChildren(...c.ruby.map((p) => (typeof p === "string" ? p : el("ruby", null, p[0], el("rt", { text: p[1] })))));
    return node;
  }

  let programmatic = 0;
  function scrollToRow(row, smooth = true) {
    if (!row) return;
    programmatic = Date.now();
    const box = ui.cues;
    box.scrollTo({ top: row.offsetTop - box.clientHeight / 2 + row.offsetHeight / 2, behavior: smooth ? "smooth" : "auto" });
  }
  /** In the fullscreen wheel the drum keeps the current line centred by itself. */
  const centerCurrent = (smooth) => {
    if (mode === "full" && !flat) return smooth ? applyWheel() : snapWheel();
    scrollToRow(rowOf(current), smooth);
  };

  // ---------- full layout: the subtitle wheel ----------
  // Lines sit on a drum seen from the front. The farther a line is from the current one along the drum,
  // the more it turns away and sinks: it moves closer to its neighbours, is squashed, smaller, dimmer and
  // softer. Every line is also shrink-wrapped to its own words and pushed against the screen edge, so at
  // rest the strip is only as wide as the text needs.
  //
  // The wheel is animated by script, not CSS transitions: one spring rolls the drum to the current line,
  // another blends between the wheel and the flat list (hover). Both keep their velocity when the target
  // changes mid-way, so every motion can be interrupted and redirected without a jump. Only the lines on
  // screen are touched; the rest of a long subtitle never animates.
  const measured = new Map(); // index → widest wrapped line, px, at the current column width
  let measureKey = "";
  let wheelExtent = 0; // px from the screen edge covered by the clearly visible lines
  let rowEls = []; // .cue rows by cue index
  const wheel = { pos: 0, v: 0, f: 0, fv: 0, raf: 0, last: 0, synced: false, styled: new Set() };

  /**
   * Width of the widest line of cue `i` as wrapped in the column (lines are balanced, so this is tight).
   * The current line is emphasised only with paint (outline, glow, scale), never a heavier font: a
   * different weight would wrap it differently and make the list jump when it becomes current.
   */
  function textWidth(i, avail) {
    let w = measured.get(i);
    if (w !== undefined) return w;
    const m = ui.measure;
    m.style.width = `${avail}px`;
    cueText(m, cues[i]);
    const box = m.getBoundingClientRect();
    // Rects are on screen; the ratio undoes any scale an ancestor animation applies.
    const unit = box.width ? m.offsetWidth / box.width : 1;
    const range = document.createRange();
    range.selectNodeContents(m);
    w = 0;
    for (const r of range.getClientRects()) w = Math.max(w, (r.right - box.left) * unit);
    w = Math.min(avail, Math.ceil(w) + 1);
    measured.set(i, w);
    return w;
  }

  function syncScroll(box, H) {
    wheel.synced = true;
    const want = wheel.pos - H / 2;
    if (Math.abs(box.scrollTop - want) < 0.5) return;
    programmatic = Date.now();
    box.scrollTop = want;
  }

  /** Critically damped spring step: no overshoot, and velocity carries over when the target moves. */
  function spring(x, v, target, dt, omega) {
    const d = x - target;
    const e = Math.exp(-omega * dt);
    const tmp = (v + omega * d) * dt;
    return [target + (d + tmp) * e, (v - omega * tmp) * e];
  }

  const centerOf = (row) => row.offsetTop + row.offsetHeight / 2;
  const wheelTarget = () => {
    const row = rowEls[current] ?? rowEls[0];
    return row ? centerOf(row) : wheel.pos;
  };

  function clearWheelStyles() {
    for (const r of wheel.styled) r.removeAttribute("style");
    wheel.styled.clear();
  }

  /** Something the wheel depends on changed (current line, settings, size, selection): animate to it. */
  function applyWheel() {
    if (mode !== "full") {
      cancelAnimationFrame(wheel.raf);
      wheel.raf = 0;
      clearWheelStyles();
      wheelExtent = 0;
      ui.veil.style.removeProperty("--vw");
      return;
    }
    if (wheel.raf) return;
    wheel.last = performance.now();
    wheel.raf = requestAnimationFrame(wheelFrame);
  }

  /** Put the drum on the current line at once (layout change, entering fullscreen). */
  function snapWheel() {
    wheel.pos = wheelTarget();
    wheel.v = 0;
    wheel.f = wheel.fv = 0;
    if (flat) wheel.f = 1;
    applyWheel();
  }

  function wheelFrame(now) {
    wheel.raf = 0;
    if (mode !== "full") return applyWheel();
    if (!rowEls.length) return clearWheelStyles();
    const dt = Math.min(0.05, Math.max(0.001, (now - wheel.last) / 1000));
    wheel.last = now;
    const box = ui.cues;
    const H = box.clientHeight;
    if (!H) return; // the subtitle list is hidden (Q&A view); resume when it shows
    const fTarget = flat ? 1 : 0;
    [wheel.f, wheel.fv] = spring(wheel.f, wheel.fv, fTarget, dt, 17);
    let target = wheel.pos;
    let rolled = false;
    if (fTarget === 1) {
      // The list is open: line up the scroll with the drum once, then the learner scrolls and the drum follows.
      if (!wheel.synced) syncScroll(box, H);
      wheel.pos = box.scrollTop + H / 2;
      wheel.v = 0;
    } else {
      target = wheelTarget();
      [wheel.pos, wheel.v] = spring(wheel.pos, wheel.v, target, dt, 11);
      rolled = Math.abs(wheel.pos - target) < 0.3 && Math.abs(wheel.v) < 2;
      // The drum rolls by transforms alone; scrolling every frame costs a repaint of the whole strip.
      // The scroll position catches up once the drum stops, so the list opens where the wheel is.
      if (rolled) syncScroll(box, H);
      else wheel.synced = false;
    }
    const top = box.scrollTop + H / 2; // the viewport centre in list coordinates, as scrolled
    const f = Math.min(1, Math.max(0, wheel.f));
    const settled = Math.abs(wheel.f - fTarget) < 0.002 && Math.abs(wheel.fv) < 0.02 && (fTarget === 1 || rolled);

    if (settled && fTarget === 1) {
      // Fully open: plain CSS takes over (hover, selection), nothing per line.
      wheel.f = 1;
      clearWheelStyles();
      return;
    }

    const probe = rowEls[current] ?? rowEls[0];
    const text = probe.querySelector(".tx");
    const avail = text.clientWidth;
    const rowW = probe.offsetWidth;
    const cs = getComputedStyle(probe);
    const pl = parseFloat(cs.paddingLeft) || 0;
    // Annotations change how wide a line is: their size is part of the key.
    const key = `${avail}|${cs.fontSize}|${settings.rubySize}|${settings.rubyPosition}`;
    if (key !== measureKey) {
      measureKey = key;
      measured.clear();
    }
    const st = settings;
    const R = (H * st.wheelRadius) / 100; // drum radius
    const P = R * 2.4; // viewing distance
    const edge = st.wheelEdge;
    const right = st.side !== "left";
    const lo = st.listOpacity / 100;
    const reach = Math.max(R * 1.5, H / 2 + 80); // every line on screen, wheel or list

    // First row whose centre is past pos − reach (rows are in order).
    let a = 0;
    let b = rowEls.length - 1;
    while (a < b) {
      const mid = (a + b) >> 1;
      if (centerOf(rowEls[mid]) < wheel.pos - reach) a = mid + 1;
      else b = mid;
    }
    // Read and measure everything first, then write: interleaving would force a layout per line.
    const out = [];
    let extent = 0;
    for (let i = a; i < rowEls.length; i++) {
      const row = rowEls[i];
      const yc = centerOf(row);
      const s = yc - wheel.pos;
      if (s > reach) break;
      const isCur = i === current;
      const raw = s / R;
      const th = Math.max(-1.5, Math.min(1.5, raw));
      const cos = Math.cos(th);
      const kp = P / (P - R * (cos - 1)); // perspective shrink of a point sunk to R·(cos−1)
      const ys = R * Math.sin(th) * kp; // where the drum puts it, from the viewport centre
      const k = (isCur ? 1 : st.wheelSize / 100) * kp;
      const push = ((1 - cos) * avail * st.wheelBend) / 100; // the rim also bends toward the screen edge
      const w = textWidth(i, avail);
      // transform-origin is the row's left centre: put the end (right side) or start (left side) of the text at the edge.
      const txW = right ? rowW - edge + push - k * (pl + w) : edge - push - k * pl;
      // Every other line is dimmed (grey, not just transparent), so the current one stands out on any frame.
      let oW = isCur ? 1 : Math.abs(raw) > 1.5 ? 0 : (st.wheelOpacity / 100) * cos ** 2.2;
      if (row.classList.contains("sel")) oW = Math.max(oW, 0.92);
      const blurW = isCur ? 0 : st.wheelBlur * Math.min(1, 0.08 + 1.2 * (1 - cos));
      const dimW = isCur ? 1 : (st.wheelDim / 100) * (1 - 0.32 * (1 - cos));
      const oF = isCur || row.classList.contains("sel") ? 1 : lo;
      // Blend wheel → list by f.
      const g = 1 - f;
      const tx = txW * g;
      const dy = (ys - (yc - top)) * g;
      const sc = k + (1 - k) * f;
      const deg = ((-th * 180) / Math.PI) * g;
      const o = oW + (oF - oW) * f;
      const blur = blurW * g;
      const dim = dimW + (1 - dimW) * f;
      out.push([row, tx, dy, sc, deg, o, blur, dim]);
      if (oW > 0.3) extent = Math.max(extent, edge - push + k * w);
    }
    const seen = new Set();
    const per = Math.round(P);
    for (const [row, tx, dy, sc, deg, o, blur, dim] of out) {
      const rs = row.style;
      rs.transition = "none";
      rs.transform = `translate(${tx.toFixed(2)}px,${dy.toFixed(2)}px) scale(${sc.toFixed(4)}) perspective(${per}px) rotateX(${deg.toFixed(2)}deg)`;
      rs.opacity = o.toFixed(3);
      rs.filter = blur > 0.05 || dim < 0.995 ? `blur(${blur.toFixed(2)}px) brightness(${dim.toFixed(3)})` : "none";
      rs.setProperty("--so", f.toFixed(3)); // end buttons fade in with the list
      rs.setProperty("--bar", f.toFixed(3)); // the current-line marker of the list
      rs.setProperty("--ul", (1 - f).toFixed(3)); // the Q&A underline of the wheel
      seen.add(row);
    }
    for (const r of wheel.styled) if (!seen.has(r)) r.removeAttribute("style");
    wheel.styled = seen;

    if (fTarget === 0 && Math.abs(extent - wheelExtent) > 2) {
      wheelExtent = extent;
      // On the veil only: a custom property on the panel would restyle every line of the subtitle.
      ui.veil.style.setProperty("--vw", `${Math.round(extent)}px`);
    }
    if (!settled) wheel.raf = requestAnimationFrame(wheelFrame);
  }

  function syncFlat() {
    const next = mode === "full" && (hot || !!drag) && !tuning();
    if (next === flat) return;
    flat = next;
    ui.panel.classList.toggle("flat", flat);
    applyWheel();
  }

  function renderCues() {
    ui.cues.textContent = "";
    current = -1;
    selection = null;
    clearWheelStyles();
    rowEls = [];
    measured.clear();
    overlayCue = -2;
    if (!cues.length) {
      ui.cues.append(
        el(
          "div",
          { class: "empty" },
          el("div", { class: "empty-t", text: subtitle ? "This subtitle file has no lines" : "No subtitle loaded" }),
          el("button", { class: "pill", onclick: () => openSheet("subs") }, icon("captions"), "Choose a subtitle file"),
        ),
      );
      renderFoot();
      renderRail();
      return;
    }
    const frag = document.createDocumentFragment();
    cues.forEach((c, i) => {
      frag.append(
        el(
          "div",
          { class: "cue", "data-i": i },
          el("span", { class: "t", text: fmt(c.start) }),
          cueText(el("span", { class: "tx" }), c),
          el(
            "span",
            { class: "side" },
            el("button", { class: "dot", title: "Show the Q&A on this line" }),
            el("button", { class: "add", title: "Add this line to the selection" }, icon("plus"), icon("check")),
          ),
        ),
      );
    });
    ui.cues.append(frag);
    rowEls = [...ui.cues.children];
    renderMarks();
    updateCurrent();
    centerCurrent(false);
    renderFoot();
  }

  // ---------- threads ----------
  // Block times are whole seconds rounded down, so a line starting at 62.5s is recorded as 1:02.
  function threadCue(t) {
    if (!cues.length) return -1;
    return cueAt((t.from ?? t.time) + 0.999);
  }
  const sortedThreads = () => [...threads.values()].sort((x, y) => x.seq - y.seq);
  const threadsAt = (i) => sortedThreads().filter((t) => threadCue(t) === i);
  const lastThreadAt = (i) => threadsAt(i).at(-1);

  /** The line range a thread was asked about. */
  function rangeOf(t) {
    const a = threadCue(t);
    if (a < 0) return null;
    const b = t.to != null ? Math.max(a, cueAt(t.to - 0.001)) : a;
    return { a, b };
  }

  function renderMarks() {
    const asked = new Map();
    for (const t of threads.values()) {
      const i = threadCue(t);
      if (i >= 0) asked.set(i, asked.get(i) || t.status === "running");
    }
    for (const row of ui.cues.querySelectorAll(".cue")) {
      const i = Number(row.dataset.i);
      row.classList.toggle("asked", asked.has(i));
      row.querySelector(".dot").classList.toggle("running", !!asked.get(i));
    }
    renderRail();
  }

  const PHASE = { waiting: "Waiting…", thinking: "Thinking…", toolcall: "Preparing a tool…", tool: "Running a tool…", answering: "Answering…" };

  function card(t, inDock) {
    const at = t.from ?? t.time;
    const answer = el("div", { class: "a" });
    if (t.html) setHTML(answer, t.html);
    const progress =
      t.status === "running"
        ? el("div", { class: "phase" }, el("span", { class: "spin" }), t.activity || PHASE[t.phase] || "Working…")
        : t.status === "aborted"
          ? el("div", { class: "phase off", text: "Stopped" })
          : null;
    return el(
      "div",
      { class: `card ${t.status}`, "data-id": t.id },
      el(
        "div",
        { class: "card-h" },
        el("span", { class: "seq", text: `#${t.seq}` }),
        t.replyToSeq ? el("span", { class: "re", text: `↳ #${t.replyToSeq}` }) : null,
        el("span", { class: "grow" }),
        el("button", { class: "chip jump", "data-t": at, title: "Jump to this moment" }, icon("play"), fmt(at)),
        inDock ? null : el("button", { class: "chip fu", "data-id": t.id, title: "Continue this conversation" }, icon("reply"), "Follow up"),
      ),
      !inDock && t.excerpt ? el("div", { class: "quote", text: t.excerpt }) : null,
      t.question ? el("div", { class: "q", text: t.question }) : null,
      answer,
      progress,
    );
  }

  function renderQa() {
    const box = ui.qa;
    const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
    box.textContent = "";
    const list = sortedThreads();
    if (!list.length) box.append(el("div", { class: "empty" }, el("div", { class: "empty-t", text: "Questions about this video appear here" })));
    for (const t of list) box.append(card(t, false));
    if (nearBottom) box.scrollTop = box.scrollHeight;
    const n = list.length;
    ui.segQa.textContent = n ? `Q&A · ${n}` : "Q&A";
    ui.viewBtn.dataset.count = n ? String(n) : "";
  }

  /** Update a thread's cards in place, so streaming does not restart their entrance animation. */
  function patchCards(t) {
    for (const old of root.querySelectorAll(`.card[data-id="${t.id}"]`)) {
      const box = old.parentElement;
      const stick = box.scrollHeight - box.scrollTop - box.clientHeight < 60;
      const fresh = card(t, !!old.closest(".dock"));
      old.className = fresh.className;
      old.replaceChildren(...fresh.childNodes);
      if (stick) box.scrollTop = box.scrollHeight;
    }
  }

  function upsertThread(t) {
    const prev = threads.get(t.id);
    threads.set(t.id, t);
    if (prev) {
      patchCards(t);
      if (prev.status !== t.status) {
        if (prev.status === "running" && dockThreads().includes(t)) dockPinned = true;
        renderMarks();
        renderFoot();
      }
      return;
    }
    if (awaitingThread) {
      awaitingThread = false;
      dockPinned = true;
      if (!selection) focusIds = [...focusIds, t.id];
    }
    renderMarks();
    renderQa();
    renderDock();
    renderFoot();
  }

  // ---------- selection, dock and composer ----------
  function renderSelection() {
    for (const row of ui.cues.querySelectorAll(".cue.sel")) row.classList.remove("sel", "sel-a", "sel-b");
    if (selection) {
      for (let i = selection.a; i <= selection.b; i++) {
        const row = rowOf(i);
        if (!row) continue;
        row.classList.add("sel");
        if (i === selection.a) row.classList.add("sel-a");
        if (i === selection.b) row.classList.add("sel-b");
      }
    }
    applyWheel(); // selected lines stay readable on the wheel
  }

  function select(a, b = a) {
    selection = a == null || !cues.length ? null : { a: Math.min(a, b), b: Math.max(a, b) };
    if (selection) focusIds = [];
    renderSelection();
    renderDock();
    renderFoot();
  }

  /** The round button at the end of a line adds it to the selection; ends toggle off, a middle line trims. */
  function toggleLine(i) {
    if (!selection) return select(i);
    let { a, b } = selection;
    if (i < a) a = i;
    else if (i > b) b = i;
    else if (a === b) return select(null);
    else if (i === a) a++;
    else if (i === b) b--;
    else b = i;
    select(a, b);
  }

  function clearContext() {
    focusIds = [];
    dockPinned = false;
    select(null);
  }

  const dockThreads = () => (selection ? threadsAt(selection.a) : focusIds.map((id) => threads.get(id)).filter(Boolean));

  let dockKey = "";
  function renderDock() {
    const list = dockThreads();
    const key = list.map((t) => t.id).join(",");
    ui.dock.classList.toggle("show", list.length > 0);
    if (key === dockKey) return;
    const fresh = list.filter((t) => !dockKey.split(",").includes(t.id));
    dockKey = key;
    ui.dockList.textContent = "";
    for (const t of list) {
      const c = card(t, true);
      if (fresh.includes(t)) c.classList.add("enter");
      ui.dockList.append(c);
    }
    requestAnimationFrame(() => (ui.dockList.scrollTop = ui.dockList.scrollHeight));
  }

  /**
   * Context chips are keyed: a chip that stays is updated in place, so only the one being added or
   * removed animates. `want` maps key → { cls, label, lead, title, clear }.
   */
  function syncChips(want) {
    for (const node of [...ui.ctx.children]) {
      const key = node.dataset.key;
      if (want.has(key) && !node.classList.contains("leaving")) continue;
      if (node.classList.contains("leaving")) continue;
      node.classList.add("leaving");
      setTimeout(() => node.remove(), 240);
    }
    for (const [key, c] of want) {
      let node = ui.ctx.querySelector(`.ctx-chip[data-key="${key}"]:not(.leaving)`);
      if (!node) {
        node = el("span", { class: `ctx-chip ${c.cls}`, "data-key": key }, el("span", { class: "lead" }), el("span", { class: "label" }), el("button", { class: "x", title: "Remove" }, icon("close")));
        node.querySelector(".x").addEventListener("click", () => chipClear.get(key)?.());
        ui.ctx.append(node);
      }
      node.title = c.title;
      const lead = node.querySelector(".lead");
      if (lead.dataset.v !== c.leadKey) {
        lead.dataset.v = c.leadKey;
        lead.replaceChildren(c.lead());
      }
      node.querySelector(".label").textContent = c.label;
      chipClear.set(key, c.clear);
    }
  }
  const chipClear = new Map();

  function renderFoot() {
    const want = new Map();
    if (selection) {
      const n = selection.b - selection.a + 1;
      want.set("lines", {
        cls: "lines",
        lead: () => icon("lines"),
        leadKey: "lines",
        label: `${n} line${n > 1 ? "s" : ""} · ${fmt(cues[selection.a].start)}–${fmt(cues[selection.b].end)}`,
        title: "The question will quote these lines",
        clear: () => select(null),
      });
    } else if (focusIds.length) {
      const last = threads.get(focusIds.at(-1));
      if (last) want.set("reply", { cls: "reply", lead: () => icon("reply"), leadKey: "reply", label: `Follow up #${last.seq}`, title: "The question continues this conversation", clear: () => clearContext() });
    }
    if (frameShot) {
      const shot = frameShot;
      want.set("frame", {
        cls: "frame",
        leadKey: shot.url ? String(shot.t) : "camera",
        lead: () => {
          if (!shot.url) return icon("camera");
          const img = el("img", { alt: "", onerror: (e) => e.target.replaceWith(icon("camera")) });
          img.src = shot.url;
          return img;
        },
        label: `Frame ${fmt(shot.t)}`,
        title: "The current frame is sent with the question",
        clear: () => setFrame(false),
      });
    }
    syncChips(want);
    ui.ctx.classList.toggle("show", want.size > 0);
    ui.frameBtn.classList.toggle("on", !!frameShot);
    const list = dockThreads();
    ui.ta.placeholder = selection ? (list.length ? "Follow up on these lines…" : "Ask about these lines…") : focusIds.length ? "Follow up…" : "Ask about this moment…";
    updateFootVisibility();
  }

  /** Full layout: the foot only shows while it is in use. */
  function updateFootVisibility() {
    const inFoot = root.activeElement && ui.foot.contains(root.activeElement);
    const running = dockThreads().some((t) => t.status === "running");
    const show = mode === "side" || (hot && !tuning()) || !!inFoot || !!ui.ta.value.trim() || !!pending || running || (dockPinned && ui.dock.classList.contains("show"));
    ui.foot.classList.toggle("show", show);
  }

  function setStatus(text, kind) {
    ui.status.textContent = text || "";
    ui.status.className = `c-status${kind ? ` ${kind}` : ""}`;
  }

  function setFrame(on) {
    if (!on) {
      frameShot = null;
      return renderFoot();
    }
    const v = video || findVideo();
    if (!v) return setStatus("No video on this page", "err");
    if (!v.paused) v.pause();
    let url = null;
    try {
      url = captureFrame(360);
    } catch {
      // Cross-origin video: pi captures a screenshot instead; just no thumbnail here.
    }
    frameShot = { t: v.currentTime, url };
    renderFoot();
    ui.ta.focus({ preventScroll: true });
  }

  function askContext() {
    if (selection) return { time: nowTime(), cues: linesOf(selection.a, selection.b), replyTo: lastThreadAt(selection.a)?.id };
    return { time: nowTime(), replyTo: focusIds.length ? focusIds.at(-1) : undefined };
  }

  function sendAsk() {
    const question = ui.ta.value.trim();
    if (!question || pending) return;
    const rid = Math.random().toString(36).slice(2);
    awaitingThread = true;
    if (!send({ type: "ask", rid, question, frame: !!frameShot, ...askContext() })) {
      awaitingThread = false;
      return setStatus("pi is not connected", "err");
    }
    ui.sendBtn.disabled = true;
    setStatus("Sending…");
    pending = {
      rid,
      timer: setTimeout(() => {
        pending = null;
        awaitingThread = false;
        ui.sendBtn.disabled = false;
        setStatus("pi did not answer; is it still running?", "err");
        updateFootVisibility();
      }, 15000),
    };
    updateFootVisibility();
  }

  function onAck(msg) {
    if (!pending || pending.rid !== msg.rid) return;
    clearTimeout(pending.timer);
    pending = null;
    ui.sendBtn.disabled = false;
    if (!msg.ok) {
      awaitingThread = false;
      setStatus(msg.error || "Failed", "err");
      return updateFootVisibility();
    }
    ui.ta.value = "";
    frameShot = null;
    setStatus(msg.delivered === "queued" ? "Queued after the current task" : "", "ok");
    if (msg.delivered === "queued") setTimeout(() => setStatus(""), 2500);
    renderFoot();
  }

  ui.sendBtn.addEventListener("click", () => sendAsk());
  ui.frameBtn.addEventListener("click", () => setFrame(!frameShot));
  ui.ta.addEventListener("input", () => updateFootVisibility());
  ui.ta.addEventListener("focus", () => updateFootVisibility());
  ui.ta.addEventListener("blur", () => setTimeout(updateFootVisibility, 0));
  ui.dock.querySelector(".d-close").addEventListener("click", () => clearContext());
  ui.dock.addEventListener("click", (e) => {
    const jump = e.target.closest(".jump");
    if (jump) seek(Number(jump.dataset.t));
  });

  // ---------- rail: a slim scrollbar with marks for lines that have Q&A ----------
  let railFrame = 0;
  function renderRail() {
    cancelAnimationFrame(railFrame);
    railFrame = requestAnimationFrame(() => {
      ui.ticks.textContent = "";
      if (view === "cues") {
        const H = ui.cues.scrollHeight || 1;
        for (const row of ui.cues.querySelectorAll(".cue.asked")) {
          const top = ((row.offsetTop + row.offsetHeight / 2) / H) * 100;
          ui.ticks.append(el("button", { class: "tick", "data-i": row.dataset.i, title: fmt(cues[Number(row.dataset.i)]?.start), style: `top:${top}%` }));
        }
        const cur = rowOf(current);
        if (cur) ui.ticks.append(el("span", { class: "tick cur", style: `top:${((cur.offsetTop + cur.offsetHeight / 2) / H) * 100}%` }));
      }
      updateThumb();
    });
  }

  const activeList = () => (view === "cues" ? ui.cues : ui.qa);
  function updateThumb() {
    const box = activeList();
    const H = box.scrollHeight || 1;
    const visible = box.clientHeight / H;
    ui.rail.classList.toggle("none", visible >= 1);
    ui.thumb.style.top = `${(box.scrollTop / H) * 100}%`;
    ui.thumb.style.height = `${Math.max(4, visible * 100)}%`;
  }

  function markUserScroll() {
    if (Date.now() - programmatic < 400) return;
    if (mode === "side" && !userScrolled && view === "cues") {
      userScrolled = true;
      ui.now.classList.toggle("show", !!settings?.follow);
    }
  }

  ui.ticks.addEventListener("click", (e) => {
    const tick = e.target.closest(".tick[data-i]");
    if (!tick) return;
    markUserScroll();
    scrollToRow(rowOf(Number(tick.dataset.i)));
  });

  ui.rail.addEventListener("pointerdown", (e) => {
    if (e.target.closest(".tick")) return;
    const box = activeList();
    const rect = ui.rail.getBoundingClientRect();
    e.preventDefault();
    markUserScroll();
    if (e.target !== ui.thumb) box.scrollTop = ((e.clientY - rect.top) / rect.height) * box.scrollHeight - box.clientHeight / 2;
    const startY = e.clientY;
    const startTop = box.scrollTop;
    ui.rail.setPointerCapture(e.pointerId);
    ui.rail.classList.add("grab");
    const move = (ev) => (box.scrollTop = startTop + ((ev.clientY - startY) / rect.height) * box.scrollHeight);
    const up = () => {
      ui.rail.classList.remove("grab");
      ui.rail.removeEventListener("pointermove", move);
      ui.rail.removeEventListener("pointerup", up);
      ui.rail.removeEventListener("pointercancel", up);
    };
    ui.rail.addEventListener("pointermove", move);
    ui.rail.addEventListener("pointerup", up);
    ui.rail.addEventListener("pointercancel", up);
  });

  ui.cues.addEventListener("wheel", markUserScroll, { passive: true });
  ui.cues.addEventListener("touchmove", markUserScroll, { passive: true });
  ui.cues.addEventListener(
    "scroll",
    () => {
      updateThumb();
      // The wheel owns the scroll position; a stray scroll (Settings open) rolls back to the current line.
      if (mode === "full" && !flat && Date.now() - programmatic > 100) applyWheel();
    },
    { passive: true },
  );
  ui.qa.addEventListener("scroll", () => updateThumb(), { passive: true });

  // ---------- hover: decided by geometry, so the rail, gaps and the foot all count as "inside" ----------
  function inZone(x, y) {
    if (!settings || settings.collapsed) return false;
    if (mode === "side") {
      const r = ui.body.getBoundingClientRect();
      return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
    }
    const parts = [ui.body, ui.controls];
    if (ui.foot.classList.contains("show")) parts.push(ui.foot);
    if (sheet) parts.push(ui.sheet);
    const rects = parts.map((n) => n.getBoundingClientRect()).filter((r) => r.width);
    if (!rects.length) return false;
    // At rest only the lines themselves count, not the whole column: the video beside them stays usable.
    if (!hot && view === "cues" && wheelExtent) {
      const b = rects[0];
      rects[0] = { left: b.right - wheelExtent - 40, right: b.left + wheelExtent + 40, width: 1 };
    }
    // The whole strip at the screen edge, from the leftmost part to the edge.
    if (settings.side === "right") return x >= Math.min(...rects.map((r) => r.left)) - 16;
    return x <= Math.max(...rects.map((r) => r.right)) + 16;
  }

  function setHot(on) {
    if (on) {
      clearTimeout(hotTimer);
      hotTimer = 0;
      if (hot) return;
    } else {
      if (!hot || hotTimer) return;
      hotTimer = setTimeout(() => {
        hotTimer = 0;
        applyHot(false);
      }, 220);
      return;
    }
    applyHot(true);
  }

  function applyHot(on) {
    if (hot === on) return;
    hot = on;
    if (!on) dockPinned = false;
    ui.panel.classList.toggle("hot", on);
    syncFlat();
    updateFootVisibility();
    renderRail();
    if (!on && following()) centerCurrent(true);
  }

  let lastPointer = null;
  const onPointerMove = (e) => {
    lastPointer = { x: e.clientX, y: e.clientY };
    if (drag) return;
    setHot(inZone(e.clientX, e.clientY));
  };
  const onPointerOut = (e) => {
    if (!e.relatedTarget && !drag) setHot(false);
  };
  window.addEventListener("pointermove", onPointerMove, { capture: true, passive: true });
  document.addEventListener("pointerout", onPointerOut, { capture: true, passive: true });

  // ---------- list interaction: click seeks, press-and-drag selects, the end button appends ----------
  function rowAtPoint(x, y) {
    const r = ui.cues.getBoundingClientRect();
    const px = Math.min(r.right - 40, Math.max(r.left + 24, x));
    const py = Math.min(r.bottom - 2, Math.max(r.top + 2, y));
    return root.elementFromPoint(px, py)?.closest?.(".cue") ?? null;
  }

  let autoScroll = 0;
  function dragScroll() {
    if (!drag) return;
    const r = ui.cues.getBoundingClientRect();
    const edge = 56;
    let v = 0;
    if (drag.y < r.top + edge) v = -Math.ceil((r.top + edge - drag.y) / 4);
    else if (drag.y > r.bottom - edge) v = Math.ceil((drag.y - (r.bottom - edge)) / 4);
    if (v) {
      ui.cues.scrollTop += v;
      dragTo(drag.x, drag.y);
    }
    autoScroll = requestAnimationFrame(dragScroll);
  }

  function dragTo(x, y) {
    const row = rowAtPoint(x, y);
    if (row) drag.last = Number(row.dataset.i);
    selection = { a: Math.min(drag.start, drag.last), b: Math.max(drag.start, drag.last) };
    renderSelection();
  }

  ui.cues.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    const row = e.target.closest(".cue");
    if (!row || e.target.closest(".side")) return;
    const i = Number(row.dataset.i);
    drag = { start: i, last: i, x: e.clientX, y: e.clientY, x0: e.clientX, y0: e.clientY, moved: false, before: selection };
    ui.cues.setPointerCapture(e.pointerId);
  });

  ui.cues.addEventListener("pointermove", (e) => {
    if (!drag) return;
    drag.x = e.clientX;
    drag.y = e.clientY;
    if (!drag.moved) {
      if (Math.hypot(e.clientX - drag.x0, e.clientY - drag.y0) < 6) return;
      drag.moved = true;
      ui.panel.classList.add("dragging");
      syncFlat();
      autoScroll = requestAnimationFrame(dragScroll);
    }
    dragTo(e.clientX, e.clientY);
  });

  function endDrag(apply) {
    if (!drag) return;
    const d = drag;
    drag = null;
    cancelAnimationFrame(autoScroll);
    ui.panel.classList.remove("dragging");
    syncFlat();
    if (!apply || !d.moved) {
      selection = d.before;
      renderSelection();
      if (apply) seek(cues[d.start].start);
      return;
    }
    select(d.start, d.last);
    ui.ta.focus({ preventScroll: true });
  }
  ui.cues.addEventListener("pointerup", () => endDrag(true));
  ui.cues.addEventListener("pointercancel", () => endDrag(false));

  ui.cues.addEventListener("click", (e) => {
    const t = e.target;
    const row = t.closest(".cue");
    if (row && t.closest(".add")) return toggleLine(Number(row.dataset.i));
    if (row && t.closest(".dot")) {
      const th = lastThreadAt(Number(row.dataset.i));
      const r = th && rangeOf(th);
      if (r) select(r.a, r.b);
    }
  });

  ui.qa.addEventListener("click", (e) => {
    const jump = e.target.closest(".jump");
    if (jump) return seek(Number(jump.dataset.t));
    const fu = e.target.closest(".fu");
    if (!fu) return;
    const t = threads.get(fu.dataset.id);
    if (!t) return;
    const r = rangeOf(t);
    if (r) {
      setView("cues");
      select(r.a, r.b);
      requestAnimationFrame(() => scrollToRow(rowOf(r.a)));
    } else {
      selection = null;
      renderSelection();
      focusIds = [t.id];
      renderDock();
      renderFoot();
    }
    ui.ta.focus({ preventScroll: true });
  });

  ui.now.addEventListener("click", () => {
    userScrolled = false;
    ui.now.classList.remove("show");
    centerCurrent(true);
  });

  // ---------- views, sheets, settings ----------
  function setView(v) {
    if (v === view) return;
    view = v;
    ui.panel.dataset.view = v;
    ui.seg.style.setProperty("--i", v === "cues" ? "0" : "1");
    ui.segCues.classList.toggle("on", v === "cues");
    ui.segQa.classList.toggle("on", v === "qa");
    ui.cues.classList.toggle("active", v === "cues");
    ui.qa.classList.toggle("active", v === "qa");
    ui.viewBtn.replaceChildren(icon(v === "cues" ? "chat" : "list"));
    ui.viewBtn.title = v === "cues" ? "Show Q&A (Alt+Q)" : "Show subtitles (Alt+Q)";
    ui.now.classList.toggle("show", v === "cues" && userScrolled && mode === "side" && !!settings?.follow);
    if (v === "qa") {
      renderQa();
      ui.qa.scrollTop = ui.qa.scrollHeight;
    } else if (!userScrolled || mode === "full") centerCurrent(false);
    renderRail();
  }
  ui.segCues.addEventListener("click", () => setView("cues"));
  ui.segQa.addEventListener("click", () => setView("qa"));
  ui.viewBtn.addEventListener("click", () => setView(view === "cues" ? "qa" : "cues"));

  function renderMeta() {
    if (!meta) {
      ui.course.textContent = location.hostname;
      ui.title.textContent = "No video recognised on this page";
      return;
    }
    ui.course.textContent = meta.course || meta.siteLabel || "";
    ui.course.hidden = !ui.course.textContent;
    ui.title.textContent = `${meta.episode ? `E${meta.episode}${meta.total ? `/${meta.total}` : ""} · ` : ""}${meta.episodeTitle}`;
    ui.title.title = ui.title.textContent;
  }

  function renderCcBtn() {
    ui.ccBtn.classList.toggle("on", !!subtitle);
    ui.ccBtn.title = subtitle ? `Subtitle: ${subtitle.path}` : "Choose a subtitle file";
  }

  function openSheet(name, back = null) {
    const dir = !sheet ? "" : back ? "fwd" : sheet !== name && sheetBack === name ? "back" : "";
    sheet = name;
    sheetBack = back;
    if (name === "subs") send({ type: "files" });
    const r = ui.controls.getBoundingClientRect();
    ui.sheet.style.top = `${Math.round(r.bottom + 8)}px`;
    // Fullscreen Settings sit beside the wheel. Kept after closing, so the sheet fades out where it was.
    ui.sheet.classList.toggle("beside", mode === "full" && (name === "settings" || back === "settings"));
    renderSheet(dir || "in");
    ui.sheet.classList.add("open");
    syncTuning();
    if (name === "subs") subs.input?.focus({ preventScroll: true });
  }
  function closeSheet() {
    if (!sheet) return;
    sheet = null;
    sheetBack = null;
    ui.sheet.classList.remove("open");
    ui.ccBtn.classList.remove("active");
    ui.setBtn.classList.remove("active");
    // The sheet counted as part of the strip. If the pointer is now outside, leave at once rather than
    // opening the list for the usual exit delay.
    if (hot && lastPointer && !inZone(lastPointer.x, lastPointer.y)) {
      clearTimeout(hotTimer);
      hotTimer = 0;
      applyHot(false);
    }
    syncTuning();
  }
  function syncTuning() {
    ui.panel.classList.toggle("tuning", tuning());
    syncFlat();
    updateFootVisibility();
    placeOverlay();
  }
  ui.ccBtn.addEventListener("click", () => (sheet === "subs" ? closeSheet() : openSheet("subs")));
  ui.setBtn.addEventListener("click", () => (sheet === "settings" ? closeSheet() : openSheet("settings")));
  ui.hideBtn.addEventListener("click", () => changeSettings({ collapsed: true }));
  ui.reopen.addEventListener("click", () => changeSettings({ collapsed: false }));

  /** Rebuild the open sheet; `anim` slides the page in ("fwd", "back") or fades it ("in"). */
  function renderSheet(anim = "") {
    ui.ccBtn.classList.toggle("active", sheet === "subs");
    ui.setBtn.classList.toggle("active", sheet === "settings");
    if (!sheet) return;
    const page = el("div", { class: `s-page${anim ? ` page-${anim}` : ""}` });
    if (sheet === "settings") renderSettingsSheet(page);
    else renderSubsSheet(page);
    const scroll = ui.sheet.querySelector(".s-page .s-body")?.scrollTop ?? 0;
    ui.sheet.replaceChildren(page);
    if (!anim) {
      const b = page.querySelector(".s-body");
      if (b && sheet === "settings") b.scrollTop = scroll;
    }
  }

  // Settings: an inset grouped list.
  const sw = (key) => el("button", { class: `switch${settings[key] ? " on" : ""}`, "data-set": key, "data-toggle": "1", role: "switch", "aria-checked": String(!!settings[key]) }, el("i"));
  const stepper = (key, step, digits = 0) =>
    el(
      "span",
      { class: "stepper" },
      el("button", { "data-set": key, "data-step": -step, text: "−" }),
      el("span", { class: "val", text: digits ? Number(settings[key]).toFixed(digits) : String(Math.round(settings[key])) }),
      el("button", { "data-set": key, "data-step": step, text: "+" }),
    );
  const segmented = (key, options) => {
    const i = Math.max(0, options.findIndex(([v]) => settings[key] === v));
    return el(
      "span",
      { class: "segmented", style: `--n:${options.length};--i:${i}` },
      options.map(([v, label]) => el("button", { class: settings[key] === v ? "on" : "", "data-set": key, "data-value": v, text: label })),
    );
  };
  const row = (label, control) => el("div", { class: "s-row" }, el("span", { class: "s-label", text: label }), control);
  const resetRow = (label, keys) => el("button", { class: "s-row link", "data-act": "reset", "data-keys": keys.join(",") }, el("span", { class: "s-label accent", text: label }));
  const group = (title, ...rows) => el("section", { class: "group" }, title ? el("h4", { text: title }) : null, el("div", { class: "rows" }, rows));
  const sheetHead = (title, ...extra) =>
    el(
      "div",
      { class: "s-head" },
      sheetBack ? el("button", { class: "ib small back", title: "Back", onclick: () => openSheet(sheetBack) }, icon("back")) : null,
      el("span", { class: "s-title", text: title }),
      ...extra,
      el("button", { class: "ib small", title: "Close", onclick: () => closeSheet() }, icon("close")),
    );

  function renderSettingsSheet(page) {
    if (!settings) return;
    page.append(
      sheetHead("Settings"),
      el(
        "div",
        { class: "s-body" },
        meta
          ? group(
              "Now watching",
              el(
                "div",
                { class: "s-now" },
                meta.course ? el("div", { class: "s-course", text: meta.course }) : null,
                el("div", { class: "s-ep", text: `${meta.episode ? `E${meta.episode}${meta.total ? `/${meta.total}` : ""} · ` : ""}${meta.episodeTitle}` }),
                el("div", { class: "s-site", text: meta.siteLabel || location.hostname }),
              ),
            )
          : null,
        group(
          "Subtitles",
          el("button", { class: "s-row link", "data-act": "subs" }, el("span", { class: "s-label", text: "File" }), el("span", { class: "s-value", text: subtitle ? subtitle.path.split("/").pop() : "Off" }), icon("chevron")),
          row("Hide site captions", sw("hideNative")),
        ),
        group(
          "Annotations",
          row("Position", segmented("rubyPosition", [["under", "Below"], ["over", "Above"]])),
          row("Size (% of the text)", stepper("rubySize", 5)),
          row("Opacity (%)", stepper("rubyOpacity", 5)),
          resetRow("Reset the annotation style", RUBY_KEYS),
        ),
        group(
          "Line on the video",
          row("Show (side panel or panel hidden)", sw("overlay")),
          row("Text size", stepper("overlayFontSize", 2)),
          row("Weight", stepper("overlayWeight", 100)),
          row("Background (%)", stepper("overlayBg", 5)),
          row("Background blur (px)", stepper("overlayBlur", 2)),
          row("Text shadow (%)", stepper("overlayShadow", 10)),
          row("Corner radius (px)", stepper("overlayRadius", 2)),
          row("Height above the bottom (%)", stepper("overlayBottom", 1)),
          row("Widest (% of the video)", stepper("overlayWidth", 2)),
          resetRow("Reset the video line style", OVERLAY_KEYS),
        ),
        group(
          "Side panel",
          row("Width (px)", stepper("width", 20)),
          row("Text size", stepper("fontSize", 1)),
          row("Line spacing", stepper("lineHeight", 0.1, 1)),
        ),
        group("Fullscreen", row("Width (% of screen)", stepper("fullWidth", 1)), row("Text size", stepper("fullFontSize", 2))),
        group(
          "Fullscreen wheel",
          row("Wheel radius (% of height)", stepper("wheelRadius", 2)),
          row("Bend toward the edge (%)", stepper("wheelBend", 2)),
          row("Gap to the edge (px)", stepper("wheelEdge", 2)),
          row("Other lines: size (%)", stepper("wheelSize", 2)),
          row("Other lines: brightness (%)", stepper("wheelDim", 4)),
          row("Other lines: opacity (%)", stepper("wheelOpacity", 4)),
          row("Other lines: blur (px)", stepper("wheelBlur", 0.2, 1)),
          row("Current line: glow (%)", stepper("wheelGlow", 5)),
          row("Current line: weight (px)", stepper("wheelBold", 0.1, 1)),
          row("Open list: other lines (%)", stepper("listOpacity", 5)),
          resetRow("Reset the wheel style", WHEEL_KEYS),
        ),
        group(
          "Layout",
          row("Side", segmented("side", [["left", "Left"], ["right", "Right"]])),
          row("Page", segmented("layout", [["push", "Shrink"], ["overlay", "Float"]])),
          row("Panel tint", segmented("theme", [["dark", "Dark"], ["light", "Light"]])),
        ),
        group("Behaviour", row("Follow playback", sw("follow")), row("Terminal messages carry the time", sw("autoContext"))),
        el(
          "div",
          { class: "s-foot" },
          "Drag across lines, or click ⊕ at the end of each line, to select them. Click a line to jump to it.",
          el("br"),
          "Alt+A ask about the current line · Alt+Q subtitles / Q&A · Alt+S hide · Alt+↑/↓ previous / next line · Alt+R replay line",
        ),
      ),
    );
  }

  // Subtitle browser: the folder tree of the pi working directory, with fuzzy search.
  const subs = { input: null, list: null, query: "", active: 0, results: [], expanded: new Set(), expandedFor: null, autoOpened: false };

  function buildTree(paths) {
    const rootNode = { name: filesRoot || ".", path: "", dirs: new Map(), files: [], count: 0 };
    for (const p of paths) {
      const parts = p.split("/");
      let node = rootNode;
      node.count++;
      for (let k = 0; k < parts.length - 1; k++) {
        const name = parts[k];
        if (!node.dirs.has(name)) node.dirs.set(name, { name, path: parts.slice(0, k + 1).join("/"), dirs: new Map(), files: [], count: 0 });
        node = node.dirs.get(name);
        node.count++;
      }
      node.files.push({ name: parts.at(-1), path: p });
    }
    return rootNode;
  }

  /** Subsequence match per term; contiguous runs, word starts and file-name hits score higher. */
  function fuzzy(query, text) {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    const lower = text.toLowerCase();
    const base = lower.lastIndexOf("/") + 1;
    const hits = new Set();
    let score = 0;
    for (const term of terms) {
      let best = null;
      // Try every occurrence of the first character; keep the best-scoring alignment.
      for (let s = lower.indexOf(term[0]); s >= 0; s = lower.indexOf(term[0], s + 1)) {
        let pos = s;
        let sc = 0;
        const idx = [];
        let prev = -2;
        let ok = true;
        for (const ch of term) {
          const f = lower.indexOf(ch, pos);
          if (f < 0) {
            ok = false;
            break;
          }
          sc += f === prev + 1 ? 6 : 1;
          if (f === 0 || /[\s/_\-.[\](（【]/.test(lower[f - 1])) sc += 4;
          if (f >= base) sc += 2;
          idx.push(f);
          prev = f;
          pos = f + 1;
        }
        if (ok && (!best || sc > best.sc)) best = { sc, idx };
      }
      if (!best) return null;
      score += best.sc;
      for (const i of best.idx) hits.add(i);
    }
    return { score: score - text.length * 0.01, hits };
  }

  function highlighted(text, hits, offset) {
    const out = [];
    let run = "";
    let mark = false;
    for (let i = 0; i < text.length; i++) {
      const m = hits.has(i + offset);
      if (m !== mark && run) {
        out.push(mark ? el("mark", { text: run }) : run);
        run = "";
      }
      mark = m;
      run += text[i];
    }
    if (run) out.push(mark ? el("mark", { text: run }) : run);
    return out;
  }

  function renderSubsSheet(page) {
    subs.input = el("input", { class: "search-in", type: "text", placeholder: "Search subtitle files", spellcheck: "false" });
    subs.input.value = subs.query;
    subs.list = el("div", { class: "s-body files" });
    subs.input.addEventListener("input", () => {
      subs.query = subs.input.value;
      subs.active = 0;
      renderSubsList();
    });
    page.append(
      sheetHead("Subtitle file", el("button", { class: "ib small", title: "Rescan the folder", onclick: () => send({ type: "files" }) }, icon("refresh"))),
      el("label", { class: "search" }, icon("search"), subs.input),
      subs.list,
    );
    renderSubsList();
  }

  function expandForCurrent() {
    const cur = subtitle?.path ?? "";
    if (subs.expandedFor === cur) return;
    subs.expandedFor = cur;
    const parts = cur.split("/");
    for (let k = 1; k < parts.length; k++) subs.expanded.add(parts.slice(0, k).join("/"));
  }

  function renderSubsList() {
    const box = subs.list;
    if (!box) return;
    box.textContent = "";
    box.append(el("button", { class: `f-row off${subtitle ? "" : " on"}`, "data-path": "" }, icon("close"), el("span", { class: "f-name", text: "No subtitle" }), subtitle ? null : icon("check")));
    if (!files.length) {
      box.append(el("div", { class: "f-empty", text: "No .srt / .vtt / .ass files under the pi working directory." }));
      return;
    }
    const q = subs.query.trim();
    if (q) {
      subs.results = files
        .map((p) => ({ p, m: fuzzy(q, p) }))
        .filter((r) => r.m)
        .sort((x, y) => y.m.score - x.m.score)
        .slice(0, 80);
      subs.active = Math.min(subs.active, Math.max(0, subs.results.length - 1));
      if (!subs.results.length) box.append(el("div", { class: "f-empty", text: "No match" }));
      subs.results.forEach((r, k) => {
        const cut = r.p.lastIndexOf("/") + 1;
        box.append(
          el(
            "button",
            { class: `f-row file result${k === subs.active ? " active" : ""}${subtitle?.path === r.p ? " on" : ""}`, "data-path": r.p, title: r.p },
            icon("file"),
            el("span", { class: "f-stack" }, el("span", { class: "f-name" }, highlighted(r.p.slice(cut), r.m.hits, cut)), cut ? el("span", { class: "f-dir" }, highlighted(r.p.slice(0, cut - 1), r.m.hits, 0)) : null),
          ),
        );
      });
      return;
    }
    expandForCurrent();
    const tree = buildTree(files);
    // Folders that only wrap a single folder open by themselves, once.
    if (!subs.autoOpened) {
      subs.autoOpened = true;
      let n = tree;
      while (!n.files.length && n.dirs.size === 1) {
        n = [...n.dirs.values()][0];
        subs.expanded.add(n.path);
      }
    }
    const walk = (node, depth) => {
      for (const d of [...node.dirs.values()].sort((x, y) => collator.compare(x.name, y.name))) {
        const open = subs.expanded.has(d.path);
        box.append(
          el(
            "button",
            { class: `f-row dir${open ? " open" : ""}`, "data-dir": d.path, style: `--depth:${depth}`, title: d.path },
            el("span", { class: "chev" }, icon("chevron")),
            icon("folder"),
            el("span", { class: "f-name", text: d.name }),
            el("span", { class: "f-count", text: String(d.count) }),
          ),
        );
        if (open) walk(d, depth + 1);
      }
      for (const f of [...node.files].sort((x, y) => collator.compare(x.name, y.name))) {
        const on = subtitle?.path === f.path;
        box.append(
          el("button", { class: `f-row file${on ? " on" : ""}`, "data-path": f.path, style: `--depth:${depth}`, title: f.path }, el("span", { class: "chev" }), icon("file"), el("span", { class: "f-name", text: f.name }), on ? icon("check") : null),
        );
      }
    };
    walk(tree, 0);
    box.querySelector(".f-row.file.on")?.scrollIntoView({ block: "nearest" });
  }

  function chooseSubtitle(path) {
    send({ type: "subtitle", path });
    closeSheet();
  }

  function subsKey(e) {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!subs.results.length) return true;
      subs.active = (subs.active + (e.key === "ArrowDown" ? 1 : -1) + subs.results.length) % subs.results.length;
      renderSubsList();
      subs.list.querySelector(".f-row.active")?.scrollIntoView({ block: "nearest" });
      return true;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      const r = subs.results[subs.active];
      if (subs.query.trim() && r) chooseSubtitle(r.p);
      return true;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      if (subs.query) {
        subs.query = "";
        subs.input.value = "";
        renderSubsList();
      } else closeSheet();
      return true;
    }
    return false;
  }

  ui.sheet.addEventListener("click", (e) => {
    const dir = e.target.closest(".f-row.dir");
    if (dir) {
      const p = dir.dataset.dir;
      if (subs.expanded.has(p)) subs.expanded.delete(p);
      else subs.expanded.add(p);
      return renderSubsList();
    }
    const file = e.target.closest(".f-row[data-path]");
    if (file) return chooseSubtitle(file.dataset.path);
    if (e.target.closest('[data-act="subs"]')) return openSheet("subs", "settings");
    const reset = e.target.closest('[data-act="reset"]');
    if (reset) {
      if (defaults) changeSettings(Object.fromEntries(reset.dataset.keys.split(",").map((k) => [k, defaults[k]])));
      return;
    }
    const b = e.target.closest("[data-set]");
    if (!b || !settings) return;
    const key = b.dataset.set;
    if (b.dataset.toggle) changeSettings({ [key]: !settings[key] });
    else if (b.dataset.value) changeSettings({ [key]: b.dataset.value });
    else if (b.dataset.step) {
      const [min, max] = limits?.[key] ?? [-Infinity, Infinity];
      const next = Math.min(max, Math.max(min, Math.round((settings[key] + Number(b.dataset.step)) * 10) / 10));
      if (next !== settings[key]) changeSettings({ [key]: next });
    }
  });

  // A press anywhere else in the panel closes the sheet; so does one on the page.
  const onOutsidePress = (e) => {
    if (!sheet) return;
    const path = e.composedPath();
    if (path.includes(ui.sheet) || path.includes(ui.ccBtn) || path.includes(ui.setBtn)) return;
    closeSheet();
  };
  const onPagePress = (e) => !e.composedPath().includes(host) && onOutsidePress(e);
  root.addEventListener("pointerdown", onOutsidePress);
  window.addEventListener("pointerdown", onPagePress, true);

  function applySettings() {
    if (!settings) return;
    const s = settings;
    const p = ui.panel;
    p.style.setProperty("--wg", String(s.wheelGlow / 100));
    p.style.setProperty("--wb", `${s.wheelBold}px`);
    p.style.setProperty("--lo", String(s.listOpacity / 100));
    p.style.setProperty("--w", `${s.width}px`);
    p.style.setProperty("--fs", `${s.fontSize}px`);
    p.style.setProperty("--ffs", `${s.fullFontSize}px`);
    p.style.setProperty("--fwv", String(s.fullWidth));
    p.style.setProperty("--lh", String(s.lineHeight));
    // Annotations (ruby) appear in the list, the wheel and the line on the video, which sits outside the panel.
    for (const st of [p.style, ui.overlay.style]) {
      st.setProperty("--rtp", s.rubyPosition);
      st.setProperty("--rts", `${s.rubySize / 100}em`);
      st.setProperty("--rto", String(s.rubyOpacity / 100));
    }
    const o = ui.overlay.style;
    o.setProperty("--ofs", `${s.overlayFontSize}px`);
    o.setProperty("--obg", String(s.overlayBg / 100));
    o.setProperty("--oblur", `${s.overlayBlur}px`);
    o.setProperty("--ow", String(s.overlayWeight));
    o.setProperty("--osh", String(s.overlayShadow / 100));
    o.setProperty("--orad", `${s.overlayRadius}px`);
    for (const node of [p, ui.reopen, ui.toast]) {
      node.dataset.theme = mode === "full" ? "dark" : s.theme;
      node.dataset.side = s.side;
    }
    ui.reopen.dataset.mode = mode;
    p.classList.toggle("collapsed", !!s.collapsed);
    ui.reopen.classList.toggle("show", !!s.collapsed);
    if (s.collapsed) {
      closeSheet();
      applyHot(false);
    }
    ui.hideBtn.replaceChildren(icon(s.side === "right" ? "hide" : "hideLeft"));
    applyLayout();
    if (hideStyle) hideStyle.textContent = s.hideNative && cues.length && site ? site.hideNativeCss : "";
    placeOverlay();
    renderRail();
  }

  let lastLayout = "";
  function applyLayout() {
    const s = settings;
    const push = s && s.layout === "push" && !s.collapsed && mode === "side";
    // position:relative makes <html> the containing block of absolutely positioned app roots (YouTube's ytd-app).
    const css = push
      ? `html{margin-${s.side}:${s.width}px!important;position:relative!important}${(site?.pushCss?.[s.side] ?? "").replaceAll("{W}", String(s.width))}`
      : "";
    if (!layoutStyle || css === lastLayout) return;
    lastLayout = css;
    layoutStyle.textContent = css;
    // Players size themselves on resize; tell them the page width changed.
    window.dispatchEvent(new Event("resize"));
  }

  function changeSettings(patch) {
    settings = { ...settings, ...patch };
    applySettings();
    if (sheet === "settings") renderSheet();
    send({ type: "settings", settings });
    if (["fontSize", "fullFontSize", "fullWidth", "width", "lineHeight", "collapsed", "side", ...WHEEL_KEYS, ...RUBY_KEYS].some((k) => k in patch)) {
      requestAnimationFrame(() => {
        centerCurrent(false);
        applyWheel();
      });
    }
  }

  /** Fullscreen, or a player that fills the window (web fullscreen), switches to the wheel layout. */
  function detectMode() {
    let full = !!document.fullscreenElement;
    if (!full && video) {
      const r = video.getBoundingClientRect();
      full = r.width >= window.innerWidth * 0.97 && r.height >= window.innerHeight * 0.9;
    }
    const next = full ? "full" : "side";
    if (next === mode) return;
    mode = next;
    ui.panel.dataset.mode = mode;
    closeSheet();
    mount();
    applySettings();
    userScrolled = false;
    ui.now.classList.remove("show");
    applyHot(false);
    syncFlat();
    applyWheel();
    updateFootVisibility();
    replay(ui.panel, "mode-in");
    requestAnimationFrame(() => centerCurrent(false));
  }

  function placeOverlay() {
    const span = ui.overlay.firstChild;
    // Fullscreen shows it with the panel hidden, and while Settings are open so its style can be tuned.
    const on = settings?.overlay && cues.length && video && !inAd() && span.textContent && (mode === "side" || settings.collapsed || tuning());
    ui.overlay.hidden = !on;
    if (!on) return;
    const r = video.getBoundingClientRect();
    if (!r.width || !r.height) {
      ui.overlay.hidden = true;
      return;
    }
    ui.overlay.style.left = `${r.left + r.width / 2}px`;
    ui.overlay.style.bottom = `${Math.max(8, window.innerHeight - r.bottom + (r.height * settings.overlayBottom) / 100)}px`;
    ui.overlay.style.maxWidth = `${Math.round((r.width * settings.overlayWidth) / 100)}px`;
  }

  let toastTimer;
  function toast(text) {
    ui.toast.textContent = text;
    ui.toast.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => ui.toast.classList.remove("show"), 3500);
  }

  // ---------- shortcuts ----------
  function askCurrent() {
    const v = video || findVideo();
    if (v && !v.paused) v.pause();
    if (settings?.collapsed) changeSettings({ collapsed: false });
    if (view !== "cues") setView("cues");
    const i = v ? cueAt(v.currentTime + 0.05) : current;
    if (i >= 0 && cues.length) select(i);
    ui.ta.focus({ preventScroll: true });
  }

  function stepCue(delta) {
    if (!cues.length) return;
    const v = video || findVideo();
    const i = v ? cueAt(v.currentTime + 0.05) : current;
    const next = Math.min(cues.length - 1, Math.max(0, (i < 0 ? 0 : i) + delta));
    seek(cues[next].start);
  }

  function replayCue() {
    const v = video || findVideo();
    const i = v ? cueAt(v.currentTime + 0.05) : -1;
    if (!v || i < 0) return;
    seek(cues[i].start);
    if (v.paused) v.play().catch(() => undefined);
  }

  function globalKey(e) {
    switch (e.code) {
      case "KeyS":
        changeSettings({ collapsed: !settings?.collapsed });
        return true;
      case "KeyA":
        askCurrent();
        return true;
      case "KeyQ":
        if (settings?.collapsed) changeSettings({ collapsed: false });
        setView(view === "cues" ? "qa" : "cues");
        return true;
      case "ArrowUp":
        stepCue(-1);
        return true;
      case "ArrowDown":
        stepCue(1);
        return true;
      case "KeyR":
        replayCue();
        return true;
      default:
        return false;
    }
  }

  /** Escape peels one layer: the sheet, then the selection or follow-up, then the composer focus. */
  function escape() {
    if (sheet) closeSheet();
    else if (selection || focusIds.length || frameShot) {
      frameShot = null;
      clearContext();
    } else if (root.activeElement) root.activeElement.blur();
    else return false;
    return true;
  }

  function panelKey(e) {
    if (e.altKey && !e.ctrlKey && !e.metaKey && globalKey(e)) return e.preventDefault();
    // composedPath() stops at the host of a closed shadow root; the root itself knows what has focus.
    const focused = root.activeElement;
    if (focused === subs.input && subsKey(e)) return;
    if (focused === ui.ta && e.key === "Enter" && !e.shiftKey && !e.isComposing && e.keyCode !== 229) {
      e.preventDefault();
      return sendAsk();
    }
    if (e.key === "Escape") {
      e.preventDefault();
      escape();
    }
  }

  // Keys typed in the panel must not reach the site's hotkeys (k / space / f on YouTube). Our
  // window-level capture listener runs first and handles the panel's own keys itself.
  function onKey(e) {
    if (e.composedPath().includes(host)) {
      if (e.type === "keydown") panelKey(e);
      e.stopImmediatePropagation();
      return;
    }
    if (e.type !== "keydown" || !settings) return;
    if (e.key === "Escape" && !e.altKey && (sheet || selection || focusIds.length)) {
      escape();
      return;
    }
    if (!e.altKey || e.ctrlKey || e.metaKey) return;
    if (globalKey(e)) {
      e.preventDefault();
      e.stopImmediatePropagation();
    }
  }
  for (const type of ["keydown", "keypress", "keyup"]) window.addEventListener(type, onKey, true);

  // Resize by dragging the inner edge (side layout).
  ui.resize.addEventListener("pointerdown", (e) => {
    if (!settings) return;
    e.preventDefault();
    ui.resize.setPointerCapture(e.pointerId);
    ui.panel.classList.add("resizing");
    const startX = e.clientX;
    const startW = settings.width;
    const move = (ev) => {
      const dx = ev.clientX - startX;
      const w = Math.min(900, Math.max(260, startW + (settings.side === "right" ? -dx : dx)));
      settings = { ...settings, width: Math.round(w) };
      applySettings();
    };
    const up = () => {
      ui.panel.classList.remove("resizing");
      ui.resize.removeEventListener("pointermove", move);
      ui.resize.removeEventListener("pointerup", up);
      send({ type: "settings", settings });
    };
    ui.resize.addEventListener("pointermove", move);
    ui.resize.addEventListener("pointerup", up);
  });

  const onFullscreen = () => {
    mount();
    detectMode();
    placeOverlay();
  };
  document.addEventListener("fullscreenchange", onFullscreen);
  const onResize = () => {
    placeOverlay();
    renderRail();
    if (mode === "full") requestAnimationFrame(applyWheel);
  };
  window.addEventListener("resize", onResize);

  timers.push(
    setInterval(attachVideo, 1000),
    setInterval(() => {
      detectMode();
      placeOverlay();
    }, 300),
  );

  // ---------- pi → panel ----------
  function setBusy(on) {
    busy = on;
    ui.dot.classList.toggle("on", busy);
    ui.dot.title = busy ? "pi is working" : "pi is idle";
  }

  function receive(msg) {
    switch (msg.type) {
      case "init":
        meta = msg.meta;
        settings = msg.settings;
        defaults = msg.defaults || null;
        limits = msg.limits || null;
        files = msg.files || [];
        filesRoot = msg.filesRoot || "";
        subtitle = msg.subtitle || null;
        cues = msg.cues || [];
        threads = new Map((msg.threads || []).map((t) => [t.id, t]));
        focusIds = [];
        dockKey = "";
        renderMeta();
        renderCcBtn();
        applySettings();
        renderCues();
        renderQa();
        renderDock();
        if (sheet) renderSheet();
        setBusy(!!msg.busy);
        break;
      case "meta":
        meta = msg.meta;
        renderMeta();
        if (sheet === "settings") renderSheet();
        break;
      case "cues":
        subtitle = msg.subtitle || null;
        cues = msg.cues || [];
        renderCcBtn();
        applySettings();
        renderCues();
        renderDock();
        if (sheet) renderSheet();
        break;
      case "files":
        files = msg.files || [];
        if (msg.filesRoot) filesRoot = msg.filesRoot;
        if (sheet === "subs") renderSubsList();
        break;
      case "settings":
        settings = msg.settings;
        applySettings();
        if (sheet === "settings") renderSheet();
        break;
      case "threads":
        threads = new Map((msg.threads || []).map((t) => [t.id, t]));
        focusIds = focusIds.filter((id) => threads.has(id));
        dockKey = "";
        renderMarks();
        renderQa();
        renderDock();
        renderFoot();
        break;
      case "thread":
        upsertThread(msg.thread);
        break;
      case "busy":
        setBusy(!!msg.busy);
        break;
      case "ack":
        onAck(msg);
        break;
      case "toast":
        toast(msg.text);
        break;
      case "detach":
        destroy();
        break;
    }
  }

  let destroyed = false;
  function destroy() {
    if (destroyed) return;
    destroyed = true;
    for (const t of timers) clearInterval(t);
    for (const type of ["keydown", "keypress", "keyup"]) window.removeEventListener(type, onKey, true);
    window.removeEventListener("pointermove", onPointerMove, true);
    window.removeEventListener("pointerdown", onPagePress, true);
    document.removeEventListener("pointerout", onPointerOut, true);
    document.removeEventListener("fullscreenchange", onFullscreen);
    window.removeEventListener("resize", onResize);
    if (video) for (const t of VIDEO_EVENTS) video.removeEventListener(t, onVideoEvent);
    for (const s of docStyles) s.remove();
    host.remove();
    if (lastLayout) window.dispatchEvent(new Event("resize"));
    document.removeEventListener(REPLACE_EVENT, destroy);
    if (document.documentElement.getAttribute(OWN.attr) === OWN.owner) document.documentElement.removeAttribute(OWN.attr);
    if (window.__piVideoPanel === api) delete window.__piVideoPanel;
  }

  function captureFrame(maxWidth) {
    const v = video || findVideo();
    if (!v || !v.videoWidth) throw new Error("No video frame is available");
    const scale = Math.min(1, (maxWidth || 1600) / v.videoWidth);
    const c = document.createElement("canvas");
    c.width = Math.round(v.videoWidth * scale);
    c.height = Math.round(v.videoHeight * scale);
    c.getContext("2d").drawImage(v, 0, 0, c.width, c.height);
    return c.toDataURL("image/jpeg", 0.85);
  }

  function videoRect() {
    const v = video || findVideo();
    if (!v) return null;
    const r = v.getBoundingClientRect();
    return { x: r.left + window.scrollX, y: r.top + window.scrollY, width: r.width, height: r.height };
  }

  const api = {
    receive,
    seek,
    destroy,
    captureFrame,
    videoRect,
    setHidden: (hidden) => (host.style.visibility = hidden ? "hidden" : ""),
    play: () => (video || findVideo())?.play().catch(() => undefined),
    pause: () => (video || findVideo())?.pause(),
  };
  window.__piVideoPanel = api;

  const boot = () => {
    // Marks the page as taken, so another pi session opens its own tab instead of sharing this one.
    document.documentElement.setAttribute(OWN.attr, OWN.owner);
    document.addEventListener(REPLACE_EVENT, destroy);
    layoutStyle = docStyle("pi-video-layout");
    hideStyle = docStyle("pi-video-hide");
    mount();
    attachVideo();
    renderMeta();
    renderFoot();
    send({ type: "hello" });
  };
  if (document.body) boot();
  else document.addEventListener("DOMContentLoaded", boot, { once: true });
});
