/** Embedding providers. Optional: retrieval falls back to keyword + fuzzy search without one. */

export interface EmbeddingProvider {
  /** Stored with each vector; only vectors of the same model are compared. */
  readonly model: string;
  embed(texts: string[], kind: "document" | "query"): Promise<number[][]>;
}

/**
 * OpenAI-style `/embeddings` endpoint (OpenAI, Voyage AI, Azure OpenAI v1, Ollama, vLLM, …).
 * Voyage accepts `input_type`, which improves retrieval; other providers ignore unknown fields
 * only if `sendInputType` is false.
 */
export class OpenAICompatibleEmbeddings implements EmbeddingProvider {
  constructor(
    private readonly options: {
      baseURL: string;
      apiKey: string;
      model: string;
      sendInputType?: boolean;
      batchSize?: number;
    },
  ) {}

  get model(): string {
    return this.options.model;
  }

  async embed(texts: string[], kind: "document" | "query"): Promise<number[][]> {
    const batchSize = this.options.batchSize ?? 64;
    const out: number[][] = [];
    for (let i = 0; i < texts.length; i += batchSize) {
      const batch = texts.slice(i, i + batchSize);
      const res = await fetch(`${this.options.baseURL.replace(/\/$/, "")}/embeddings`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${this.options.apiKey}` },
        body: JSON.stringify({
          model: this.options.model,
          input: batch,
          ...(this.options.sendInputType ? { input_type: kind } : {}),
        }),
      });
      if (!res.ok) throw new Error(`Embeddings request failed: ${res.status} ${await res.text()}`);
      const body = (await res.json()) as { data: { index: number; embedding: number[] }[] };
      const sorted = [...body.data].sort((a, b) => a.index - b.index);
      out.push(...sorted.map((d) => d.embedding));
    }
    return out;
  }
}
