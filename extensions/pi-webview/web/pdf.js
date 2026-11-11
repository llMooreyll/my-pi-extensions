// PDF viewer (also office documents through their LibreOffice PDF rendition).
const PV = window.PiView;
const { cfg } = PV;
const vendor = (p) => new URL(`${cfg.base}/vendor/pdfjs-dist/${p}`, location.origin).href;
const stateKey = `pv-pdf:${cfg.doc}`;
const container = document.getElementById("viewerContainer");
const statusEl = document.getElementById("pdf-status");
const rail = document.getElementById("rail");
const unitLabel = cfg.unit === "slide" ? "SLIDE" : "P.";
const pageTexts = new Map();
let viewer = null;
let userScaled = false;
let regionMode = false;

function setStatus(title, detail = "", error = false) {
  statusEl.hidden = false;
  statusEl.classList.toggle("error", error);
  statusEl.querySelector("b").textContent = title;
  statusEl.querySelector("em").textContent = detail;
}

const elOf = (node) => (node?.nodeType === 1 ? node : node?.parentElement);
const norm = (s) => s.replace(/\s+/g, " ").trim();

function buildRail(count) {
  const frag = document.createDocumentFragment();
  for (let n = 1; n <= count; n++) {
    const b = document.createElement("button");
    b.textContent = String(n).padStart(2, "0");
    b.dataset.page = String(n);
    b.addEventListener("click", () => (viewer.currentPageNumber = n));
    frag.appendChild(b);
  }
  rail.replaceChildren(frag);
}

function markRail(n) {
  rail.querySelector("button.on")?.classList.remove("on");
  const b = rail.querySelector(`button[data-page="${n}"]`);
  b?.classList.add("on");
  b?.scrollIntoView({ block: "nearest" });
}

function pageEl(n) {
  return container.querySelector(`.page[data-page-number="${n}"]`);
}

function surrounding(page, text) {
  const full = pageTexts.get(page);
  const needle = norm(text).slice(0, 120);
  if (!full || !needle) return "";
  const at = full.indexOf(needle);
  if (at < 0) return full.slice(0, 1400);
  return full.slice(Math.max(0, at - 700), at + needle.length + 700);
}

// ── region capture: Alt+drag, or ▭ then drag ──
function setRegion(on) {
  regionMode = on;
  document.documentElement.classList.toggle("pv-region-mode", on);
  regionBtn.classList.toggle("on", on);
}
const regionBtn = PV.addTool("▭", "Mark a region to ask about (or Alt+drag), key R", () => setRegion(!regionMode));

function capture(page, r, pr) {
  const canvas = page.querySelector(".canvasWrapper canvas");
  let image;
  if (canvas?.width) {
    const cr = canvas.getBoundingClientRect();
    const sx = canvas.width / cr.width;
    const sy = canvas.height / cr.height;
    const cx = (pr.left + r.x - cr.left) * sx;
    const cy = (pr.top + r.y - cr.top) * sy;
    const cw = r.w * sx;
    const ch = r.h * sy;
    const k = Math.min(1, 1600 / Math.max(cw, ch));
    const out = document.createElement("canvas");
    out.width = Math.max(1, Math.round(cw * k));
    out.height = Math.max(1, Math.round(ch * k));
    out.getContext("2d").drawImage(canvas, cx, cy, cw, ch, 0, 0, out.width, out.height);
    image = out.toDataURL("image/png");
  }
  const box = { left: pr.left + r.x, top: pr.top + r.y, right: pr.left + r.x + r.w, bottom: pr.top + r.y + r.h };
  const words = [];
  for (const s of page.querySelectorAll(".textLayer span")) {
    const b = s.getBoundingClientRect();
    if (b.width && b.right > box.left && b.left < box.right && b.bottom > box.top && b.top < box.bottom) words.push(s.textContent);
  }
  const clamp01 = (v) => Math.min(1, Math.max(0, v));
  return {
    kind: "pdf",
    page: Number(page.dataset.pageNumber),
    text: norm(words.join(" ")),
    context: "",
    region: [r.x / pr.width, r.y / pr.height, r.w / pr.width, r.h / pr.height].map(clamp01),
    image,
  };
}

