// Markdown viewer: outline rail, source-line anchors, live re-render with changed blocks lit up.
const PV = window.PiView;
const { cfg } = PV;
const docEl = document.getElementById("doc");
const rail = document.getElementById("rail");
const titleEl = document.querySelector(".mast-title");
let spy = null;

const elOf = (node) => (node?.nodeType === 1 ? node : node?.parentElement);
const lineOf = (el) => Number(el.dataset.line);
const endOf = (el) => Number(el.dataset.lineEnd || el.dataset.line);

function slug(text, used) {
  let s = text.trim().toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "") || "section";
  const base = s;
  for (let i = 2; used.has(s); i++) s = `${base}-${i}`;
  used.add(s);
  return s;
}

function scrollToEl(el, flashClass = "pv-target") {
  el.scrollIntoView({ block: "center", behavior: "smooth" });
  el.classList.remove(flashClass);
  void el.offsetWidth;
  el.classList.add(flashClass);
}

/** The masthead already shows the title: hide a leading H1 that repeats it, and mark the opening paragraph. */
function dressDocument() {
  const first = docEl.firstElementChild;
  if (first?.tagName === "H1" && titleEl && first.textContent.trim() === titleEl.textContent.trim()) first.classList.add("pv-dup");
  const lead = [...docEl.children].slice(0, 3).find((el) => el.tagName === "P");
  if (lead && /^[\p{L}\p{N}]/u.test(lead.textContent.trim())) lead.classList.add("pv-lead");
}

function buildOutline() {
  spy?.disconnect();
  const used = new Set();
  const heads = [...docEl.querySelectorAll("h1, h2, h3")].filter((h) => !h.classList.contains("pv-dup"));
  const ol = document.createElement("ol");
  const links = new Map();
  heads.forEach((h, i) => {
    h.id ||= slug(h.textContent, used);
    const li = document.createElement("li");
    li.className = h.tagName === "H3" ? "l3" : "l2";
    const a = document.createElement("a");
    const n = document.createElement("span");
    n.textContent = String(i + 1).padStart(2, "0");
    a.append(n, h.textContent.trim());
    a.addEventListener("click", () => scrollToEl(h));
    li.appendChild(a);
    ol.appendChild(li);
    links.set(h, a);
  });
  const head = document.createElement("div");
  head.className = "rail-head";
  head.textContent = heads.length ? "CONTENTS" : "";
  rail.replaceChildren(head, ol);

  spy = new IntersectionObserver(
    (entries) => {
      const seen = entries.filter((e) => e.isIntersecting).map((e) => e.target);
      if (!seen.length) return;
      for (const a of links.values()) a.classList.remove("on");
      const a = links.get(seen[0]);
      a?.classList.add("on");
      a?.scrollIntoView({ block: "nearest" });
    },
    { rootMargin: "-70px 0px -70% 0px" },
  );
  heads.forEach((h) => spy.observe(h));
}

function headingPath(line) {
  const stack = [];
  for (const h of docEl.querySelectorAll("h1, h2, h3, h4, h5, h6")) {
    if (lineOf(h) > line) break;
    const level = Number(h.tagName[1]);
    while (stack.length && stack[stack.length - 1].level >= level) stack.pop();
    stack.push({ level, text: h.textContent.trim() });
  }
  return stack.map((s) => s.text);
}

function goto({ line }) {
  if (!line) return;
  let best = null;
  for (const el of docEl.querySelectorAll("[data-line]")) {
    if (lineOf(el) <= line && line <= endOf(el)) best = el; // later matches are nested deeper
    else if (lineOf(el) > line) break;
  }
  best ??= [...docEl.querySelectorAll("[data-line]")].filter((el) => lineOf(el) <= line).pop();
  if (best) scrollToEl(best.closest("pre") || best);
}

