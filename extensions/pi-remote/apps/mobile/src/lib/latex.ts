/**
 * LaTeX → Unicode for the math models usually write ($…$, $$…$$, \(…\), \[…\]).
 * No layout engine on the phone, so fractions become a/b, scripts become ¹²³/₁₂₃ when every
 * character has a Unicode form (otherwise ^(…) / _(…)), and symbols map to their glyphs.
 */

const SYMBOLS: Record<string, string> = {
  alpha: "α", beta: "β", gamma: "γ", delta: "δ", epsilon: "ε", varepsilon: "ε", zeta: "ζ", eta: "η", theta: "θ", vartheta: "ϑ",
  iota: "ι", kappa: "κ", lambda: "λ", mu: "μ", nu: "ν", xi: "ξ", pi: "π", varpi: "ϖ", rho: "ρ", varrho: "ϱ", sigma: "σ",
  varsigma: "ς", tau: "τ", upsilon: "υ", phi: "φ", varphi: "φ", chi: "χ", psi: "ψ", omega: "ω",
  Gamma: "Γ", Delta: "Δ", Theta: "Θ", Lambda: "Λ", Xi: "Ξ", Pi: "Π", Sigma: "Σ", Upsilon: "Υ", Phi: "Φ", Psi: "Ψ", Omega: "Ω",
  times: "×", cdot: "·", div: "÷", pm: "±", mp: "∓", ast: "∗", star: "⋆", circ: "∘", bullet: "•",
  leq: "≤", le: "≤", geq: "≥", ge: "≥", neq: "≠", ne: "≠", approx: "≈", equiv: "≡", sim: "∼", simeq: "≃", cong: "≅", propto: "∝",
  ll: "≪", gg: "≫", prec: "≺", succ: "≻", mid: "∣", parallel: "∥", perp: "⊥",
  infty: "∞", partial: "∂", nabla: "∇", sum: "∑", prod: "∏", coprod: "∐", int: "∫", iint: "∬", iiint: "∭", oint: "∮",
  in: "∈", notin: "∉", ni: "∋", subset: "⊂", supset: "⊃", subseteq: "⊆", supseteq: "⊇", cup: "∪", cap: "∩", setminus: "∖",
  emptyset: "∅", varnothing: "∅", forall: "∀", exists: "∃", nexists: "∄", neg: "¬", lnot: "¬", land: "∧", wedge: "∧", lor: "∨", vee: "∨",
  oplus: "⊕", otimes: "⊗", odot: "⊙",
  to: "→", rightarrow: "→", leftarrow: "←", gets: "←", leftrightarrow: "↔", Rightarrow: "⇒", Leftarrow: "⇐", Leftrightarrow: "⇔",
  implies: "⟹", iff: "⟺", mapsto: "↦", uparrow: "↑", downarrow: "↓", longrightarrow: "⟶", longleftarrow: "⟵",
  ldots: "…", cdots: "⋯", vdots: "⋮", ddots: "⋱", dots: "…", prime: "′", degree: "°", angle: "∠", triangle: "△",
  langle: "⟨", rangle: "⟩", lfloor: "⌊", rfloor: "⌋", lceil: "⌈", rceil: "⌉", lvert: "|", rvert: "|", vert: "|", Vert: "‖",
  hbar: "ℏ", ell: "ℓ", Re: "ℜ", Im: "ℑ", aleph: "ℵ", therefore: "∴", because: "∵", top: "⊤", bot: "⊥",
  quad: "  ", qquad: "    ", ",": " ", ";": " ", ":": " ", "!": "", " ": " ",
  "{": "{", "}": "}", "%": "%", "$": "$", "&": "&", "#": "#", "_": "_", "\\": "\n",
  sin: "sin", cos: "cos", tan: "tan", cot: "cot", sec: "sec", csc: "csc", arcsin: "arcsin", arccos: "arccos", arctan: "arctan",
  sinh: "sinh", cosh: "cosh", tanh: "tanh", log: "log", ln: "ln", exp: "exp", lim: "lim", max: "max", min: "min", sup: "sup", inf: "inf",
  det: "det", dim: "dim", ker: "ker", deg: "deg", gcd: "gcd", arg: "arg", Pr: "Pr",
};

