import type { Citation, Tx } from "@traiblazer/db";
import { sql } from "drizzle-orm";

export interface Passage {
  key: string;
  kind: Citation["kind"];
  title: string | null;
  url: string | null;
  heading: string | null;
  content: string;
  score: number;
}

const RRF_K = 60;

/** Q&A matching (see retrievePassages): the lowest score that counts, and the scores of word matches. */
const QA_MIN_MATCH = 0.45;
const QA_QUESTION_MATCH = 0.6;
const QA_CONTENT_MATCH = 0.5;

/** Builds an OR-query of the words in the given texts, safe for to_tsquery (letters/digits only). */
export function toOrQuery(texts: string[]): string | null {
  const words = new Set<string>();
  for (const text of texts) {
    for (const w of text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []) {
      if (w.length > 1 || /[一-鿿]/.test(w)) words.add(w);
      if (words.size >= 40) break;
    }
  }
  return words.size ? [...words].join(" | ") : null;
}

type Row = Record<string, unknown> & {
  id: string;
  heading: string | null;
  content: string;
  title: string | null;
  url: string | null;
  source_type: string;
};

/**
 * Hybrid retrieval for one bot: full-text (simple + English + French stemming), trigram fuzzy
 * matching, and vector similarity when query embeddings are available; merged with reciprocal-rank
 * fusion. Owner-written Q&A pairs are searched too and ranked first when they match.
 * Must run inside withTenant() (row-level security applies).
 */
export async function retrievePassages(
  tx: Tx,
  input: {
    botId: string;
    queries: string[];
    embedding?: { vector: number[]; model: string } | null;
    limit?: number;
  },
): Promise<Passage[]> {
  const limit = input.limit ?? 6;
  const orQuery = toOrQuery(input.queries);
  const fuzzyText = input.queries.join(" ").slice(0, 500);
  const scores = new Map<string, Passage>();

  const add = (rows: Row[], weight = 1) => {
    rows.forEach((row, rank) => {
      const kind: Citation["kind"] = row.source_type === "website" ? "page" : "text";
      const key = `c:${row.id}`;
      const existing = scores.get(key);
      const score = weight / (RRF_K + rank + 1);
      if (existing) existing.score += score;
      else
        scores.set(key, {
          key,
          kind,
          title: row.title,
          url: row.source_type === "website" ? row.url : null,
          heading: row.heading,
          content: row.content,
          score,
        });
    });
  };

  const select = sql`select c.id, c.heading, c.content, d.title, d.url, s.type as source_type
    from chunks c
    join documents d on d.id = c.document_id
    join knowledge_sources s on s.id = d.source_id`;

  if (orQuery) {
    const q = sql`(to_tsquery('simple', ${orQuery}) || to_tsquery('english', ${orQuery}) || to_tsquery('french', ${orQuery}))`;
    add(
      await tx.execute<Row>(sql`${select}
        where c.bot_id = ${input.botId} and c.tsv @@ ${q}
        order by ts_rank_cd(c.tsv, ${q}) desc
        limit 20`),
    );
  }

  if (fuzzyText) {
    add(
      await tx.execute<Row>(sql`${select}
        where c.bot_id = ${input.botId} and word_similarity(${fuzzyText}, c.content) > 0.25
        order by word_similarity(${fuzzyText}, c.content) desc
        limit 20`),
    );
  }

  if (input.embedding) {
    const vec = `[${input.embedding.vector.join(",")}]`;
    add(
      await tx.execute<Row>(sql`${select}
        where c.bot_id = ${input.botId} and c.embedding_model = ${input.embedding.model}
        order by c.embedding <=> ${vec}::vector
        limit 20`),
      1.2,
    );
  }

  // Owner-written Q&A pairs: strongest signal when the question matches. A pair must really be
  // about the question — sharing everyday words ("do", "you", "have") is not a match — because a
  // matching pair outranks every page and replaces the page sources under the answer.
  // Each query (the visitor's words and its EN/FR rewrites) is compared on its own, so a rewrite
  // can't dilute the similarity of another. A pair matches a query when
  //   - its question reads much like the query (trigram similarity), or
  //   - every meaningful word of the query (stop words dropped, stemmed) is in its question, or
  //   - the query has two or more such words and all of them are in its question + answer.
  const qaQueries = input.queries.map((q) => q.trim().slice(0, 300)).filter(Boolean);
  const perQuery = qaQueries.map((q) => {
    const stemmed = (["english", "french"] as const).map((config) => {
      const tsq = sql`plainto_tsquery(${config}::regconfig, ${q})`;
      return sql`case
        when numnode(${tsq}) = 0 then 0::real
        when to_tsvector(${config}::regconfig, question) @@ ${tsq} then ${QA_QUESTION_MATCH}::real
        when numnode(${tsq}) >= 3 and tsv @@ ${tsq} then ${QA_CONTENT_MATCH}::real
        else 0::real end`;
    });
    return sql`greatest(similarity(question, ${q}), ${sql.join(stemmed, sql`, `)})`;
  });
  const qaRows = perQuery.length
    ? await tx.execute<{ id: string; question: string; answer: string; match: number }>(sql`
        select id, question, answer, greatest(${sql.join(perQuery, sql`, `)}) as match
        from qa_pairs
        where bot_id = ${input.botId} and enabled
        order by match desc
        limit 5`)
    : [];
  qaRows
    .filter((r) => Number(r.match) >= QA_MIN_MATCH)
    .slice(0, 3)
    .forEach((row, rank) => {
      scores.set(`q:${row.id}`, {
        key: `q:${row.id}`,
        kind: "qa",
        title: row.question,
        url: null,
        heading: null,
        content: `Q: ${row.question}\nA: ${row.answer}`,
        score: 1 + 1 / (rank + 1),
      });
    });

  return [...scores.values()].sort((a, b) => b.score - a.score).slice(0, limit);
}
