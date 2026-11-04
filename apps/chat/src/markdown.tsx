import type { ComponentChildren } from "preact";

/**
 * Minimal, safe Markdown for assistant replies: paragraphs, bullet/numbered lists, **bold**,
 * *italic*, [links](https://…) and bare https links. Output is built as virtual DOM nodes (never
 * innerHTML), so model output can't inject markup. Only http(s) links are rendered as links.
 */

const INLINE = /(\*\*[^*]+\*\*|\*[^*\s][^*]*\*|\[[^\]]+\]\([^)\s]+\)|https?:\/\/[^\s<>()]+[^\s<>().,!?;:])/g;

function safeHref(url: string): string | null {
  try {
    const u = new URL(url);
    return u.protocol === "https:" || u.protocol === "http:" ? u.toString() : null;
  } catch {
    return null;
  }
}

function inline(text: string): ComponentChildren[] {
  const out: ComponentChildren[] = [];
  let last = 0;
  for (const match of text.matchAll(INLINE)) {
    const token = match[0];
    const index = match.index ?? 0;
    if (index > last) out.push(text.slice(last, index));
    if (token.startsWith("**")) {
      out.push(<strong>{token.slice(2, -2)}</strong>);
    } else if (token.startsWith("*")) {
      out.push(<em>{token.slice(1, -1)}</em>);
    } else if (token.startsWith("[")) {
      const [, label = "", url = ""] = token.match(/^\[([^\]]+)\]\(([^)\s]+)\)$/) ?? [];
      const href = safeHref(url);
      out.push(
        href ? (
          <a href={href} target="_blank" rel="noopener noreferrer nofollow">
            {label}
          </a>
        ) : (
          label
        ),
      );
    } else {
      const href = safeHref(token);
      out.push(
        href ? (
          <a href={href} target="_blank" rel="noopener noreferrer nofollow">
            {token}
          </a>
        ) : (
          token
        ),
      );
    }
    last = index + token.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function Markdown({ text }: { text: string }) {
  const blocks: ComponentChildren[] = [];
  const lines = text.replace(/\r/g, "").split("\n");
  let list: { ordered: boolean; items: string[] } | null = null;
  let paragraph: string[] = [];

  const flushParagraph = () => {
    if (paragraph.length) {
      blocks.push(<p>{inline(paragraph.join(" "))}</p>);
      paragraph = [];
    }
  };
  const flushList = () => {
    if (list) {
      const items = list.items.map((item) => <li>{inline(item)}</li>);
      blocks.push(list.ordered ? <ol>{items}</ol> : <ul>{items}</ul>);
      list = null;
    }
  };

  for (const raw of lines) {
    const line = raw.trim();
    const bullet = line.match(/^[-*•]\s+(.*)$/);
    const numbered = line.match(/^\d+[.)]\s+(.*)$/);
    if (bullet || numbered) {
      flushParagraph();
      const ordered = Boolean(numbered);
      if (!list || list.ordered !== ordered) {
        flushList();
        list = { ordered, items: [] };
      }
      list.items.push((bullet ?? numbered)![1]!);
    } else if (!line) {
      flushParagraph();
      flushList();
    } else {
      flushList();
      paragraph.push(line.replace(/^#+\s*/, ""));
    }
  }
  flushParagraph();
  flushList();
  return <>{blocks}</>;
}
