import { describe, expect, it } from "vitest";
import {
  AVATAR_ICON_IDS,
  contrastRatio,
  ensureContrast,
  initialsOf,
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
