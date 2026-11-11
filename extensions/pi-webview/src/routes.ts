import { createReadStream, existsSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createRequire } from "node:module";
import { dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { type Doc, canonicalPath, convertOffice, displayPath, kindOf, makeDoc } from "./docs.ts";
import { type Hub, releaseDir, statusPayload, watchDir } from "./hub.ts";
import { PDF_STAGE, frontMatterHtml, indexPage, injectHtml, markdownTitle, renderMarkdown, shellPage } from "./render.ts";

const WEB_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "web");
const VENDOR_PKGS = new Set(["pdfjs-dist", "katex"]);
const vendorRoots = new Map<string, string>();
const requireFromHere = createRequire(import.meta.url);

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".md": "text/plain; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".wasm": "application/wasm",
  ".pdf": "application/pdf",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mp3": "audio/mpeg",
};

export class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export interface RouteDeps {
  /** POST /ask: a selection, asked now or pinned. */
  ask(body: unknown): Promise<unknown>;
  /** POST /say: a message from the panel, carrying all pins. */
  say(body: unknown): Promise<unknown>;
  editPin(id: string, body: unknown): unknown;
  /** Without an id, removes every pin. */
  deletePin(id: string | undefined): unknown;
  /** Pins and threads for a freshly connected page. */
  snapshot(): Promise<Record<string, unknown>>;
}

function send(res: ServerResponse, status: number, body: string, type = "text/plain; charset=utf-8"): void {
  res.writeHead(status, { "content-type": type, "cache-control": "no-store" });
  res.end(body);
}

function sendJson(res: ServerResponse, status: number, data: unknown): void {
  send(res, status, JSON.stringify(data ?? {}), "application/json; charset=utf-8");
}

function sendFile(res: ServerResponse, path: string, cache: string): void {
  let size: number;
  try {
    const st = statSync(path);
    if (!st.isFile()) throw new Error("not a file");
    size = st.size;
  } catch {
    throw new HttpError(404, "File not found");
  }
  res.writeHead(200, {
    "content-type": MIME[extname(path).toLowerCase()] ?? "application/octet-stream",
    "content-length": size,
    "cache-control": cache,
  });
  createReadStream(path).pipe(res);
}

/** Resolve URL segments under root; dot-segments and dotfiles are refused. */
function within(root: string, segments: string[]): string {
  if (!segments.length || segments.some((s) => !s || s.startsWith(".") || s.includes("/") || s.includes("\\"))) {
    throw new HttpError(404, "Invalid path");
  }
  const full = resolve(root, ...segments);
  if (!full.startsWith(root.endsWith(sep) ? root : root + sep)) throw new HttpError(403, "Path outside the document folder");
  return full;
}

function vendorRoot(pkg: string): string {
  let root = vendorRoots.get(pkg);
  if (!root) {
    try {
      root = dirname(requireFromHere.resolve(`${pkg}/package.json`));
    } catch {
      throw new HttpError(500, `Missing dependency ${pkg}: run npm install in the pi-webview directory`);
    }
    vendorRoots.set(pkg, root);
  }
  return root;
}

/** One document per file: paths are canonical, so a file reached through a symlink is the same document. */
export function ensureDoc(h: Hub, rawPath: string): Doc {
  const path = canonicalPath(rawPath);
  const existing = [...h.docs.values()].find((d) => d.path === path);
  if (existing) return existing;
  const doc = makeDoc(path);
  h.docs.set(doc.id, doc);
  // The directory is watched while a tab shows the document (see the events route).
  return doc;
}

/** For office documents: (re)start the PDF conversion when the source changed. */
export function refreshRendition(doc: Doc): Promise<string> | undefined {
  if (doc.kind !== "office") return undefined;
  doc.rendition = convertOffice(doc.path);
  doc.rendition.catch(() => undefined);
  return doc.rendition;
}

async function readJson(req: IncomingMessage, limit: number): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new HttpError(413, "Request too large");
    chunks.push(chunk as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    throw new HttpError(400, "Invalid JSON");
  }
}

/** Documents referenced from session history open on demand, as long as the file still exists. */
function docOr404(h: Hub, id: string | undefined): Doc {
  const doc = id ? h.docs.get(id) : undefined;
  if (doc) return doc;
  const known = id ? h.knownPaths.get(id) : undefined;
  if (known && existsSync(known)) return ensureDoc(h, known);
  throw new HttpError(404, "Document is not open (pi may have restarted); run /view again");
}

export function createRouter(h: Hub, deps: RouteDeps) {
  return (req: IncomingMessage, res: ServerResponse): void => {
    handle(h, deps, req, res).catch((e: unknown) => {
      const status = e instanceof HttpError ? e.status : 500;
      const message = e instanceof Error ? e.message : String(e);
      if (res.headersSent) res.end();
      else if (req.headers.accept?.includes("application/json") || req.method !== "GET") sendJson(res, status, { error: message });
      else send(res, status, message);
    });
  };
}

