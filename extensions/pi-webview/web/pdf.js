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
let pdfDoc = null;
let pdfLib = null;
let exportScale = 1;
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
  if (PV.exportMode) return;
  regionMode = on;
  document.documentElement.classList.toggle("pv-region-mode", on);
  regionBtn?.classList.toggle("on", on);
}
const regionBtn = PV.exportMode ? null : PV.addTool("▭", "Mark a region to ask about (or Alt+drag), key R", () => setRegion(!regionMode));

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
    if (PV.exportMode || !(regionMode || e.altKey) || e.ctrlKey || e.button !== 0) return;
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
      box.remove();
      if (r.w < 8 || r.h < 8) return;
      const anchor = capture(page, r, pr);
      const [rx, ry, rw, rh] = anchor.region;
      const pageNum = anchor.page;
      const liveRect = () => {
        const p = pageEl(pageNum);
        if (!p) return null;
        const rect = p.getBoundingClientRect();
        return new DOMRect(rect.left + rx * rect.width, rect.top + ry * rect.height, rw * rect.width, rh * rect.height);
      };
      PV.openSlip(anchor, { rect: liveRect, fullRect: liveRect, showBox: true, label: `${unitLabel} ${pageNum} · ▭` });
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
    if (!PV.exportMode && (regionMode || e.altKey)) e.preventDefault();
  },
  true,
);

function layoutExportPages() {
  const pages = [...container.querySelectorAll(".pv-export-page")];
  if (!pages.length) return;
  const availW = Math.max(280, container.clientWidth - 64);
  for (const p of pages) {
    const bw = Number(p.dataset.baseW) || 800;
    const bh = Number(p.dataset.baseH) || 1000;
    const targetW = userScaled ? bw * exportScale : Math.min(availW, bw);
    const ratio = targetW / bw;
    p.style.width = `${targetW.toFixed(1)}px`;
    p.style.height = `${(bh * ratio).toFixed(1)}px`;
    p.style.setProperty("--tl-scale", String(ratio));
  }
  PV.relocate();
}

// ── keyboard zoom ──
addEventListener("keydown", (e) => {
  if ((!viewer && !PV.exportMode) || (e.target instanceof HTMLElement && /^(INPUT|TEXTAREA)$/.test(e.target.tagName))) return;
  if (e.composedPath().some((n) => n.localName === "pv-overlay")) return;
  if ((e.key === "=" || e.key === "+") && (e.ctrlKey || !e.metaKey)) {
    e.preventDefault();
    userScaled = true;
    if (PV.exportMode) {
      exportScale = Math.min(3, exportScale * 1.15);
      layoutExportPages();
    } else {
      viewer.currentScale = Math.min(5, viewer.currentScale * 1.15);
    }
  } else if (e.key === "-" && (e.ctrlKey || !e.metaKey)) {
    e.preventDefault();
    userScaled = true;
    if (PV.exportMode) {
      exportScale = Math.max(0.3, exportScale / 1.15);
      layoutExportPages();
    } else {
      viewer.currentScale = Math.max(0.3, viewer.currentScale / 1.15);
    }
  } else if (e.key === "0") {
    userScaled = false;
    if (PV.exportMode) layoutExportPages();
    else viewer.currentScaleValue = "page-width";
  } else if (!PV.exportMode && e.key === "r" && !e.ctrlKey && !e.metaKey && !e.altKey) {
    setRegion(!regionMode);
  }
});
container.addEventListener(
  "wheel",
  (e) => {
    if ((!viewer && !PV.exportMode) || !e.ctrlKey) return;
    e.preventDefault();
    userScaled = true;
    const factor = e.deltaY < 0 ? 1.08 : 1 / 1.08;
    if (PV.exportMode) {
      exportScale = Math.min(3, Math.max(0.3, exportScale * factor));
      layoutExportPages();
    } else {
      viewer.currentScale = Math.min(5, Math.max(0.3, viewer.currentScale * factor));
    }
  },
  { passive: false },
);
addEventListener("resize", () => {
  if (PV.exportMode) {
    if (!userScaled) layoutExportPages();
  } else if (viewer && !userScaled) {
    viewer.currentScaleValue = "page-width";
  }
});

function collectPdfRegion(dragRect) {
  let bestPage = null;
  let bestPr = null;
  let bestInter = null;
  let bestArea = 0;
  for (const p of container.querySelectorAll(".page")) {
    const pr = p.getBoundingClientRect();
    const inter = PV.clipToRect(pr, dragRect);
    const a = PV.rectArea(inter);
    if (a > bestArea) {
      bestArea = a;
      bestPage = p;
      bestPr = pr;
      bestInter = inter;
    }
  }
  if (!bestPage || !bestPr || !bestInter || bestInter.width < 4 || bestInter.height < 4) return null;

  const spanRects = [];
  for (const s of bestPage.querySelectorAll(".textLayer span")) {
    if (!s.textContent || !s.textContent.trim()) continue;
    const sr = s.getBoundingClientRect();
    if (sr.width <= 0.5 || sr.height <= 0.5) continue;
    const inter = PV.clipToRect(sr, bestInter);
    if (!inter) continue;
    const cov = PV.rectArea(inter) / Math.max(1, PV.rectArea(sr));
    const cx = (sr.left + sr.right) / 2;
    const cy = (sr.top + sr.bottom) / 2;
    const centerIn = cx >= bestInter.left && cx <= bestInter.right && cy >= bestInter.top && cy <= bestInter.bottom;
    if (cov >= 0.35 || centerIn) spanRects.push(sr);
  }

  let bbox = PV.unionRects(spanRects);
  if (bbox) {
    const pad = 3;
    bbox = PV.clipToRect(new DOMRect(bbox.left - pad, bbox.top - pad, bbox.width + pad * 2, bbox.height + pad * 2), bestPr) || bestInter;
  } else {
    bbox = bestInter;
  }
  return { page: bestPage, pageNum: Number(bestPage.dataset.pageNumber), pr: bestPr, rects: spanRects, bbox };
}

