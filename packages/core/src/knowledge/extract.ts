import * as cheerio from "cheerio";

export interface Section {
  heading: string | null;
  text: string;
}

export interface ExtractedPage {
  title: string | null;
  language: string | null;
  sections: Section[];
  /** Absolute same-document-stripped links found on the page. */
  links: string[];
  /** Full plain text (for hashing and storage). */
  text: string;
  /**
   * Text of the page footer (hours, phone, address on many small-business sites). It repeats on
   * every page, so it is left out of `text`; the crawler adds it once per site.
   */
  footer: string | null;
}

const REMOVE =
  "script, style, noscript, template, svg, canvas, iframe, form, nav, footer, header, aside, " +
  "[role=navigation], [role=banner], [role=contentinfo], [aria-hidden=true], [hidden]";
const NOISE_ATTR = /(cookie|consent|gdpr|newsletter|popup|modal|share|social|breadcrumb|skip-link)/i;
const BLOCKS = "h1, h2, h3, h4, h5, h6, p, li, dt, dd, tr, blockquote, pre, figcaption, address";
/** Never removed as "noise": a class like "has-newsletter-popup" on these describes the whole page. */
const PAGE_CONTAINERS = new Set(["html", "body", "main", "article"]);
/** Only longer blocks are de-duplicated; short repeats ("Closed", "9:00 – 17:00", "$12") are real content. */
const DEDUPE_MIN_CHARS = 60;
const MAX_FOOTER_CHARS = 1500;

const clean = (s: string) => s.replace(/\s+/g, " ").trim();
const tagOf = (el: unknown) => (el as { tagName?: string }).tagName?.toLowerCase() ?? "";

/** Extracts readable sections (heading + text) and links from an HTML page. */
export function extractPage(html: string, pageUrl: string): ExtractedPage {
  const $ = cheerio.load(html);
  const title = clean($("title").first().text()) || clean($("h1").first().text()) || null;
  const language = $("html").attr("lang")?.trim() || null;

  const links = new Set<string>();
  $("a[href]").each((_, el) => {
    const href = $(el).attr("href");
    if (!href || href.startsWith("mailto:") || href.startsWith("tel:") || href.startsWith("javascript:"))
      return;
    try {
      const url = new URL(href, pageUrl);
      url.hash = "";
      links.add(url.toString());
    } catch {
      // ignore malformed links
    }
  });

  // Footer text is read before footers are removed from the main content.
  const $footer = $("footer, [role=contentinfo]").first().clone();
  $footer.find("script, style, noscript, template, svg, nav, form, [role=navigation]").remove();
  // Footers are mostly <div>/<span> soup: break lines at block boundaries, then tidy each line.
  $footer.find("br").replaceWith("\n");
  $footer.find("p, li, div, address, tr, h1, h2, h3, h4, h5, h6, dt, dd, section, ul, ol").append("\n");
  const footerLines = [...new Set($footer.text().split("\n").map(clean).filter(Boolean))];
  const footerText = footerLines.join("\n").slice(0, MAX_FOOTER_CHARS);

  $(REMOVE).remove();
  $("[id], [class]").each((_, el) => {
    if (PAGE_CONTAINERS.has(tagOf(el))) return;
    const marker = `${$(el).attr("id") ?? ""} ${$(el).attr("class") ?? ""}`;
    if (NOISE_ATTR.test(marker)) $(el).remove();
  });

  const root = $("main, [role=main], article").first().length
    ? $("main, [role=main], article").first()
    : $("body");

  const sections: Section[] = [];
  let current: Section = { heading: null, text: "" };
  const seen = new Set<string>();

  root.find(BLOCKS).each((_, el) => {
    const $el = $(el);
    // Skip containers whose text is already captured by a nested block (e.g. <li><p>…</p></li>).
    if ($el.find(BLOCKS).length) return;
    const tag = tagOf(el);
    // Table rows keep their cells together ("Monday | 9:00 – 17:00"), so hours and prices stay
    // attached to what they describe.
    const text =
      tag === "tr"
        ? $el
            .children("td, th")
            .map((_, cell) => clean($(cell).text()))
            .get()
            .filter(Boolean)
            .join(" | ")
        : clean($el.text());
    if (!text) return;
    if (text.length >= DEDUPE_MIN_CHARS) {
      if (seen.has(text)) return;
      seen.add(text);
    }

    if (/^h[1-6]$/.test(tag)) {
      if (current.text) sections.push(current);
      current = { heading: text, text: "" };
      return;
    }
    const line = tag === "li" ? `- ${text}` : text;
    current.text = current.text ? `${current.text}\n${line}` : line;
  });
  if (current.text) sections.push(current);

  // Pages built without semantic blocks: fall back to the root's text.
  if (!sections.length) {
    const text = clean(root.text());
    if (text) sections.push({ heading: null, text });
  }

  const text = sections.map((s) => (s.heading ? `${s.heading}\n${s.text}` : s.text)).join("\n\n");
  return { title, language, sections, links: [...links], text, footer: footerText || null };
}