function collectMdBlocks(dragRect) {
  const hits = [];
  for (const el of docEl.querySelectorAll("[data-line]")) {
    const target = el.tagName === "CODE" && el.parentElement?.tagName === "PRE" ? el.parentElement : el;
    const r = PV.rectOf(target);
    if (!r) continue;
    const inter = PV.clipToRect(r, dragRect);
    if (!inter) continue;
    const cov = PV.rectArea(inter) / Math.max(1, PV.rectArea(r));
    const vCov = inter.height / Math.max(1, r.height);
    if (cov >= 0.3 || (vCov >= 0.6 && inter.width >= 20)) {
      hits.push({ el, rect: r, coverage: Math.max(cov, vCov * 0.85) });
    }
  }
  const kept = PV.pruneElements(hits, dragRect, docEl);
  const rects = kept.map((k) => k.rect);
  return { kept, rects, bbox: PV.unionRects(rects) };
}

function mergeLineRanges(blocks) {
  const raw = blocks
    .map((el) => [lineOf(el), Math.max(lineOf(el), endOf(el))])
    .filter(([s]) => s > 0)
    .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const merged = [];
  for (const [s, e] of raw) {
    const prev = merged[merged.length - 1];
    if (prev && s <= prev[1] + 1) prev[1] = Math.max(prev[1], e);
    else merged.push([s, e]);
  }
  return merged;
}

