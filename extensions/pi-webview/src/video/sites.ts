/** What a lesson is called on its site, read from the page's own data. */
export interface VideoMeta {
  site: SiteId;
  /** Stable key for this video (and part): site-qualified, used to match threads and subtitle files. */
  key: string;
  /** Bare platform id (YouTube video id, Bilibili BV id), used to find subtitle files by name. */
  id: string;
  /** Part number of a multi-part Bilibili video. */
  part?: number;
  course?: string;
  episode?: string;
  total?: number;
  episodeTitle: string;
  url: string;
}

export type SiteId = "youtube" | "bilibili" | "generic";

export interface SiteAdapter {
  id: SiteId;
  label: string;
  match(url: URL): boolean;
  /** Main-world expression returning { id, course?, episode?, total?, episodeTitle } or null without a video. */
  metaExpression: string;
}

/** DOM facts the injected panel needs per site; serialized into the injected script. */
export interface SiteDom {
  site: SiteId;
  hosts: string[];
  /** Tried in order before falling back to the largest <video> on the page. */
  videoSelectors: string[];
  /** CSS hiding the site's own captions while a local subtitle is shown. */
  hideNativeCss: string;
  /** Present while an ad plays; the reported time then belongs to the ad, not the lesson. */
  adSelector?: string;
  /** Extra CSS for the "shrink page" layout, per panel side; {W} is the panel width in px. */
  pushCss?: { left: string; right: string };
}

const YOUTUBE_META = `(() => {
  const u = new URL(location.href);
  if (u.pathname !== "/watch") return null;
  const mp = document.querySelector("#movie_player");
  const vd = (typeof mp?.getVideoData === "function" && mp.getVideoData()) || {};
  const id = vd.video_id || u.searchParams.get("v") || "";
  if (!id) return null;
  const title = vd.title || document.querySelector("ytd-watch-metadata h1")?.textContent?.trim() || document.title.replace(/ - YouTube$/, "");
  // The playlist panel's data can outlive the playlist after in-app navigation; trust it only while the URL has a list.
  const pl = u.searchParams.get("list") ? document.querySelector("ytd-watch-flexy")?.playlistData : undefined;
  const idx = pl && typeof mp?.getPlaylistIndex === "function" ? mp.getPlaylistIndex() : -1;
  return { id, course: pl?.title || undefined, episode: idx >= 0 ? String(idx + 1) : undefined, total: pl?.totalVideos || undefined, episodeTitle: title };
})()`;

const BILIBILI_META = `(() => {
  const u = new URL(location.href);
  const bvid = (u.pathname.match(/\\/video\\/(BV\\w+)/) || [])[1];
  if (!bvid) return null;
  const s = window.__INITIAL_STATE__ || {};
  const vd = s.videoData && s.videoData.bvid === bvid ? s.videoData : null;
  const fallbackTitle = document.title.replace(/_哔哩哔哩_bilibili$/, "");
  if (!vd) return { id: bvid, episodeTitle: fallbackTitle };
  const p = Number(u.searchParams.get("p")) || s.p || 1;
  const pages = vd.pages || [];
  if (pages.length > 1) {
    const part = pages.find((x) => x.page === p)?.part;
    return { id: bvid, part: p, course: vd.title, episode: String(p), total: pages.length, episodeTitle: part || fallbackTitle };
  }
  const season = vd.ugc_season;
  if (season) {
    const eps = (season.sections || []).flatMap((sec) => sec.episodes || []);
    const i = eps.findIndex((e) => e.bvid === bvid);
    return { id: bvid, course: season.title, episode: i >= 0 ? String(i + 1) : undefined, total: eps.length || undefined, episodeTitle: vd.title || fallbackTitle };
  }
  return { id: bvid, episodeTitle: vd.title || fallbackTitle };
})()`;

const GENERIC_META = `(() => {
  if (!document.querySelector("video")) return null;
  return { id: location.origin + location.pathname, episodeTitle: document.title || location.hostname };
})()`;

const isHost = (url: URL, host: string) => url.hostname === host || url.hostname.endsWith(`.${host}`);

