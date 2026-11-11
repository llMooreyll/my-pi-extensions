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
  const cfg = {
    base: script.dataset.base,
    doc: script.dataset.doc,
    kind: script.dataset.kind,
    unit: script.dataset.unit || "page",
    file: script.dataset.file || "",
  };
  const viewer = cfg.kind !== "html";
  const scrollKey = `pv-scroll:${cfg.doc}`;
  const norm = (s) => (s || "").replace(/\s+/g, " ").trim();
  const keyOf = (a) =>
    [a.kind, a.lines ? a.lines.join("-") : "", a.page || "", a.region ? a.region.map((n) => n.toFixed(3)).join(",") : "", a.selector || "", norm(a.text).slice(0, 80)].join("|");
  const api = (path, init = {}) =>
    fetch(`${cfg.base}${path}`, { ...init, headers: { "content-type": "application/json", accept: "application/json", ...(init.headers || {}) } }).then(async (res) => {
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `${res.status} ${res.statusText}`);
      return data;
    });

  let adapter = null;
  let status = { online: false, busy: false, session: "", pinned: 0 };
  let pins = [];
  let threads = [];
  const pending = new Map(); // anchor key → { anchor, question, at }: asked, thread not seen yet
  const openDrawers = new Set();
  const locCache = new Map();
  let groups = [];
  let current = null; // the open slip: { anchor, range, rectFn, onClose }
  let pendingSel = null;
  let es = null;
  let ended = false;

  // ── shadow UI ──
  const host = document.createElement("pv-overlay");
  const root = host.attachShadow({ mode: "open" });
  root.innerHTML = `
    <link rel="stylesheet" href="${cfg.base}/vendor/katex/dist/katex.min.css">
    <link rel="stylesheet" href="${cfg.base}/assets/ui.css">
    <div class="layer boxes"></div>
    <div class="layer markers"></div>
    <div class="layer drawers"></div>
    <div class="tab" hidden><button class="t-ask">Ask <kbd>Enter</kbd></button><button class="t-pin">Pin</button></div>
    <section class="slip" hidden role="dialog" aria-label="Ask pi">
      <header><span class="no"></span><span class="loc"></span><button class="mode" title="Follow the selection when the page scrolls, or stay fixed on screen"></button></header>
      <div class="quote"></div>
      <textarea rows="3" placeholder="Ask about this…"></textarea>
      <footer><span class="hint">Enter ask · Shift+Enter newline<br>Ctrl+Enter pin · Esc close</span><button class="pin" title="Pin: send with your next message">Pin</button><button class="ask">Ask →</button></footer>
    </section>
    <aside class="panel" hidden>
      <header>
        <nav class="tabs"><button data-tab="wire">Wire</button><button data-tab="pins">Pins <b class="count"></b></button></nav>
        <button class="x" title="Close">✕</button>
      </header>
      <div class="filters" data-of="wire"><button data-filter="all">All</button><button data-filter="refs">From browser</button><button data-filter="doc">This document</button></div>
      <div class="filters" data-of="pins"><span class="note">Pins go out with your next message, from here or from pi.</span><button class="clear">Clear all</button></div>
      <div class="scroll" data-of="wire"></div>
      <div class="scroll" data-of="pins"></div>
      <footer class="composer">
        <div class="attach" hidden></div>
        <textarea rows="2" placeholder="Message pi…"></textarea>
        <button class="send">Send →</button>
      </footer>
    </aside>
    <div class="dock offline">
      <span class="state"><i></i><b>offline</b></span><span class="session"></span>
      <button class="d-pins" hidden title="Pinned references"></button>
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
  const connected = (loc) => loc.el?.isConnected && (!loc.range || loc.range.startContainer.isConnected);
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
      return { tail: r, body: r };
    }
    if (loc.range) {
      const rects = [...loc.range.getClientRects()].filter((r) => r.width > 0);
      if (rects.length) return { tail: rects[rects.length - 1], body: loc.range.getBoundingClientRect() };
    }
    const r = loc.el.getBoundingClientRect();
    return { tail: r, body: r };
  }
  function clipRect() {
    return adapter?.clip?.() || new DOMRect(0, viewer ? 46 : 0, innerWidth, innerHeight - (viewer ? 46 : 0));
  }
  /** Forget cached locations (after a re-render) and redraw. */
  function relocate() {
    locCache.clear();
    paint();
    schedule();
  }

  // ── highlights (CSS Custom Highlight API: no DOM mutation, host pages stay intact) ──
  const hlStyle = document.createElement("style");
  hlStyle.textContent =
    "::highlight(pv-asked){background-color:rgb(255 74 28/.16);text-decoration:underline 2px rgb(255 74 28);text-underline-offset:4px}" +
    "::highlight(pv-pinned){background-color:rgb(35 53 255/.14);text-decoration:underline 2px dotted rgb(35 53 255);text-underline-offset:4px}";
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

  // ── groups: one per distinct anchor on this page ──
  function buildGroups() {
    const map = new Map();
    const group = (anchor) => {
      const key = keyOf(anchor);
      if (!map.has(key)) map.set(key, { key, anchor, threads: [], pins: [], pending: null });
      return map.get(key);
    };
    for (const t of threads) for (const r of t.refs) if (r.docId === cfg.doc) group(r.anchor).threads.push(t);
    for (const p of pins) if (p.docId === cfg.doc) group(p.anchor).pins.push(p);
    for (const [key, p] of pending) {
      if (map.get(key)?.threads.some((t) => t.at >= p.at - 5000)) pending.delete(key);
      else group(p.anchor).pending = p;
    }
    groups = [...map.values()];
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
    drawers.replaceChildren();
    for (const g of groups) {
      const m = document.createElement("div");
      m.className = "marker";
      m.dataset.key = g.key;
      const asked = g.threads.length + (g.pending ? 1 : 0);
      if (asked) {
        const b = document.createElement("button");
        b.className = `chip asked${g.pending || g.threads.some((t) => t.status === "running") ? " live" : ""}${openDrawers.has(g.key) ? " open" : ""}`;
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
      markers.appendChild(m);
      const loc = locOf(g.anchor);
      if (loc?.box) {
        const box = document.createElement("div");
        box.className = `box${g.pins.length ? " pinned" : " asked"}`;
        box.dataset.key = g.key;
        boxes.appendChild(box);
      }
      if (openDrawers.has(g.key) && asked) drawers.appendChild(drawerEl(g));
    }
  }

  function drawerEl(g) {
    const d = document.createElement("section");
    d.className = "drawer";
    d.dataset.key = g.key;
    const head = document.createElement("header");
    const label = document.createElement("span");
    label.textContent = adapter?.label?.(g.anchor) || "";
    const close = document.createElement("button");
    close.textContent = "✕";
    close.title = "Collapse";
    close.addEventListener("click", () => toggleDrawer(g.key));
    head.append(label, close);
    const list = document.createElement("div");
    list.className = "list";
    for (const t of g.threads) list.appendChild(threadEl(t, false));
    if (g.pending) list.appendChild(pendingEl(g.pending));
    d.append(head, list);
    return d;
  }

  function toggleDrawer(key) {
    if (openDrawers.has(key)) openDrawers.delete(key);
    else openDrawers.add(key);
    renderMarkers();
    schedule();
  }

  // ── thread rendering, shared by drawers and the Wire tab ──
  const STATUS = { running: "Answering", done: "Done", aborted: "Stopped" };
  const time = (at) => new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

  function threadEl(t, withRefs) {
    const el = document.createElement("article");
    el.className = "th";
    el.dataset.thread = t.id;
    el.innerHTML = `<header><span class="st"></span><time></time></header><ul class="refs"></ul><p class="q"></p><div class="a md"></div><div class="act"></div>`;
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
    el.dataset.status = t.status;
    el.querySelector(".st").textContent = STATUS[t.status] || t.status;
    el.querySelector("time").textContent = time(t.at);
    const q = el.querySelector(".q");
    q.textContent = t.question || (t.refs.length ? "(references only)" : "");
    q.hidden = !q.textContent;
    const a = el.querySelector(".a");
    if (a.dataset.html !== t.html) {
      a.innerHTML = t.html || "";
      a.dataset.html = t.html || "";
    }
    a.classList.toggle("empty", !t.html);
    const act = el.querySelector(".act");
    act.textContent = t.activity ? `⚙ ${t.activity}` : t.status === "running" && !t.html ? "Thinking…" : "";
    act.hidden = !act.textContent;
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

  function openPanel(tabName = panelTab, focusPin = null) {
    panelTab = tabName;
    panel.hidden = false;
    $(".d-wire").classList.remove("unread");
    renderPanel();
    if (tabName === "wire") {
      const s = $('.scroll[data-of="wire"]');
      s.scrollTop = s.scrollHeight;
    }
    if (focusPin) {
      const card = root.querySelector(`.pin[data-pin="${focusPin}"]`);
      card?.scrollIntoView({ block: "nearest" });
      card?.querySelector("textarea")?.focus();
    }
  }
  function closePanel() {
    panel.hidden = true;
  }

  function renderPanel() {
    $(".count").textContent = pins.length ? String(pins.length) : "";
    for (const b of root.querySelectorAll(".tabs button")) b.classList.toggle("on", b.dataset.tab === panelTab);
    for (const el of root.querySelectorAll(".panel [data-of]")) el.hidden = el.dataset.of !== panelTab;
    for (const b of root.querySelectorAll("[data-filter]")) b.classList.toggle("on", b.dataset.filter === wireFilter);
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

  function renderWire() {
    const scroll = $('.scroll[data-of="wire"]');
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
    quote.textContent = p.anchor.region ? "▭ region of the page" : norm(p.anchor.text).slice(0, 280) || p.anchor.selector || "";
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
        const wire = $('.scroll[data-of="wire"]');
        const follow = wire.scrollHeight - wire.scrollTop - wire.clientHeight < 40;
        for (const el of root.querySelectorAll(`[data-thread="${t.id}"]`)) fillThread(el, t);
        if (follow) wire.scrollTop = wire.scrollHeight;
        schedule();
      }
    } else {
      threads.push(t);
      render();
    }
    const shown = !panel.hidden || t.refs.some((r) => r.docId === cfg.doc && openDrawers.has(keyOf(r.anchor)));
    if (!shown) $(".d-wire").classList.add("unread");
  }

  function connect() {
    es?.close();
    es = new EventSource(`${cfg.base}/events?doc=${encodeURIComponent(cfg.doc)}`);
    const on = (name, fn) => es.addEventListener(name, (e) => fn(e.data ? JSON.parse(e.data) : {}));
    on("hello", (s) => {
      setStatus({ ...s, online: true });
      threads = s.threads || [];
      setPins(s.pins || []);
    });
    on("status", (s) => setStatus({ ...s, online: true }));
    on("pins", setPins);
    on("threads", (list) => {
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
    for (const b of root.querySelectorAll(".box")) {
      const g = geomOf(b.dataset.key);
      b.hidden = !visible(g?.body);
      if (b.hidden) continue;
      Object.assign(b.style, { left: `${g.body.left - 3}px`, top: `${g.body.top - 3}px`, width: `${g.body.width + 6}px`, height: `${g.body.height + 6}px` });
    }
    for (const d of root.querySelectorAll(".drawer")) {
      const g = geomOf(d.dataset.key);
      d.hidden = !g?.body;
      if (d.hidden) continue;
      const frame = adapter?.drawerFrame?.();
      if (frame) d.style.width = `${frame.width}px`;
      const w = d.offsetWidth;
      const top = g.body.bottom + 10;
      // The drawer hangs below its anchor; hide it only once the drawer itself leaves the view.
      d.hidden = top > clip.bottom || top + d.offsetHeight < clip.top;
      const left = frame ? frame.left : g.body.left;
      d.style.left = `${Math.min(Math.max(16, left), innerWidth - w - 24)}px`;
      d.style.top = `${top}px`;
    }
    if (current && slipMode === "follow" && !slip.hidden) placeSlip();
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
    if (!slip.hidden) return;
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

  function openSlip(anchor, opts = {}) {
    closeSlip();
    current = { anchor, range: opts.range || null, rectFn: opts.rect || null, onClose: opts.onClose || null };
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
    slipText.focus({ preventScroll: true });
  }

  function closeSlip() {
    if (slip.hidden) return;
    slip.hidden = true;
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
        pending.set(key, { anchor, question, at: Date.now() });
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

  window.PiView = {
    cfg,
    register(a) {
      adapter = a;
      relocate();
    },
    openSlip,
    toast,
    addTool,
    outline,
    findText,
    rangeText,
    relocate,
    syncTheme,
  };
  connect();
})();
