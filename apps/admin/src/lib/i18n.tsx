"use client";

import { createTranslator, type MessageKey, type MessageValues } from "@traiblazer/i18n";
import { createContext, type ReactNode, useContext, useMemo } from "react";

type Translator = ReturnType<typeof createTranslator>;

const I18nContext = createContext<Translator | null>(null);

export function I18nProvider({ language, children }: { language: string; children: ReactNode }) {
  const translator = useMemo(() => createTranslator(language), [language]);
  return <I18nContext.Provider value={translator}>{children}</I18nContext.Provider>;
}

export function useI18n(): Translator & { t: (key: MessageKey, values?: MessageValues) => string } {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error("useI18n must be used inside I18nProvider");
  return ctx;
}

/** Stores the UI language in a cookie and reloads so server-rendered lang/dir update too. */
export function setUiLanguage(language: string) {
  // biome-ignore lint/suspicious/noDocumentCookie: simple preference cookie, read on the server
  document.cookie = `tb_lang=${encodeURIComponent(language)}; path=/; max-age=31536000; samesite=lax`;
  window.location.reload();
}
