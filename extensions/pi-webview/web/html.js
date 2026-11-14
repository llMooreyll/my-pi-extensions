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
        if ((picking || e.altKey) && !ours(e)) {
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
      if (!(picking || e.altKey) || ours(e) || !(e.target instanceof Element)) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      const el = e.target;
      setPick(false);
      PV.outline(null);
      PV.openSlip(elementAnchor(el), { rect: () => el.getBoundingClientRect() });
    },
    true,
  );

  addEventListener("keydown", (e) => {
    if (e.key === "Escape" && picking) setPick(false);
  });
  addEventListener("keyup", (e) => {
    if (e.key === "Alt" && !picking) PV.outline(null);
  });

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
    label(anchor) {
      return short(anchor.selector);
    },
    locate(anchor) {
      if (anchor.kind !== "html") return null;
      let el = null;
      try {
        el = document.querySelector(anchor.selector);
      } catch {
        return null;
      }
      if (!el) return null;
      const range = anchor.text ? PV.findText(el, anchor.text) : null;
      return range ? { el, range } : { el, box: true };
    },
  });
})();