container.addEventListener(
  "pointerdown",
  (e) => {
    if (!(regionMode || e.altKey) || e.button !== 0) return;
    const page = e.target.closest?.(".page");
    if (!page) return;
    e.preventDefault();
    e.stopPropagation();
    document.getSelection()?.removeAllRanges();
    const pr = page.getBoundingClientRect();
    const x0 = e.clientX - pr.left;
    const y0 = e.clientY - pr.top;
    const box = document.createElement("div");
    box.className = "pv-marquee";
    page.appendChild(box);
    let r = { x: x0, y: y0, w: 0, h: 0 };
    const move = (ev) => {
      const x1 = Math.min(Math.max(ev.clientX - pr.left, 0), pr.width);
      const y1 = Math.min(Math.max(ev.clientY - pr.top, 0), pr.height);
      r = { x: Math.min(x0, x1), y: Math.min(y0, y1), w: Math.abs(x1 - x0), h: Math.abs(y1 - y0) };
      Object.assign(box.style, { left: `${r.x}px`, top: `${r.y}px`, width: `${r.w}px`, height: `${r.h}px` });
    };
    const up = () => {
      removeEventListener("pointermove", move);
      setRegion(false);
      if (r.w < 8 || r.h < 8) return box.remove();
      const anchor = capture(page, r, pr);
      PV.openSlip(anchor, { rect: () => box.getBoundingClientRect(), onClose: () => box.remove() });
    };
    addEventListener("pointermove", move);
    addEventListener("pointerup", up, { once: true });
  },
  true,
);

// Keep text selection from starting under a region drag.
container.addEventListener(
  "mousedown",
  (e) => {
    if (regionMode || e.altKey) e.preventDefault();
  },
  true,
);

// ── keyboard zoom ──
addEventListener("keydown", (e) => {
  if (!viewer || e.target instanceof HTMLElement && /^(INPUT|TEXTAREA)$/.test(e.target.tagName)) return;
  if (e.composedPath().some((n) => n.localName === "pv-overlay")) return;
  if ((e.key === "=" || e.key === "+") && (e.ctrlKey || !e.metaKey)) {
    e.preventDefault();
    userScaled = true;
    viewer.currentScale = Math.min(5, viewer.currentScale * 1.15);
  } else if (e.key === "-" && (e.ctrlKey || !e.metaKey)) {
    e.preventDefault();
    userScaled = true;
    viewer.currentScale = Math.max(0.3, viewer.currentScale / 1.15);
  } else if (e.key === "0") {
    userScaled = false;
    viewer.currentScaleValue = "page-width";
  } else if (e.key === "r" && !e.ctrlKey && !e.metaKey && !e.altKey) {
    setRegion(!regionMode);
  }
});
container.addEventListener(
  "wheel",
  (e) => {
    if (!viewer || !e.ctrlKey) return;
    e.preventDefault();
    userScaled = true;
    viewer.currentScale = Math.min(5, Math.max(0.3, viewer.currentScale * (e.deltaY < 0 ? 1.08 : 1 / 1.08)));
  },
  { passive: false },
);
addEventListener("resize", () => {
  if (viewer && !userScaled) viewer.currentScaleValue = "page-width";
});

PV.register({
  fromSelection(sel, range) {
    const page = elOf(range.startContainer)?.closest(".page");
    if (!page || !container.contains(page)) return null;
    const n = Number(page.dataset.pageNumber);
    const text = sel.toString();
    return { kind: "pdf", text, page: n, context: surrounding(n, text) };
  },
  label(anchor) {
    return `${unitLabel} ${anchor.page}${anchor.region ? " · ▭ region" : ""}`;
  },
  goto({ page }) {
    if (!viewer || !page) return;
    viewer.currentPageNumber = page;
    const el = pageEl(page);
    el?.classList.remove("pv-page-flash");
    void el?.offsetWidth;
    el?.classList.add("pv-page-flash");
  },
  locate(anchor) {
    if (anchor.kind !== "pdf") return null;
    const page = pageEl(anchor.page);
    if (!page) return null;
    if (anchor.region) {
      const [x, y, w, h] = anchor.region;
      return {
        el: page,
        box: true,
        rect: () => {
          const r = page.getBoundingClientRect();
          return new DOMRect(r.left + x * r.width, r.top + y * r.height, w * r.width, h * r.height);
        },
      };
    }
    const layer = page.querySelector(".textLayer");
    const range = anchor.text && layer?.childElementCount ? PV.findText(layer, anchor.text) : null;
    if (range) return { el: page, range };
    // Text layer not rendered yet (or text not found): point at the top of the page.
    return {
      el: page,
      rect: () => {
        const r = page.getBoundingClientRect();
        return new DOMRect(r.left, r.top, r.width, 28);
      },
    };
  },
  clip() {
    return container.getBoundingClientRect();
  },
  reveal(anchor) {
    this.goto({ page: anchor.page });
  },
  converting() {
    setStatus("CONVERTING", "The source changed; LibreOffice is regenerating the PDF");
  },
  reload() {
    if (viewer) sessionStorage.setItem(stateKey, JSON.stringify({ scale: userScaled ? viewer.currentScale : null, top: container.scrollTop }));
    location.reload();
  },
});

