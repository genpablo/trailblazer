import type { bots } from "@traiblazer/db";
import { describe, expect, it } from "vitest";
import { buildSystemBlocks } from "./prompt.js";

type Bot = typeof bots.$inferSelect;

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
