import { describe, expect, it } from "vitest";
import {
  AVATAR_ICON_IDS,
  BRAND_COLOR_PRESETS,
  contrastRatio,
  DEFAULT_COLOR,
  ensureContrast,
  findColorPreset,
  initialsOf,
  isHexColor,
  isTheme,
  paletteFor,
  THEMES,
  textOn,
  themeInfo,
} from "./index.js";

describe("themes and icons", () => {
  it("describes every theme in English and French", () => {
    expect(themeInfo.map((t) => t.id)).toEqual([...THEMES]);
    for (const t of themeInfo) expect(t.name.fr && t.description.fr).toBeTruthy();
    expect(isTheme("bold")).toBe(true);
    expect(isTheme("neon")).toBe(false);
  });

  it("has a set of avatar icons", () => {
    expect(AVATAR_ICON_IDS.length).toBeGreaterThanOrEqual(12);
  });
});

describe("initials", () => {
  it.each([
    ["Northshore Handyman", "NH"],
    ["Mike", "M"],
    ["  jean-luc   bistro ", "JB"],
    ["李师傅", "李"],
    ["", "?"],
    ["Mike 🔧", "M"],
    ["🔧 Fix-it Felix", "FF"],
    ["🔧", "?"],
  ])("%s → %s", (name, expected) => expect(initialsOf(name)).toBe(expected));
});

describe("contrast", () => {
  it("picks readable text on any brand color", () => {
    expect(textOn("#1f6f5c")).toBe("#ffffff");
    expect(textOn("#ffeb3b")).toBe("#111111");
    expect(textOn("#ffffff")).toBe("#111111");
  });

  it("darkens light brand colors used as text on white", () => {
    const fixed = ensureContrast("#ffeb3b", "#ffffff");
    expect(contrastRatio(fixed, "#ffffff")).toBeGreaterThanOrEqual(4.5);
    expect(ensureContrast("#1f6f5c", "#ffffff")).toBe("#1f6f5c");
  });

  it("lightens dark brand colors on the midnight theme", () => {
    const palette = paletteFor("#202060", "midnight");
    expect(contrastRatio(palette.accent, palette.surface)).toBeGreaterThanOrEqual(4.5);
  });

  it("falls back to the default color for invalid input", () => {
    expect(paletteFor("red; background:url(x)", "classic").brand).toBe("#1f6f5c");
  });
});

describe("brand color presets", () => {
  it("offers a dozen distinct, valid colors with English and French names", () => {
    expect(BRAND_COLOR_PRESETS.length).toBeGreaterThanOrEqual(10);
    const colors = BRAND_COLOR_PRESETS.map((p) => p.color.toLowerCase());
    expect(new Set(colors).size).toBe(colors.length);
    for (const p of BRAND_COLOR_PRESETS) {
      expect(isHexColor(p.color), p.id).toBe(true);
      expect(p.name.en && p.name.fr, p.id).toBeTruthy();
    }
    expect(BRAND_COLOR_PRESETS[0]!.color).toBe(DEFAULT_COLOR);
  });

  it("keeps every preset readable on buttons and as link color", () => {
    for (const p of BRAND_COLOR_PRESETS) {
      expect(contrastRatio(p.color, textOn(p.color)), p.id).toBeGreaterThanOrEqual(4.5);
      const palette = paletteFor(p.color, "classic");
      expect(contrastRatio(palette.accent, "#ffffff"), p.id).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("recognizes presets regardless of letter case", () => {
    expect(findColorPreset("#1F6F5C")?.id).toBe("forest");
    expect(findColorPreset("#123456")).toBeUndefined();
  });
});
