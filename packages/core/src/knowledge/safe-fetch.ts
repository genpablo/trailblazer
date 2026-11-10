import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";

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

/**
 * Addresses a crawler must never reach: loopback, private networks, link-local (cloud metadata),
 * carrier-grade NAT, documentation/benchmark ranges, multicast and reserved space, plus the IPv6
 * forms that wrap an IPv4 address (NAT64, 6to4, IPv4-compatible). IPv4-mapped IPv6 addresses
 * (::ffff:a.b.c.d, also in hex form) are checked against the IPv4 rules by BlockList itself.
 */
const blocked = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 3],
] as const) {
  blocked.addSubnet(network, prefix, "ipv4");
}
for (const [network, prefix] of [
  ["::", 96], // unspecified, loopback and IPv4-compatible addresses
  ["64:ff9b::", 96], // NAT64
  ["64:ff9b:1::", 48],
  ["100::", 64], // discard-only
  ["2001:db8::", 32], // documentation
  ["2002::", 16], // 6to4
  ["fc00::", 7], // unique local
  ["fe80::", 10], // link-local
  ["fec0::", 10], // site-local (deprecated)
  ["ff00::", 8], // multicast
] as const) {
  blocked.addSubnet(network, prefix, "ipv6");
}

/** True for any address that is not a public unicast address (unparseable input counts as private). */
export function isPrivateAddress(ip: string): boolean {
  const family = isIP(ip);
  if (!family) return true;
  return blocked.check(ip, family === 6 ? "ipv6" : "ipv4");
}

export async function assertPublicUrl(url: URL, allowPrivate = false): Promise<void> {
  if (url.protocol !== "http:" && url.protocol !== "https:")
    throw new UnsafeUrlError(`Unsupported protocol: ${url.protocol}`);
  if (url.username || url.password) throw new UnsafeUrlError("Credentials in URLs are not allowed");
  if (allowPrivate) return;
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".internal") ||
    host.endsWith(".local")
  ) {
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