PV.register({
  fromSelection(sel, range) {
    const a = elOf(range.startContainer)?.closest("[data-line]");
    if (!a || !docEl.contains(a)) return null;
    let b = elOf(range.endContainer)?.closest("[data-line]");
    if (!b || !docEl.contains(b)) b = a;
    // Triple-click ends the range at offset 0 of the following block; that block is not selected.
    if (b !== a && range.endOffset === 0) {
      const all = [...docEl.querySelectorAll("[data-line]")];
      b = all[all.indexOf(b) - 1] || a;
    }
    const start = Math.min(lineOf(a), lineOf(b));
    const end = Math.max(endOf(a), endOf(b), start);
    return { kind: "md", text: PV.rangeText(range), lines: [start, end], headings: headingPath(start) };
  },
  marquee: {
    preview(dragRect) {
      const { kept, rects, bbox } = collectMdBlocks(dragRect);
      if (!kept.length || !bbox) return null;
      const ranges = mergeLineRanges(kept.map((k) => k.el));
      const label = ranges.length
        ? `${kept.length} block${kept.length > 1 ? "s" : ""} · L${ranges[0][0]}${ranges[ranges.length - 1][1] > ranges[0][0] ? `–${ranges[ranges.length - 1][1]}` : ""}`
        : "";
      return { rects, bbox, label };
    },
    finish(dragRect) {
      const { kept, rects, bbox } = collectMdBlocks(dragRect);
      if (!kept.length || !bbox) return null;
      const els = kept.map((k) => k.el);
      const ranges = mergeLineRanges(els);
      if (!ranges.length) return null;
      const start = ranges[0][0];
      const end = ranges[ranges.length - 1][1];
      const text = els
        .map((e) => (e.textContent || "").replace(/\s+/g, " ").trim())
        .filter(Boolean)
        .join("\n")
        .slice(0, 5000);
      return {
        anchor: {
          kind: "md",
          text,
          lines: [start, end],
          ...(ranges.length > 1 ? { ranges } : {}),
          box: true,
          headings: headingPath(start),
        },
        rects,
        bbox,
        label: `L${start}${end > start ? `–${end}` : ""}`,
        rectFn: () => PV.smartAnchorRect(els.map((e) => PV.rectOf(e.closest("pre") || e)).filter(Boolean)) || bbox,
        subRectsFn: () => els.map((e) => PV.rectOf(e.closest("pre") || e)).filter(Boolean),
        fullRectFn: () => PV.unionRects(els.map((e) => PV.rectOf(e.closest("pre") || e)).filter(Boolean)) || bbox,
      };
    },
  },
  label(anchor) {
    if (anchor.kind !== "md") return "";
    const [s, e] = anchor.lines;
    const h = anchor.headings[anchor.headings.length - 1];
    return `L${s}${e > s ? `–${e}` : ""}${h ? ` · ${h}` : ""}`;
  },
  goto,
  // Markers sit in the right margin, answers unfold at the width of the text column.
  gutter() {
    return docEl.getBoundingClientRect().right + 14;
  },
  drawerFrame() {
    const r = docEl.getBoundingClientRect();
    return { left: r.left - 18, width: r.width + 36 };
  },
  locate(anchor) {
    if (anchor.kind !== "md") return null;
    const [start, end] = anchor.lines;
    const blocks = [...docEl.querySelectorAll("[data-line]")];
    const block = blocks.find((el) => lineOf(el) === start) || blocks.filter((el) => lineOf(el) <= start).pop();
    if (!block) return null;
    if (anchor.box || anchor.ranges?.length) {
      const ranges = anchor.ranges?.length ? anchor.ranges : [[start, end]];
      const matched = blocks.filter((el) => {
        const s = lineOf(el);
        const e = endOf(el);
        return ranges.some(([rs, re]) => s >= rs && e <= re);
      });
      const els = matched.length ? matched : [block];
      const subRects = () => els.map((el) => PV.rectOf(el.closest("pre") || el)).filter(Boolean);
      return {
        els,
        el: els[0],
        box: true,
        subRects,
        fullRect: () => PV.unionRects(subRects()),
        rect: () => PV.smartAnchorRect(subRects()),
      };
    }
    const range = anchor.text ? PV.findText(docEl, anchor.text, block) : null;
    // A highlight over the drop cap paints a tall box above it; start after the initial letter.
    if (range?.startOffset === 0 && range.startContainer.parentElement?.closest("p.pv-lead") && !range.startContainer.previousSibling) range.setStart(range.startContainer, 1);
    if (range) return { el: block, range };
    // Text no longer found (edited): mark the whole source range.
    const last = blocks.filter((el) => lineOf(el) <= end && el.parentElement === block.parentElement).pop() || block;
    const whole = document.createRange();
    whole.setStartBefore(block.closest("pre") || block);
    whole.setEndAfter(last.closest("pre") || last);
    return { el: block, rect: () => whole.getBoundingClientRect(), box: true };
  },
  async reload() {
    // Keep the reader's place: remember the first block on screen and its offset.
    const firstVisible = [...docEl.querySelectorAll(":scope > [data-line]")].find((el) => el.getBoundingClientRect().bottom > 60);
    const keepLine = firstVisible ? lineOf(firstVisible) : 0;
    const keepTop = firstVisible?.getBoundingClientRect().top ?? 0;
    const before = new Set([...docEl.children].map((el) => el.innerHTML));
    let data;
    try {
      const res = await fetch(`${cfg.base}/md/${cfg.doc}`, { headers: { accept: "application/json" } });
      data = await res.json();
      if (!res.ok) throw new Error(data.error || res.statusText);
    } catch (e) {
      PV.toast(`Re-render failed: ${e.message || e}`, true);
      return;
    }
    PV.clearMarks();
    docEl.innerHTML = data.html;
    if (titleEl && data.title) {
      titleEl.textContent = data.title;
      const small = document.querySelector(".topbar .doc-title");
      if (small) small.textContent = data.title;
      document.title = `${data.title} — pi/view`;
    }
    dressDocument();
    buildOutline();
    let fresh = 0;
    for (const el of docEl.children) {
      if (!before.has(el.innerHTML)) {
        el.classList.add("pv-fresh");
        fresh++;
      }
    }
    const anchorEl = [...docEl.querySelectorAll(":scope > [data-line]")].filter((el) => lineOf(el) <= keepLine).pop();
    if (anchorEl) scrollBy(0, anchorEl.getBoundingClientRect().top - keepTop);
    PV.relocate();
    if (fresh) PV.toast(`↻ ${fresh} block${fresh > 1 ? "s" : ""} changed`);
  },
});

// Anchor links inside the document must not follow <base href>.
document.addEventListener("click", (e) => {
  const a = e.target.closest?.("a[href^='#']");
  if (!a || !docEl.contains(a)) return;
  const target = document.getElementById(decodeURIComponent(a.getAttribute("href").slice(1)));
  if (target) {
    e.preventDefault();
    scrollToEl(target);
  }
});

dressDocument();
buildOutline();
const hashLine = /^#L(\d+)$/.exec(location.hash);
if (hashLine) requestAnimationFrame(() => goto({ line: Number(hashLine[1]) }));