const SUP: Record<string, string> = {
  "0": "⁰", "1": "¹", "2": "²", "3": "³", "4": "⁴", "5": "⁵", "6": "⁶", "7": "⁷", "8": "⁸", "9": "⁹", "+": "⁺", "-": "⁻", "−": "⁻", "=": "⁼", "(": "⁽", ")": "⁾",
  a: "ᵃ", b: "ᵇ", c: "ᶜ", d: "ᵈ", e: "ᵉ", f: "ᶠ", g: "ᵍ", h: "ʰ", i: "ⁱ", j: "ʲ", k: "ᵏ", l: "ˡ", m: "ᵐ", n: "ⁿ", o: "ᵒ", p: "ᵖ", r: "ʳ", s: "ˢ", t: "ᵗ", u: "ᵘ", v: "ᵛ", w: "ʷ", x: "ˣ", y: "ʸ", z: "ᶻ",
  T: "ᵀ", "′": "′", "*": "*", "∗": "*", " ": "",
};
const SUB: Record<string, string> = {
  "0": "₀", "1": "₁", "2": "₂", "3": "₃", "4": "₄", "5": "₅", "6": "₆", "7": "₇", "8": "₈", "9": "₉", "+": "₊", "-": "₋", "−": "₋", "=": "₌", "(": "₍", ")": "₎",
  a: "ₐ", e: "ₑ", h: "ₕ", i: "ᵢ", j: "ⱼ", k: "ₖ", l: "ₗ", m: "ₘ", n: "ₙ", o: "ₒ", p: "ₚ", r: "ᵣ", s: "ₛ", t: "ₜ", u: "ᵤ", v: "ᵥ", x: "ₓ", " ": "",
};
const BB: Record<string, string> = { R: "ℝ", N: "ℕ", Z: "ℤ", Q: "ℚ", C: "ℂ", P: "ℙ", E: "𝔼", H: "ℍ", F: "𝔽", "1": "𝟙" };
const ACCENT: Record<string, string> = { hat: "\u0302", widehat: "\u0302", bar: "\u0304", overline: "\u0305", vec: "\u20D7", dot: "\u0307", ddot: "\u0308", tilde: "\u0303", widetilde: "\u0303" };
const PASSTHROUGH = new Set(["text", "mathrm", "mathbf", "mathit", "mathsf", "mathtt", "boldsymbol", "operatorname", "textbf", "textit", "mbox", "mathcal", "mathscr", "mathfrak", "displaystyle", "textstyle", "rm", "bf", "it"]);
const IGNORE = new Set(["left", "right", "big", "Big", "bigg", "Bigg", "bigl", "bigr", "Bigl", "Bigr", "limits", "nolimits", "begin", "end"]);

function script(s: string, map: Record<string, string>, mark: string): string {
  const chars = [...s];
  if (chars.length && chars.every((c) => map[c] !== undefined)) return chars.map((c) => map[c]).join("");
  return chars.length === 1 ? `${mark}${s}` : `${mark}(${s})`;
}

const needsParens = (s: string) => [...s].length > 1 && /[+\-−=<>±×·/ ]/.test(s);

class Parser {
  private i = 0;
  private s: string;
  constructor(s: string) { this.s = s; }

  /** Parses until end or an unmatched closing brace. */
  seq(stopAtBrace = false): string {
    let out = "";
    while (this.i < this.s.length) {
      const ch = this.s[this.i]!;
      if (ch === "}") { if (stopAtBrace) { this.i++; return out; } this.i++; continue; }
      out += this.atom();
    }
    return out;
  }

  private group(): string {
    while (this.s[this.i] === " ") this.i++;
    if (this.s[this.i] === "{") { this.i++; return this.seq(true); }
    return this.atom();
  }

  private optional(): string | undefined {
    if (this.s[this.i] !== "[") return undefined;
    const end = this.s.indexOf("]", this.i);
    if (end < 0) return undefined;
    const v = new Parser(this.s.slice(this.i + 1, end)).seq();
    this.i = end + 1;
    return v;
  }

  private atom(): string {
    const ch = this.s[this.i]!;
    if (ch === "{") { this.i++; return this.seq(true); }
    if (ch === "^") { this.i++; return script(this.group(), SUP, "^"); }
    if (ch === "_") { this.i++; return script(this.group(), SUB, "_"); }
    if (ch === "~") { this.i++; return " "; }
    if (ch === "&") { this.i++; return "  "; }
    if (ch === "-") { this.i++; return "−"; }
    if (ch !== "\\") { this.i++; return ch; }
    this.i++;
    const m = /^[A-Za-z]+/.exec(this.s.slice(this.i));
    const name = m ? m[0] : this.s[this.i] ?? "";
    this.i += Math.max(1, name.length);
    if (name === "frac" || name === "dfrac" || name === "tfrac") {
      const a = this.group(); const b = this.group();
      return `${needsParens(a) ? `(${a})` : a}/${needsParens(b) ? `(${b})` : b}`;
    }
    if (name === "binom") { const a = this.group(); const b = this.group(); return `C(${a}, ${b})`; }
    if (name === "sqrt") {
      const n = this.optional(); const a = this.group();
      return `${n ? script(n, SUP, "") : ""}√${[...a].length > 1 ? `(${a})` : a}`;
    }
    if (name === "mathbb") { const a = this.group(); return [...a].map((c) => BB[c] ?? c).join(""); }
    if (ACCENT[name]) { const a = this.group(); const cs = [...a]; return cs.length === 1 ? a + ACCENT[name] : `${a}${ACCENT[name]}`; }
    if (name === "begin" || name === "end") { this.group(); return name === "end" ? "" : ""; }
    if (PASSTHROUGH.has(name)) return this.group();
    if (IGNORE.has(name)) return "";
    if (name === "not") { const a = this.atom(); return a === "=" ? "≠" : a === "∈" ? "∉" : `${a}\u0338`; }
    return SYMBOLS[name] ?? name;
  }
}

export function latexToUnicode(src: string): string {
  try {
    return new Parser(src.trim()).seq().replace(/[ \t]+/g, " ").replace(/ ?\n ?/g, "\n").trim();
  } catch {
    return src;
  }
}
