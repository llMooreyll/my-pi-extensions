// Injected into local HTML pages: select text, or pick an element (◎, or Alt+click) to ask about it.
(() => {
  const PV = window.PiView;
  if (!PV) return;
  let picking = false;

  const ours = (e) => e.composedPath().some((n) => n.localName === "pv-overlay");
  const pickBtn = PV.addTool("◎", "Pick an element to ask about (or Alt+click)", () => setPick(!picking));

  function setPick(on) {
    picking = on;
    pickBtn.classList.toggle("on", on);
    document.documentElement.style.cursor = on ? "crosshair" : "";
    if (!on) PV.outline(null);
  }

  function isUnique(sel, el) {
    try {
      const m = document.querySelectorAll(sel);
      return m.length === 1 && m[0] === el;
    } catch {
      return false;
    }
  }

  const UNIQUE_ATTRS = ["data-testid", "data-id", "name", "aria-label", "href"];

  function segmentOf(n) {
    if (n.id) {
      const idSel = `#${CSS.escape(n.id)}`;
      if (isUnique(idSel, n)) return { sel: idSel, anchor: true };
    }
    for (const attr of UNIQUE_ATTRS) {
      const val = n.getAttribute(attr);
      if (!val || val.length > 60 || /[\r\n]/.test(val)) continue;
      const attrSel = `${n.localName}[${attr}="${CSS.escape(val)}"]`;
      if (isUnique(attrSel, n)) return { sel: attrSel, anchor: true };
    }
    let s = n.localName;
    const cls = [...n.classList]
      .filter((c) => c.length <= 40 && !/^(is-|has-|active$|hover$|focus|selected$|open$|pv-)/.test(c))
      .slice(0, 2);
    if (cls.length) s += "." + cls.map((c) => CSS.escape(c)).join(".");
    if (n.parentElement) {
      const kids = [...n.parentElement.children];
      const same = kids.filter((c) => c.localName === n.localName);
      if (same.length > 1) {
        let matched = same.length;
        if (cls.length) {
          try {
            matched = kids.filter((c) => c.matches(s)).length;
          } catch {
            matched = same.length;
          }
        }
        if (matched !== 1) s += `:nth-of-type(${same.indexOf(n) + 1})`;
      }
    }
    return { sel: s, anchor: false };
  }

  function cssPath(el) {
    if (!el || el.nodeType !== 1) return "";
    if (el === document.documentElement || el === document.body) return el.localName;
    const parts = [];
    for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
      const { sel, anchor } = segmentOf(n);
      parts.unshift(sel);
      const candidate = parts.join(" > ");
      if (isUnique(candidate, el)) return candidate;
      if (anchor || n === document.documentElement || parts.length >= 16) break;
    }
    return parts.join(" > ");
  }

  const ownText = (el) =>
    [...el.childNodes]
      .filter((n) => n.nodeType === 3)
      .map((n) => n.textContent)
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();

  function compactOuter(el) {
    const tag = el.localName;
    const attrs = [];
    if (el.id) attrs.push(`id="${el.id}"`);
    if (el.classList.length) attrs.push(`class="${[...el.classList].slice(0, 4).join(" ")}"`);
    const open = attrs.length ? `<${tag} ${attrs.join(" ")}>` : `<${tag}>`;
    const txt = (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim();
    if (!txt) return open;
    const snippet = txt.length > 60 ? `${txt.slice(0, 60).trimEnd()}…` : txt;
    return `${open}${snippet}</${tag}>`;
  }

  function elementAnchor(el) {
    return {
      kind: "html",
      text: "",
      selector: cssPath(el),
      tag: el.localName,
      outer: compactOuter(el),
      hint: { id: el.id || undefined, classes: [...el.classList], text: ownText(el).slice(0, 80) || undefined },
      preview: (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim(),
    };
  }

  function short(selector) {
    const parts = selector.split(" > ");
    return parts.length > 2 ? `… > ${parts.slice(-2).join(" > ")}` : selector;
  }

  document.addEventListener(
    "mousemove",
    (e) => {
      if (!(picking || e.altKey) || ours(e) || !(e.target instanceof Element)) return PV.outline(null);
      PV.outline(e.target.getBoundingClientRect(), short(cssPath(e.target)));
    },
    true,
  );

  for (const type of ["mousedown", "mouseup", "pointerdown", "pointerup"]) {
    document.addEventListener(
      type,
      (e) => {
        if ((picking || e.altKey) && !e.ctrlKey && !ours(e)) {
          e.preventDefault();
          e.stopImmediatePropagation();
        }
      },
      true,
    );
  }

  document.addEventListener(
    "click",
    (e) => {
      if (!(picking || e.altKey) || e.ctrlKey || ours(e) || !(e.target instanceof Element)) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      const el = e.target;
      setPick(false);
      PV.outline(null);
      PV.openSlip(elementAnchor(el), {
        rect: () => PV.rectOf(el) || el.getBoundingClientRect(),
        label: short(cssPath(el)),
        showBox: true,
      });
    },
    true,
  );

  addEventListener("keydown", (e) => {
    if (e.key === "Escape" && picking) setPick(false);
  });
  addEventListener("keyup", (e) => {
    if (e.key === "Alt" && !picking) PV.outline(null);
  });

  const SKIP_TAGS = new Set(["HTML", "BODY", "SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "LINK", "META", "BR", "HR", "PV-OVERLAY"]);
  const LEAF_TAGS = new Set(["P", "H1", "H2", "H3", "H4", "H5", "H6", "LI", "TD", "TH", "DT", "DD", "BLOCKQUOTE", "PRE", "CODE", "A", "BUTTON", "LABEL", "INPUT", "IMG", "SVG", "FIGURE", "FIGCAPTION", "SPAN", "STRONG", "EM", "VIDEO", "CANVAS"]);

  function collectHtmlElements(dragRect) {
    const root = document.body;
    if (!root) return { kept: [], rects: [], bbox: null };
    const hits = [];

    const walk = (node) => {
      for (const el of node.children) {
        if (SKIP_TAGS.has(el.tagName)) continue;
        const r = PV.rectOf(el);
        if (!r) continue;
        const cs = getComputedStyle(el);
        const clippedContainer = cs.overflowX !== "visible" || cs.overflowY !== "visible";
        const inter = PV.clipToRect(r, dragRect);
        if (!inter) {
          if (!clippedContainer && el.children.length) walk(el);
          continue;
        }
        const area = Math.max(1, PV.rectArea(r));
        const cov = PV.rectArea(inter) / area;
        const cx = (r.left + r.right) / 2;
        const cy = (r.top + r.bottom) / 2;
        const centerIn = cx >= dragRect.left && cx <= dragRect.right && cy >= dragRect.top && cy <= dragRect.bottom;

        // Treat compact <svg> as an atomic object instead of exploding into hundreds of <path> nodes.
        if (el.tagName === "SVG" && cov >= 0.4) {
          hits.push({ el, rect: r, coverage: cov });
          continue;
        }

        const isLeaf = LEAF_TAGS.has(el.tagName) || el.children.length === 0;
        if ((isLeaf && (cov >= 0.35 || centerIn)) || (!isLeaf && cov >= 0.55)) {
          hits.push({ el, rect: r, coverage: cov });
        }
        if (el.children.length && el.tagName !== "SVG") walk(el);
      }
    };

    walk(root);
    const kept = PV.pruneElements(hits, dragRect, root);
    const rects = kept.map((k) => k.rect);
    return { kept, rects, bbox: PV.unionRects(rects) };
  }

  function itemOf(el) {
    return {
      selector: cssPath(el),
      tag: el.localName,
      outer: compactOuter(el),
      hint: { id: el.id || undefined, classes: [...el.classList], text: ownText(el).slice(0, 80) || undefined },
    };
  }

  PV.register({
    fromSelection(sel, range) {
      const common = range.commonAncestorContainer;
      const el = common.nodeType === 1 ? common : common.parentElement;
      if (!el || el.closest("pv-overlay")) return null;
      const text = PV.rangeText(range);
      return {
        kind: "html",
        text,
        selector: cssPath(el),
        tag: el.localName,
        hint: { id: el.id || undefined, classes: [...el.classList], text: text.replace(/\s+/g, " ").trim().slice(0, 80) },
      };
    },
    marquee: {
      preview(dragRect) {
        const { kept, rects, bbox } = collectHtmlElements(dragRect);
        if (!kept.length || !bbox) return null;
        return {
          rects,
          bbox,
          label: kept.length === 1 ? short(cssPath(kept[0].el)) : `${kept.length} elements`,
        };
      },
      finish(dragRect) {
        const { kept, rects, bbox } = collectHtmlElements(dragRect);
        if (!kept.length || !bbox) return null;
        setPick(false);
        PV.outline(null);
        if (kept.length === 1) {
          const el = kept[0].el;
          return {
            anchor: elementAnchor(el),
            rects,
            bbox,
            label: short(cssPath(el)),
            rectFn: () => PV.rectOf(el) || bbox,
          };
        }
        const els = kept.slice(0, 32).map((k) => k.el);
        const items = els.map(itemOf);
        const snippets = els
          .slice(0, 4)
          .map((e) => (e.innerText || e.textContent || "").replace(/\s+/g, " ").trim() || `<${e.localName}>`)
          .filter(Boolean);
        return {
          anchor: {
            kind: "html",
            text: "",
            selector: items[0].selector,
            items,
            hint: { classes: [] },
            preview: `${items.length} elements: ${snippets.join(" · ")}`,
          },
          rects,
          bbox,
          label: `${items.length} elements`,
          rectFn: () => PV.smartAnchorRect(els.map((e) => PV.rectOf(e)).filter(Boolean)) || bbox,
          subRectsFn: () => els.map((e) => PV.rectOf(e)).filter(Boolean),
          fullRectFn: () => PV.unionRects(els.map((e) => PV.rectOf(e)).filter(Boolean)) || bbox,
        };
      },
    },
    label(anchor) {
      if (anchor.items?.length > 1) return `${anchor.items.length}× · ${short(anchor.selector)}`;
      return short(anchor.selector);
    },
    locate(anchor) {
      if (anchor.kind !== "html") return null;
      if (anchor.items?.length > 1) {
        const els = anchor.items
          .map((item) => {
            try {
              return document.querySelector(item.selector);
            } catch {
              return null;
            }
          })
          .filter(Boolean);
        if (!els.length) return null;
        const subRects = () => els.map((e) => PV.rectOf(e)).filter(Boolean);
        return {
          els,
          el: els[0],
          box: true,
          subRects,
          fullRect: () => PV.unionRects(subRects()),
          rect: () => PV.smartAnchorRect(subRects()),
        };
      }
      let el = null;
      try {
        el = document.querySelector(anchor.selector);
      } catch {
        return null;
      }
      if (!el) return null;
      const range = anchor.text ? PV.findText(el, anchor.text) : null;
      return range ? { el, range } : { el, box: true, rect: () => PV.rectOf(el) || el.getBoundingClientRect() };
    },
  });
})();
