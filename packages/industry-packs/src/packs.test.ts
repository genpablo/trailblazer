import { describe, expect, it } from "vitest";
import { availablePacks, isSelectable, packs } from "./index.js";

describe("industry packs", () => {
  it("has unique pack slugs and unique variant slugs per pack", () => {
    const slugs = packs.map((p) => p.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
    for (const pack of packs) {
      const vs = pack.variants.map((v) => v.slug);
      expect(new Set(vs).size, pack.slug).toBe(vs.length);
    }
  });

  it("launches with the phase-1 packs only", () => {
    expect(availablePacks().map((p) => p.slug)).toEqual([
      "restaurant",
      "cafe-bakery",
      "retail",
      "personal-care",
      "lodging",
      "attractions",
      "generic",
    ]);
  });

  it("marks regulated professions as professional scope", () => {
    for (const slug of [
      "clinic",
      "pharmacy",
      "law-firm",
      "accounting-tax",
      "immigration-consultant",
      "car-dealership",
    ]) {
      expect(packs.find((p) => p.slug === slug)?.scope).toBe("professional");
    }
  });

  it("validates pack and variant selection", () => {
    expect(isSelectable("restaurant")).toBe(true);
    expect(isSelectable("restaurant", "pub")).toBe(true);
    expect(isSelectable("restaurant", "dental")).toBe(false);
    expect(isSelectable("clinic")).toBe(false); // phase 3
    expect(isSelectable("clinic", null, 3)).toBe(true);
    expect(isSelectable("nope")).toBe(false);
  });
});
