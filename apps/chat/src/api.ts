/** Calls to the public chat API (same origin as this page). */

import type { PublicAppearance } from "@traiblazer/appearance";

export interface PublicLanguage {
  code: string;
  nativeName: string;
  dir: "ltr" | "rtl";
}

export interface PublicBotConfig {
  name: string;
  businessName: string;
  appearance: PublicAppearance;
  languages: PublicLanguage[];
  defaultLanguage: string;
  greeting: Record<string, string>;
  quickReplies: Record<string, string[]>;
  poweredBy: boolean;
}

export interface Citation {
  title: string | null;
  url: string | null;
}

export interface StoredMessage {
  role: "user" | "assistant";
  content: string;
  citations: Citation[];
}

export type StreamEvent =
  | { type: "start"; conversationId: string }
  | { type: "text"; text: string }
  | { type: "done"; messageId: string; citations: Citation[] }
  | { type: "error"; code: string; message: string };

export async function fetchConfig(publicKey: string): Promise<PublicBotConfig> {
  const res = await fetch(`/v1/public/bots/${encodeURIComponent(publicKey)}`);
  if (!res.ok) throw new Error(`config ${res.status}`);
  return (await res.json()).bot as PublicBotConfig;
}

export async function fetchHistory(
  publicKey: string,
  conversationId: string,
  visitorId: string,
): Promise<StoredMessage[]> {
  const params = new URLSearchParams({ key: publicKey, visitorId });
  const res = await fetch(`/v1/public/conversations/${encodeURIComponent(conversationId)}?${params}`);
  if (!res.ok) return [];
  return (await res.json()).messages as StoredMessage[];
}

/** POSTs a message and yields server-sent events as they arrive. */
export async function* streamChat(body: {
  publicKey: string;
  conversationId: string | null;
  visitorId: string;
  message: string;
  channel: string;
  pageUrl: string | null;
}): AsyncGenerator<StreamEvent> {
  const res = await fetch("/v1/public/chat", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "text/event-stream" },
    body: JSON.stringify(body),
  });
  if (!res.ok || !res.body) {
    const data = await res.json().catch(() => ({}));
    yield {
      type: "error",
      code: data.error ?? String(res.status),
      message: data.message ?? "Request failed",
    };
    return;
  }
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += value;
    let index = buffer.indexOf("\n\n");
    while (index !== -1) {
      const frame = buffer.slice(0, index);
      buffer = buffer.slice(index + 2);
      const data = frame
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n");
      if (data) yield JSON.parse(data) as StreamEvent;
      index = buffer.indexOf("\n\n");
    }
  }
}