export const SITES: SiteAdapter[] = [
  { id: "youtube", label: "YouTube", match: (u) => isHost(u, "youtube.com"), metaExpression: YOUTUBE_META },
  { id: "bilibili", label: "Bilibili", match: (u) => isHost(u, "bilibili.com"), metaExpression: BILIBILI_META },
  { id: "generic", label: "Web", match: (u) => u.protocol === "https:" || u.protocol === "http:", metaExpression: GENERIC_META },
];

export const SITE_DOM: SiteDom[] = [
  {
    site: "youtube",
    hosts: ["youtube.com"],
    videoSelectors: ["#movie_player video.html5-main-video", "#movie_player video"],
    hideNativeCss: ".ytp-caption-window-container{display:none!important}",
    adSelector: "#movie_player.ad-showing",
    // The masthead is position:fixed to the viewport; everything else follows <html>.
    pushCss: {
      right: "#masthead-container{width:calc(100% - {W}px)!important}",
      left: "#masthead-container{left:{W}px!important;width:calc(100% - {W}px)!important}",
    },
  },
  {
    site: "bilibili",
    hosts: ["bilibili.com"],
    videoSelectors: [".bpx-player-video-wrap video", "#bilibili-player video"],
    hideNativeCss: ".bpx-player-subtitle-wrap{display:none!important}",
  },
];

export function siteFor(url: string): SiteAdapter | undefined {
  try {
    const u = new URL(url);
    return SITES.find((s) => s.match(u));
  } catch {
    return undefined;
  }
}

/** Pages that are recognisably a single video, for picking among open tabs. */
export function looksLikeVideoPage(url: string): boolean {
  try {
    const u = new URL(url);
    if (isHost(u, "youtube.com")) return u.pathname === "/watch" || u.pathname.startsWith("/live/");
    if (isHost(u, "bilibili.com")) return /^\/(video|bangumi\/play|cheese\/play)\//.test(u.pathname);
    return false;
  } catch {
    return false;
  }
}

/** Identity of the video a URL shows, to reuse a tab that already plays it. */
export function videoIdentity(url: string): string | undefined {
  try {
    const u = new URL(url);
    if (isHost(u, "youtube.com") && u.pathname === "/watch") return `yt:${u.searchParams.get("v") ?? ""}`;
    const bv = /\/video\/(BV\w+)/.exec(u.pathname)?.[1];
    if (isHost(u, "bilibili.com") && bv) return `bili:${bv}:${Number(u.searchParams.get("p")) || 1}`;
    return `${u.origin}${u.pathname}`;
  } catch {
    return undefined;
  }
}

/** Accept a bare URL the user typed or pasted, including youtu.be and BV ids. */
export function normalizeVideoUrl(input: string): string | undefined {
  const raw = input.trim();
  if (/^BV\w{10}$/.test(raw)) return `https://www.bilibili.com/video/${raw}/`;
  try {
    const u = new URL(/^[a-z]+:\/\//i.test(raw) ? raw : `https://${raw}`);
    if (u.hostname === "youtu.be") {
      const id = u.pathname.slice(1);
      const t = u.searchParams.get("t");
      return `https://www.youtube.com/watch?v=${id}${t ? `&t=${t}` : ""}`;
    }
    return u.protocol === "https:" || u.protocol === "http:" ? u.toString() : undefined;
  } catch {
    return undefined;
  }
}

export function toMeta(adapter: SiteAdapter, raw: unknown, url: string): VideoMeta | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  const id = typeof r.id === "string" ? r.id.slice(0, 300) : "";
  if (!id) return undefined;
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim().slice(0, 300) : undefined);
  const part = typeof r.part === "number" && r.part > 0 ? r.part : undefined;
  return {
    site: adapter.id,
    key: `${adapter.id}:${id}${part ? `:p${part}` : ""}`,
    id,
    part,
    course: str(r.course),
    episode: str(r.episode),
    total: typeof r.total === "number" && r.total > 0 ? r.total : undefined,
    episodeTitle: str(r.episodeTitle) ?? id,
    url,
  };
}
