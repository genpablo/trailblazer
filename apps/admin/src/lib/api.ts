/** Minimal client for the API, reached through the /api rewrite (same origin, cookie session). */

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

export async function api<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method: init.method ?? "GET",
    headers: init.body !== undefined ? { "content-type": "application/json" } : undefined,
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    credentials: "same-origin",
  });
  if (res.status === 204) return undefined as T;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data.error ?? "error", data.message ?? res.statusText);
  return data as T;
}

export interface Me {
  user: { id: string; email: string; name: string; uiLanguage: string };
  tenants: { id: string; name: string; slug: string; plan: string; role: string }[];
}

export interface Bot {
  id: string;
  name: string;
  pack: string;
  variant: string | null;
  status: "draft" | "active" | "paused";
  languages: string[];
  defaultLanguage: string;
}

export interface BotDetail {
  bot: Bot;
  keys: { id: string; publicKey: string; allowedOrigins: string[] }[];
}

export interface Pack {
  slug: string;
  name: string;
  variants: { slug: string; name: string }[];
}

export interface Language {
  code: string;
  englishName: string;
  nativeName: string;
  tier: 1 | 2 | 3 | "owner";
  dir: "ltr" | "rtl";
}
