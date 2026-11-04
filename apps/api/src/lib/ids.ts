import { randomBytes } from "node:crypto";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const isUuid = (value: string) => UUID_RE.test(value);

/** Public widget key, e.g. pk_live_3Jd9…  (not a secret; origin checks still apply). */
export function newPublicKey(live: boolean): string {
  return `pk_${live ? "live" : "test"}_${randomBytes(18).toString("base64url")}`;
}

/** URL-safe slug from a business name, with a random suffix for uniqueness. */
export function slugify(name: string): string {
  const base =
    name
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "business";
  return `${base}-${randomBytes(3).toString("hex")}`;
}

/** Normalizes a URL to its origin ("https://example.com/menu" → "https://example.com"). */
export function toOrigin(url: string): string {
  return new URL(url).origin;
}
