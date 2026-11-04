import { describe, expect, it } from "vitest";
import { getDirection, languages, negotiateLanguage, normalizeLanguageTag } from "./languages.js";
import { en } from "./messages/en.js";
import { fr } from "./messages/fr.js";
import { createTranslator, resolveUiLanguage, t } from "./translate.js";

describe("language registry", () => {
  it("has unique codes", () => {
    const codes = languages.map((l) => l.code);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it("marks Arabic-script languages as right-to-left", () => {
    expect(getDirection("ar")).toBe("rtl");
    expect(getDirection("ur")).toBe("rtl");
    expect(getDirection("fa")).toBe("rtl");
    expect(getDirection("hi")).toBe("ltr");
    expect(getDirection("unknown")).toBe("ltr");
  });

  it.each([
    ["fr-CA", "fr"],
    ["en-US", "en"],
    ["zh-CN", "zh-Hans"],
    ["zh-TW", "zh-Hant"],
    ["zh-HK", "zh-Hant"],
    ["zh", "zh-Hans"],
    ["pa-IN", "pa"],
    ["fil-PH", "tl"],
    ["uk-UA", "uk"],
    ["ar-EG", "ar"],
    ["xx", undefined],
    ["", undefined],
  ])("normalizes %s → %s", (tag, expected) => {
    expect(normalizeLanguageTag(tag)).toBe(expected);
  });

  it("negotiates Accept-Language against allowed languages", () => {
    expect(negotiateLanguage("fr-CA,fr;q=0.9,en;q=0.8", ["en", "fr"])).toBe("fr");
    expect(negotiateLanguage("zh-CN,zh;q=0.9", ["en", "zh-Hans"])).toBe("zh-Hans");
    expect(negotiateLanguage("pa-IN;q=0.5,hi;q=0.9", ["en", "pa", "hi"])).toBe("hi");
    expect(negotiateLanguage("de-DE", ["en", "fr"])).toBe("en");
    expect(negotiateLanguage(undefined, ["en"], "fr")).toBe("fr");
  });
});

describe("UI messages", () => {
  it("French defines every English key", () => {
    expect(Object.keys(fr).sort()).toEqual(Object.keys(en).sort());
  });

  it("formats plurals in both languages", () => {
    expect(t("en", "bots.count", { count: 0 })).toBe("No assistants yet");
    expect(t("en", "bots.count", { count: 1 })).toBe("1 assistant");
    expect(t("en", "bots.count", { count: 3 })).toBe("3 assistants");
    expect(t("fr", "bots.count", { count: 3 })).toBe("3 assistants");
  });

  it("falls back to English UI for languages without a catalog", () => {
    expect(resolveUiLanguage("ar")).toBe("en");
    expect(t("ar", "auth.signIn")).toBe("Sign in");
    expect(createTranslator("fr-CA").t("auth.signIn")).toBe("Se connecter");
  });
});
