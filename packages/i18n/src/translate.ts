import { IntlMessageFormat } from "intl-messageformat";
import { getDirection, normalizeLanguageTag } from "./languages.js";
import { en, type MessageKey } from "./messages/en.js";
import { fr } from "./messages/fr.js";

type Catalog = Partial<Record<MessageKey, string>>;

/**
 * UI catalogs. Tier 2 languages get catalogs as they are translated and reviewed; until then
 * their UI falls back to English (answers are still generated in the visitor's language).
 */
const catalogs: Record<string, Catalog> = { en, fr };

export const uiLanguages = Object.keys(catalogs);

const cache = new Map<string, IntlMessageFormat>();

export type MessageValues = Record<string, string | number | boolean | Date | null | undefined>;

/** Returns the UI language to use for a requested tag (falls back to English). */
export function resolveUiLanguage(tag: string | undefined | null): string {
  const code = tag ? normalizeLanguageTag(tag) : undefined;
  return code && catalogs[code] ? code : "en";
}

export function t(language: string, key: MessageKey, values?: MessageValues): string {
  const lang = resolveUiLanguage(language);
  const template = catalogs[lang]?.[key] ?? en[key];
  const cacheKey = `${lang}\u0000${key}`;
  let formatter = cache.get(cacheKey);
  if (!formatter) {
    // ignoreTag: strings may contain literal markup such as "</body>"; we don't use rich-text tags.
    formatter = new IntlMessageFormat(template, lang, undefined, { ignoreTag: true });
    cache.set(cacheKey, formatter);
  }
  return String(formatter.format(values));
}

/** Convenience for components: a translator bound to one language plus its text direction. */
export function createTranslator(language: string) {
  const lang = resolveUiLanguage(language);
  return {
    language: lang,
    dir: getDirection(lang),
    t: (key: MessageKey, values?: MessageValues) => t(lang, key, values),
  };
}
