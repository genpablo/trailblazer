import type { bots, businessProfiles } from "@traiblazer/db";
import { describe, expect, it } from "vitest";
import { buildSystemBlocks } from "./prompt.js";

type Bot = typeof bots.$inferSelect;
type Profile = typeof businessProfiles.$inferSelect;

const bot = (overrides: Partial<Bot>): Bot =>
  ({
    id: "b",
    tenantId: "t",
    name: "Pine Café",
    pack: "cafe-bakery",
    variant: null,
    persona: null,
    languages: ["en", "fr", "uk"],
    defaultLanguage: "en",
    settings: {},
    ...overrides,
  }) as Bot;

const botBlock = (b: Bot) =>
  buildSystemBlocks({ bot: b, profile: null, passages: [], now: new Date() })[1]!.text;

describe("local time in the prompt", () => {
  const now = new Date("2026-07-01T16:30:00Z");
  const timeBlock = (timezone: string) =>
    buildSystemBlocks({
      bot: bot({}),
      profile: { timezone, staffLanguages: [] } as unknown as Profile,
      passages: [],
      now,
    })[2]!.text;

  it("uses the business's time zone", () => {
    expect(timeBlock("America/Winnipeg")).toContain("11:30 (America/Winnipeg)");
  });

  it("falls back to the default zone instead of failing on an unknown one", () => {
    expect(timeBlock("Mars/Phobos")).toContain("12:30 (America/Toronto)");
  });
});

describe("language rules in the prompt", () => {
  it("lists the languages offered and answers other languages by default", () => {
    const text = botBlock(bot({}));
    expect(text).toContain("<languages>\nLanguages offered: English, French, Ukrainian.");
    expect(text).toContain("If the visitor's language is unclear, use English.");
    expect(text).not.toContain("Only reply in one of the languages offered");
  });

  it("limits replies to the languages offered when the owner turns other languages off", () => {
    const text = botBlock(bot({ defaultLanguage: "fr", settings: { answerOtherLanguages: false } }));
    expect(text).toContain("Only reply in one of the languages offered");
    expect(text).toContain("reply in French");
  });
});