PV.register({
  fromSelection(sel, range) {
    const page = elOf(range.startContainer)?.closest(".page");
    if (!page || !container.contains(page)) return null;
    const n = Number(page.dataset.pageNumber);
    const text = sel.toString();
    return { kind: "pdf", text, page: n, context: surrounding(n, text) };
  },
  marquee: {
    preview(dragRect) {
      const hit = collectPdfRegion(dragRect);
      if (!hit) return null;
      return {
        rects: hit.rects,
        bbox: hit.bbox,
        label: `${unitLabel} ${hit.pageNum}${hit.rects.length ? ` · ${hit.rects.length} spans` : " · ▭"}`,
      };
    },
    finish(dragRect) {
      const hit = collectPdfRegion(dragRect);
      if (!hit || hit.bbox.width < 8 || hit.bbox.height < 8) return null;
      const { page, pageNum, pr, rects, bbox } = hit;
      const anchor = capture(page, { x: bbox.left - pr.left, y: bbox.top - pr.top, w: bbox.width, h: bbox.height }, pr);
      if (anchor.text) anchor.context = surrounding(pageNum, anchor.text);
      const [rx, ry, rw, rh] = anchor.region;
      const liveRect = () => {
        const p = pageEl(pageNum);
        if (!p) return bbox;
        const r = p.getBoundingClientRect();
        return new DOMRect(r.left + rx * r.width, r.top + ry * r.height, rw * r.width, rh * r.height);
      };
      return {
        anchor,
        rects,
        bbox,
        label: `${unitLabel} ${pageNum} · ▭`,
        rectFn: liveRect,
        fullRectFn: liveRect,
      };
    },
  },
  label(anchor) {
    return `${unitLabel} ${anchor.page}${anchor.region ? " · ▭ region" : ""}`;
  },
  goto({ page }) {
    if (!page) return;
    if (PV.exportMode) {
      const el = pageEl(page);
      if (!el) return;
      el.scrollIntoView({ block: "start", behavior: "smooth" });
      markRail(page);
      el.classList.remove("pv-page-flash");
      void el.offsetWidth;
      el.classList.add("pv-page-flash");
      return;
    }
    if (!viewer) return;
    viewer.currentPageNumber = page;
    const el = pageEl(page);
    el?.classList.remove("pv-page-flash");
    void el?.offsetWidth;
    el?.classList.add("pv-page-flash");
  },
  exportInfo(annotatedSet) {
    const total = pdfDoc?.numPages || 0;
    const annotated = [...annotatedSet].filter((n) => Number.isInteger(n) && n >= 1 && n <= total).sort((a, b) => a - b);
    return { total, annotated };
  },
  async prepareExport(pageNums) {
    if (!pdfDoc || !pdfLib) throw new Error("PDF is still loading");
    const list = pageNums?.length ? pageNums : Array.from({ length: pdfDoc.numPages }, (_, i) => i + 1);
    const out = [];
    for (const num of list) {
      const page = await pdfDoc.getPage(num);
      const baseVp = page.getViewport({ scale: 1 });
      const scale = Math.min(2, Math.max(1, 1240 / Math.max(1, baseVp.width)));
      const vp = page.getViewport({ scale });
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(vp.width);
      canvas.height = Math.round(vp.height);
      const ctx = canvas.getContext("2d");
      await page.render({ canvasContext: ctx, viewport: vp }).promise;
      let image = canvas.toDataURL("image/webp", 0.86);
      if (!image.startsWith("data:image/webp")) image = canvas.toDataURL("image/png");

      const content = await page.getTextContent();
      const spans = [];
      for (const item of content.items) {
        if (!item.str) continue;
        const tx = pdfLib.Util.transform(vp.transform, item.transform);
        const fontSize = Math.max(4, Math.hypot(tx[2], tx[3]) || Math.hypot(tx[0], tx[1]) || 12);
        const left = tx[4];
        const top = tx[5] - fontSize * 0.85;
        const angle = Math.atan2(tx[1], tx[0]);
        const transform = Math.abs(angle) > 0.01 ? `rotate(${angle.toFixed(4)}rad)` : undefined;
        spans.push({ text: item.str, left, top, fontSize, ...(transform ? { transform } : {}) });
      }
      out.push({ page: num, width: canvas.width, height: canvas.height, image, spans });
    }
    return out;
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
  pdfDoc = doc;
  pdfLib = lib;
  viewer.setDocument(doc);
  linkService.setDocument(doc, null);
}

function initExportedPdf() {
  const pages = [...container.querySelectorAll(".pv-export-page")];
  if (!pages.length) return;
  const frag = document.createDocumentFragment();
  for (const p of pages) {
    const n = Number(p.dataset.pageNumber);
    const b = document.createElement("button");
    b.textContent = String(n).padStart(2, "0");
    b.dataset.page = String(n);
    b.addEventListener("click", () => {
      p.scrollIntoView({ block: "start", behavior: "smooth" });
      markRail(n);
    });
    frag.appendChild(b);
  }
  rail.replaceChildren(frag);
  markRail(Number(pages[0].dataset.pageNumber));
  container.addEventListener(
    "scroll",
    () => {
      const top = container.getBoundingClientRect().top + 80;
      let cur = pages[0];
      for (const p of pages) {
        if (p.getBoundingClientRect().top <= top) cur = p;
        else break;
      }
      if (cur) markRail(Number(cur.dataset.pageNumber));
    },
    { passive: true },
  );
  layoutExportPages();
}

if (PV.exportMode) initExportedPdf();
else main();
