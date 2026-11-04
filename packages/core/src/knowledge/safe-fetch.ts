import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

/**
 * Fetching customer-supplied URLs from our servers is a server-side request forgery risk: a URL
 * could point at localhost, the cloud metadata service or the private network. Every request and
 * every redirect hop is resolved and rejected if any address is not public.
 */

export class UnsafeUrlError extends Error {}

export interface SafeFetchOptions {
  /** Tests only: allow loopback/private addresses. */
  allowPrivate?: boolean;
  timeoutMs?: number;
  maxBytes?: number;
  userAgent?: string;
  accept?: string;
}

export const USER_AGENT = "TraiblazerBot/0.1 (+https://traiblazer.example/bot)";

function isPrivateIPv4(ip: string): boolean {
  const [a = 0, b = 0] = ip.split(".").map(Number);
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

function isPrivateIPv6(ip: string): boolean {
  const v = ip.toLowerCase();
  if (v === "::" || v === "::1") return true;
  if (v.startsWith("::ffff:")) return isPrivateIPv4(v.slice(7));
  return v.startsWith("fc") || v.startsWith("fd") || v.startsWith("fe80") || v.startsWith("ff");
}

export function isPrivateAddress(ip: string): boolean {
  return isIP(ip) === 6 ? isPrivateIPv6(ip) : isPrivateIPv4(ip);
}

export async function assertPublicUrl(url: URL, allowPrivate = false): Promise<void> {
  if (url.protocol !== "http:" && url.protocol !== "https:")
    throw new UnsafeUrlError(`Unsupported protocol: ${url.protocol}`);
  if (url.username || url.password) throw new UnsafeUrlError("Credentials in URLs are not allowed");
  if (allowPrivate) return;
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal")) {
    throw new UnsafeUrlError("Private host");
  }
  const addresses = isIP(host) ? [{ address: host }] : await lookup(host, { all: true, verbatim: true });
  if (!addresses.length || addresses.some((a) => isPrivateAddress(a.address))) {
    throw new UnsafeUrlError("URL resolves to a private address");
  }
}

export interface SafeResponse {
  url: string;
  status: number;
  contentType: string;
  body: string;
}

/** GET with SSRF checks on every redirect hop, a timeout and a body size limit. */
export async function safeFetch(input: string, options: SafeFetchOptions = {}): Promise<SafeResponse> {
  let url = new URL(input);
  const maxBytes = options.maxBytes ?? 2_000_000;

  for (let hop = 0; hop < 5; hop++) {
    await assertPublicUrl(url, options.allowPrivate);
    const res = await fetch(url, {
      redirect: "manual",
      signal: AbortSignal.timeout(options.timeoutMs ?? 15_000),
      headers: {
        "user-agent": options.userAgent ?? USER_AGENT,
        accept: options.accept ?? "text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8",
      },
    });

    if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
      await res.body?.cancel();
      url = new URL(res.headers.get("location") as string, url);
      continue;
    }

    const reader = res.body?.getReader();
    const parts: Uint8Array[] = [];
    let size = 0;
    if (reader) {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > maxBytes) {
          await reader.cancel();
          break;
        }
        parts.push(value);
      }
    }
    const body = new TextDecoder("utf-8").decode(Buffer.concat(parts));
    return {
      url: url.toString(),
      status: res.status,
      contentType: res.headers.get("content-type") ?? "",
      body,
    };
  }
  throw new UnsafeUrlError("Too many redirects");
}
