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

  function cssPath(el) {
    const parts = [];
    for (let n = el; n && n.nodeType === 1 && n !== document.documentElement; n = n.parentElement) {
      if (n.id && document.querySelectorAll(`#${CSS.escape(n.id)}`).length === 1) {
        parts.unshift(`#${CSS.escape(n.id)}`);
        break;
      }
      let s = n.localName;
      const cls = [...n.classList].filter((c) => !/^(is-|has-|active$|hover$|focus)/.test(c)).slice(0, 2);
      if (cls.length) s += "." + cls.map((c) => CSS.escape(c)).join(".");
      const same = n.parentElement ? [...n.parentElement.children].filter((c) => c.localName === n.localName) : [];
      if (same.length > 1) s += `:nth-of-type(${same.indexOf(n) + 1})`;
      parts.unshift(s);
      if (parts.length >= 5) break;
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

  function elementAnchor(el) {
    let outer = el.outerHTML;
    if (outer.length > 3000) {
      const open = outer.slice(0, outer.indexOf(">") + 1);
      outer = `${open}\n  <!-- ${el.children.length} child elements omitted -->\n</${el.localName}>`;
    }
    return {
      kind: "html",
      text: "",
      selector: cssPath(el),
      tag: el.localName,
      outer,
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