async function main() {
  setStatus(cfg.kind === "office" ? "CONVERTING" : "RENDERING", cfg.kind === "office" ? "LibreOffice → PDF; the first open takes a few seconds" : "");
  let lib;
  let ui;
  try {
    lib = await import(vendor("build/pdf.mjs"));
    ui = await import(vendor("web/pdf_viewer.mjs")); // reads globalThis.pdfjsLib set by pdf.mjs
  } catch (e) {
    setStatus("MISSING", `Cannot load pdfjs-dist; run npm install in the pi-webview directory\n${e.message || e}`, true);
    return;
  }
  lib.GlobalWorkerOptions.workerSrc = vendor("build/pdf.worker.mjs");

  const saved = JSON.parse(sessionStorage.getItem(stateKey) || "null");
  sessionStorage.removeItem(stateKey);
  const hashPage = Number(/^#page=(\d+)$/.exec(location.hash)?.[1] || 0);

  const eventBus = new ui.EventBus();
  const linkService = new ui.PDFLinkService({ eventBus, externalLinkTarget: 2 /* BLANK */ });
  viewer = new ui.PDFViewer({ container, eventBus, linkService });
  linkService.setViewer(viewer);

  let doc;
  eventBus.on("pagesinit", () => {
    if (saved?.scale) {
      userScaled = true;
      viewer.currentScale = saved.scale;
    } else {
      viewer.currentScaleValue = "page-width";
    }
    if (saved) requestAnimationFrame(() => (container.scrollTop = saved.top));
    else if (hashPage) viewer.currentPageNumber = Math.min(hashPage, doc.numPages);
    buildRail(doc.numPages);
    markRail(viewer.currentPageNumber);
    statusEl.hidden = true;
    PV.relocate();
  });
  eventBus.on("pagechanging", ({ pageNumber }) => markRail(pageNumber));
  let relocateTimer;
  eventBus.on("textlayerrendered", async ({ pageNumber }) => {
    // Text layers are rebuilt on zoom; markers re-find their text.
    clearTimeout(relocateTimer);
    relocateTimer = setTimeout(PV.relocate, 120);
    if (pageTexts.has(pageNumber)) return;
    pageTexts.set(pageNumber, "");
    const page = await doc.getPage(pageNumber);
    const content = await page.getTextContent();
    pageTexts.set(pageNumber, norm(content.items.map((i) => (i.str ?? "") + (i.hasEOL ? "\n" : "")).join("")));
  });

  try {
    doc = await lib.getDocument({
      url: `${cfg.base}/raw/${cfg.doc}`,
      cMapUrl: vendor("cmaps/"),
      cMapPacked: true,
      standardFontDataUrl: vendor("standard_fonts/"),
      wasmUrl: vendor("wasm/"),
      iccUrl: vendor("iccs/"),
    }).promise;
  } catch (e) {
    let detail = e.message || String(e);
    try {
      const res = await fetch(`${cfg.base}/raw/${cfg.doc}`, { headers: { accept: "application/json" } });
      if (!res.ok) detail = (await res.json()).error || detail;
    } catch {}
    setStatus("FAILED", detail, true);
    return;
  }
  viewer.setDocument(doc);
  linkService.setDocument(doc, null);
}

main();
