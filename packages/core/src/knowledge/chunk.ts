import type { Section } from "./extract.js";

export interface Chunk {
  heading: string | null;
  content: string;
}

/**
 * Splits sections into chunks of roughly `maxChars` (≈ 350–450 tokens at the default), keeping the
 * section heading with every chunk and never splitting a paragraph unless it alone is too long.
 */
export function chunkSections(
  sections: Section[],
  options: { maxChars?: number; title?: string | null } = {},
): Chunk[] {
  const maxChars = options.maxChars ?? 1600;
  const chunks: Chunk[] = [];

  for (const section of sections) {
    const heading = section.heading ?? options.title ?? null;
    const paragraphs = section.text.split(/\n+/).flatMap((p) => splitLong(p.trim(), maxChars));
    let buffer = "";
    for (const paragraph of paragraphs) {
      if (!paragraph) continue;
      if (buffer && buffer.length + paragraph.length + 1 > maxChars) {
        chunks.push({ heading, content: buffer });
        buffer = "";
      }
      buffer = buffer ? `${buffer}\n${paragraph}` : paragraph;
    }
    if (buffer) chunks.push({ heading, content: buffer });
  }
  return mergeTiny(chunks, maxChars);
}

function splitLong(paragraph: string, maxChars: number): string[] {
  if (paragraph.length <= maxChars) return [paragraph];
  const sentences = paragraph.split(/(?<=[.!?。！？])\s*/);
  const out: string[] = [];
  let buffer = "";
  for (const sentence of sentences) {
    if (buffer && buffer.length + sentence.length + 1 > maxChars) {
      out.push(buffer);
      buffer = "";
    }
    if (sentence.length > maxChars) {
      for (let i = 0; i < sentence.length; i += maxChars) out.push(sentence.slice(i, i + maxChars));
      continue;
    }
    buffer = buffer ? `${buffer} ${sentence}` : sentence;
  }
  if (buffer) out.push(buffer);
  return out;
}

/** Merges very small neighbouring chunks under the same heading (e.g. one-line sections). */
function mergeTiny(chunks: Chunk[], maxChars: number): Chunk[] {
  const out: Chunk[] = [];
  for (const chunk of chunks) {
    const prev = out.at(-1);
    if (prev && prev.content.length < 200 && prev.content.length + chunk.content.length + 2 <= maxChars) {
      const label = chunk.heading && chunk.heading !== prev.heading ? `${chunk.heading}\n` : "";
      prev.content = `${prev.content}\n\n${label}${chunk.content}`;
      continue;
    }
    out.push({ ...chunk });
  }
  return out;
}
