import robotsParserImport from "robots-parser";
import { type ExtractedPage, extractPage } from "./extract.js";
import { type SafeFetchOptions, safeFetch, USER_AGENT } from "./safe-fetch.js";

// robots-parser is CommonJS: at runtime the default import is the function itself, while its type
// declarations describe an ES default export. Normalize both shapes.
type RobotsParserFn = typeof robotsParserImport extends { default: infer F } ? F : typeof robotsParserImport;
const robotsParser = ((robotsParserImport as { default?: unknown }).default ??
  robotsParserImport) as RobotsParserFn;

export interface CrawledPage extends ExtractedPage {
  url: string;
}

export interface CrawlOptions extends SafeFetchOptions {
  maxPages?: number;
  /** Pause between requests to be polite to small business sites. */
  delayMs?: number;
  onPage?: (page: CrawledPage) => void;
}

const SKIP_EXTENSIONS =
  /\.(pdf|jpe?g|png|gif|webp|svg|ico|mp4|mov|webm|mp3|wav|zip|gz|rar|7z|docx?|xlsx?|pptx?|css|js|json|xml|rss|woff2?|ttf|eot)$/i;
const SKIP_PATHS =
  /\/(wp-admin|wp-login|wp-json|cart|checkout|account|login|signin|signup|register|search|feed)(\/|$)/i;

/** Section title for the site footer (contact details, hours, address), stored with the first page. */
const FOOTER_HEADING = "Website footer (contact, hours, address)";

const sameSite = (a: URL, b: URL) => a.hostname.replace(/^www\./, "") === b.hostname.replace(/^www\./, "");

function normalize(url: URL): string {
  const u = new URL(url);
  u.hash = "";
  for (const key of [...u.searchParams.keys()]) {
    if (/^(utm_|fbclid|gclid|mc_)/i.test(key)) u.searchParams.delete(key);
  }
  if (u.pathname !== "/" && u.pathname.endsWith("/")) u.pathname = u.pathname.slice(0, -1);
  return u.toString();
}

/**
 * Crawls a small business website: robots.txt is respected, sitemap URLs are queued first, then
 * links are followed breadth-first within the same site, up to `maxPages` HTML pages.
 */
export async function crawlSite(startUrl: string, options: CrawlOptions = {}): Promise<CrawledPage[]> {
  const start = new URL(startUrl);
  const maxPages = options.maxPages ?? 50;
  const delayMs = options.delayMs ?? 300;
  const fetchOpts: SafeFetchOptions = { ...options };

  let robots: ReturnType<typeof robotsParser> | null = null;
  const robotsUrl = new URL("/robots.txt", start).toString();
  try {
    const res = await safeFetch(robotsUrl, { ...fetchOpts, accept: "text/plain", maxBytes: 200_000 });
    if (res.status === 200) robots = robotsParser(robotsUrl, res.body);
  } catch {
    // No robots.txt: allowed.
  }
  const allowed = (url: string) => robots?.isAllowed(url, USER_AGENT) ?? true;

  const queue: string[] = [normalize(start)];
  const queued = new Set(queue);
  const enqueue = (raw: string) => {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      return;
    }
    if (!/^https?:$/.test(url.protocol) || !sameSite(url, start)) return;
    if (SKIP_EXTENSIONS.test(url.pathname) || SKIP_PATHS.test(url.pathname)) return;
    const key = normalize(url);
    if (queued.has(key) || queued.size > maxPages * 5) return;
    queued.add(key);
    queue.push(key);
  };

  // Sitemaps (from robots.txt or the default location), one level of sitemap index.
  const sitemapUrls = robots?.getSitemaps().length
    ? robots.getSitemaps()
    : [new URL("/sitemap.xml", start).toString()];
  for (const sitemapUrl of sitemapUrls.slice(0, 3)) {
    for (const loc of await readSitemap(sitemapUrl, fetchOpts, 1)) enqueue(loc);
  }

  const pages: CrawledPage[] = [];
  const seenFinal = new Set<string>();
  let footerKept = false;
  while (queue.length && pages.length < maxPages) {
    const url = queue.shift() as string;
    if (!allowed(url)) continue;
    try {
      const res = await safeFetch(url, fetchOpts);
      const finalUrl = normalize(new URL(res.url));
      if (res.status !== 200 || !/html/i.test(res.contentType) || seenFinal.has(finalUrl)) continue;
      if (!sameSite(new URL(finalUrl), start)) continue;
      seenFinal.add(finalUrl);
      const page = { url: finalUrl, ...extractPage(res.body, finalUrl) };
      for (const link of page.links) enqueue(link);
      if (page.text.length >= 50) {
        // The footer repeats on every page; keep it once, with the first page read.
        if (page.footer && !footerKept) {
          footerKept = true;
          page.sections.push({ heading: FOOTER_HEADING, text: page.footer });
          page.text = `${page.text}\n\n${FOOTER_HEADING}\n${page.footer}`;
        }
        pages.push(page);
        options.onPage?.(page);
      }
    } catch {
      // Skip pages that fail; the crawl continues.
    }
    if (delayMs && queue.length) await new Promise((r) => setTimeout(r, delayMs));
  }
  return pages;
}

async function readSitemap(url: string, options: SafeFetchOptions, depth: number): Promise<string[]> {
  try {
    const res = await safeFetch(url, { ...options, accept: "application/xml,text/xml", maxBytes: 5_000_000 });
    if (res.status !== 200) return [];
    const locs = [...res.body.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map((m) => m[1] as string);
    if (/<sitemapindex/i.test(res.body) && depth > 0) {
      const nested = await Promise.all(locs.slice(0, 5).map((loc) => readSitemap(loc, options, depth - 1)));
      return nested.flat();
    }
    return locs;
  } catch {
    return [];
  }
}