async function handle(h: Hub, deps: RouteDeps, req: IncomingMessage, res: ServerResponse): Promise<void> {
  // DNS-rebinding guard: only the literal loopback host is accepted.
  const host = req.headers.host ?? "";
  if (host !== `127.0.0.1:${h.port}` && host !== `localhost:${h.port}`) throw new HttpError(403, "Host not allowed");
  const url = new URL(req.url ?? "/", `http://${host}`);
  let segments: string[];
  try {
    segments = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
  } catch {
    throw new HttpError(400, "Bad path");
  }
  if (segments[0] !== h.token) throw new HttpError(404, "Not found");
  const base = `/${h.token}`;
  const [, area, id, ...rest] = segments;
  const method = req.method ?? "GET";

  // Mutations must come from our own pages.
  if (method !== "GET" && method !== "HEAD") {
    const origin = req.headers.origin;
    if (origin && origin !== `http://${host}`) throw new HttpError(403, "Origin not allowed");
  }

  switch (area) {
    case undefined: {
      const items = [...h.docs.values()].map((d) => ({
        id: d.id,
        kind: d.kind,
        file: displayPath(d.path, h.cwd),
        live: [...h.clients].filter((c) => c.docId === d.id).length,
      }));
      return send(res, 200, indexPage(base, items, h.session), MIME[".html"]);
    }

    case "assets":
      return sendFile(res, within(WEB_DIR, [id!, ...rest].filter(Boolean)), "no-cache");

    case "vendor":
      if (!id || !VENDOR_PKGS.has(id)) throw new HttpError(404, "Unknown vendor package");
      return sendFile(res, within(vendorRoot(id), rest), "max-age=86400");

    case "v": {
      const doc = docOr404(h, id);
      if (doc.kind === "html") {
        res.writeHead(302, { location: `${base}/f/${doc.id}/${encodeURIComponent(doc.name)}` });
        return void res.end();
      }
      const file = displayPath(doc.path, h.cwd);
      if (doc.kind === "md") {
        const src = await readFile(doc.path, "utf8");
        const html = shellPage({ base, doc, file, title: markdownTitle(src, doc.name), body: await renderMarkdown(src), meta: frontMatterHtml(src) });
        return send(res, 200, html, MIME[".html"]);
      }
      if (doc.kind === "office" && !doc.rendition) refreshRendition(doc);
      return send(res, 200, shellPage({ base, doc, file, title: doc.name.replace(/\.[^.]+$/, ""), body: PDF_STAGE }), MIME[".html"]);
    }

    case "md": {
      const doc = docOr404(h, id);
      if (doc.kind !== "md") throw new HttpError(400, "Not a markdown document");
      const src = await readFile(doc.path, "utf8");
      return sendJson(res, 200, { html: await renderMarkdown(src), title: markdownTitle(src, doc.name) });
    }

    case "raw": {
      const doc = docOr404(h, id);
      if (doc.kind === "pdf") return sendFile(res, doc.path, "no-store");
      if (doc.kind === "office") {
        const pdf = await (doc.rendition ?? refreshRendition(doc)!).catch((e: unknown) => {
          throw new HttpError(500, e instanceof Error ? e.message : String(e));
        });
        return sendFile(res, pdf, "no-store");
      }
      throw new HttpError(400, "Not a paginated document");
    }

    case "f": {
      const doc = docOr404(h, id);
      const path = within(doc.dir, rest);
      const kind = kindOf(path);
      const navigating = req.headers["sec-fetch-dest"] === "document" || (req.headers.accept ?? "").includes("text/html");
      // Following a link to another document opens it in its own viewer.
      if (kind && kind !== "html" && navigating && !url.searchParams.has("raw") && existsSync(path)) {
        const target = ensureDoc(h, path);
        res.writeHead(302, { location: `${base}/v/${target.id}` });
        return void res.end();
      }
      if (kind === "html") {
        if (!existsSync(path)) throw new HttpError(404, "File not found");
        const target = ensureDoc(h, path);
        const html = injectHtml(await readFile(path, "utf8"), base, target, displayPath(path, h.cwd));
        return send(res, 200, html, MIME[".html"]);
      }
      return sendFile(res, path, "no-cache");
    }

    case "events": {
      const doc = docOr404(h, url.searchParams.get("doc") ?? undefined);
      const hello = { ...statusPayload(h), ...(await deps.snapshot()) };
      res.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-store",
        connection: "keep-alive",
      });
      res.write(`retry: 2000\nevent: hello\ndata: ${JSON.stringify(hello)}\n\n`);
      const client = { res, docId: doc.id };
      h.clients.add(client);
      watchDir(h, doc.dir);
      req.on("close", () => {
        h.clients.delete(client);
        releaseDir(h, doc.dir);
      });
      return;
    }

    case "ask":
      if (method !== "POST") throw new HttpError(405, "POST only");
      return sendJson(res, 200, await deps.ask(await readJson(req, 24 * 1024 * 1024)));

    case "say":
      if (method !== "POST") throw new HttpError(405, "POST only");
      return sendJson(res, 200, await deps.say(await readJson(req, 1024 * 1024)));

    case "pins":
      if (method === "PATCH" && id) return sendJson(res, 200, deps.editPin(id, await readJson(req, 1024 * 1024)));
      if (method === "DELETE") return sendJson(res, 200, deps.deletePin(id));
      throw new HttpError(405, "PATCH /pins/:id or DELETE /pins[/:id]");

    default:
      throw new HttpError(404, `Not found: ${area}`);
  }
}
